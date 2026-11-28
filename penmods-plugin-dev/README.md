# PenMods 插件开发 Skill

面向网易有道词典笔 YDP02X 的 PenMods 插件开发辅助 Skill。整理自 [`Lyrecoul/PenMods`](https://github.com/Lyrecoul/PenMods) 提交 `cb8e352`（2026-11-26）的全部文档与相关源码，把分散在 `doc/`、`AGENTS.md`、`src/plugin/`、`src/media/` 和内嵌 QML 里的插件开发契约，收敛为可直接指导实际开发的内容。

适用：写插件、改插件、编译 `.so`、接 `mediaSession`、Hook 宿主函数、部署到设备、排障与验收。
不适用：PenMods 核心仓库自身的 xmake 构建与发布流程（见上游 `README.md` / `AGENTS.md`）。

## 目录内容

| 路径 | 说明 |
|---|---|
| `SKILL.md` | 主文档：文档结构与梳理范围、核心概念、关键步骤、配置方式、接口与生命周期、常见约束、最佳实践、来源链接与排障速查 |
| `references/repo-docs-map.md` | 33 份文档的分类清单与永久链接；文档与源码的 11 处差异；仓库未提供的东西 |
| `references/plugin-abi.md` | 目录布局、`metadata.json` 解析行为、导出符号、真实加载顺序、崩溃自愈、`pluginManager` API、日志文案 |
| `references/hook-api.md` | `PluginHookAPI`、SymDB 行为、最小 Hook 插件、常用符号、detour 要求、故障排除 |
| `references/qml-ui.md` | 插件页装载契约、可用 context property、原生组件 import、页面骨架、自检清单 |
| `references/media-session.md` | `mediaSession` QML API 与 C ABI 全量语义、会话生命周期规则 |
| `references/build-deploy-debug.md` | Zig/CMake 编译、产物自检、部署与重启纪律、日志、截图、触摸注入、恢复、验收清单 |
| `scripts/new_plugin.py` | 生成插件脚手架（纯 QML 或含 `.so`） |
| `scripts/verify_so.py` | 纯标准库 ELF 检查：AArch64、依赖、`GLIBC ≤ 2.27`、入口符号 |
| `scripts/deploy_plugin.sh` | 推送运行期文件到设备并重启（`.so` 走 tmp + rename） |
| `assets/plugin-template/` | `metadata.json`、`Main.qml`、`plugin.cpp`、`build.sh`、与上游一致的 `PluginSDK.h` |
| `penmods-plugin-dev.zip` | 可直接分发/导入的 Skill 包（本目录的打包快照） |

## 安装与使用

1. 下载 `penmods-plugin-dev.zip` 并解压，或直接复制本目录。
2. 将解压后的 `penmods-plugin-dev/` 目录放到 WorkBuddy 的 skills 目录：
   - 用户级：`~/.workbuddy-ai/skills/penmods-plugin-dev/`
   - 项目级：`<项目>/.workbuddy-ai/skills/penmods-plugin-dev/`
3. 之后在对话中提出插件开发需求即可触发；也可按主题直接查 `references/`。

常用命令（在插件项目目录执行）：

```sh
python scripts/new_plugin.py com.example.myplugin "My Plugin" --out ./plugins      # 纯 QML
python scripts/new_plugin.py com.example.native "Native" --out ./plugins --with-so  # 含原生 SO
python scripts/verify_so.py build/libnative.so                                      # 推送前自检
sh scripts/deploy_plugin.sh ./plugins/com.example.native                            # 部署并重启
```

也可把上面的脚本路径替换为安装后的 skills 目录里的绝对路径。

## 内容与约定

- **源码优先**：上游文档与源码冲突时以 `src/plugin/`、`src/media/` 源码为准；差异逐条列在 `references/repo-docs-map.md`。
- **显式标注推断**：由源码推断、未做真机验证的结论统一标 `【源码推断】`，包括图标的 `file:///` 写法、原生 QML 组件目录 import、Hook 插件不宜在线禁用。
- **设备事实**：逻辑分辨率 320×170；插件目录 `/userdisk/PenMods/plugins/<id>/`；日志 `/userdata/applog/DictPen_*.log`；已加载的 `.so` 不可原地覆盖。
- **更新基线**：上游 ABI 或加载流程变更后，重新核对 `PluginManager.cpp`、`PluginSDK.h`、`MediaSession.cpp` 与 `qrc_qml.h`，并同步本 Skill。
- **验证边界**：Skill 的脚手架生成、Shell 语法和 ELF 校验脚本已用真实 aarch64 样本测试；交叉编译与真机部署需在本机安装 Zig/ADB 后自行完成。

## 主要来源

- [插件开发指南](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/PLUGIN_DEV_GUIDE.md)
- [插件 Hook API 指南](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/doc/PLUGIN_HOOK_DEV_GUIDE.md)
- [PluginSDK.h（公开 C ABI）](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/plugin/PluginSDK.h)
- [PluginManager.cpp（加载器）](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/plugin/PluginManager.cpp)
- [MediaSession.cpp（媒体会话）](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/src/media/MediaSession.cpp)
- [AGENTS.md §Plugin System](https://github.com/Lyrecoul/PenMods/blob/cb8e352698067d3fb122e1c3f38ce90efe88cfe8/AGENTS.md#L395-L422)

`assets/plugin-template/sdk/PluginSDK.h` 来自上游 PenMods（GPL-3.0）；本 Skill 的文档与脚本按同一许可随上游源码分发。
