# 实现原理：网页版为什么能在浏览器里给词典笔装 PenMods

> 这份文档解释 <https://pen.skdkzzx.dpdns.org/>（源码：[skdkzzx/PenModsInstaller](https://github.com/skdkzzx/PenModsInstaller)）
> 的工作原理，以及本桌面版如何**沿用同一套原理**把它搬进 Electron。
> 看完你就能自己复刻一份，或者把这里的代码接到别的前端上。

---

## 1. 一句话原理

词典笔本质上是一台 **Android 设备**，只是没有屏幕键盘去点「允许 USB 调试」。

所以整个方案的核心只有两件事：

1. **用 WebUSB 直接和设备的 ADB 守护进程说 ADB 协议**（浏览器里没有 `adb.exe`，那就自己实现协议）；
2. **把要改的文件推上去，然后用设备自带的 shell 执行几条命令**（`auth` → `remount` → 解压证书 → `init.sh` → `patch.sh` → `reboot`）。

网页只是壳子。真正干活的是「ADB over WebUSB」和「一串 shell 命令」。

---

## 2. 设备通道 A：WebUSB + ADB

### 2.1 拿设备

```ts
// src/lib/adb.ts:177
const rawDevice = await usb.requestDevice({ filters: [{ classCode: 0xff }] });
```

`classCode: 0xff` 是 USB 的「厂商自定义类」。词典笔的 ADB 接口就挂在这个类下，
所以不用枚举 VID/PID 也能精确命中，避免让用户在一堆 USB 设备里猜。

### 2.2 建立 ADB 会话

```ts
// src/lib/adb.ts:218
this.transport = await AdbDaemonTransport.authenticate({
  serial: adbDevice.serial,
  connection,
  credentialStore: this.credentialStore,   // BrowserCredentialStore
});
```

这一步做了三件事：

- **交换 ADB banner**（`CNXN` / `AUTH` 包），协商协议版本；
- **RSA 认证**：设备第一次见到某台电脑会要求授权。`BrowserCredentialStore`
  把生成的私钥存进 IndexedDB，所以第二次连接不用再授权；
- **升级成 transport**，之后就能跑 shell / sync 通道。

代码基于 [`@yume-chan/adb`](https://github.com/yume-chan/ya-webadb)（纯 TypeScript 的 ADB 实现）
和 `@yume-chan/adb-daemon-webusb`（把 WebUSB 的端点包装成 ADB 需要的字节流）。

### 2.3 三条通道的用途

| 通道 | 用途 | 特点 |
| --- | --- | --- |
| `sync:` | 推送/拉取文件 | 快，**不需要 `auth`** |
| `shell:` | 执行命令（非交互） | 一次拿全部输出，`&&`/重定向可用 |
| PTY（`shell:` + pty） | 交互式会话 | 有回显和提示符，**`auth` 只能在这里跑** |

设备上的 `auth` 是个需要 TTY 的命令（会读密码），所以安装脚本必须开一个 PTY 会话，
把 `echo 'CherryYoudao' | auth` 当成一条命令喂进去。

---

## 3. 设备通道 B：SSH over WebSocket（本地代理）

浏览器不能开 TCP 连接，所以「用 SSH 连设备」这件事**必须有个服务端帮忙**。

网页版的解法是在同一台服务器上跑一个 WebSocket 代理：

```
浏览器 ──ws://<host>/ws/ssh?target=host:port──► 代理（Node + ssh2）──TCP──► 词典笔:22
```

代理端（网页版是 `server.mjs` 和 `vite.config.ts` 里的插件，桌面版是 `app/electron/server.cjs` 的
`attachSshProxy`）把 SSH 的通道能力拆成 JSON 消息：

| 消息 | 作用 |
| --- | --- |
| `exec` | 在设备上执行命令，回传 stdout/stderr |
| `shell_exec` | 在**交互式 shell** 里跑一段脚本，末尾用 `__PM_DONE_<id>__` + 退出码做哨兵 |
| `shell_input` / `shell_resize` | 终端输入、窗口大小（配合 xterm.js） |
| `sftp_readdir` / `sftp_read` / `sftp_write` / `sftp_delete` / `sftp_rename` / `sftp_mkdir` / `sftp_rmdir` | 文件管理 |

> **为什么要 `shell_exec` 这种奇怪的东西？**
> 词典笔的 SSH server 的 `exec` 通道**不走 shell**：`&&`、`cd`、`unzip`、重定向全部失效。
> 所以要么用纯 SFTP 逐文件写（慢但可靠），要么进交互式 shell 喂脚本（快）。
> `DeviceConnection` 上的 `noShell` 标记就是这个坑的产物（`src/lib/device.ts`），
> 上层看到它就自动改走 SFTP 路径。

桌面版的优势就在这里：Electron 里可以**在主进程直接起这个代理**，前端代码一行都不用改
（`src/App.tsx` 只认 `window.location.host`，本地 HTTP 服务和页面同源，`ws://` 自然打通）。

---

## 4. 一次性安装全流程

`src/lib/installer.ts:66-137`，顺序不能乱：

```
1. 推 8 个文件（走 sync，不需要 auth）
   /userdisk/CA.zip
   /userdata/PenMods/libPenMods.so
   /userdata/PenMods/patch.sh
   /userdata/PenMods/misc/init.sh
   /userdata/PenMods/misc/patchelf
   /userdata/PenMods/misc/libm.so
   /userdata/PenMods/misc/libcrypt.so
   /userdata/PenMods/misc/libstdc++.so

2. 开一个 PTY，按顺序执行：
   echo 'CherryYoudao' | auth            # 设备 root 授权
   mount -o remount,rw /                 # 根分区可写
   cd /userdisk && unzip -oq CA.zip && mv CA/* /etc/ssl/certs/   # 可选：装 CA
   cd /userdata/PenMods && chmod +x patch.sh misc/init.sh misc/patchelf
   cd /userdata/PenMods/misc && ./init.sh
   cd /userdata/PenMods && ./patch.sh
   reboot
```

几个关键设计：

- **先推文件、后 auth**：sync 通道不需要授权，能省掉一次「授权窗口」的等待；
- **只开一个 PTY、串成一条命令链**：每次 `auth` 都要重新授权，链式执行避免反复；
- **`reboot` 是必须的**：`patch.sh` 改的是系统库/QML 资源，重启后才生效；
- **进度用日志流驱动**：`Installing` 页面把每一步的输出打进日志面板，失败时用户能直接看到哪条命令挂了。

---

## 5. 插件是怎么被「识别 + 安装」的

### 5.1 插件长什么样

一个 PenMods 插件就是一个目录，里面有一个 `metadata.json`：

```json
{
  "id": "com.reader.novel",
  "name": "电子书阅读器",
  "version": "1.4.0",
  "author": "skdkzzx",
  "description": "支持上传小说的小说阅读器",
  "icon": "file://userdisk/PenMods/plugins/novel-reader/icon.png",
  "main_qml": "main.qml",
  "main_so": "libshell_plugin.so"
}
```

- **安装目录名**藏在 `icon` 的路径里：`/plugins/<NAME>/` → `novel-reader`；
  没有 `icon` 就取 `id` 的最后一段，再没有就用仓库名。
- 插件放在 `/userdisk/PenMods/plugins/<NAME>/`。

### 5.2 从 zip / 目录解析

`src/lib/plugin-install.ts`：

- `parsePluginFromZip(zip)`：用 JSZip 遍历条目，**排除 `源码` / `source` / `src` 目录**
  （仓库常常同时打包源码，不能塞进设备），以 `metadata.json` 所在目录为插件根；
- 图标文件读成 `iconData`（base64）用于在列表里显示；
- `installPlugin(conn, pkg, onProgress)`：
  - **ADB**：把整包重新压成一个 zip，一次 `pushFile` 推到 `/userdisk/`，再 `unzip` 到插件目录；
  - **SSH（`noShell`）**：`installViaSftp` 逐文件写，先 `mkdirp` 再由 SFTP 上传。

### 5.3 插件市场（桌面版新增）

因为插件仓库没有任何统一 registry，本桌面版用「扫 GitHub 仓库内容」来发现插件（`src/lib/market.ts`）：

1. `GET /users/<owner>/repos` 列出仓库（过滤 fork/archived）；
2. 对每个仓库看**根目录**和**一级子目录** `plugin|plugins|src|app|source` 有没有 `metadata.json`；
3. 有就拉 `raw` 解析成一张卡片（名字/版本/作者/图标/星数）；
4. 安装时下载 `https://codeload.github.com/<owner>/<repo>/zip/refs/heads/<branch>` 整仓 zip，
   走 `installPluginBytes()`：校验 PK 头 → `JSZip.loadAsync` → `parsePluginFromZip` → `installPlugin`。

> 所以「发布一个插件」= 把插件推到 GitHub，并在仓库根（或 `plugin/`、`src/` 之类的子目录）放一个 `metadata.json`。

---

## 6. 安装包市场

`src/lib/app-store.ts` 定义了一种更通用的东西：

```ts
AppPackage { id, name, description, sizeMB, files[], script, uninstallScript? }
```

- 支持 `.zip` / `.tar.gz` / `.tgz`；
- 解压后如果找到 `install.sh` 就执行它；
- 脚本末尾必须有 `__INSTALL_DONE__` 标记，否则判定失败（`MARKER` 常量）。

桌面版的安装包市场（`src/lib/market.ts` 的 `discoverApps`）从两个来源收包：

1. **GitHub Release 附件**：扫每个仓库最近 5 个 release，挑 `.zip/.tar.gz/.tgz`（>200MB 跳过）；
2. **仓库根 `app.json` 清单**：

```json
{
  "id": "my-app",
  "name": "我的工具",
  "version": "1.0.0",
  "description": "……",
  "author": "you",
  "archive": "dist/my-app.zip",
  "installScript": "install.sh",
  "icon": "icon.png"
}
```

安装时 `installMarketApp()`：下载 → 推到 `/userdisk/__market_pkg.zip` → 生成脚本
`remount → cd /userdisk → unzip/tar → 有 install.sh 就 sh → 清理`。

---

## 7. OTA 更新（Lyrecoul/penmods-ota）

那个仓库里是 `update_v<版本>.zip`，每个包里装着新的运行时库和一个 `_do_update.sh`：

```sh
mount -o remount,rw /
TARGET_DIR="/userdata/PenMods"
TEMP_DIR=$(pwd)
cp -f "$TEMP_DIR/libPenMods.so" "$TARGET_DIR/libPenMods.so" || exit 255
# 2.4.0 起包里还有 libPenModsResources.so（QML 资源库）
[ -f "$TEMP_DIR/libPenModsResources.so" ] && cp -f "$TEMP_DIR/libPenModsResources.so" "$TARGET_DIR/"
touch "$TEMP_DIR/INSTALL_SUCCESSFULLY"
```

设备端的执行逻辑（`src/lib/market-install.ts` 的 `otaScript()`）：

```
推 /userdisk/__penmods_ota.zip
→ unzip 到 /userdisk/__penmods_ota
→ FOUND=$(find ... -maxdepth 3 -name _do_update.sh | head -n1)   # 包内层级不固定
→ cd $(dirname $FOUND) && sh _do_update.sh
→ 校验 INSTALL_SUCCESSFULLY 存在
→ echo OTA_OK
```

两个坑写在这里，省得你踩：

- **`cd` 到脚本所在目录再执行**：`_do_update.sh` 用 `$(pwd)` 当 `TEMP_DIR`，在别处跑就找不到 `.so`；
- **主库和资源库要一起更新**：只换 `libPenMods.so` 会出现「新 C++ + 旧 QML」错配。

---

## 8. 桌面版跟网页版差在哪

| | 网页版 | 桌面版（本项目） |
| --- | --- | --- |
| 设备通道 | WebUSB | 一样（Electron 就是 Chromium） |
| 页面来源 | 远端 CDN | 本地 `http://127.0.0.1:47821/`（打包进 asar） |
| SSH 代理 | 服务端 `server.mjs` / vite 插件 | 主进程 `electron/server.cjs` 内建 |
| GitHub 请求 | 浏览器直连（受 CORS / 限流影响） | `/api/gh`、`/api/dl` 代理转发，可塞 Token |
| 端口 | 固定域名 | **固定 47821**（占用才回退随机），否则 localStorage 每次清零 |
| 更新 | 刷新页面 | 重装 exe |

为什么端口必须固定：渲染进程的 `localStorage`（连接模式、SSH 主机、市场 Token、免责声明已读）
是**按 origin 隔离**的，端口一变 origin 就变，用户每次都要重填。

另外两处在 `electron/server.cjs` 里值得抄走的细节：

- **`/api/dl` 必须关掉 gzip**：`undici` 会自动解压，但上游 `content-length` 还是压缩后的长度，
  原样转发会让前端按错误长度截断文件（实测 309B 的 `metadata.json` 只剩 237B，`JSON.parse` 直接炸）。
  所以请求头加 `accept-encoding: identity`，并且只有确实没压缩时才回 `Content-Length`；
- **`/api/gh` 白名单**：只放行 `/users/ /repos/ /search/ /orgs/ /rate_limit /releases`，防止被当成开放代理。

---

## 9. 想自己复刻一遍？

最小可行路径：

1. `npm create vite@latest my-installer -- --template react-ts`
2. `npm i @yume-chan/adb @yume-chan/adb-daemon-webusb jszip`
3. 抄 `src/lib/adb.ts`（WebUSB + authenticate + PTY）、`src/lib/installer.ts`（命令链）、
   `src/lib/plugin-install.ts`（zip 解析 + 安装）
4. 想要 SSH 模式，就再写一个 ws + ssh2 的代理，照第 3 节的消息表实现
5. 包成桌面版：`npm i -D electron electron-builder`，主进程起静态服务器 + 代理，
   `BrowserWindow` 指向 `http://127.0.0.1:<port>/`，记得放行 USB 权限：

```js
session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
  cb(['usb', 'serial', 'hid'].includes(permission)));
session.defaultSession.setDevicePermissionHandler(d => d.deviceType === 'usb');
```

6. `electron-builder --win` 出 exe。

本仓库已经把上面每一步都实现了，直接 `git clone` 当模板更快。

---

## 10. 目录速查

```
app/src/lib/adb.ts              WebUSB + ADB 连接、PTY、sync 推送
app/src/lib/device.ts           DeviceConnection 抽象（ADB / SSH 双实现）
app/src/lib/ssh.ts              浏览器侧的 WS 消息客户端
app/src/lib/installer.ts        PenMods 一次性安装命令链
app/src/lib/files.ts            8 个安装文件的清单与来源
app/src/lib/plugin-install.ts   插件解析与安装
app/src/lib/app-store.ts        通用安装包（zip/tar.gz + install.sh）
app/src/lib/github.ts           GitHub API 客户端 + 断点续传下载
app/src/lib/market.ts           插件市场 / 安装包市场的发现逻辑
app/src/lib/market-install.ts   市场包与 OTA 包的落地脚本
app/electron/main.cjs           主进程：窗口、USB 权限、单实例
app/electron/server.cjs         本地 HTTP 服务 + SSH WS 代理 + GitHub 代理
app/electron/preload.cjs        contextBridge（暴露 window.penmodsDesktop）
```

有更细的疑问，直接看代码里的注释 —— 每个「为什么这么写」都写在旁边了。
