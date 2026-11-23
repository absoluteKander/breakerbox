import QtQuick
import qs.Commons

// A titled, bordered box. Children land in the inner column.
Rectangle {
    id: root

    property string title: ""
    property color contentForeground: Color.foreground
    default property alias content: body.data

    width: parent ? parent.width : 0
    height: inner.implicitHeight + Style.space(20)
    radius: Style.space(6)
    color: "transparent"
    border.width: 1
    border.color: Qt.rgba(contentForeground.r, contentForeground.g, contentForeground.b, 0.15)

    Column {
        id: inner
        anchors.fill: parent
        anchors.margins: Style.space(10)
        spacing: Style.space(8)

        Text {
            visible: root.title.length > 0
            text: root.title
            color: root.contentForeground
            opacity: 0.7
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            font.capitalization: Font.AllUppercase
        }

        Column {
            id: body
            width: parent.width
            spacing: Style.space(6)
        }
    }
}
