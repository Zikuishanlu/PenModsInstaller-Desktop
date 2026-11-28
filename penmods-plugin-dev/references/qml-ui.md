# 插件 QML 页面

来源：D1 §QML 集成、D3 §QML Integration / On-Device UI Verification、Q1 宿主 QML 源码
（`qml/PluginManager.qml`、`qml/YIndexPage.qml`、`qml/commons/YDynamicPageStack.qml`、`YPage.qml`、
`YBackButtonPage.qml`、`YImage.qml`、`qml/doc/plugin-and-dynamic-loading.md`）、S5 上下文注册点。
Q1 源码不入库，需 `scripts/unpack_qt_res.sh YDP02X` 还原。

## 1. 屏幕与输入

- 物理面板 170×320 竖屏，Weston `transform=270`，**Qt 逻辑分辨率 320×170 横屏**。
- 触控是笔尖式，点击会抖：可点区域不小于约 40×40，控件间距留足。
- 左右手模式是宿主给主窗口套 180° 旋转实现的，插件页在同一窗口内**自动跟随**，不要自己旋转。
- 低端 ARM + GL：动画短、避免大面积模糊/阴影/嵌套 `ShaderEffect`。
- 列表滑动时点击会被 `Flickable` 吞掉（D3 实测）：`preventStealing` 只在按下时读取，滑行中按下无法恢复。

## 2. 页面是怎么被装载的（Q1，文档未写全）

入口有两个，都只列出 `enabled && loaded` 的插件：

1. **首页插件抽屉**（`YIndexPage` 底部抽屉，横向图标列表）→ 点击图标。
2. **插件管理页**卡片上的"打开"按钮。

两者都调用 `YDynamicPageStack.createPage(mainQmlUrl, mainQmlUrl, options, { pluginName: name })`，
宿主对插件页根对象的契约如下：

| 契约 | 说明 |
|---|---|
| 注入属性 | 创建时设置 `pluginName`（= `metadata.json` 的 `name`）。声明 `property string pluginName` 可获得类型检查 |
| 父项 | 宿主页面内一个铺满 320×170 的容器（`anchors.fill: parent`，`z: 500`）。根对象应 `anchors.centerIn: parent` 或 `anchors.fill: parent`，并保留 320×170 的固定尺寸以便脱离宿主预览 |
| 显示 | 根对象有 `show()` 则调用；否则 `visible = true`。不要把根对象设成 `visible: false` |
| 关闭 | 根对象若有 `backButtonClicked` 信号，宿主连接到销毁逻辑：**发射 `backButtonClicked()` 即关闭页面**（`YPage` / `YBackButtonPage` 自带该信号与标题栏） |
| 销毁时机 | 返回键；Home 键释放（`closeOnHomeRelease`）；从插件管理页打开后切换到其它页面；宿主页面销毁；防作弊模式 `antiEmbs` 激活。销毁调用 `destroy(1)` |
| 去重 | `popStackId` = `mainQmlUrl`：同一插件再次打开时先关闭旧实例 |
| 同步创建 | `Qt.createComponent(url)` 同步编译；组件出错时 `console.error("... component error:" ...)` 进日志 |
| 事件屏障 | 容器里有一个 `z: -1` 的 `MouseArea` 吸收未被插件覆盖区域的点击，不会穿透到下层页面 |

**结论：页面是用完即毁的。** 需要跨页面存活的状态（播放列表、`Connections { target: mediaSession }`、定时器）
放到 C++ 单例或独立的长寿命对象里，不要挂在页面根对象上。

D1 里的 `Loader { source: pluginManager.getPluginInfo(index).mainQmlUrl }` 是给"插件页内再嵌套加载"用的写法，
宿主装载插件页本身并不走它。

## 3. 可用的 context property

插件 QML 与应用**共用根上下文**，全部 context property 直接可见，不需要 import。

PenMods 注册的（S5，按模块分组；均为内部 API，无稳定性承诺）：

| 类别 | 名称 |
|---|---|
| 插件/媒体 | `pluginManager`、`mediaSession` |
| 宿主增强 | `mod`、`builtinEvents`、`res`、`queryTweaks`、`aiTranslation`、`workBookTweaks`、`columnDb`、`readingLoop`、`customDict`、`keyBoard`、`rime`、`ocrBackend`、`asrService` |
| 文件与媒体 | `fileManager`、`musicPlayer`、`videoPlayer`、`textReader`、`imageViewer`、`externalPlayer`、`audioRecorder` |
| 系统 | `batteryInfo`、`screenManager`、`volumeGuard`、`torch`、`wallpaperManager`、`bluetoothBattery`、`touchCalibration`、`vpuUnlock`、`cameraCapture` |
| 工具 | `shell`、`tts`、`hitokoto`、`serviceManager`、`networkSettings`、`developerSettings` |
| 安全与策略 | `locker`、`antiEmbs`、`loggerMonitor`、`contributors` |
| 更新 | `updateCenter`、`updater` |

宿主二进制（`YoudaoDictPen`）提供的对象（D3 §Host Objects + Q1）：

| QML 名 | 类 | 常用成员 |
|---|---|---|
| `settingManager` | `YSettingManager` | `isRightHandMode`、`lcdBrightness`、`updateVolumeAndLcd()` |
| `mediaPlayerManager` | `YMediaPlayerManager` | `title`、`playState`、`progress`、`currentPos`、`duration`、`hasLrc`、`onClickedPlay/Pause/Prev/Next()` |
| `qmlGlobal` | 全局 QML 单例 | `showToast()`、`requestShowPage()`、`currentPageIndex`、`checkFeature()` |
| `systemBase` | 系统基类 | 信号 `homeKeyRelease`、`homeKeyLongPress` |
| `YEnum` | 宿主枚举 | `PLAYING`、`STOPPED`、`PM_AudioPlayer`、`Screen.Width/Height`、`PageIndex` |

可用前用 `typeof name !== "undefined"` 守卫——以上对象随 PenMods 版本与配置增减。

已注册的 QML 类型：

```qml
import com.github.penuniverse 1.0   // MediaSession.Playing / PageIndex（不可创建的枚举类型）；LyricClock、LyricLineItem
import Mod.FileManager 1.0         // WebPAnimatedImage
import com.youdao.input 1.0         // RimeWrapper
```

## 4. 用有道原生组件（`【源码推断】`，需真机确认）

D1/D3 要求"优先用 Youdao 原生 QML 组件而非 Qt Quick Controls"。宿主自己是用**目录 import** 引入它们的
（`main.qml`: `import "./qml/commons"`），它们不在 `com.youdao.pen` 模块里（该模块只注册 C++ 类型）。
对 `file://` 加载的插件页，理论上可以：

```qml
import "qrc:/qml/commons"     // YButton、YText、YSwitch、YSlider、YTwoButtonDialog、YColors(singleton)…
import "qrc:/qml/utils"       // YUtils(singleton)
```

组件清单以还原后的 `qml/commons/` 目录为准。确认可用后再依赖；不可用时退回 `QtQuick` 基础类型。

**不要用 `QtQuick.Controls`**：主题不匹配、默认尺寸在 320×170 下放不下。

## 5. 页面内引用外部代码

- 相对目录 / 文件 import：`import "sub"`、`import "util.js" as U`——相对插件目录，随插件目录一起部署。
- QML 扩展插件（`.so` + `qmldir`）可放在插件目录内，由页面相对 import（`doc/FFMPEG_PLAYER_ANALYSIS.md` §4 方案 B，
  `external/ffmpeg-player` 即此形态）。局限：只能在自己的插件页里用，替换不了宿主内置页面。
- 宿主额外加了导入路径 `/userdata/PenMods/qml`（目录存在时才加，S5 `Engine.cpp` L31-L35）。

## 6. 骨架（即 `assets/plugin-template/qml/Main.qml`）

```qml
import QtQuick 2.12

Item {
    id: page
    anchors.centerIn: parent
    width: 320
    height: 170
    property string pluginName: ""          // 宿主注入

    Rectangle { anchors.fill: parent; color: "#f7f7f7" }

    Text {
        anchors.centerIn: parent
        text: page.pluginName !== "" ? page.pluginName : "My Plugin"
        font.pixelSize: 18
        color: "#222222"
    }

    MouseArea {                               // ≥ 40×40
        x: 270; y: 10; width: 44; height: 44
        onClicked: console.log("[myplugin] tapped")
    }
}
```

需要"返回"按钮时，把根对象换成 `YPage` / `YBackButtonPage`（若 qrc 目录 import 可用），点击标题栏会发射
`backButtonClicked()`，宿主随即销毁页面。纯 `Item` 根对象可自行声明 `signal backButtonClicked()`，在自定义按钮里发射。

## 7. 自检清单

- [ ] 根对象自包含：无 `Window`、无 `visible: false`、320×170
- [ ] 可点区域 ≥ 40×40
- [ ] 没有 `QtQuick.Controls`
- [ ] 长寿命对象（会话、`Connections`、`Timer`）不在页面根上
- [ ] 日志无 `ReferenceError` / `TypeError` / `Unable to assign` / `Cannot read` / `is not a function`
- [ ] 截图确认排版（`adb shell touch /tmp/penmods_shot`）；返回后再次打开正常
- [ ] 左右手模式下方向正确（应自动跟随）
