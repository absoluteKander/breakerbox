import QtQuick
import qs.Commons
import "core/Core.js" as Core

// One row per group: status dot, name, and (only when it holds more than
// one thing) a stack badge with the count on the right. No words, no
// fractions.
//
// Anything not green opens by itself and lists just the members that are
// down (red) or degraded (amber), each with Docker/Proxmox/TrueNAS's own
// reason. Clicking a multi-member group toggles the full list.
Column {
    id: root

    property var groups: []
    property color contentForeground: Color.foreground

    spacing: Style.space(5)

    function problems(group) {
        return (group.members || []).filter(function(m) { return m.status !== Core.STATUS.OK })
    }

    Repeater {
        model: root.groups

        delegate: Column {
            id: groupItem
            required property var modelData

            readonly property var members: modelData.members || []
            readonly property int count: members.length
            readonly property string status: Core.groupStatus(modelData)
            readonly property var problemMembers: root.problems(modelData)
            readonly property bool autoOpen: status === Core.STATUS.ERROR || status === Core.STATUS.WARN
            property bool userExpanded: false

            // What's listed underneath: everything when the user asked,
            // otherwise only what's wrong when it opened by itself.
            readonly property var shown: userExpanded ? members : (autoOpen ? problemMembers.slice(0, Core.MAX_PROBLEMS) : [])
            readonly property int notShown: userExpanded || !autoOpen ? 0 : Math.max(0, problemMembers.length - Core.MAX_PROBLEMS)
            // A one-member group whose member has the group's name (a lone
            // container, a TrueNAS app) just shows the reason, not the name again.
            readonly property bool soloSameName: count === 1 && members[0].name === modelData.name

            width: root.width
            spacing: Style.space(3)

            Item {
                width: parent.width
                height: Math.max(nameText.implicitHeight, badge.height)

                Rectangle {
                    id: dot
                    width: 7
                    height: 7
                    radius: 3.5
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    color: Core.color(groupItem.status)
                }

                Text {
                    id: nameText
                    anchors.left: dot.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: badge.visible ? badge.left : parent.right
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    text: groupItem.modelData.name
                    color: groupItem.status === Core.STATUS.ERROR ? Core.color("error") : root.contentForeground
                    opacity: groupItem.status === Core.STATUS.OK ? 0.85 : 1.0
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                }

                StackBadge {
                    id: badge
                    visible: groupItem.count > 1
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    count: groupItem.count
                    foreground: root.contentForeground
                    opacity: groupItem.status === Core.STATUS.OK ? 0.55 : 0.9
                }

                MouseArea {
                    anchors.fill: parent
                    enabled: groupItem.count > 1
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: groupItem.userExpanded = !groupItem.userExpanded
                }
            }

            // Lone member, something wrong: just the reason, under the name.
            Text {
                visible: groupItem.soloSameName && groupItem.status !== Core.STATUS.OK && !!groupItem.members[0].detail
                leftPadding: Style.space(15)
                text: groupItem.soloSameName ? (groupItem.members[0].detail || "") : ""
                color: root.contentForeground
                opacity: 0.5
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }

            Column {
                visible: !groupItem.soloSameName && groupItem.shown.length > 0
                width: parent.width
                leftPadding: Style.space(15)
                spacing: Style.space(2)

                Repeater {
                    model: groupItem.soloSameName ? [] : groupItem.shown

                    delegate: Item {
                        id: memberRow
                        required property var modelData
                        readonly property bool ok: modelData.status === Core.STATUS.OK
                        width: parent.width - Style.space(15)
                        height: memberName.implicitHeight

                        Rectangle {
                            id: memberDot
                            width: 5
                            height: 5
                            radius: 2.5
                            anchors.left: parent.left
                            anchors.verticalCenter: parent.verticalCenter
                            color: Core.color(memberRow.modelData.status)
                        }

                        Text {
                            id: memberName
                            anchors.left: memberDot.right
                            anchors.leftMargin: Style.space(7)
                            text: memberRow.modelData.name
                            color: root.contentForeground
                            opacity: memberRow.ok ? 0.65 : 1.0
                            font.family: Style.font.family
                            font.pixelSize: Style.font.caption
                        }

                        // Only say why when something's wrong.
                        Text {
                            visible: !memberRow.ok && !!memberRow.modelData.detail
                            anchors.left: memberName.right
                            anchors.leftMargin: Style.space(8)
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            text: memberRow.modelData.detail || ""
                            color: root.contentForeground
                            opacity: 0.45
                            font.family: Style.font.family
                            font.pixelSize: Style.font.caption
                            elide: Text.ElideRight
                        }
                    }
                }

                Text {
                    visible: groupItem.notShown > 0
                    text: "+" + groupItem.notShown + " more"
                    color: root.contentForeground
                    opacity: 0.45
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                }
            }
        }
    }

    Text {
        visible: root.groups.length === 0
        width: parent.width
        text: "Nothing to show"
        color: root.contentForeground
        opacity: 0.4
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
    }

    // Two offset outlined squares (a "stack") and the count. Drawn rather
    // than taken from an icon font so it looks the same in every theme.
    component StackBadge: Row {
        id: badgeRoot
        property int count: 0
        property color foreground: Color.foreground
        spacing: Style.space(4)
        height: Math.max(glyph.height, countText.implicitHeight)

        Item {
            id: glyph
            width: 10
            height: 10
            anchors.verticalCenter: parent.verticalCenter

            Rectangle {
                x: 3; y: 0
                width: 7; height: 7
                radius: 1.5
                color: "transparent"
                border.width: 1
                border.color: badgeRoot.foreground
                opacity: 0.6
            }
            Rectangle {
                x: 0; y: 3
                width: 7; height: 7
                radius: 1.5
                color: Color.popups.background
                border.width: 1
                border.color: badgeRoot.foreground
            }
        }

        Text {
            id: countText
            anchors.verticalCenter: parent.verticalCenter
            text: badgeRoot.count
            color: badgeRoot.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }
    }
}
