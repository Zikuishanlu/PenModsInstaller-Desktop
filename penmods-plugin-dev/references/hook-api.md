# PluginHookAPI：拦截宿主函数

来源：D2 `doc/PLUGIN_HOOK_DEV_GUIDE.md`、D1 §Hook API、S1 `src/plugin/PluginSDK.h`、
S2 `PluginManager.cpp` L359-L413、D3 §Hooking（编号见 `repo-docs-map.md`）。

定位：Hook 是**最后手段**——绑定固件版本、崩溃连带主进程、装上不可撤销。能用 context property / 媒体会话 /
纯 QML 页面解决的，不要 Hook。

## 1. 接口（S1）

```cpp
typedef struct {
    void* (*querySymbol)(const char* symbolName);                              // 失败返回 NULL
    int   (*hookFunction)(void* targetAddr, void* detourFunc, void** originalFunc); // 0 = 成功
} PluginHookAPI;

#define PLUGIN_SYM(sym) (g_hook_api ? g_hook_api->querySymbol(sym) : NULL)
#define PLUGIN_HOOK(target, detour, original) \
    (g_hook_api ? g_hook_api->hookFunction(target, (void*)(detour), (void**)&(original)) : -1)

extern PluginHookAPI* g_hook_api;   // 只有声明：插件必须自己定义 PluginHookAPI* g_hook_api = nullptr;
```

- `querySymbol` 走宿主 `SymDB`（`src/base/SymDB.cpp`）：启动时用 ELFIO 解析主程序 **`.symtab`**，以名字哈希建表；
  未命中再回退 `DobbySymbolResolver`（只能解析动态符号）。参数是 C++ mangled name。
  - `.symtab` 被 strip 时表为空（启动日志 `SYMTAB_STRIPPED`），只剩动态符号可查。
  - SymDB **过滤掉** `_ZNS`（模板）、`_ZT`（vtable / typeinfo：`_ZTV`、`_ZTI`、`_ZTS`）、`_ZSt`（标准库）、`_ZGV` 开头的符号。
    需要 vtable 地址时 `querySymbol` 查不到，只能走裸地址。
- `hookFunction` 即 `DobbyHook`。任一参数为空返回 `-1`。
- 插件里**没有** `PEN_HOOK_ADDR`（那是核心仓库 `src/base/Hook.h` 的内部宏）。要按裸地址 Hook，直接
  `hook_api->hookFunction(addr, (void*)detour, (void**)&original)`。

## 2. 最小可用 Hook 插件

```cpp
#include "PluginSDK.h"

PluginHookAPI* g_hook_api = nullptr;

namespace {
typedef uint64_t (*OcrStartFn)(uint64_t self);          // 签名必须与原函数逐参数一致，self = this
OcrStartFn original_ocrStart = nullptr;

uint64_t detour_ocrStart(uint64_t self) {
    if (!original_ocrStart) return 0;                   // 兜底，绝不空调用
    // 前置逻辑
    uint64_t ret = original_ocrStart(self);
    // 后置逻辑
    return ret;
}
}  // namespace

extern "C" {
void init_plugin() {}

void init_plugin_with_hook_api(PluginHookAPI* hook_api) {
    if (!hook_api || !hook_api->querySymbol || !hook_api->hookFunction) return;
    g_hook_api = hook_api;

    void* addr = hook_api->querySymbol("_ZN11YSystemBase8ocrStartEv");
    if (!addr) return;                                 // 符号不在就静默退出，不要 abort
    (void)hook_api->hookFunction(addr, (void*)detour_ocrStart, (void**)&original_ocrStart);
}

void destroy_plugin() { /* Hook 不可卸载：只清自有资源 */ }
}  // extern "C"
```

D2 的示例把 `init_plugin` 写成可选、`init_plugin_with_hook_api` 写成必须，与源码相反：**`init_plugin` 才是必须的**
（见 `plugin-abi.md` §4）。

## 3. 文档给出的常用符号（D2，示例而非契约）

| 功能 | mangled name |
|---|---|
| OCR 启动 | `_ZN11YSystemBase8ocrStartEv` |
| OCR 停止 | `_ZN11YSystemBase7ocrStopEi` |
| 扫描完成 | `_ZN11YSystemBase12onScanFinishERK7QStringi` |
| 按钮按下 | `_ZN14YButtonMonitor16_do_button_pressE11button_id_tiii` |
| 页面切换 | `_ZN7YGlobal23currentPageIndexChangedEv` |

符号随固件变化；换固件必须重新核对。

## 4. 找符号

1. 取主程序：`adb pull /oem/YoudaoDictPen/output/YoudaoDictPen`（仓库**不含**该二进制与 IDA 库）。
2. `nm YoudaoDictPen | grep -i <keyword>` —— 看全部 `.symtab` 符号（`nm -D` 只看 `.dynsym`，会漏）。
   D3 提示：`nm -C binary/YoudaoDictPen` 的结果与设备上 `SymDB` 能解析到的完全一致。
3. `readelf -s YoudaoDictPen | head` 确认存在 `.symtab`；strip 版只有 `.dynsym` 时 `querySymbol` 查不到，这是返回 `NULL` 最常见的原因。
4. `echo <mangled> | c++filt` 反查可读名；函数签名以反汇编或 `c++filt` 的参数列表为准。
5. 没有本机 `nm`/`readelf` 时：`python <skill>/scripts/verify_so.py <so>` 可列出 `.so` 的依赖与符号（针对插件产物）；
   主程序符号查询仍需 binutils 或 IDA/Ghidra。

## 5. 写 detour 的硬要求

- **签名逐字节对齐**：AArch64 前 8 个整型/指针参数走 `x0..x7`，浮点走 `v0..v7`。成员函数首参是 `this`，不能省。
- **不在 detour 里抛异常**（跨 C 边界是未定义行为）；要保护就自己 `try/catch` 包住（D2 最佳实践）。
- **原函数指针存全局**，不要每次调用重查。
- **每条返回路径都合法**：提前返回时返回类型正确的值（`0` / `nullptr`），别让调用方拿到垃圾值。
- **热路径不做重活**：OCR、按钮、页面切换都在 UI 线程同步调用，阻塞直接卡界面；耗时工作丢到自己的线程/队列。
- **可以用 Qt 类型**（主进程已加载 Qt），但 `QObject` 与 GUI 操作必须在主线程。
- **容忍"已停用"**：Hook 不可卸载。用 `std::atomic<bool> g_active` 之类的开关在 `destroy_plugin` 里短路 detour，
  不要让 detour 依赖已释放的对象。进一步建议装 Hook 的插件不要在线禁用（`plugin-abi.md` §6）。

## 6. 故障排除（D2 + S2）

| 现象 | 排查 |
|---|---|
| `querySymbol` 返回 `NULL`，日志 `[PluginHookAPI] Symbol not found` | mangled 名拼错；`.symtab` 被 strip；函数被内联/LTO 掉；固件不同 |
| `hookFunction` 返回非 `0`，日志 `Failed to hook at 0x…` | 地址无效；detour 签名不对导致 Dobby 拒绝；目标已被别处 Hook；函数太短无法 inline hook |
| 加载后立刻崩，重启后插件被禁用 | detour 签名不匹配最常见；其次是在 init 入口里访问了未初始化的宿主对象 |
| Hook 生效但行为错乱 | 忘调原函数、调了两次、返回了错误类型 |
| 运行一段时间后崩且**不会**自愈 | detour / 线程里的崩溃不在 `.loading` 覆盖范围；看 `/userdata/syslog/messages` 的 fault 记录 |
