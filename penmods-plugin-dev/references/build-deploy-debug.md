# 编译、部署、调试与验收

来源：D1 §构建插件 / 安装与调试、D4 §构建 / 本地验证与部署、D3 §Deploying / Recovering / Deployment Paths /
On-Device UI Verification、D5、D6。插件是**独立工程**（CMake / xmake / 手写命令），不在 PenMods 主仓库内构建。

## 1. 工具链

| 项 | 值 |
|---|---|
| 目标 | `aarch64-linux-gnu`（ARM64，rk3326） |
| ABI | glibc **2.27**——target 后缀 `.2.27` 不能省，否则引入设备没有的符号，`dlopen` 即失败 |
| Qt | 5.15.2，sysroot 形如 `aarch64-linux-qt-5.15.2`（PenMods 同源） |
| C++ | C++14 以上；PenMods 自身用 C++17 |
| 编译器 | Zig：`zig c++ -target aarch64-linux-gnu.2.27`；或 `aarch64-linux-gnu-g++` |
| 设备侧 | ADB；主进程 `YoudaoDictPen`，守护进程会自动拉起 |

Zig 的 `zig c++` 默认静态链接 libc++，产物不依赖设备的 libstdc++；用 g++ 则会带上 `libstdc++.so.6` 依赖，需确认固件有。

## 2. 直接编译（模板 `assets/plugin-template/build.sh`）

```sh
zig c++ \
    -target aarch64-linux-gnu.2.27 \
    -shared -fPIC -std=c++17 -O2 \
    -Isdk \
    -I"$QT/include" -I"$QT/include/QtCore" -I"$QT/include/QtQml" -I"$QT/include/QtGui" \
    src/plugin.cpp \
    -o build/libmyplugin.so
```

- `PluginSDK.h` 本身只依赖 `<cstdint>`；不在 C++ 里用 Qt 类型时不需要 Qt 头文件。
- **不要在产物里打包 / 覆盖设备已有的库**（Qt、libc、libPenMods.so）：主进程已加载，`dlopen` 时自动共享。
- `-Wl,--no-undefined` / `-Wl,-z,defs`：能暴露"忘了定义 `g_hook_api`"之类问题。但它与"不链接 Qt"**互斥**：
  只要源码引用了 Qt 符号，就必须要么链接 sysroot 里**同版本**的 Qt（`-L"$QT/lib" -lQt5Core -lQt5Qml`，
  运行时解析到主进程已加载的库），要么去掉该选项。模板用 `STRICT=0 ./build.sh` 关闭。
- 链接设备专有库（ALSA、MPP、DRM 等）时只做链接用途，`.so` 不要随插件分发
  （`external/ffmpeg-player` 的 `external/dictpen/` 即此做法）。

### CMake 变体

```cmake
cmake_minimum_required(VERSION 3.16)
project(myplugin CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_library(myplugin SHARED src/plugin.cpp)
target_include_directories(myplugin PRIVATE sdk ${QT_INCLUDE_DIR})
set_target_properties(myplugin PROPERTIES OUTPUT_NAME "myplugin" PREFIX "lib")
# 需要严格链接时再打开：target_link_options(myplugin PRIVATE -Wl,--no-undefined -Wl,-z,defs)
```

```cmake
# zig-toolchain.cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_C_COMPILER zig)
set(CMAKE_C_COMPILER_ARG1 cc)
set(CMAKE_CXX_COMPILER zig)
set(CMAKE_CXX_COMPILER_ARG1 c++)
set(CMAKE_CXX_FLAGS_INIT "-target aarch64-linux-gnu.2.27")
```

```sh
cmake -B build -DCMAKE_TOOLCHAIN_FILE=zig-toolchain.cmake -DQT_INCLUDE_DIR="$QT/include"
cmake --build build -j
```

## 3. 产物自检（推送前必做）

```sh
python <skill>/scripts/verify_so.py build/libmyplugin.so          # 纯标准库，不依赖 readelf/nm
# 等价的手工检查（有 binutils 时）
readelf -h build/libmyplugin.so | grep Machine                      # AArch64
readelf -d build/libmyplugin.so | grep -E 'NEEDED|RUNPATH'
readelf -V build/libmyplugin.so | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1   # 必须 <= GLIBC_2.27
nm -D build/libmyplugin.so | grep -E 'init_plugin|attach_engine|destroy_plugin'
```

脚本检查：ELF64 小端 ET_DYN、AArch64；`DT_NEEDED` 清单；未定义符号的最高 `GLIBC_x.y`；
`init_plugin` 等入口是否导出；Qt / libstdc++ 引用提示。退出码 0 通过、1 失败、2 文件错误。

## 4. 部署

首次安装 / 更新纯 QML 文件：

```sh
ID=com.example.myplugin
adb shell mkdir -p /userdisk/PenMods/plugins/$ID
adb push metadata.json  /userdisk/PenMods/plugins/$ID/
adb push Main.qml       /userdisk/PenMods/plugins/$ID/
adb shell 'sync; killall YoudaoDictPen'      # 守护进程几秒内拉起
```

**已加载过的 `.so` 禁止原地覆盖**（D3 L558-L572）：运行中的进程映射着它，直接 `adb push` 会改写活映射的页，
主进程段错误 → 守护重启 → 连续几次后固件写入 `boot-recovery`，设备进入 Rockchip recovery。先推临时名再 `mv`
（老进程继续用旧 inode）：

```sh
adb push build/libmyplugin.so /userdisk/PenMods/plugins/$ID/libmyplugin.tmp.so
adb shell "mv -f /userdisk/PenMods/plugins/$ID/libmyplugin.tmp.so /userdisk/PenMods/plugins/$ID/libmyplugin.so"
adb shell 'sync; killall YoudaoDictPen'
```

`scripts/deploy_plugin.sh <plugin-dir>` 封装了上述流程（只推运行期文件，`.so` 走 tmp + rename，默认重启）。

## 5. 重启纪律

- 重启命令统一用 `adb shell 'sync; killall YoudaoDictPen'`。
- **等 `pidof YoudaoDictPen` 稳定（约 10 秒）再做下一次重启**。`PluginManager` 加载每个 `.so` 前写 `.loading`，
  进程在加载途中被杀会留下标记，下次启动把该插件当作崩溃而自动禁用。
- 连续重启后检查并清理残留：

```sh
adb shell 'for d in /userdisk/PenMods/plugins/*/; do [ -f "$d/.loading" ] && echo "loading: $d"; done'
adb shell 'rm -f /userdisk/PenMods/plugins/*/.loading'          # 仅清残留标记；.disabled 需先确认不是真崩溃
```

## 6. 看日志

设备**没有 logcat**。`YoudaoDictPen` 的 stdout（spdlog + QML `console.log`）写到：

```
/userdata/applog/DictPen_<YYYYMMDD_HHMMSS>.log     # 只保留最新一份；设备时钟为 UTC
```

```sh
LOG="$(adb shell 'ls -t /userdata/applog/DictPen_*.log | head -1')"
adb shell "grep -E 'Found plugin|init_plugin|attach_engine|Hook API|Media API|Failed to load|No init_plugin|Auto-disabling' $LOG"
adb shell "grep -E 'ReferenceError|TypeError|Unable to assign|Cannot read|is not a function|component error' $LOG"
```

- `console.log` 行带 `[qml]` 前缀，是插件页唯一的运行时输出通道。
- 进程崩溃：看 `/userdata/syslog/messages`（崩溃循环时反复出现 `unhandled level 2 translation fault ... Comm: YoudaoDictPen`）。
- 日志关键词对照见 `plugin-abi.md` §8。

## 7. 看画面与操作界面

截图（无需 weston `--debug`，D5）：

```sh
adb shell touch /tmp/penmods_shot
adb shell cat /tmp/penmods_shot.log          # ok /tmp/penmods_shot-0.png 320x170 ...
adb pull /tmp/penmods_shot-0.png             # 已是 320×170 逻辑分辨率；序号自增
```

失败对照：`err no-view`（窗口未建）、`err wrong-thread`、`err grab-null`、`err no-png-enc fmt=...`、`err save-fail`。
`no-png-enc` / `save-fail` 可能留下 **0 字节 PNG**，别把"文件存在"当成功。

操作界面（D6，`tools/touch-injector`）：

```sh
zig cc -target aarch64-linux-gnu.2.27 -O2 -o injector injector.c
adb push injector /userdisk/ && adb shell 'chmod +x /userdisk/injector'
I=/userdisk/injector
$I tap     ui 160 107                 # 点击（UI 逻辑坐标 ux uy）
$I swipe   ui 300 107 20 107          # 横向拖动（滚列表 / 抽插件抽屉）
$I longtap ui 160 107                 # 长按 600ms
$I type "hello"                       # 逐字符输入
$I tap     ui 20 15 --lefthand         # 左手模式坐标
```

隔离验证单个 QML 文件（不依赖宿主 context property 的部分）：

```sh
adb push test.qml /userdisk/
adb shell 'killall YoudaoDictPen; cd /tmp && XDG_RUNTIME_DIR=/var/run \
  WAYLAND_DISPLAY=wayland-0 QT_WAYLAND_SHELL_INTEGRATION=xdg-shell-v6 qmlscene /userdisk/test.qml'
```

`QT_WAYLAND_SHELL_INTEGRATION` 不能省（只装了 `libxdg-shell-v6.so`）。

## 8. 手动启用 / 禁用

```sh
adb shell touch /userdisk/PenMods/plugins/$ID/.disabled     # 禁用
adb shell rm    /userdisk/PenMods/plugins/$ID/.disabled     # 启用
```

重启后生效；UI 插件管理页的开关等价于 `pluginManager.setPluginEnabled(id, bool)`（运行期即时生效，无需重启）。
不要手动创建 `.loading`。装了 Hook 的插件用"写 `.disabled` + 重启"停用，不要在线禁用
（`plugin-abi.md` §6）。

## 9. 崩溃循环 → recovery（最后手段）

症状：ADB 重连后落在 ramdisk rootfs（`rootfs on / type rootfs`，只挂了 `/userdata`、`/userdisk`），
所有 `adb shell` 回 `login with "adb shell auth" to continue.`，`/userdata/syslog/messages` 里反复出现
`unhandled level 2 translation fault ... Comm: YoudaoDictPen`。固件已向 misc 分区写入 `boot-recovery`。

`system_a` 本身没有问题，**不要去"修复"它**。恢复步骤（D3 L577-L601）：

```sh
adb shell auth                       # 口令见仓库文档
adb shell 'rm -rf /userdisk/PenMods/plugins/<id>'          # 先移除肇因
adb shell 'cp -f /userdata/PenMods/libPenMods.known_good.so /userdata/PenMods/libPenMods.so'
adb shell 'dd if=/userdisk/Music/OTHERS/misc.img of=/dev/block/by-name/misc bs=4096 conv=fsync; sync'
adb shell 'md5sum /dev/block/by-name/misc'   # 应为 50e0f9d40f6912cbff7ac89b7862ab4c
adb shell 'reboot'
```

这是**破坏性操作**（写 misc 分区）：执行前向用户说明风险并取得明确同意。

## 10. 设备端路径

| 路径 | 内容 |
|---|---|
| `/userdisk/PenMods/plugins/<id>/` | 插件目录 |
| `/userdata/PenMods/libPenMods.so` | 主库（已映射，不可原地覆盖） |
| `/userdata/PenMods/libPenModsResources.so` | 外置资源库 |
| `/userdata/PenMods/qml/` | 外部 QML 导入路径（存在时生效） |
| `/userdata/PenModsconfig.json` | 用户配置（注意 `PenMods` 与 `config.json` 之间没有 `/`） |
| `/userdata/applog/DictPen_*.log` | 主进程 stdout |
| `/oem/YoudaoDictPen/output/YoudaoDictPen` | 主程序二进制（查符号用） |

## 11. 验收清单

- [ ] `verify_so.py` 通过（有 `.so` 时）：AArch64、GLIBC ≤ 2.27、导出 `init_plugin`
- [ ] 日志出现 `Found plugin` + `init_plugin() called` + `Successfully loaded SO`
- [ ] 日志无 `Failed to load SO` / `No init_plugin symbol` / `Auto-disabling` / `Symbol not found`
- [ ] 插件管理页开关为开、`loaded == true`、"打开"按钮可见；首页抽屉出现图标
- [ ] 日志无 QML 绑定错误关键词
- [ ] 截图确认 320×170 排版；返回后再次打开正常；Home 键能关闭页面
- [ ] 连续重启两次后插件未被自动禁用（无残留 `.loading`）
- [ ] 启动健康检查通过**之后**，实际功能在真机上验证过
