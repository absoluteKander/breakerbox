import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "core/Core.js" as Core

// Bar icon with one status dot. Left click opens the panel, right click
// refreshes everything now. All state comes from the Monitor singleton.
BarWidget {
    id: root
    moduleName: "io.github.absolutekander.breakerbox"

    readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
    function open() { if (panelLoader.item) panelLoader.item.open() }
    function close() { if (panelLoader.item) panelLoader.item.close() }
    function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
    function refresh() { Monitor.refresh() }

    // The setup dialog is this plugin's overlay entry point; the shell
    // facade on `bar` is scoped to our own id, so this can only open ours.
    function openSetup(payload) {
        if (root.bar && root.bar.shell && typeof root.bar.shell.summon === "function")
            root.bar.shell.summon(root.moduleName, JSON.stringify(payload || {}))
    }

    readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
    function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

    function injectPanel() {
        var target = panelLoader.item
        if (!target) return
        if ("bar" in target) target.bar = root.bar
        if ("settings" in target) target.settings = root.settings
        if ("anchorItem" in target) target.anchorItem = button
        if ("hostWidget" in target) target.hostWidget = root
    }

    implicitWidth: button.implicitWidth
    implicitHeight: button.implicitHeight

    onBarChanged: injectPanel()
    onSettingsChanged: injectPanel()

    Loader {
        id: panelLoader
        active: true
        source: Qt.resolvedUrl("Panel.qml")
        visible: false
        onLoaded: {
            root.injectPanel()
            Qt.callLater(root.injectPanel)
        }
    }

    ShellIpc {
        target: "io.github.absolutekander.breakerbox"
        function refresh(): void { Monitor.refresh() }
        function setup(): void { root.openSetup({}) }
        // One line, same as the tooltip — handy for scripts and notifications.
        function status(): string { return Monitor.overall + "\t" + Monitor.summary }
        function open(): void { root.open() }
        function close(): void { root.close() }
        function toggle(): void { root.toggle() }
    }

    Component {
        id: iconWithDot

        // Drawn on an exact 12×12 pixel grid (the bar's icon size), so the
        // bar's fit-to-size scaling is 1:1 and every switch gets the same
        // pixels: four 2px switches, the third flipped up — the Breaker Box
        // mark — with the status dot in the bottom-right corner.
        Item {
            width: 12
            height: 12

            BreakerMark {
                size: 11
                color: button.foreground
            }

            Rectangle {
                x: 7
                y: 7
                width: 5
                height: 5
                radius: 2.5
                color: Core.color(Monitor.overall)
                border.color: "#00000080"
                border.width: 1
            }
        }
    }

    BarIconButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        iconComponent: iconWithDot
        tooltipText: Monitor.summary
        onPressed: function(b) {
            if (b === Qt.RightButton) Monitor.refresh()
            else if (b === Qt.LeftButton) root.toggle()
        }
    }
}
