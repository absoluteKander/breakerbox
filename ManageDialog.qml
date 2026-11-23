import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "core/Core.js" as Core

// Add / edit / remove services. An overlay (like Omarchy's own reminder and
// polkit dialogs): a centred card with keyboard focus that stays put until
// Esc, Cancel or Save. It doesn't vanish when the pointer wanders off, and
// clicking the dimmed backdrop only closes it from the list view, never
// mid-form.
//
// Saving tests the connection first. Keys go straight from the password
// field to the keyring; they are never written to config.json, logged, or
// kept in this component's state.
Item {
    id: root

    property string omarchyPath: ""
    property var shell: null
    property var manifest: null

    property bool opened: false

    property string view: "list"        // "list" | "form"
    property string editingName: ""     // "" while adding
    property string formType: ""
    property var form: ({})             // field -> string
    property string message: ""
    property string messageTone: ""     // "", "ok", "warn", "error"
    property bool busy: false
    property bool offerSaveAnyway: false
    property bool certProblem: false
    property var cert: null
    property string confirmRemove: ""

    readonly property var adapter: formType ? Monitor.adapters[formType] : null
    readonly property var rawInstances: Monitor.rawConfig.instances || []
    readonly property bool readOnly: Monitor.configBroken
    // Adding one more of this type would pass the limit for small labs.
    readonly property bool atCap: !editingName && !!formType && !Core.canAdd(Monitor.rawConfig, formType, Monitor.adapters)
    // Hit the tab limit rather than this service's own instance limit.
    readonly property bool atTypeLimit: atCap
        && (Monitor.rawConfig.instances || []).filter(function(x) { return x && x.type === formType }).length < Core.maxFor(adapter)
    readonly property bool allCapped: Monitor.adapterOrder.every(function(t) { return !Core.canAdd(Monitor.rawConfig, t, Monitor.adapters) })

    // First service type that still has room.
    function firstOpenType() {
        for (var i = 0; i < Monitor.adapterOrder.length; i++)
            if (Core.canAdd(Monitor.rawConfig, Monitor.adapterOrder[i], Monitor.adapters)) return Monitor.adapterOrder[i]
        return Monitor.adapterOrder[0]
    }

    readonly property color fg: Commons.Color.menu.text
    readonly property color bg: Commons.Color.menu.background
    readonly property color accent: Commons.Color.accent
    readonly property var borderSpec: Border.surfaceSpec("menu", "border", Commons.Color.menu.border, Math.max(1, Style.space(2)))
    readonly property string fontFamily: Style.font.family
    readonly property real gap: Style.space(10)

    // ── Lifecycle ────────────────────────────────────────────────────────

    function open(payloadJson) {
        var payload = ({})
        try { payload = JSON.parse(payloadJson || "{}") || ({}) } catch (e) { payload = ({}) }
        root.opened = true
        root.resetMessage()
        root.confirmRemove = ""
        if (payload.edit && root.findRaw(payload.edit)) root.startEdit(payload.edit)
        else if (payload.add || root.rawInstances.length === 0) root.startAdd(root.firstOpenType())
        else root.view = "list"
    }

    function close() { root.opened = false }

    function dismiss() {
        root.opened = false
        root.clearSecret()
        if (root.shell && typeof root.shell.hide === "function")
            root.shell.hide((root.manifest && root.manifest.id) || "io.github.absolutekander.breakerbox")
    }

    function toggle() { root.opened ? root.dismiss() : root.open("{}") }

    // ── State helpers ────────────────────────────────────────────────────

    function findRaw(name) {
        for (var i = 0; i < root.rawInstances.length; i++)
            if (root.rawInstances[i] && root.rawInstances[i].name === name) return root.rawInstances[i]
        return null
    }

    function resetMessage() {
        root.message = ""
        root.messageTone = ""
        root.offerSaveAnyway = false
        root.certProblem = false
        root.cert = null
    }

    function say(text, tone) {
        root.message = text
        root.messageTone = tone || ""
    }

    function clearSecret() { if (formLoader.item) formLoader.item.clearSecret() }
    function typedSecret() { return formLoader.item ? formLoader.item.secretText : "" }

    // Flip view so the Loader tears down and rebuilds the form.
    function showForm() {
        root.view = "list"
        root.view = "form"
    }

    function setField(key, value) {
        var copy = {}
        for (var k in root.form) copy[k] = root.form[k]
        copy[key] = value
        root.form = copy
        root.offerSaveAnyway = false
    }

    function startAdd(type) {
        root.editingName = ""
        root.formType = type
        root.form = ({ name: "", url: "", interval: "", pin: "", secret: "" })
        root.resetMessage()
        root.showForm()
    }

    function startEdit(name) {
        var raw = root.findRaw(name)
        if (!raw || !Monitor.adapters[raw.type]) return
        root.editingName = name
        root.formType = raw.type
        root.form = Core.rawToForm(Monitor.adapters[raw.type], raw)
        root.resetMessage()
        root.showForm()
    }

    // Cancel on the very first add (nothing to list) just closes.
    function backToList(afterSave) {
        root.clearSecret()
        root.resetMessage()
        root.view = "list"
        if (!afterSave && root.rawInstances.length === 0) { root.dismiss(); return }
        Qt.callLater(function() { scope.forceActiveFocus() })
    }

    function candidate() {
        return Core.formToRaw(root.adapter, root.formType, root.form)
    }

    // Save = test, then write. A failed test offers "Save anyway" (the
    // server may just be down right now).
    function save(skipTest) {
        if (root.busy || root.readOnly || !root.adapter || root.atCap) return
        var raw = root.candidate()
        var secret = root.typedSecret()
        var probe = Object.assign({}, raw)
        if (root.adapter.secret && !probe.secret) probe.secret = "keyring:placeholder"
        var problems = Core.validateCandidate(Monitor.rawConfig, probe, root.editingName, Monitor.adapters)
        if (!problems.length && root.adapter.secret && !secret && !raw.secret)
            problems = ["enter the " + root.adapter.secretLabel.toLowerCase()]
        if (problems.length) { root.say(problems[0], "error"); return }

        root.busy = true
        root.certProblem = false
        root.cert = null
        var write = function() {
            root.say("Saving…", "")
            Monitor.saveInstance(raw, secret, root.editingName, function(err, warning) {
                root.busy = false
                if (err) { root.say(err, "error"); return }
                root.clearSecret()
                var name = raw.name
                root.backToList(true)
                if (warning) root.say("Saved " + name + ", but " + warning, "warn")
                else root.say("Saved " + name + ". It will show up in the bar within a few seconds.", "ok")
            })
        }
        if (skipTest) return write()
        root.say("Checking connection…", "")
        Monitor.testInstance(raw, secret, function(err, msg, certProblem) {
            if (err) {
                root.busy = false
                root.certProblem = certProblem
                root.offerSaveAnyway = !certProblem
                root.say(err, "error")
                return
            }
            write()
        })
    }

    function inspectCert() {
        if (root.busy) return
        root.busy = true
        root.say("Reading certificate…", "")
        Monitor.fetchCert(root.form.url || "", function(err, info) {
            root.busy = false
            if (err) { root.say(err, "error"); return }
            root.cert = info
            root.say("", "")
            Qt.callLater(function() { trustButton.forceActiveFocus() })
        })
    }

    function trustCert() {
        if (!root.cert) return
        root.setField("pin", root.cert.pin)
        root.cert = null
        root.certProblem = false
        root.save(false)
    }

    function remove(name) {
        if (root.busy || root.readOnly) return
        root.busy = true
        Monitor.removeInstance(name, function(err, warning) {
            root.busy = false
            root.confirmRemove = ""
            Qt.callLater(function() { scope.forceActiveFocus() })
            if (err) root.say(err, "error")
            else if (warning) root.say("Removed " + name + " from the config, but " + warning, "warn")
            else root.say("Removed " + name + ".", "ok")
        })
    }

    function toneColor(tone) {
        return tone === "ok" ? Core.color("ok") : tone === "error" ? Core.color("error") : tone === "warn" ? Core.color("warn") : root.fg
    }

    // ── Window ───────────────────────────────────────────────────────────

    OverlayWindow {
        id: panel
        shown: root.opened
        WlrLayershell.namespace: "breakerbox-setup"

        Rectangle {
            anchors.fill: parent
            color: Commons.Color.menu.scrim
        }

        // Backdrop click closes the list, but never a half-filled form.
        MouseArea {
            anchors.fill: parent
            onClicked: if (root.view === "list" && !root.busy) root.dismiss()
        }

        BorderSurface {
            id: card
            width: Math.min(Style.space(560), panel.width - Style.gapsOut * 2)
            height: Math.min(body.implicitHeight + card.contentTopInset + card.contentBottomInset, panel.height - Style.gapsOut * 2)
            radius: Style.cornerRadius
            anchors.centerIn: parent
            color: root.bg
            borderSpec: root.borderSpec
            padding: Style.spacing.panelPadding

            MouseArea { anchors.fill: parent; onClicked: {} }

            FocusScope {
                id: scope
                anchors.fill: parent
                anchors.topMargin: card.contentTopInset
                anchors.rightMargin: card.contentRightInset
                anchors.bottomMargin: card.contentBottomInset
                anchors.leftMargin: card.contentLeftInset
                focus: true

                Keys.onEscapePressed: function(event) {
                    event.accepted = true
                    if (root.busy) return
                    if (root.cert) { root.cert = null; return }
                    if (root.confirmRemove) { root.confirmRemove = ""; return }
                    if (root.view === "form") root.backToList()
                    else root.dismiss()
                }
                Keys.onPressed: function(event) {
                    if (root.view === "list" && !root.busy && event.text === "a" && !root.readOnly && !root.allCapped) {
                        root.startAdd(root.firstOpenType())
                        event.accepted = true
                    }
                }

                Flickable {
                    anchors.fill: parent
                    contentHeight: body.implicitHeight
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: body
                        width: parent.width
                        spacing: root.gap

                        // ── Header ──────────────────────────────────────
                        Item {
                            width: parent.width
                            height: titleText.implicitHeight

                            Text {
                                id: titleText
                                text: root.view === "list" ? "Your services"
                                    : root.editingName ? "Edit " + root.editingName
                                    : "Add a service"
                                color: root.fg
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.heading
                                font.bold: true
                            }
                            Text {
                                anchors.right: parent.right
                                anchors.verticalCenter: titleText.verticalCenter
                                text: "Esc to " + (root.view === "form" ? "go back" : "close")
                                color: root.fg
                                opacity: 0.4
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.caption
                            }
                        }

                        Text {
                            visible: root.readOnly
                            width: parent.width
                            text: "config.json has a syntax error, so it can't be edited here without losing it. Fix it by hand: " + Monitor.configPathShort
                            color: Core.color("warn")
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.body
                            wrapMode: Text.WordWrap
                        }

                        // ── List view ───────────────────────────────────
                        Column {
                            visible: root.view === "list"
                            width: parent.width
                            spacing: Style.space(6)

                            Repeater {
                                model: root.rawInstances

                                delegate: Rectangle {
                                    id: row
                                    required property var modelData
                                    readonly property string name: modelData && modelData.name ? String(modelData.name) : "(unnamed)"
                                    readonly property var adapterDef: modelData ? Monitor.adapters[modelData.type] : null
                                    readonly property var entry: Monitor.entries[name]
                                    readonly property bool loaded: Monitor.instances.some(function(i) { return i.name === row.name })
                                    readonly property bool confirming: root.confirmRemove === name
                                    // Safe default: confirming lands on Keep, not Remove.
                                    onConfirmingChanged: if (confirming) Qt.callLater(function() { keepButton.forceActiveFocus() })

                                    width: body.width
                                    height: rowCol.implicitHeight + Style.space(16)
                                    radius: Style.space(6)
                                    color: "transparent"
                                    border.width: 1
                                    border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.12)

                                    Column {
                                        id: rowCol
                                        anchors.left: parent.left
                                        anchors.right: parent.right
                                        anchors.verticalCenter: parent.verticalCenter
                                        anchors.leftMargin: Style.space(10)
                                        anchors.rightMargin: Style.space(8)
                                        spacing: Style.space(6)

                                        Item {
                                            width: parent.width
                                            height: Math.max(info.implicitHeight, actions.implicitHeight)

                                            Row {
                                                id: info
                                                anchors.left: parent.left
                                                anchors.right: actions.left
                                                anchors.rightMargin: Style.space(8)
                                                anchors.verticalCenter: parent.verticalCenter
                                                spacing: Style.space(8)

                                                Rectangle {
                                                    width: 8; height: 8; radius: 4
                                                    anchors.verticalCenter: parent.verticalCenter
                                                    color: !row.loaded ? Core.color("warn") : Core.color(row.entry ? row.entry.status : "loading")
                                                }
                                                Column {
                                                    width: info.width - Style.space(16)
                                                    Text {
                                                        text: row.name
                                                        color: root.fg
                                                        font.family: root.fontFamily
                                                        font.pixelSize: Style.font.body
                                                        font.bold: true
                                                        width: parent.width
                                                        elide: Text.ElideRight
                                                    }
                                                    Text {
                                                        text: !row.loaded ? "not loaded — see config problems in the panel"
                                                            : (row.adapterDef ? row.adapterDef.label : row.modelData.type) + "  ·  " + (row.modelData.url || "")
                                                        color: root.fg
                                                        opacity: 0.55
                                                        font.family: root.fontFamily
                                                        font.pixelSize: Style.font.caption
                                                        width: parent.width
                                                        elide: Text.ElideRight
                                                    }
                                                }
                                            }

                                            Row {
                                                id: actions
                                                visible: !row.confirming && !root.readOnly
                                                anchors.right: parent.right
                                                anchors.verticalCenter: parent.verticalCenter
                                                spacing: Style.space(4)

                                                Button {
                                                    text: "Edit"
                                                    visible: !!row.adapterDef
                                                    bordered: true
                                                    focusable: true
                                                    foreground: root.fg
                                                    fontSize: Style.font.caption
                                                    onClicked: root.startEdit(row.name)
                                                }
                                                Button {
                                                    text: "Remove"
                                                    bordered: true
                                                    focusable: true
                                                    foreground: root.fg
                                                    fontSize: Style.font.caption
                                                    onClicked: root.confirmRemove = row.name
                                                }
                                            }
                                        }

                                        // Inline confirm: no second dialog to lose track of.
                                        Item {
                                            visible: row.confirming
                                            width: parent.width
                                            height: confirmButtons.implicitHeight

                                            Text {
                                                anchors.left: parent.left
                                                anchors.right: confirmButtons.left
                                                anchors.verticalCenter: parent.verticalCenter
                                                text: "Remove " + row.name + "? Its saved key is deleted from the keyring too."
                                                color: Core.color("warn")
                                                font.family: root.fontFamily
                                                font.pixelSize: Style.font.caption
                                                wrapMode: Text.WordWrap
                                            }
                                            Row {
                                                id: confirmButtons
                                                anchors.right: parent.right
                                                spacing: Style.space(4)
                                                Button {
                                                    text: "Remove"
                                                    bordered: true
                                                    focusable: true
                                                    foreground: Core.color("error")
                                                    fontSize: Style.font.caption
                                                    onClicked: root.remove(row.name)
                                                }
                                                Button {
                                                    id: keepButton
                                                    text: "Keep"
                                                    bordered: true
                                                    focusable: true
                                                    foreground: root.fg
                                                    fontSize: Style.font.caption
                                                    onClicked: { root.confirmRemove = ""; scope.forceActiveFocus() }
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            Text {
                                visible: !root.readOnly && root.allCapped
                                width: body.width
                                text: "That's every service at its limit. This is built for small labs; " + Core.BIGGER_LAB_HINT + "."
                                color: root.fg
                                opacity: 0.55
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.caption
                                wrapMode: Text.WordWrap
                            }

                            Button {
                                visible: !root.readOnly && !root.allCapped
                                text: "Add a service"
                                iconText: "+"
                                bordered: true
                                focusable: true
                                foreground: root.fg
                                onClicked: root.startAdd(root.firstOpenType())
                            }
                        }

                        // ── Form view ───────────────────────────────────
                        // Rebuilt from scratch every time it opens, so no
                        // field ever shows text left over from last time.
                        Loader {
                            id: formLoader
                            width: parent.width
                            active: root.view === "form" && !!root.adapter
                            visible: active
                            sourceComponent: formComponent
                            onLoaded: Qt.callLater(function() { if (formLoader.item) formLoader.item.focusFirst() })
                        }

                        // ── Certificate review ──────────────────────────
                        Rectangle {
                            visible: root.view === "form" && !!root.cert
                            width: parent.width
                            height: certCol.implicitHeight + Style.space(20)
                            radius: Style.space(6)
                            color: "transparent"
                            border.width: 1
                            border.color: Core.color("warn")

                            Column {
                                id: certCol
                                anchors.fill: parent
                                anchors.margins: Style.space(10)
                                spacing: Style.space(6)

                                Text {
                                    width: parent.width
                                    text: "Check this matches the certificate your server shows in its own settings before trusting it."
                                    color: root.fg
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.caption
                                    wrapMode: Text.WordWrap
                                }
                                Text {
                                    width: parent.width
                                    text: root.cert ? "Subject: " + (root.cert.subject || "?") + "\nExpires: " + (root.cert.expires || "?") : ""
                                    color: root.fg
                                    opacity: 0.8
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.caption
                                    wrapMode: Text.WrapAnywhere
                                }
                                Text {
                                    width: parent.width
                                    text: root.cert ? "SHA-256 fingerprint:\n" + root.cert.fingerprint : ""
                                    color: root.fg
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.caption
                                    wrapMode: Text.WrapAnywhere
                                }
                                Row {
                                    spacing: Style.space(4)
                                    Button {
                                        id: trustButton
                                        text: "Trust this certificate"
                                        bordered: true
                                        focusable: true
                                        foreground: root.fg
                                        onClicked: root.trustCert()
                                    }
                                    Button {
                                        text: "Cancel"
                                        bordered: true
                                        focusable: true
                                        foreground: root.fg
                                        onClicked: root.cert = null
                                    }
                                }
                            }
                        }

                        // ── Message line ────────────────────────────────
                        Text {
                            visible: root.message !== ""
                            width: parent.width
                            text: root.message
                            color: root.toneColor(root.messageTone)
                            opacity: root.messageTone === "" ? 0.6 : 1
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.body
                            wrapMode: Text.WordWrap
                        }

                        // ── Form buttons ────────────────────────────────
                        Row {
                            visible: root.view === "form" && !root.readOnly
                            spacing: Style.space(6)

                            Button {
                                text: root.busy ? "Working…" : "Save"
                                bordered: true
                                focusable: true
                                selected: true
                                foreground: root.fg
                                enabled: !root.busy && !root.atCap
                                onClicked: root.save(false)
                            }
                            Button {
                                visible: root.certProblem && !root.cert && !root.busy
                                text: "Inspect certificate"
                                bordered: true
                                focusable: true
                                foreground: root.fg
                                onClicked: root.inspectCert()
                            }
                            Button {
                                visible: root.offerSaveAnyway && !root.busy
                                text: "Save anyway"
                                bordered: true
                                focusable: true
                                foreground: root.fg
                                onClicked: root.save(true)
                            }
                            Button {
                                text: "Cancel"
                                bordered: true
                                focusable: true
                                foreground: root.fg
                                enabled: !root.busy
                                onClicked: root.backToList()
                            }
                        }

                        // ── About ───────────────────────────────────────
                        Row {
                            visible: root.view === "list"
                            spacing: Style.space(10)
                            topPadding: Style.space(6)

                            BreakerMark {
                                size: 33
                                color: root.fg
                                anchors.verticalCenter: parent.verticalCenter
                            }
                            Column {
                                anchors.verticalCenter: parent.verticalCenter
                                Text {
                                    text: "Breaker Box " + (root.manifest && root.manifest.version ? root.manifest.version : "")
                                    color: root.fg
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.body
                                    font.bold: true
                                }
                                Text {
                                    text: "Status for small homelabs · Absolute-Candor · MIT"
                                    color: root.fg
                                    opacity: 0.5
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.caption
                                }
                            }
                        }

                        Text {
                            visible: root.view === "list"
                            width: parent.width
                            text: "a  add  ·  Esc  close  ·  keys live in your keyring  ·  " + Monitor.configPathShort
                            color: root.fg
                            opacity: 0.35
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            elide: Text.ElideMiddle
                        }
                    }
                }
            }
        }
    }

    Component {
        id: formComponent

        Column {
            id: formCol
            width: parent ? parent.width : 0
            spacing: Style.space(8)

            readonly property string secretText: secretField.text
            function clearSecret() { secretField.text = "" }
            function focusFirst() { nameField.forceActiveFocus() }

            // Type: only when adding. Changing a saved
            // service's type would orphan its key.
            Column {
                visible: !root.editingName
                width: parent.width
                spacing: Style.space(4)
                FieldLabel { text: "Service" }
                Flow {
                    width: parent.width
                    spacing: Style.space(4)
                    Repeater {
                        model: Monitor.adapterOrder
                        delegate: Button {
                            required property string modelData
                            text: Monitor.adapters[modelData].label
                            selected: root.formType === modelData
                            opacity: Core.canAdd(Monitor.rawConfig, modelData, Monitor.adapters) ? 1 : 0.45
                            bordered: true
                            focusable: true
                            foreground: root.fg
                            onClicked: {
                                var keep = { name: root.form.name || "", url: root.form.url || "", interval: "", pin: "", secret: "" }
                                root.formType = modelData
                                root.form = keep
                                root.resetMessage()
                            }
                        }
                    }
                }
            }

            Text {
                visible: root.atCap
                width: parent.width
                text: root.atTypeLimit
                    ? "You already watch " + Core.MAX_TYPES + " different services, one tab each — that's the limit here. "
                      + "This is built for small labs; " + Core.BIGGER_LAB_HINT + "."
                    : "You already have " + Core.maxFor(root.adapter) + " " + (root.adapter ? root.adapter.label : "")
                      + " — that's the limit here. This is built for small labs; " + Core.BIGGER_LAB_HINT + "."
                color: Core.color("warn")
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
            }

            FieldLabel { text: "Name" }
            TextField {
                id: nameField
                width: parent.width
                text: root.form.name || ""
                placeholderText: root.adapter ? root.adapter.id : ""
                font.family: root.fontFamily
                foreground: root.fg
                enabled: !root.readOnly
                onTextEdited: root.setField("name", text)
                onAccepted: root.save(false)
            }

            FieldLabel { text: "Address" }
            TextField {
                width: parent.width
                text: root.form.url || ""
                placeholderText: root.adapter ? root.adapter.urlExample : ""
                font.family: root.fontFamily
                foreground: root.fg
                enabled: !root.readOnly
                onTextEdited: {
                    // A different server means the old pin no longer applies.
                    if (root.form.pin) root.setField("pin", "")
                    root.setField("url", text)
                }
                onAccepted: root.save(false)
            }

            Repeater {
                model: root.adapter ? Object.keys(root.adapter.fields || {}) : []
                delegate: Column {
                    required property string modelData
                    readonly property var def: root.adapter.fields[modelData]
                    width: formCol.width
                    spacing: Style.space(4)
                    FieldLabel { text: def.label || modelData }
                    TextField {
                        width: parent.width
                        text: root.form[modelData] || ""
                        placeholderText: def.placeholder || ""
                        inputMethodHints: def.type === "number" ? Qt.ImhDigitsOnly : Qt.ImhNone
                        font.family: root.fontFamily
                        foreground: root.fg
                        enabled: !root.readOnly
                        onTextEdited: root.setField(modelData, text)
                        onAccepted: root.save(false)
                    }
                    FieldHint { text: def.hint || "" }
                }
            }

            FieldLabel {
                visible: !!root.adapter && !!root.adapter.secret
                text: root.adapter ? root.adapter.secretLabel || "" : ""
            }
            TextField {
                id: secretField
                visible: !!root.adapter && !!root.adapter.secret
                width: parent.width
                password: true
                echoMode: TextInput.Password
                placeholderText: root.editingName && root.form.secret
                    ? "saved — leave blank to keep it"
                    : "paste it here"
                font.family: root.fontFamily
                foreground: root.fg
                enabled: !root.readOnly
                onTextEdited: root.offerSaveAnyway = false
                onAccepted: root.save(false)
            }
            FieldHint {
                visible: !!root.adapter && !!root.adapter.secret
                text: root.adapter && root.adapter.secret
                    ? (root.adapter.secretHint || "") + " Stored in your system keyring, never in the config file."
                    : ""
            }

            FieldLabel { text: "Check every (seconds)" }
            TextField {
                width: Style.space(120)
                text: root.form.interval || ""
                placeholderText: root.adapter ? String(root.adapter.defaultInterval) : ""
                inputMethodHints: Qt.ImhDigitsOnly
                font.family: root.fontFamily
                foreground: root.fg
                enabled: !root.readOnly
                onTextEdited: root.setField("interval", text)
                onAccepted: root.save(false)
            }

            // Pinned certificate, if any.
            Item {
                visible: !!root.form.pin
                width: parent.width
                height: Math.max(pinText.implicitHeight, unpin.implicitHeight)
                Text {
                    id: pinText
                    anchors.left: parent.left
                    anchors.right: unpin.left
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Trusting a pinned certificate: " + (root.form.pin || "").slice(8, 24) + "…"
                    color: root.fg
                    opacity: 0.7
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                }
                Button {
                    id: unpin
                    anchors.right: parent.right
                    text: "Unpin"
                    bordered: true
                    focusable: true
                    foreground: root.fg
                    fontSize: Style.font.caption
                    onClicked: root.setField("pin", "")
                }
            }
        }
    }

    component FieldLabel: Text {
        color: root.fg
        opacity: 0.75
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
    }

    component FieldHint: Text {
        visible: text !== ""
        width: parent ? parent.width : 0
        color: root.fg
        opacity: 0.45
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
    }
}
