# 插件包、ABI 与生命周期

来源：D1 `doc/PLUGIN_DEV_GUIDE.md`、D2 `doc/PLUGIN_HOOK_DEV_GUIDE.md`、S1 `src/plugin/PluginSDK.h`、
S2 `src/plugin/PluginManager.cpp`、S3 `src/plugin/QmlPluginWrapper.cpp`（编号见 `repo-docs-map.md`）。
文档与源码冲突处以源码为准，差异清单见 `repo-docs-map.md` §3。

## 1. 目录布局

```
/userdisk/PenMods/plugins/            ← PluginManager::m_defaultDir（注意是 /userdisk，不是 /userdata）
└── com.example.myplugin/              ← 目录名随意，习惯用 id；真正的主键是 metadata.json 的 id
    ├── metadata.json                 ← 必须；缺失/非法/无 id → 目录被静默跳过
    ├── Main.qml                      ← 可选，QML 页入口（main_qml）
    ├── libmyplugin.so                 ← 可选，ARM64 共享库（main_so）
    ├── icon.png                      ← 可选
    ├── qml/  *.js  qmldir            ← 可选，页面相对 import 的资源
    ├── .disabled                     ← 框架管理：存在即禁用
    └── .loading                      ← 框架管理：崩溃自愈标记，勿手动创建
```

扫描规则（S2 `scanAndLoadAll`）：只遍历**一级子目录**，每个目录读 `metadata.json`。

## 2. metadata.json

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

| 字段 | 必需 | 解析行为（S2 `parseMetadata` L154-L173） |
|---|---|---|
| `id` | ✅ | 唯一键；空则整份 metadata 无效。`togglePlugin` / `uninstallPlugin` / 媒体会话属主都用它。全局唯一、不随版本变 |
| `name` | ✅（文档） | 显示名；注入到插件页的 `pluginName`；也被 `setPluginEnabled` / `uninstallPlugin` 当作 id 的别名接受 |
| `version` | ✅（文档） | 仅展示（卡片 `v<version>`） |
| `author` / `description` | 否 | 卡片展示；`description` 最多显示 2 行 |
| `icon` | 否 | 原样交给 `YImage.imageName`。空 → 内置图标 `settings/plugin`。**相对路径大概率不显示**：不以 `qrc:/`、`file:/` 开头会被拼成 `image://icons/<值>.png`。要自定义图标用绝对 URL `file:///userdisk/PenMods/plugins/<id>/icon.png`（`【源码推断】`，真机复核） |
| `main_qml` | 否 | 拼成 `<插件目录>/<值>` 的绝对路径，再转 `file://` URL 给页面装载器。不填时 URL 指向目录本身，"打开"必然失败 |
| `main_qml` / `main_so` 之外的字段 | — | 被忽略，可放自定义字段自用（宿主不读） |

约束：必须是由 `QJsonDocument::fromJson` 能解析的严格 JSON（UTF-8，无注释、无尾逗号）。未知字段会被忽略，可自用。

## 3. 三种插件形态

| 形态 | 组成 | 加载行为 | 适用 |
|---|---|---|---|
| 纯 QML | `metadata.json` + `main_qml` | 不涉及 `.so`；`loaded` 恒为 true | 页面、调用现成 context property 的工具 |
| QML + SO | + `main_so` | 启动时 `dlopen`，按 §4 顺序调用入口 | 需要 C++ 对象、文件/网络、Hook、后台任务 |
| 纯 SO | `metadata.json` + `main_so` | 同上；`mainQmlUrl` 指向目录，宿主仍会显示"打开"按钮 | 纯后台逻辑 |

`enabled && loaded` 的插件才显示"打开"按钮和首页抽屉入口。纯 SO 插件建议同样提供一个极简 QML 页，避免用户点到必失败的"打开"。

## 4. 导出符号（C ABI）

全部必须在 `extern "C"` 内；C++ 名称修饰会让 `QLibrary::resolve` 找不到。

```cpp
void init_plugin();                                            // 必须（有 .so 时）
void attach_engine(QQmlEngine* engine);                         // 可选
void init_plugin_with_hook_api(PluginHookAPI* hook_api);        // 可选
void init_plugin_with_media_api(PluginMediaAPI* media_api);      // 可选
void destroy_plugin();                                          // 可选
```

自检：`nm -D libmyplugin.so | grep -E 'init_plugin|attach_engine'`，或 `scripts/verify_so.py`。

| 符号 | 调用时机 | 能做什么 | 不能做什么 |
|---|---|---|---|
| `init_plugin` | `dlopen` 成功后立即 | 初始化全局状态、分配资源 | 此时**没有 QCoreApplication**：不能创建依赖事件循环的对象（`QTimer`、`QNetworkAccessManager` 异步请求），不能碰宿主未初始化的单例。缺失则 `.so` 被卸载并自动禁用 |
| `attach_engine` | 引擎已就绪时紧跟 `init_plugin`；否则推迟到宿主 `beforeUiInitialization` | `engine->rootContext()->setContextProperty(...)`、`qmlRegisterType` | 不能假设它与两个 init API 的先后顺序 |
| `init_plugin_with_hook_api` | `init_plugin` 之后（`attach_engine` 之后或之前） | 查符号、装 Hook | 运行阶段仍是 `BeforeMain` |
| `init_plugin_with_media_api` | `init_plugin_with_hook_api` 之后 | 申请媒体会话、注册回调（见 `media-session.md`） | 同上 |
| `destroy_plugin` | 禁用 / 卸载时，`dlclose` 之前；进程退出时 | 停线程、停播放、落盘 | **Hook 无法卸载**（Dobby 限制） |

`PluginHookAPI*` / `PluginMediaAPI*` 指向进程级 static 结构体，生命周期覆盖插件全程：保存指针即可，不要拷贝后释放。
`init_plugin_with_hook_api` / `init_plugin_with_media_api` 在宿主侧被 `try/catch(std::exception)` 包住，抛异常只记日志；`init_plugin` 与 `attach_engine` 的调用**没有**这层保护，异常会直接传播进宿主。

## 5. 真实加载顺序（S2 `loadSo` L179-L249）

```
写 .loading
QLibrary::load(main_so)                                   ── 失败：记 Failed to load SO，删 .loading，自动禁用并持久化
  ├─ resolve("init_plugin") → 调用                        ── 缺失：unload，记 No init_plugin symbol，返回 false
  ├─ if (引擎已就绪) resolve("attach_engine") → 调用
  ├─ 记入 m_loadedLibraries，isLoaded = true
  ├─ resolve("init_plugin_with_hook_api") → 调用
  ├─ resolve("init_plugin_with_media_api") → 调用
  └─ 删 .loading

（引擎晚于 .so 就绪）beforeUiInitialization → attachEngineToLoadedPlugins → attach_engine(engine)
（引擎未变时不会重复调用；setEngine 只在引擎指针变化时分发）

运行期：
  setPluginEnabled(id,true)  → loadSo()（热加载：引擎已就绪，attach_engine 立即调用）；失败回滚为禁用
  setPluginEnabled(id,false) → MediaSession::releaseFor(id) → destroy_plugin() → unload(dlclose)
  uninstallPlugin(id)        → 禁用 → 释放会话 → destroy_plugin() → unload → removeRecursively(插件目录)
  进程退出                    → 对所有已加载插件 unloadSo()
```

启动期：启用的 `.so` **全部饿加载**（`PluginManager` 构造函数在宿主 `BeforeMain` 内执行）；插件 QML 只在用户打开时才创建。

## 6. 启用、禁用与崩溃自愈

| 文件 | 谁写 | 含义 |
|---|---|---|
| `.disabled` | `PluginManager.setPluginPersistence` | 存在即禁用。启用=删除该文件。UI 开关、`setPluginEnabled`、崩溃自愈、加载失败都会写它 |
| `.loading` | `loadSo` 创建、四个入口全部返回后删除 | 启动扫描时若发现它仍在 → 判定上次加载期间崩溃：写 `.disabled`、删 `.loading`、本次不加载。日志 `Plugin <id> crashed during last startup. Auto-disabling.` |

自愈覆盖范围：`init_plugin`（含 `dlopen` 期间的全局对象构造函数）、`attach_engine`、两个 init API **内部**的崩溃。
不覆盖：入口返回之后的崩溃（detour、工作线程、QML、定时器回调）——这些崩溃会连带主进程，连续几次后固件升级为 `boot-recovery`。

运行期点"禁用"的后果（`【源码推断】`）：`destroy_plugin()` 后 `dlclose`，已安装的 Hook 仍指向库内 detour。
若库被真正卸载，被 Hook 的函数再次调用会跳进已解除映射的代码。装了 Hook 的插件应通过"写 `.disabled` + 重启"停用，不要在线禁用。

## 7. QML 侧管理 API（S3，context property `pluginManager`）

| 方法 | 说明 |
|---|---|
| `getPluginCount() → int` | 已发现插件数 |
| `getPluginInfo(index) → object` | `{id, name, description, version, author, enabled, loaded, icon, mainQmlUrl}` |
| `setPluginEnabled(idOrName, bool) → bool` | 启用/禁用；加载失败返回 false 并保持禁用 |
| `uninstallPlugin(idOrName)` | 禁用 + 卸载 + 递归删除插件目录（**不可恢复**，宿主 UI 有二次确认） |
| `requestPluginList()` | 重新扫描目录（会触发 `pluginListUpdated`） |

- 信号：只用 `pluginListUpdated()`。头文件里的 `pluginStateChanged` 从未发射。
- `enabled` = 用户偏好（无 `.disabled`）；`loaded` = 实际在跑。`enabled && !loaded` 即加载失败。
- 宿主 UI：插件管理页每插件一张卡片（右侧开关、底部"打开""卸载"），进入页面时 `requestPluginList()`。
- 安全锁：若启用了 Locker 且开启场景 `plugin_manager`（默认开），进入插件管理页需密码；首页抽屉入口不受此限制（只在 Locker 关闭时显示插件管理图标）。
- `antiEmbs.active`（考试/防作弊模式）为真时，隐藏插件入口并关闭已打开的插件页，插件 `.so` 本身仍已加载。

## 8. 日志文案对照（D1、S2）

日志文件：`/userdata/applog/DictPen_<YYYYMMDD_HHMMSS>.log`（只保留最新一份；设备时钟为 UTC）。

| 日志 | 含义 |
|---|---|
| `Found plugin: <name> (ID: <id>, Enabled: true)` | 扫描到插件 |
| `init_plugin() called for <id>` | 基础入口已执行 |
| `attach_engine() called for <id>` / `Attaching engine to plugin: <id>` | 引擎已分发 |
| `Hook API initialized for plugin: <id>` | Hook 接口注入完成 |
| `Media API initialized for plugin: <id>` | 媒体接口注入完成 |
| `Successfully loaded SO: <id>` | 加载完成（`.loading` 已删） |
| `No init_plugin symbol in <path>` | 缺必须符号 / 没放 `extern "C"` |
| `Failed to load SO: <path>, Error: ...` | `dlopen` 失败：架构、glibc、依赖缺失 |
| `Auto-disabling plugin <id> due to load failure.` | 加载失败并已持久化禁用 |
| `Plugin <id> crashed during last startup. Auto-disabling.` | 触发崩溃自愈 |
| `[PluginHookAPI] Symbol not found: <mangled>` | `querySymbol` 未命中 |
| `[PluginHookAPI] Successfully hooked at 0x…` / `Failed to hook at 0x…` | Hook 结果 |
