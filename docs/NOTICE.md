# 开源协议与来源声明（NOTICE）

本项目（PenMods Installer Desktop，以下简称「本项目」）是**开源软件的修改再分发**，
不是从零写的原创程序。为了遵守上游许可证，这里把话说清楚。

---

## 1. 许可证

本项目整体以 **GNU General Public License v3.0（GPL-3.0）** 发布，
全文见仓库根目录的 [LICENSE](../LICENSE)，也可在 <https://www.gnu.org/licenses/gpl-3.0.html> 查看。

GPL-3.0 给了你四件事：

- **可以**自由使用、复制、修改、分发本项目（甚至商用）；
- **必须**在你分发（包括打包成 exe 发给别人）时：
  - 附上本许可证全文；
  - **公开完整对应源码**——就是你改过的这份代码，不能只发 exe；
  - 标注你改了什么、什么时候改的（见第 3 节）；
  - 保留原作者的版权声明与免责声明；
- **不能**把本项目（或其修改版）变成闭源专有软件再分发；
- **没有**任何担保，作者不为设备变砖、数据丢失等后果负责。

---

## 2. 上游项目与本项目的关系

| 项目 | 许可证 | 本项目用它做了什么 |
| --- | --- | --- |
| [PenUniverse/PenMods](https://github.com/PenUniverse/PenMods) | GPL-3.0 | 设备端内核（`libPenMods.so`、`patch.sh`、`misc/*`）。本项目把这些文件原样分发给设备，**未修改** |
| [skdkzzx/PenModsInstaller](https://github.com/skdkzzx/PenModsInstaller) | GPL-3.0 | 本项目的**直接上游**：前端页面、`src/lib/*` 的设备通信/安装逻辑、`public/files` 安装包都来自这里 |
| [yume-chan/ya-webadb](https://github.com/yume-chan/ya-webadb) | MIT | `@yume-chan/adb`、`@yume-chan/adb-daemon-webusb`：浏览器里实现 ADB over WebUSB |
| 本项目新增部分 | GPL-3.0 | Electron 主进程与本地服务、插件市场、安装包市场、OTA 更新页 |

> 简言之：**界面和安装逻辑来自网页版 PenModsInstaller，设备端来自 PenMods，本项目新增的是「桌面壳 + 三个市场」。**
> 因此本项目必须继续以 GPL-3.0 分发。这一点没有商量余地——GPL 是传染性的（copyleft）。

---

## 3. 相对上游的修改说明（GPL-3.0 §5(a) 要求）

本项目基于 `skdkzzx/PenModsInstaller` 的源码（主干版本）修改，主要变更：

1. **新增 Electron 桌面外壳**：`app/electron/{main,preload,server}.cjs`
   - 主进程内建静态文件服务 + SSH WebSocket 代理 + GitHub API/下载代理；
   - USB 设备权限放行（`setPermissionRequestHandler` / `setDevicePermissionHandler`）；
   - 固定监听端口 `47821`（占用时回退随机端口），避免 localStorage 因 origin 变化被清空。
2. **新增三个功能页面**（`app/src/pages/`）：
   - `PluginMarket`：从 GitHub 仓库扫描 `metadata.json` 发现并安装插件；
   - `AppsMarket`：从 GitHub Release 附件与仓库 `app.json` 清单发现并安装安装包；
   - `OtaPage`：从 `Lyrecoul/penmods-ota` 拉取 `update_*.zip` 并推送到设备执行 `_do_update.sh`。
3. **新增数据层**：`app/src/lib/{github,market,market-install,branding}.ts`
   （GitHub API 客户端、断点续传下载、市场发现逻辑、OTA 脚本生成、品牌常量）。
4. **原文案与品牌**：页脚、标题、关于信息改为指向本项目；
   `screenshots/` 为本项目界面截图。
5. **移除**：上游的 Node 服务端 `server.mjs` / `proxy.mjs` / 部署脚本（由 Electron 主进程内的服务替代）；
   上游单元测试（`src/**/__tests__`）保留在源码中但未纳入构建。

未修改的部分：`app/src/lib/{adb,device,ssh,installer,files,plugin-install,app-store,steps,youdaoxt,credential-store}.ts`
的设备通信与安装算法逻辑、各安装向导页面、`app/public/files/**` 的安装包内容。

修改日期：2026-10（初版）。

---

## 4. 第三方组件清单

运行时依赖（均为宽松许可，可与 GPL-3.0 共存）：

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| react / react-dom | 19.3.1 | MIT | UI |
| @yume-chan/adb | 2.6.4 | MIT | ADB 协议实现 |
| @yume-chan/adb-daemon-webusb | 2.3.2 | MIT | WebUSB 传输层 |
| jszip | 3.10.2 | MIT 或 GPL-3.0-or-later | zip 解析/打包 |
| ssh2 | 1.17.0 | MIT | SSH 代理（主进程） |
| ws | 8.22.0 | MIT | WebSocket |
| @xterm/xterm、xterm、xterm-addon-fit | 6.0.0 / 5.3.0 / 0.8.0 | MIT | 终端 |
| electron | 39.8.10 | MIT | 桌面运行时 |
| electron-builder | 26.x | MIT | 打包 |

构建期依赖（Vite、Tailwind、TypeScript 等）不进入产物，其许可证不影响分发。

设备端 `app/public/files/**` 来自 PenUniverse/PenMods（GPL-3.0），随本项目一起以 GPL-3.0 分发。

---

## 5. 免责声明

- 本工具会**修改词典笔的系统分区**（替换系统应用、注入动态库、安装 CA 证书），
  操作不当或意外中断可能导致设备变砖、功能异常、数据丢失、保修失效。
- 本项目作者不对任何直接或间接损失负责，使用即代表你自行承担全部风险。
- 本项目与网易有道无任何关联。请勿用于违反设备用户协议或当地法律的用途。
- 仅适用于有道词典笔 **2 代（YDP02x）** 与 **3 代（YDPG3）**，其他型号请勿尝试。

---

## 6. 如何获取源码

- 对应源码：本仓库（git 标签与你拿到的版本号一致，例如 `v1.0.0`）；
- 若你只拿到了 exe：仓库根目录 `README.md` 里有构建步骤，
  `npm ci && npm run dist` 可复现同一份产物；
- 上游源码：<https://github.com/skdkzzx/PenModsInstaller>、<https://github.com/PenUniverse/PenMods>。

如果你修改后再分发，请把「你的仓库地址 + 修改说明」补到本文档第 3 节——这是 GPL 要求的，
也是对下一个人最基本的礼貌。
