import QtQuick
import qs.Commons
import "core/Core.js" as Core

// Renders any instance of any service from its entry alone: reachability
// line, summary stats, alerts, groups. No per-service QML exists anywhere.
Column {
    id: root

    property var entry: null
    property var adapter: null
    property double now: Date.now()
    property color contentForeground: Color.foreground

    signal openRequested()

    readonly property var visible_: Core.visibleGroups(snap ? snap.groups : [])

    readonly property var snap: entry ? entry.snapshot : null
    readonly property bool down: !!entry && entry.status === Core.STATUS.ERROR && entry.failCount > 0
    readonly property bool retrying: Core.isRetrying(entry)

    spacing: Style.space(10)

    Text {
        textFormat: Text.PlainText
        visible: !root.snap && !root.down
        text: "Checking…"
        color: root.contentForeground
        opacity: 0.5
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
    }

    Text {
        textFormat: Text.PlainText
        visible: root.down || root.retrying
        width: root.width
        text: root.down
            ? "Unreachable: " + root.entry.error + (root.entry.lastOk ? "  ·  last seen " + Core.fmtAgo(root.entry.lastOk, root.now) : "")
            : "Retrying: " + (root.entry ? root.entry.error : "")
        color: root.down ? Core.color("error") : root.contentForeground
        opacity: root.down ? 1.0 : 0.6
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
    }

    // Last-known-good stays on screen while down, dimmed so it reads as old.
    Column {
        visible: !!root.snap
        width: root.width
        spacing: Style.space(10)
        opacity: root.down ? 0.45 : 1.0

        PanelBox {
            visible: !!root.snap && (root.snap.summary || []).length > 0
            width: parent.width
            contentForeground: root.contentForeground

            Repeater {
                model: root.snap ? (root.snap.summary || []) : []
                delegate: StatRow {
                    required property var modelData
                    width: parent.width
                    stat: modelData
                    contentForeground: root.contentForeground
                }
            }
        }

        PanelBox {
            visible: !!root.snap && (root.snap.alerts || []).length > 0
            title: "Alerts"
            width: parent.width
            contentForeground: root.contentForeground

            Repeater {
                model: root.snap ? (root.snap.alerts || []) : []
                delegate: Row {
                    required property var modelData
                    width: parent.width
                    spacing: Style.space(6)

                    Text {
                        textFormat: Text.PlainText
                        text: "●"
                        color: Core.color(modelData.status)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }
                    Text {
                        textFormat: Text.PlainText
                        text: modelData.text
                        color: root.contentForeground
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.WordWrap
                        width: parent.width - Style.space(20)
                    }
                }
            }
        }

        PanelBox {
            visible: !!root.snap
            title: root.adapter ? root.adapter.groupsTitle || "" : ""
            width: parent.width
            contentForeground: root.contentForeground

            GroupList {
                width: parent.width
                groups: root.visible_.rows
                contentForeground: root.contentForeground
            }

            // Past the row limit: say so, and point at the real UI.
            Text {
                textFormat: Text.PlainText
                visible: root.visible_.hidden > 0
                text: "+" + root.visible_.hidden + " more in " + (root.adapter ? root.adapter.label : "the service")
                color: root.contentForeground
                opacity: hiddenArea.containsMouse ? 0.9 : 0.45
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                MouseArea {
                    id: hiddenArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.openRequested()
                }
            }
        }
    }

    Row {
        visible: !!root.entry
        spacing: Style.space(10)

        Text {
            textFormat: Text.PlainText
            visible: !!root.entry && root.entry.lastOk > 0 && !root.down
            text: "updated " + Core.fmtAgo(root.entry ? root.entry.lastOk : 0, root.now)
            color: root.contentForeground
            opacity: 0.35
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }

        Text {
            textFormat: Text.PlainText
            text: "Open " + (root.adapter ? root.adapter.label : "") + " \u2197"
            color: root.contentForeground
            opacity: openArea.containsMouse ? 0.9 : 0.4
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            MouseArea {
                id: openArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.openRequested()
            }
        }
    }
}
