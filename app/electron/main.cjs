'use strict';
/**
 * PenMods Installer — Electron 主进程
 *
 * 1. 在 127.0.0.1 的随机端口起本地服务（静态站点 + SSH WebSocket 代理 + GitHub 代理）
 * 2. 用 BrowserWindow 加载它，从而 WebUSB / 同源 fetch / WebSocket 全部正常工作
 * 3. 处理 WebUSB 设备选择与权限（Electron 不会弹 Chrome 的原生选择框）
 */
const { app, BrowserWindow, Menu, session, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer } = require('./server.cjs');

// 启动日志：万一窗口没出来，用户可以在 %TEMP%\penmods-installer-boot.log 里看到卡在哪一步
const BOOT_LOG = path.join(os.tmpdir(), 'penmods-installer-boot.log');
function bootLog(msg) {
  try {
    fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* noop */ }
}

const isDev = !app.isPackaged;
let mainWindow = null;
let localServer = null;

bootLog(`---- start up: exe=${process.execPath} packaged=${app.isPackaged}`);

// 只允许运行一个实例，避免多个进程同时抢占 USB 设备
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  bootLog('another instance already running → quit this one');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      revealWindow();
    }
  });
}

/** 是否看起来像 Android/ADB 设备（USB 接口类 0xff 厂商自定义，或 0x0a CDC） */
function looksLikeAdb(device) {
  try {
    const interfaces = device.interfaces || device.configurations || [];
    const list = Array.isArray(interfaces) ? interfaces : Object.values(interfaces);
    return list.some((i) => i && (i.interfaceClass === 0xff || i.interfaceClass === 10 || i.class === 0xff));
  } catch {
    return false;
  }
}

function setupUsb() {
  const ses = session.defaultSession;

  // 允许页面使用 USB 设备（本应用是本地可信桌面程序）
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'usb' || permission === 'serial' || permission === 'hid') return callback(true);
    // WebUSB 需要：media 等其它权限一律拒绝
    callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
  });

  ses.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'usb') return true;
    return false;
  });

  // 不弹 Chromium 原生选择框，自动挑第一个像 ADB 的设备
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const list = details.deviceList || [];
    if (list.length === 0) return callback('');
    const preferred = list.find((d) => looksLikeAdb(d.device) || looksLikeAdb(d)) || list[0];
    callback(preferred.deviceId);
  });

  // 个别 Chromium 版本对已知设备做拦截，这里全部放行
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'usb' || permission === 'clipboard-sanitized-write');
}

function setupMenu() {
  Menu.setApplicationMenu(null);
}

/**
 * 把窗口显示出来并提到最前。
 * Windows 有前台窗口锁（foreground lock），单纯 show()+focus() 经常只让任务栏图标闪一下，
 * 用户会以为「点了没反应」，所以这里短暂置顶再取消置顶。
 */
function revealWindow() {
  if (!mainWindow) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.moveTop();
  } catch { /* noop */ }
}

async function createWindow() {
  const root = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    dialog.showErrorBox('资源缺失', '未找到 dist/index.html，请先执行构建（npm run build）。');
    app.quit();
    return;
  }

  localServer = await startServer({ root, appVersion: app.getVersion() });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f172a',
    title: 'PenMods 安装器',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => revealWindow());
  // 兜底：某些机器上 ready-to-show 迟迟不来（首帧慢/显卡驱动），3 秒后强显
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) revealWindow();
  }, 3000);
  mainWindow.loadURL(`http://127.0.0.1:${localServer.port}/`).catch((e) => {
    revealWindow();
    dialog.showErrorBox('页面加载失败', String((e && e.message) || e));
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    revealWindow();
    dialog.showErrorBox('页面加载失败', `${desc} (${code})\n本地服务：http://127.0.0.1:${localServer.port}/`);
  });

  // 外部链接交给系统浏览器，窗口内不允许跳转到别的站点
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const origin = `http://127.0.0.1:${localServer.port}`;
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // F12 / Ctrl+Shift+I 打开开发者工具（排障用）
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.setAppUserModelId('org.zikuishanlu.penmods.installer');

ipcMain.handle('penmods:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) return shell.openExternal(url);
  return false;
});

process.on('uncaughtException', (e) => {
  bootLog(`uncaughtException: ${(e && e.stack) || e}`);
});

app.whenReady().then(async () => {
  bootLog('app ready');
  setupMenu();
  setupUsb();
  try {
    await createWindow();
    bootLog(`window created, url=http://127.0.0.1:${localServer && localServer.port}/`);
  } catch (e) {
    bootLog(`createWindow failed: ${(e && e.stack) || e}`);
    dialog.showErrorBox('启动失败', String((e && e.stack) || e));
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  try { localServer && localServer.server.close(); } catch { /* noop */ }
});
