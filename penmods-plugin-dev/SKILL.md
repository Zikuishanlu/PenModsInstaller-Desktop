---
name: penmods-plugin-dev
description: 开发、构建、部署与调试网易有道词典笔 PenMods（YDP02X）插件时使用——涵盖目录式插件包与 metadata.json、纯 QML 插件页、原生 .so 的 C ABI（init_plugin / attach_engine / init_plugin_with_hook_api / init_plugin_with_media_api / destroy_plugin）、PluginHookAPI 函数 Hook、mediaSession 媒体会话、320×170 页面约束、aarch64 glibc 2.27 交叉编译与 adb 真机验证。当任务涉及 PenMods 插件、/userdisk/PenMods/plugins、PluginSDK.h，或需要为词典笔写插件/扩展时使用。
agent_created: true
---

# PenMods 插件开发

依据 `Lyrecoul/PenMods` 提交 `cb8e352`（2026-11-26）的全部文档，以及 `src/plugin`、`src/media` 源码与内嵌 QML 整理。
目标设备：网易有道词典笔 YDP02X（ARM64 Linux、Qt 5.15.2、glibc 2.27、逻辑分辨率 320×170）。文档与源码冲突时以源码为准。

## 一、文档结构与梳理范围

仓库共 33 份 Markdown 文档，按与插件开发的关系分三类（完整清单、永久链接、逐条差异见 `references/repo-docs-map.md`）：

| 类别 | 内容 | 用法 |
|---|---|---|
| 直接相关 | `doc/PLUGIN_DEV_GUIDE.md`（主指南）、`doc/PLUGIN_HOOK_DEV_GUIDE.md`（Hook）、`AGENTS.md` 的 Plugin System / 部署 / 恢复 / 设备验证章节、`README.md` 构建章节、`doc/SCREENSHOT_CHANNEL.md`、`tools/touch-injector/README.md` | 事实来源 |
| 契约定义（源码） | `src/plugin/PluginSDK.h`（公开 C ABI）、`PluginManager.cpp`（加载器）、`QmlPluginWrapper.cpp`（QML 管理接口）、`src/media/MediaSession.cpp`、`resource/models/YDP02X/qrc_qml.h` 内嵌的 `PluginManager.qml` / `YIndexPage.qml` / `YDynamicPageStack.qml` | 文档没写或写错的以这里为准 |
| 间接 / 无关 | `doc/FFMPEG_PLAYER_ANALYSIS.md` §4（插件包组织示例）、`external/ffmpeg-player`（QML 扩展插件编译范例）、`doc/REVERSE_ENGINEERING.md`（启动顺序）；其余为词典、OCR、摄像头、蓝牙、更新中心等模块文档 | 仅作背景 |

文档未覆盖、由源码补全的要点：插件页的真实装载契约（`YDynamicPageStack`，不是 `Loader`）、首页插件抽屉入口、
`.loading` 的真实保留范围、`icon` 的解析方式、SymDB 的符号过滤。凡源码推断且未真机验证的结论统一标 `【源码推断】`。

## 二、核心概念

- **插件 = 目录**：`/userdisk/PenMods/plugins/<id>/`（`/userdisk`，不是 `/userdata`）= 一个 `metadata.json`（必须）+ 可选 QML 页 + 可选 ARM64 `.so` + 可选图标。`id` 是唯一键，全局唯一、不随版本变。
- **PluginManager**：宿主 `BeforeMain` 阶段扫描一级子目录并饿加载所有启用的 `.so`；管理启用/禁用/卸载与崩溃自愈。
- **C ABI 入口**：`.so` 用 `extern "C"` 导出约定函数，由 `QLibrary::resolve` 查找；`init_plugin` 是唯一必须符号。
- **根上下文共享**：插件 QML 与应用共用 QQmlEngine 根上下文，宿主所有 context property（`mediaSession`、`pluginManager`、`shell`、`mod`…）直接可用。
- **PluginHookAPI**：`querySymbol`（查主程序 `.symtab`）+ `hookFunction`（Dobby inline hook）；装上不可卸载。
- **mediaSession**：插件自行播放音频时接管下拉面板音乐卡片；同一时刻只有一个属主。
- **页面用完即毁**：插件页由宿主 `YDynamicPageStack` 装载，返回 / Home 键 / 切页时整页 `destroy()`。
- **崩溃自愈**：`.loading` 标记覆盖四个 init 入口；期间崩溃 → 下次启动自动禁用该插件。入口之外的崩溃不自愈，连续崩溃会进 recovery。

## 三、关键步骤

1. **定型态**（代价从低到高）：
   - 只要界面或调用现成对象 → **纯 QML**（无 `.so`，免编译，`loaded` 恒 true）
   - 需要 C++ 对象 / 文件 / 网络 / 后台任务 → **QML + SO**
   - 需要 Hook 宿主函数 → **SO + `init_plugin_with_hook_api`**（最后手段：绑定固件、不可撤销、崩溃连带主进程）

   默认先用纯 QML 插件打通"目录 → metadata → 打开页面 → 重启生效"链路，再叠加 `.so`。
2. **生成脚手架**：
   ```sh
   python scripts/new_plugin.py com.example.myplugin "My Plugin" --out ./plugins [--with-so]
   ```
   模板在 `assets/plugin-template/`（`metadata.json`、`Main.qml`、`plugin.cpp`、`build.sh`、与仓库一致的 `sdk/PluginSDK.h`）。
3. **写实现**：QML 页遵守 `references/qml-ui.md`（320×170、根对象自包含、可点区 ≥ 40×40、长寿命状态不挂页面）；
   C++ 只导出 `extern "C"` 入口；Hook 按 `references/hook-api.md`，媒体按 `references/media-session.md`。
4. **编译**（仅 `.so`）：`cd <plugin> && ./build.sh`（Zig，`-target aarch64-linux-gnu.2.27`）；细节与 CMake 变体见 `references/build-deploy-debug.md`。
5. **产物自检**：`python scripts/verify_so.py build/lib<name>.so` —— AArch64、GLIBC ≤ 2.27、导出 `init_plugin`。
6. **部署**：`sh scripts/deploy_plugin.sh <plugin-dir>`。`.so` 一律 **tmp + rename**，禁止原地覆盖；随后重启主进程。
7. **验证**：日志出现 `Found plugin` / `init_plugin() called` / `Successfully loaded SO` 且无 QML 错误关键字 →
   截图（`adb shell touch /tmp/penmods_shot`）→ 实际功能真机验证。启动健康检查通过 ≠ 功能通过。

## 四、配置方式

**`metadata.json`**（严格 JSON，由 `QJsonDocument` 解析；未知字段被忽略）：

```json
{
    "id": "com.example.myplugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "author": "Your Name",
    "description": "一句话描述",
    "main_qml": "Main.qml",
    "main_so": "libmyplugin.so"
}
```

| 字段 | 必需 | 要点 |
|---|---|---|
| `id` | ✅ | 缺失或为空 → 整个目录被静默忽略 |
| `name` | 文档标必须（源码只强制 `id`） | 显示名；注入为页面属性 `pluginName`，也是按名启停/卸载的别名；留空会让卡片无名 |
| `main_qml` | 按需 | 相对插件目录；不填时"打开"必然失败 |
| `main_so` | 按需 | 相对插件目录；不填 = 纯 QML 插件 |
| `icon` | 否 | 原样交给 `YImage.imageName`，相对路径大概率不显示；自定义用 `file:///userdisk/PenMods/plugins/<id>/icon.png`（`【源码推断】`），否则省略 |
| `version` / `author` / `description` | 否 | 卡片展示 |

**框架状态文件**（PluginManager 维护，开发时只用于排障）：`.disabled`（存在即禁用）、`.loading`（加载期崩溃标记，勿手动创建）。
设备路径：插件目录 `/userdisk/PenMods/plugins/<id>/`、日志 `/userdata/applog/DictPen_*.log`（设备无 logcat）、配置 `/userdata/PenModsconfig.json`。

## 五、接口与生命周期

**导出符号（全部 `extern "C"`）**

| 符号 | 必须 | 调用时机 | 用途与限制 |
|---|---|---|---|
| `init_plugin()` | ✅ | `dlopen` 后立即 | 初始化全局状态。此时**没有 QCoreApplication**：不建 `QTimer`、不发异步网络请求、不碰宿主单例 |
| `attach_engine(QQmlEngine*)` | 否 | 引擎已就绪时紧随 `init_plugin`；否则推迟到 `beforeUiInitialization` | 注册 context property / QML 类型 |
| `init_plugin_with_hook_api(PluginHookAPI*)` | 否 | `init_plugin` 之后 | 查符号、装 Hook |
| `init_plugin_with_media_api(PluginMediaAPI*)` | 否 | hook API 之后 | 申请媒体会话、注册回调 |
| `destroy_plugin()` | 否 | 禁用 / 卸载 / 进程退出，`dlclose` 前 | 停线程、停播放、落盘；Hook 不可卸载 |

**加载顺序（`PluginManager::loadSo`）**：写 `.loading` → `dlopen` → `init_plugin` →（引擎已就绪）`attach_engine` →
`init_plugin_with_hook_api` → `init_plugin_with_media_api` → 删 `.loading`。不能假设 `attach_engine` 与两个 init API 的先后顺序。

**停用路径**：`setPluginEnabled(id,false)` / `uninstallPlugin(id)` → 释放媒体会话 → `destroy_plugin()` → `dlclose`（卸载还会递归删除插件目录）。

**宿主提供的接口**

- QML `pluginManager`：`getPluginCount()`、`getPluginInfo(i)` → `{id,name,description,version,author,enabled,loaded,icon,mainQmlUrl}`、
  `setPluginEnabled(idOrName,bool)`、`uninstallPlugin(idOrName)`、`requestPluginList()`；信号只用 `pluginListUpdated()`。
- QML `mediaSession`：`begin(pluginId)` / `end(pluginId)`，`title` `artist` `album` `cover` `duration` `position` `playState`，`setLyrics()`；
  信号 `playRequested` `pauseRequested` `toggleRequested` `nextRequested` `prevRequested` `stopRequested` `seekRequested(ms)` `openRequested` `sessionRevoked`。
- C `PluginMediaAPI`：`beginSession` `endSession` `setTrack` `setPlayState` `setPosition` `setDuration` `setLyrics` `setCallbacks`；回调在 UI 线程。
- C `PluginHookAPI`：`querySymbol(mangled)` → 地址 / `NULL`；`hookFunction(addr, detour, &original)` → 0 成功。便利宏 `PLUGIN_SYM`、`PLUGIN_HOOK`。
- 插件页装载契约：宿主注入 `pluginName`；根对象发射 `backButtonClicked()` 即关闭；Home 键释放、切页、同插件重开都会销毁页面。

完整语义见 `references/plugin-abi.md`、`references/media-session.md`、`references/hook-api.md`。

## 六、常见约束（违反即失败或变砖）

1. **ABI 固定**：`aarch64-linux-gnu`、glibc **2.27**、Qt 5.15.2。漏掉 `-target aarch64-linux-gnu.2.27` 会引入设备没有的符号，加载即失败。
2. **只导出 C ABI**：入口必须在 `extern "C"` 内；`init_plugin` 缺失则卸载并自动禁用。
3. **`g_hook_api` / `g_media_api` 由插件自己定义**（`PluginSDK.h` 只有 `extern` 声明），否则严格链接失败。
4. **`.so` 的全局构造函数与四个 init 入口都运行在 `BeforeMain` 阶段**：早于 QCoreApplication 与事件循环，也可能早于宿主库的静态初始化。全局对象保持平凡，Qt 相关工作放到 `attach_engine` 之后。
5. **不原地覆盖已加载的 `.so`**：直接 `adb push` 会改写活映射 → 段错误 → 守护重启 → 固件写入 `boot-recovery`。
6. **重启节奏**：等 `pidof YoudaoDictPen` 稳定（约 10 秒）再杀下一次，否则残留 `.loading` 导致插件被误判崩溃而禁用。
7. **插件崩溃连带主进程**：自愈只覆盖四个 init 入口；detour、线程、QML 里的崩溃不自愈。
8. **Hook 不可卸载、`querySymbol` 依赖 `.symtab`**：vtable / typeinfo（`_ZT*`）、模板（`_ZNS`）、标准库（`_ZSt`）符号被 SymDB 过滤，查不到。
9. **屏幕 320×170、笔尖触控**：控件够大，不用 `QtQuick.Controls`；左右手模式由宿主窗口旋转实现，页面不要再转。
10. **媒体会话单属主**：用 `end(pluginId)` 而非 `end()`；被接管只停播不 `end()`；播放结束置 `Stopped` 保留续播卡片。
11. **`uninstallPlugin` 不可恢复**：递归删除插件目录。
12. **插件是独立工程**（CMake / xmake / 手写编译），不在 PenMods 主仓库内构建；核心仓库的 `xmake run` 含开发者本机路径，禁止执行。

## 七、最佳实践

- **优先级**：context property 能解决就不写 `.so`；`mediaSession` 能解决就不 Hook。Hook 是最后手段。
- **最小可用先行**：先交纯 QML 版验证目录与 metadata，再叠加原生能力；每加一层都单独重启验证。
- **init 入口保持"零风险"**：只查符号、存指针、登记回调；任何失败路径直接 `return`，不 `abort`、不抛异常、不解引用空指针。
- **detour**：签名逐参数对齐（成员函数首参 `this`），原函数指针存全局，每条返回路径返回合法值，`try/catch` 包住自定义逻辑，
  热路径不做重活；用 `std::atomic<bool>` 开关让 detour 容忍插件已停用。装了 Hook 的插件用 `.disabled` + 重启停用，不在线禁用（`【源码推断】`）。
- **页面与长寿命状态分离**：会话、`Connections`、定时器放 C++ 单例或独立对象；页面每次打开都应能从零重建。
- **稳定 id、自管配置**：`id` 发布后不改；自定义配置放 metadata 额外字段（宿主忽略）或自己的文件，不写 `/userdata/PenModsconfig.json`。
- **媒体会话语义**：`begin` 幂等；进度由宿主每 500 ms 推进，只在开始/跳转时设 `position`；回调（C 侧在 UI 线程）不阻塞。
- **编译产物自检**：推送前跑 `scripts/verify_so.py`；开 `-Wl,--no-undefined` 时若引用 Qt 符号，需链接 sysroot 同版本 Qt 或关闭该选项。
- **部署纪律**：`.so` 走 tmp + rename；`sync` 后再 `killall`；验证"日志无错 + 截图排版 + 实际功能"三件事，不以"启动没报错"为准。
- **破坏性操作先确认**：recovery 恢复（写 misc 分区）、卸载插件、清理 `.disabled` 之前，向用户说明风险并取得同意。

## 八、来源链接

| 内容 | 来源 |
|---|---|
| 插件主指南（目录、metadata、导出符号、生命周期、Hook、QML、媒体会话、构建、调试） | [doc/PLUGIN_DEV_GUIDE.md](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/PLUGIN_DEV_GUIDE.md) |
| 插件 Hook 指南（`PluginHookAPI`、符号表、故障排除） | [doc/PLUGIN_HOOK_DEV_GUIDE.md](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/PLUGIN_HOOK_DEV_GUIDE.md) |
| 公开 C ABI 定义 | [src/plugin/PluginSDK.h](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/plugin/PluginSDK.h) |
| 加载器实现（加载顺序、崩溃自愈、启停卸载） | [src/plugin/PluginManager.cpp](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/plugin/PluginManager.cpp) |
| QML 管理接口 `pluginManager` | [src/plugin/QmlPluginWrapper.cpp](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/plugin/QmlPluginWrapper.cpp) |
| 媒体会话实现 | [src/media/MediaSession.cpp](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/media/MediaSession.cpp) |
| 运行阶段、根上下文、C ABI 静态初始化陷阱 | [AGENTS.md §Plugin System](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L395-L422) |
| `.so` 部署（tmp + rename）与崩溃循环恢复 | [AGENTS.md L558-L601](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L558-L601) |
| 日志、截图、触摸注入、重启纪律 | [AGENTS.md L818-L930](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L818-L930) |
| 工具链与 `--cross=aarch64-linux-gnu.2.27` | [README.md](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/README.md) |
| 截图通道 | [doc/SCREENSHOT_CHANNEL.md](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/SCREENSHOT_CHANNEL.md) |
| 触摸注入工具 | [tools/touch-injector/README.md](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/tools/touch-injector/README.md) |
| 插件页装载契约（内嵌 QML，需 `scripts/unpack_qt_res.sh YDP02X` 还原） | [resource/models/YDP02X/qrc_qml.h](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/resource/models/YDP02X/qrc_qml.h) |

## 九、参考文件

| 文件 | 内容 | 何时读 |
|---|---|---|
| `references/repo-docs-map.md` | 文档分类清单与永久链接；文档 vs 源码的差异；仓库未提供的东西 | 追溯来源，或怀疑文档说法时 |
| `references/plugin-abi.md` | 目录布局、`metadata.json` 解析行为、三种形态、导出符号、真实加载顺序、启停与崩溃自愈、`pluginManager` API、日志文案 | 写 / 调试 `.so` 插件 |
| `references/hook-api.md` | `PluginHookAPI`、SymDB 行为、最小 Hook 插件、常用符号、detour 硬要求、故障排除 | 需要 Hook 宿主函数时 |
| `references/qml-ui.md` | 页面装载契约、可用 context property 与已注册类型、原生组件 import、骨架、自检清单 | 写插件页时 |
| `references/media-session.md` | `mediaSession` QML API 与 C ABI 全量语义、会话生命周期规则 | 插件自己播放音频时 |
| `references/build-deploy-debug.md` | Zig/CMake 编译、产物自检、部署与重启纪律、日志、截图、触摸注入、崩溃循环恢复、验收清单 | 编译、上机、排障时 |
| `scripts/new_plugin.py` | 生成脚手架（纯 QML 或含 `.so`） | 起项目 |
| `scripts/verify_so.py` | 纯标准库 ELF 检查（架构 / 依赖 / GLIBC 版本 / 入口符号） | 每次编译后、推送前 |
| `scripts/deploy_plugin.sh` | 推送运行期文件并重启（`.so` 走 tmp + rename） | 上机 |
| `assets/plugin-template/` | `metadata.json`、`Main.qml`、`plugin.cpp`、`build.sh`、`sdk/PluginSDK.h` | 脚手架模板 |

## 十、排障速查

| 现象 | 处理 |
|---|---|
| 插件不出现在列表 | `metadata.json` 不是合法 JSON 或缺 `id`；目录不在 `/userdisk/PenMods/plugins/` 的一级子目录 |
| `Failed to load SO` | 架构不是 AArch64 / glibc > 2.27 / 依赖缺失；跑 `verify_so.py` |
| `No init_plugin symbol` | 没导出 `init_plugin`，或没放在 `extern "C"` 里 |
| 启用但没反应、开关被回滚 | `loaded == false`：日志 `Auto-disabling plugin ... due to load failure` |
| 重启后变成禁用 | 上次加载期崩了（`.loading` 残留）。先修崩溃点，再删 `.disabled`；若只是重启太频繁，等进程稳定 10 秒后再杀 |
| `querySymbol` 返回 `NULL` | mangled 名拼错；`.symtab` 被 strip；`_ZT*` / `_ZNS` / `_ZSt` 被 SymDB 过滤；固件不同 |
| `attach_engine` 没被调用 | 拼写（全小写下划线）与 `extern "C"`；`nm -D` 自检 |
| "打开"没反应或空白 | `main_qml` 未填或路径错（URL 指向目录）；QML 顶层报错，查日志 `component error` |
| 自定义图标不显示 | 用 `file:///userdisk/PenMods/plugins/<id>/icon.png`，或省略 `icon` |
| 返回后下拉面板控制失灵 | `Connections { target: mediaSession }` 挂在了被 `destroy()` 的页面根上 |
| 页面太小 / 控件点不中 | 可点区 < 40×40；用了 `QtQuick.Controls` |
