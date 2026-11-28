# PenMods 仓库文档结构与梳理范围

基线：`Lyrecoul/PenMods` 提交 `cb8e352`（2026-11-26）。链接均为该提交的永久链接；上游变更后以仓库源码为准。

设备事实（AGENTS.md 开篇）：网易有道词典笔 YDP02X 为主，ARM64 Linux（rk3326）、Qt 5.15.2、glibc 2.27；
PenMods 以 `libPenMods.so` 注入闭源 `YoudaoDictPen`，Hook 引擎为 Dobby。许可：GPL-3.0（引用/派生源码需遵守）。

## 1. 文档清单与相关度

### 1.1 直接相关（插件开发的事实来源）

| 编号 | 文档 | 内容 | 链接 |
|---|---|---|---|
| D1 | `doc/PLUGIN_DEV_GUIDE.md` | 插件开发主指南：目录、`metadata.json`、导出符号、生命周期、Hook API、QML 集成、媒体会话、崩溃自愈、构建、安装调试、QML 侧管理 API | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/PLUGIN_DEV_GUIDE.md |
| D2 | `doc/PLUGIN_HOOK_DEV_GUIDE.md` | 插件 Hook 专用指南：`PluginHookAPI`、便利宏、常见符号表、最佳实践、故障排除 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/PLUGIN_HOOK_DEV_GUIDE.md |
| D3 | `AGENTS.md` § Plugin System（L395-L422） | 运行阶段（`BeforeMain`）、根上下文共享、媒体会话属主语义、C ABI 状态的静态初始化陷阱 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L395-L422 |
| D3 | `AGENTS.md` § Deploying a new `libPenMods.so` / plugin `.so`（L558-L575） | 不可原地覆盖已加载的 `.so`（tmp + rename） | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L558-L575 |
| D3 | `AGENTS.md` § Recovering from a crash loop（L577-L601） | `.loading` 标记保留到四个入口全部返回；崩溃循环 → recovery 的恢复步骤 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L577-L601 |
| D3 | `AGENTS.md` § Deployment Paths（L603-L613） | 设备端路径表（插件目录、日志、配置） | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L603-L613 |
| D3 | `AGENTS.md` § On-Device UI Verification（L818-L930） | 日志、截图、触摸注入、重启纪律（L917 起） | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L818-L930 |
| D3 | `AGENTS.md` § QML Integration / Host Objects（L294-L304、L359-L362） | 320×170、已注册 context property、宿主对象表 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L294-L304 |
| D3 | `AGENTS.md` § Hooking（L75-L83） | `SymDB` 解析 `.symtab`；`binary/YoudaoDictPen` 与设备二进制一致 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L75-L83 |
| D4 | `README.md` § 开发与维护 / 文档 | 工具链要求、`--cross=aarch64-linux-gnu.2.27`、本地验证与部署 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/README.md |
| D5 | `doc/SCREENSHOT_CHANNEL.md` | `touch /tmp/penmods_shot` 截图通道与失败对照 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/SCREENSHOT_CHANNEL.md |
| D6 | `tools/touch-injector/README.md` | uinput 触摸注入工具（点击/滑动/输入） | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/tools/touch-injector/README.md |
| S1 | `src/plugin/PluginSDK.h` | **公开 C ABI 的唯一定义**：`PluginHookAPI`、`PluginMediaAPI`、`PluginMediaCallbacks`、`PLUGIN_SYM` / `PLUGIN_HOOK` | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/plugin/PluginSDK.h |
| S2 | `src/plugin/PluginManager.cpp`（+.h） | 加载器实现：`scanAndLoadAll`、`parseMetadata`、`loadSo`、`unloadSo`、`togglePlugin`、`uninstallPlugin`、Hook/Media API 注入 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/plugin/PluginManager.cpp |
| S3 | `src/plugin/QmlPluginWrapper.cpp`（+.h） | QML 侧 `pluginManager` 接口与返回字段 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/plugin/QmlPluginWrapper.cpp |
| S4 | `src/media/MediaSession.cpp`（+.h） | `mediaSession` QML API 与 C ABI 实现（接管、令牌、UI 线程 marshal） | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/media/MediaSession.cpp |
| S5 | `src/mod/Engine.cpp`、`src/mod/Mod.cpp` | 根上下文注册点；外部 QML 导入路径 `/userdata/PenMods/qml` | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/mod/Engine.cpp |
| S6 | `src/locker/Locker.cpp`、`src/mod/Config.cpp` | 插件管理页的密码锁场景 `plugin_manager` | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/locker/Locker.cpp |
| Q1 | `resource/models/YDP02X/qrc_qml.h` 内嵌的 QML 源码 | 插件页的真实装载契约：`qml/PluginManager.qml`、`qml/YIndexPage.qml`（首页插件抽屉）、`qml/commons/YDynamicPageStack.qml`、`qml/commons/YPage.qml`、`qml/commons/YImage.qml`、`qml/doc/plugin-and-dynamic-loading.md` | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/resource/models/YDP02X/qrc_qml.h |

> Q1 说明：QML 源码树不入库，只提交生成的 `qrc_qml.h`。执行 `scripts/unpack_qt_res.sh YDP02X`（内部 `scripts/unpack_qrc.py`）还原到 `resource/models/YDP02X/qml/`，或 `--platform YDP02X -o <dir>` 还原到指定目录。

### 1.2 间接相关（提供模式与背景）

| 文档 | 可借用内容 | 链接 |
|---|---|---|
| `doc/FFMPEG_PLAYER_ANALYSIS.md` §4 | "方案 B：做成 PenMods 插件包"——`metadata.json` + 原生 `.so` + `qml/FFmpegPlayer/{qmldir,so}` 的组织方式，插件页用相对目录 `import "FFmpegPlayer"`；并指出其局限"只能在自己的插件页面里用" | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/FFMPEG_PLAYER_ANALYSIS.md |
| `external/ffmpeg-player/README.md` | 一个真实的 QML 扩展插件（`qmldir` + `.so`）如何用 Zig + ARM64 Qt 5.15 交叉编译；`external/dictpen/` 存放设备提供的动态库（仅用于链接） | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/external/ffmpeg-player/README.md |
| `doc/REVERSE_ENGINEERING.md` | 架构与启动顺序（`SymDB` 先于各模块初始化，`PluginManager` 在 `BeforeMain` 内构造）；Hook 相关细节属于核心仓库内部宏 `PEN_HOOK*` | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/REVERSE_ENGINEERING.md |
| `doc/UPDATE_SYSTEM.md` | 组件化更新中心；仓库未定义插件专用安装包格式，插件按目录分发 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/UPDATE_SYSTEM.md |
| `.agents/skills/penmods-device-workflow/SKILL.md` | **核心仓库**的改动/构建/部署流程（xmake）；其中设备验证纪律可迁移到插件开发 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/.agents/skills/penmods-device-workflow/SKILL.md |
| `doc/RECOVERY_2.7.3.md` | PenMods 核心启动故障恢复；与插件开发无直接关系，仅作设备救砖背景 | https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/RECOVERY_2.7.3.md |

### 1.3 不涉及插件开发（已遍历，排除）

`doc/CUSTOM_DICT_GUIDE.md`（自定义词典）、`doc/DICT_FORMAT_ANALYSIS.md`（离线词典格式）、
`doc/YSOUNDCENTER_ANALYSIS.md`（`YSoundCenter` 逆向）、`doc/CAMERA_CAPTURE_ANALYSIS.md`（摄像头逆向）、
`doc/PPOCR_BACKEND_ANALYSIS.md`（PP-OCR 后端）、`doc/LYRICS_DISPLAY_PLAN.md`（歌词显示方案）、
`doc/FFMPEG_PLAYER_FILTER_PERFORMANCE.md`（播放器滤镜性能）、`doc/BLUETOOTH_PERSISTENCE.md`（蓝牙持久化）、
`doc/AI_SHELL_MODES.md`（AI 助手 Shell 模式）、`doc/SESSION_STORAGE_AND_PALETTE.md`（会话存储与配色）、
`tests/rime/README.md`、`tools/` 下除 `touch-injector` 外的 README、`mathjax-server/`、`penmods-installer/`（子模块）。

## 2. 梳理口径

1. **以源码为准**：文档与源码冲突时采信 `src/plugin/`、`src/media/` 的实现，并在第 3 节列出差异。
2. **文档只覆盖"意图"，源码补全"契约"**：D1 把插件页描述成 `Loader { source: mainQmlUrl }`，真实装载走
   `YDynamicPageStack`（见 `qml-ui.md`）；D1 未写首页插件抽屉入口，源码里有。
3. **标注推断**：凡由阅读源码得出、仓库文档未明说、本次也未真机验证的结论，统一标 `【源码推断】`。

## 3. 文档与源码的差异（已核对）

| # | 文档说法 | 源码事实（以源码为准） | 依据 |
|---|---|---|---|
| 1 | D1"崩溃自愈"：只有 `init_plugin` 中的崩溃会触发自动禁用；`init_plugin` 返回后崩溃不在覆盖范围 | `.loading` 在 `init_plugin`、`attach_engine`、`init_plugin_with_hook_api`、`init_plugin_with_media_api` **全部返回后**才删除；任一入口内崩溃都会自愈。入口之外的崩溃（detour、线程、QML）不覆盖 | S2 `loadSo` L239；D3 L598-L601 |
| 2 | D2 快速开始注释：`init_plugin` "可选"，`init_plugin_with_hook_api` "必须导出" | `init_plugin` 是**唯一必须符号**；`init_plugin_with_hook_api` 可选。缺 `init_plugin` 则卸载并自动禁用 | S2 L207-L217；D1 §导出符号 |
| 3 | D1 生命周期图：`attach_engine` 在 hook API 之前，且未画媒体 API | 实际顺序：`init_plugin` →（引擎已就绪时）`attach_engine` → `init_plugin_with_hook_api` → `init_plugin_with_media_api` → 删 `.loading`。引擎未就绪时 `attach_engine` 推迟到 `beforeUiInitialization`，可能在两个 init API **之后** | S2 L204-L241 |
| 4 | D1 FAQ：可用 `PEN_HOOK_ADDR` 宏硬编码地址 | `PEN_HOOK_ADDR` 是核心仓库内部宏（`src/base/Hook.h`），**不在 `PluginSDK.h`**。插件只能用 `PLUGIN_SYM` / `PLUGIN_HOOK`，或直接调 `hook_api->hookFunction(addr, ...)` 传裸地址 | S1；`src/base/Hook.h` L20 |
| 5 | D1 FAQ：用 `adb logcat` 或 `/userdata/PenMods/penmod.log` 看崩溃 | 设备**没有 logcat**；stdout 写 `/userdata/applog/DictPen_*.log`（只留最新一份） | D3 L820 |
| 6 | D1 / D3 / D2：`nm binary/YoudaoDictPen`、IDA 库 `binary/YoudaoDictPen.i64` | 二者**都不在仓库里**（`binary/` 只有 xmake 包）。需自行从设备 `/oem/YoudaoDictPen/output/YoudaoDictPen` 拉取 | 仓库 `git ls-files binary` |
| 7 | D3 引用 `doc/HOOK_SYSTEM_ANALYSIS.md` | 该文件不存在于本提交 | `doc/` 清单 |
| 8 | D1：`icon` 为"相对于插件目录的图标路径" | 宿主把 `icon` 原样交给 `YImage.imageName`；不以 `qrc:/` 或 `file:/` 开头的值会被拼成 `image://icons/<值>.png`。相对路径 `icon.png` 大概率显示不出来。`【源码推断】` | Q1 `PluginManager.qml`、`commons/YImage.qml` |
| 9 | D1：`main_qml` 可选 | 不填 `main_qml` 时 `mainQmlUrl` 指向**目录本身**，"打开"必然失败。纯 `.so` 插件不要给用户提供"打开"按钮语义，或同样提供 QML 页 | S2 L168；S3 L34 |
| 10 | D1：`Loader { source: mainQmlUrl }` | 宿主实际用 `YDynamicPageStack.createPage`：注入 `pluginName`、连接 `backButtonClicked` 销毁、Home 键释放销毁、同 URL 重开先关旧实例 | Q1 `PluginManager.qml`、`YIndexPage.qml`、`YDynamicPageStack.qml` |
| 11 | S3 头文件声明信号 `pluginStateChanged` | 从未发射；监听 `pluginListUpdated` 即可 | S2/S3 全文 |

## 4. 仓库未提供、需要自行准备的东西

- 设备主程序二进制 `YoudaoDictPen`（查符号、对地址）；IDA/Ghidra 工程。
- ARM64 Qt 5.15.2 sysroot（`aarch64-linux-qt-5.15.2`）与 Zig、ADB（均不在本机 PATH 时需用户自备）。
- 真机或模拟器（QEMU：核心仓库 `--qemu=y` + `scripts/install.sh`）。
- 插件安装包格式、签名、版本兼容矩阵：仓库均未定义。
