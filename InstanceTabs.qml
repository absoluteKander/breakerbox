import QtQuick
import qs.Commons
import "core/Core.js" as Core

// Tab strip used at both levels (services, then instances). Purely
// presentational: takes [{ label, status }] and emits selected(index). Hidden
// when there's only one tab, since one tab isn't a choice. Wraps to a second
// line rather than ever clipping a tab.
Flow {
    id: root

    property var items: []
    property int currentIndex: 0
    property color foreground: Color.foreground

    signal selected(int index)

    spacing: Style.space(4)
    visible: items.length > 1

    Repeater {
        model: root.items

        delegate: Rectangle {
            id: tab
            required property var modelData
            required property int index
            readonly property bool active: index === root.currentIndex

            width: rowContent.implicitWidth + Style.space(12)
            height: Style.space(22)
            radius: Style.space(4)
            color: active ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08) : "transparent"
            border.width: active ? 1 : 0
            border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)

            Row {
                id: rowContent
                anchors.centerIn: parent
                spacing: Style.space(5)

                Rectangle {
                    width: 6
                    height: 6
                    radius: 3
                    anchors.verticalCenter: parent.verticalCenter
                    color: Core.color(tab.modelData.status)
                }

                Text {
                    text: tab.modelData.label
                    color: root.foreground
                    opacity: tab.active ? 1.0 : 0.6
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                    font.bold: tab.active
                }
            }

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.selected(tab.index)
            }
        }
    }
}
