import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "core/Core.js" as Core

// Service tabs → instance tabs → one generic InstanceView. Everything is
// built from Monitor.services; there is no per-service code here.
//
// Keys: ←/→ service, ↑/↓ instance, r refresh, o open in browser, s setup, Esc close.
Panel {
    id: root
    moduleName: "io.github.absolutekander.breakerbox"
    manageIpc: false

    property var anchorItem: null
    property var hostWidget: null

    readonly property color contentForeground: bar ? bar.foreground : Color.foreground

    // Selection survives the panel closing, and is by name so it survives a
    // config reload that reorders things.
    property string selectedType: ""
    property var selectedInstance: ({})     // type -> instance name

    readonly property var services: Monitor.services
    readonly property int serviceIndex: {
        for (var i = 0; i < services.length; i++) if (services[i].type === selectedType) return i
        return 0
    }
    readonly property var currentService: services.length ? services[serviceIndex] : null
    readonly property var currentInstances: currentService ? currentService.instances : []
    readonly property int instanceIndex: {
        if (!currentService) return 0
        var want = selectedInstance[currentService.type]
        for (var i = 0; i < currentInstances.length; i++) if (currentInstances[i].name === want) return i
        return 0
    }
    readonly property var currentInstance: currentInstances.length ? currentInstances[instanceIndex] : null

    function selectService(i) {
        if (!services.length) return
        selectedType = services[(i + services.length) % services.length].type
    }
    function selectInstance(i) {
        if (!currentService || !currentInstances.length) return
        var copy = {}
        for (var k in selectedInstance) copy[k] = selectedInstance[k]
        copy[currentService.type] = currentInstances[(i + currentInstances.length) % currentInstances.length].name
        selectedInstance = copy
    }

    function openSetup(payload) {
        root.close()
        if (root.hostWidget && typeof root.hostWidget.openSetup === "function") root.hostWidget.openSetup(payload)
    }

    // Opening the panel goes straight to the worst problem: the service tab,
    // then the instance, that's red (or amber if nothing is red). Inside
    // it, GroupList already has the offending group open. Only on open,
    // never while you're reading, and with everything green it stays on
    // whatever you looked at last.
    function jumpToTrouble() {
        var pick = Core.worstInstance(root.services, Monitor.entries)
        if (!pick) return
        root.selectedType = pick.type
        var copy = {}
        for (var k in root.selectedInstance) copy[k] = root.selectedInstance[k]
        copy[pick.type] = pick.name
        root.selectedInstance = copy
    }

    onOpenedChanged: if (opened) jumpToTrouble()

    function switchPanel(direction) {
        if (root.bar && typeof root.bar.switchPanelFrom === "function")
            return root.bar.switchPanelFrom(root.hostWidget || root, direction)
        return false
    }

    KeyboardPanel {
        id: panel
        anchorItem: root.anchorItem
        owner: root.hostWidget || root
        bar: root.bar
        open: root.opened
        focusTarget: panel.loadedContent
        contentWidth: panel.fittedContentWidth(Style.space(340))
        // Never taller than this, however much a service reports: the row
        // limit should keep it well under, and anything past it scrolls.
        contentHeight: panel.fittedContentHeight(Math.min(panel.loadedContentHeight, Style.space(640)))

        content: PanelKeyCatcher {
            id: keyCatcher
            anchors.fill: parent
            implicitHeight: body.implicitHeight + Style.space(24)
            onCloseRequested: root.close()
            onTabRequested: function(direction) { root.switchPanel(direction) }
            onMoveRequested: function(dx, dy) {
                if (dx !== 0) root.selectService(root.serviceIndex + dx)
                if (dy !== 0) root.selectInstance(root.instanceIndex + dy)
            }
            onTextKey: function(t, modifiers) {
                if (t === "r") Monitor.refresh()
                else if (t === "o") { root.close(); Monitor.openInstance(root.currentInstance) }
                else if (t === "s") root.openSetup({})
            }

            Flickable {
                anchors.fill: parent
                anchors.margins: Style.space(12)
                contentHeight: body.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds

                Column {
                    id: body
                    width: parent.width
                    spacing: Style.space(10)

                    // ── Header, like Omarchy's own panels: mark, name and
                    //    the one line that matters ─────────────────────
                    PanelHero {
                        width: body.width
                        title: "Breaker Box"
                        meta: Core.troubleLine(root.services, Monitor.entries)
                        foreground: root.contentForeground
                        iconSize: 33
                        iconComponent: Component {
                            BreakerMark {
                                size: 33
                                // tripped = red, flickering = amber, otherwise just the text colour
                                color: Monitor.overall === "error" || Monitor.overall === "warn"
                                    ? Core.color(Monitor.overall) : root.contentForeground
                            }
                        }
                    }

                    // ── Setup / config problems ──────────────────────
                    Text {
                        visible: Monitor.configLoaded && Monitor.rawConfig.instances.length === 0 && !Monitor.configBroken
                        width: parent.width
                        text: "Nothing to watch yet."
                        color: root.contentForeground
                        opacity: 0.6
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Button {
                        visible: Monitor.configLoaded && Monitor.rawConfig.instances.length === 0 && !Monitor.configBroken
                        text: "Add your first service"
                        bordered: true
                        foreground: root.contentForeground
                        onClicked: root.openSetup({ add: true })
                    }

                    Repeater {
                        model: Monitor.configErrors
                        delegate: Text {
                            required property string modelData
                            width: body.width
                            text: "Config: " + modelData
                            color: Core.color("warn")
                            font.family: Style.font.family
                            font.pixelSize: Style.font.caption
                            wrapMode: Text.WordWrap
                        }
                    }


                    // ── Tabs ─────────────────────────────────────────
                    InstanceTabs {
                        width: body.width
                        items: root.services.map(function(s) { return { label: s.label, status: s.status } })
                        currentIndex: root.serviceIndex
                        foreground: root.contentForeground
                        onSelected: function(i) { root.selectService(i) }
                    }

                    InstanceTabs {
                        width: body.width
                        items: root.currentInstances.map(function(inst) {
                            var e = Monitor.entries[inst.name]
                            return { label: inst.name, status: e ? e.status : "loading" }
                        })
                        currentIndex: root.instanceIndex
                        foreground: root.contentForeground
                        onSelected: function(i) { root.selectInstance(i) }
                    }

                    // No instance tab strip (only one instance): still name it.
                    Text {
                        visible: !!root.currentInstance && root.currentInstances.length === 1
                        text: !root.currentInstance ? ""
                            : (root.services.length === 1 ? root.currentService.label + "  ·  " : "") + root.currentInstance.name
                        color: root.contentForeground
                        opacity: 0.7
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        font.bold: true
                    }

                    InstanceView {
                        visible: !!root.currentInstance
                        width: body.width
                        entry: root.currentInstance ? Monitor.entries[root.currentInstance.name] : null
                        adapter: root.currentInstance ? Monitor.adapters[root.currentInstance.type] : null
                        now: Monitor.now
                        contentForeground: root.contentForeground
                        onOpenRequested: {
                            root.close()
                            Monitor.openInstance(root.currentInstance)
                        }
                    }

                    // Quiet way into setup, always at the bottom.
                    Text {
                        visible: Monitor.rawConfig.instances.length > 0 || Monitor.configBroken
                        text: "Manage services…"
                        color: root.contentForeground
                        opacity: manageArea.containsMouse ? 0.9 : 0.4
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        MouseArea {
                            id: manageArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.openSetup({})
                        }
                    }
                }
            }
        }
    }
}
