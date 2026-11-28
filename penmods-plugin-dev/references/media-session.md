# 媒体会话：接管下拉面板的音乐卡片

来源：D1 §媒体会话、S1 `PluginSDK.h`（Media API 段）、S4 `src/media/MediaSession.cpp`、D3 §Plugin System L405-L422。

用途：插件**自己播放音频**（不走宿主播放器）时，把曲目/进度/状态上报给宿主，下拉快捷设置面板显示音乐卡片，
并把播放/暂停/上一首/下一首/停止/跳转转给插件。同一时刻**只有一个属主**；没有插件会话时面板回落到宿主
`mediaPlayerManager`，不影响原有行为。

## 1. QML 侧（`mediaSession`，类型 `MediaSession`）

```qml
import QtQuick 2.12
import com.github.penuniverse 1.0     // MediaSession.Stopped / Playing / Paused

// 放进比页面活得久的对象（C++ 单例 / 独立对象），不要放在会被 destroy() 的插件页根上
QtObject {
    readonly property string pluginId: "com.example.myplugin"   // 必须与 metadata.json 的 id 一致

    function start() {
        if (!mediaSession.begin(pluginId)) return
        mediaSession.title = "Song"; mediaSession.artist = "Artist"
        mediaSession.duration = 180000            // ms；0 = 未知
        mediaSession.position = 0                  // ms；只在开始/跳转时校正
        mediaSession.setLyrics("当前歌词行", "翻译")
        mediaSession.playState = MediaSession.Playing
    }

    Connections {
        target: mediaSession
        function onPlayRequested()        { mediaSession.playState = MediaSession.Playing }
        function onPauseRequested()       { mediaSession.playState = MediaSession.Paused }
        function onToggleRequested()      { /* ... */ }
        function onNextRequested()        { /* ... */ }
        function onPrevRequested()        { /* ... */ }
        function onStopRequested()        { mediaSession.end(pluginId) }   // 卡片随之消失
        function onSeekRequested(ms)      { /* ... */ }
        function onOpenRequested()        { /* 可选：打开插件自己的播放页 */ }
        function onSessionRevoked()       { /* 停播；不要在这里 end() */ }
    }
}
```

| 成员 | 语义（S4） |
|---|---|
| `begin(pluginId) → bool` | 声明/接管。同属主重复调用幂等返回 true；空 id 返回 false。接管时向旧属主发 `sessionRevoked`，并停止宿主 `MusicPlayer` 的播放 |
| `end(pluginId) → bool` | 属主校验的释放：非当前属主为 no-op 返回 false。**插件一律用它** |
| `end()` | 无条件释放；接管广播期间被忽略。宿主内部用，插件不要用 |
| `active`（只读） | 面板据此选数据源；**卡片可见性 = `active`** |
| `ownerPluginId`（只读） | 当前属主 |
| `title` `artist` `album` `cover` | 曲目信息；`cover` 为 URL 或本地路径 |
| `duration` `position`（int，ms） | `duration` 0 = 未知；负值按 0 处理，`position` 被夹到 `[0, duration]` |
| `playState` | `Stopped`(0) / `Playing`(1) / `Paused`(2) |
| `hasLyrics`（只读）、`mainLyric`、`transLyric` | 歌词 |
| `setLyrics(main, trans)` | 当前歌词行，空串 = 无歌词 |

控制信号：`playRequested`、`pauseRequested`、`toggleRequested`、`nextRequested`、`prevRequested`、
`stopRequested`、`seekRequested(int position)`、`openRequested`、`sessionRevoked`。
耳机线控等外部输入（`requestPlay/Pause/Next/Previous`）在 `active` 时走同一组信号。

进度推进：`active && Playing` 时宿主每 **500 ms** 自动推进 `position`（S4 L235；S1 注释写"按秒"，以源码为准），
插件只在开始/跳转时设置 `position`。`duration == 0` 时面板进度条为空。

## 2. C ABI 侧（`init_plugin_with_media_api`）

```cpp
PluginMediaAPI* g_media_api = nullptr;      // PluginSDK.h 只有 extern 声明，插件必须定义
static void* g_session = nullptr;

static void on_pause(void* user)          { my_player_pause(); }
static void on_session_revoked(void* user){ my_player_stop(); }   // 被其它插件接管

extern "C" void init_plugin_with_media_api(PluginMediaAPI* api) {
    if (!api || !api->beginSession) return;
    g_media_api = api;

    g_session = api->beginSession("com.example.myplugin");    // 与 metadata.json 的 id 一致
    if (!g_session) return;

    api->setTrack(g_session, "Song", "Artist", "Album", nullptr);
    api->setDuration(g_session, 180000);
    api->setPosition(g_session, 0);
    api->setLyrics(g_session, "当前歌词行", nullptr);
    api->setPlayState(g_session, PLUGIN_MEDIA_PLAYING);

    PluginMediaCallbacks cbs = { 0 };
    cbs.structSize = sizeof(cbs);           // 必填：宿主按 structSize 兼容追加字段
    cbs.onPause = on_pause;
    cbs.onSessionRevoked = on_session_revoked;
    api->setCallbacks(g_session, &cbs, nullptr);   // 0 = 成功；-1 = handle 已失效
}
```

| 函数 | 语义 |
|---|---|
| `beginSession(pluginId)` | 返回不透明 handle。同 id 且已有活 handle 时返回同一个；否则换发新令牌并接管 |
| `endSession(handle)` | 属主 handle 有效时释放；陈旧 handle 为 no-op |
| `setTrack(handle, title, artist, album, cover)` | **每次整体替换**；`NULL` / 空串 = 该字段为空 |
| `setPlayState(handle, state)` | `PLUGIN_MEDIA_STOPPED=0` / `PLAYING=1` / `PAUSED=2`；越界忽略 |
| `setPosition` / `setDuration` | ms；负值按 0，上限 `INT_MAX` |
| `setLyrics(handle, main, trans)` | `NULL` = 清空 |
| `setCallbacks(handle, &cbs, user)` | 宿主按 `min(structSize, sizeof(PluginMediaCallbacks))` **拷贝**一份，传栈上临时对象即可；`NULL` 清除回调 |

- 回调：`onPlay` `onPause` `onToggle` `onNext` `onPrev` `onStop` `onSeek(user, ms)` `onOpen`，以及可选的
  `onSessionRevoked`（`structSize` 之后追加的最后一个字段，旧宿主不认识也不会调用）。
- 线程：所有函数可从任意线程调用，宿主用 `Qt::QueuedConnection` 转到 UI 线程执行；**回调在 UI 线程执行，不要阻塞**。
- handle 是单调递增的整数令牌（编码在 `void*`），不是指针，永不复用；不要解引用、不要比较地址语义。
- `abiVersion` / `structSize` 由宿主填充，插件只读；不要自己构造 `PluginMediaAPI`。
- 该入口在 `BeforeMain` 阶段被调用，此时事件循环还没跑：上报调用入队后才生效，不要在回调里假设界面已存在。

## 3. 会话生命周期规则（D1 + S4）

| 场景 | 做法 |
|---|---|
| 用户按面板**停止**（`stopRequested`） | 停止播放并 `end(pluginId)`，卡片消失 |
| 播放自然结束 / 用户暂停 | 只把 `playState` 置为 `Stopped` / `Paused`，**不要 `end()`**：卡片保留供一键续播 |
| 被其它插件接管（`sessionRevoked` / `onSessionRevoked`） | 停止自己的播放，**不要 `end()`**；C 侧 handle 已失效，后续调用全部丢弃 |
| 用户确认结束（离开播放页） | `end(pluginId)` |
| 插件被禁用 / 卸载 | 宿主自动 `releaseFor(pluginId)`，无需插件处理 |

宿主没有空闲自动过期：何时真正结束由插件决定。`end()` 之后卡片立即消失、控制信号不再送达——
想保留续播入口，唯一办法是保留会话、只置 `Stopped`。

## 4. 页面寿命陷阱

插件页由 `YDynamicPageStack` 装载，返回后整页 `destroy()`。把 `Connections { target: mediaSession }`
或会话状态挂在页面根对象上，用户一返回，面板按钮就全部失效。放进 C++ 单例或独立长寿命对象
（见 `qml-ui.md` §2）。C ABI 没有这个问题，但 `beginSession` / `endSession` 仍需成对。
