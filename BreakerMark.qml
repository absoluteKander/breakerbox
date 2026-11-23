import QtQuick

// The Breaker Box mark: four solid breaker switches, the third one flipped
// up. Drawn on an 11×11 unit grid (2-unit switches, 1-unit gaps, 7 tall,
// the tripped one raised by 2), so at any size that's a multiple of 11 every
// edge lands on a whole pixel.
Item {
    id: root
    property real size: 11
    property color color: "white"
    readonly property real u: size / 11

    width: size
    height: size

    Repeater {
        model: 4
        Rectangle {
            required property int index
            x: index * 3 * root.u
            y: (index === 2 ? 1 : 3) * root.u
            width: 2 * root.u
            height: 7 * root.u
            color: root.color
        }
    }
}
