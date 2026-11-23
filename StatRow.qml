import QtQuick
import qs.Commons
import "core/Core.js" as Core

// One summary stat: label + value, and a thin bar when the stat has a ratio.
Column {
    id: root
    property var stat: ({})
    property color contentForeground: Color.foreground

    readonly property bool hasBar: stat.ratio !== undefined && stat.ratio !== null

    spacing: Style.space(2)

    Row {
        width: root.width
        spacing: Style.space(8)

        Text {
            text: root.stat.label || ""
            color: root.contentForeground
            opacity: 0.6
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            width: Math.min(implicitWidth, root.width * 0.45)
            elide: Text.ElideRight
        }

        Text {
            text: root.stat.value || ""
            color: root.contentForeground
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }
    }

    Rectangle {
        visible: root.hasBar
        width: root.width
        height: 3
        radius: 1
        color: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.15)

        Rectangle {
            width: parent.width * Math.max(0, Math.min(root.stat.ratio || 0, 1))
            height: parent.height
            radius: parent.radius
            color: Core.color(root.stat.tone || "ok")
            Behavior on width { NumberAnimation { duration: 400; easing.type: Easing.OutCubic } }
        }
    }
}
