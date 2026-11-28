import QtQuick 2.12

// PenMods 插件页（__PLUGIN_NAME__）
//
// 宿主用 YDynamicPageStack.createPage(mainQmlUrl, ..., { pluginName: name }) 装载本文件：
//   - 创建时注入属性 pluginName（插件显示名，来自 metadata.json 的 name）
//   - 根对象若有 backButtonClicked 信号，发射后页面被 destroy()
//   - 按 Home 键释放、跳到其它页面、同一插件被再次打开时，页面都会被 destroy()
// 结论：页面是"用完即毁"的，需要跨页面存活的状态放到 C++ 单例或独立对象里。
// 布局：Qt 逻辑分辨率 320×170 横屏；可点区域不小于 40×40。

Item {
    id: page

    // 宿主把页面放进一个铺满 320×170 的容器；用 anchors 适配，同时保留固定尺寸
    // 以便脱离宿主用 qmlscene 单独预览。
    anchors.centerIn: parent
    width: 320
    height: 170

    // 宿主注入的插件显示名（不声明也会成为动态属性，声明后才有类型检查）
    property string pluginName: ""

    Rectangle {
        anchors.fill: parent
        color: "#f7f7f7"
    }

    Column {
        anchors.centerIn: parent
        spacing: 10

        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: page.pluginName !== "" ? page.pluginName : "__PLUGIN_NAME__"
            font.pixelSize: 18
            color: "#222222"
        }

        Rectangle {
            width: 132
            height: 44
            radius: 8
            color: tap.pressed ? "#dcdcdc" : "#ffffff"
            border.color: "#c8c8c8"

            Text {
                anchors.centerIn: parent
                text: qsTr("点我")
                font.pixelSize: 16
                color: "#333333"
            }

            MouseArea {
                id: tap
                anchors.fill: parent
                onClicked: console.log("[__PLUGIN_ID__] tapped")
            }
        }
    }
}
