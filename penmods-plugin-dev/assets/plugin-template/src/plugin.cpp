// __PLUGIN_NAME__ — PenMods 插件入口（__PLUGIN_ID__）
//
// 硬约束（依据 src/plugin/PluginManager.cpp 与 src/plugin/PluginSDK.h）：
//   - 所有入口函数必须在 extern "C" 内，否则 PluginManager 的 resolve() 找不到
//   - init_plugin* 运行在宿主 BeforeMain 阶段：早于 QCoreApplication 与事件循环
//   - 初始化阶段只做不会失败的事；失败就 return，绝不 abort / 抛异常 / 解引用空指针
//   - init_plugin 是唯一必须导出的符号；缺失则 .so 被卸载并自动禁用

#include "PluginSDK.h"

#include <cstdio>

// PluginSDK.h 里 g_hook_api / g_media_api 只有 extern 声明，必须由插件自己定义，
// 否则带 -Wl,--no-undefined 链接时失败。
PluginHookAPI*  g_hook_api  = nullptr;
PluginMediaAPI* g_media_api = nullptr;

namespace {

constexpr const char* kPluginId = "__PLUGIN_ID__";

}  // namespace

extern "C" {

void init_plugin() {
    // 这里还没有 QCoreApplication：不要创建 QObject / QTimer / QNetworkAccessManager，
    // 也不要访问宿主尚未初始化的单例。
    std::printf("[%s] init_plugin\n", kPluginId);
}

// 需要 Hook 宿主函数时导出。详见 references/hook-api.md
//
// void init_plugin_with_hook_api(PluginHookAPI* hook_api) {
//     if (!hook_api || !hook_api->querySymbol || !hook_api->hookFunction) return;
//     g_hook_api = hook_api;
//
//     void* addr = hook_api->querySymbol("_ZN11YSystemBase8ocrStartEv");
//     if (!addr) return;                       // 符号不在就静默退出
//     (void)hook_api->hookFunction(addr, (void*)detour_fn, (void**)&original_fn);
// }

// 需要下拉快捷面板的音乐卡片时导出。详见 references/media-session.md
//
// void init_plugin_with_media_api(PluginMediaAPI* api) {
//     if (!api || !api->beginSession) return;
//     g_media_api = api;
//     // g_session = api->beginSession(kPluginId);
//     // 设置曲目 / 状态 / 回调见 references/media-session.md
// }

// 需要向 QML 暴露 C++ 对象时导出。需要 Qt 头文件（build.sh 的 QT_SDK）。
// 调用时机：引擎已就绪时紧跟 init_plugin；否则推迟到宿主 beforeUiInitialization。
//
// void attach_engine(QQmlEngine* engine) {
//     if (!engine) return;
//     engine->rootContext()->setContextProperty("myPlugin", &MyPluginObject::getInstance());
// }

void destroy_plugin() {
    // Hook 无法卸载（Dobby 限制）；这里只清理自有资源：停线程、停播放、落盘
    std::printf("[%s] destroy_plugin\n", kPluginId);
}

}  // extern "C"
