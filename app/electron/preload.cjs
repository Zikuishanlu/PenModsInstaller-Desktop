'use strict';
/**
 * 极简 preload：只暴露只读的环境信息，渲染进程不需要直接使用 Node。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('penmodsDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  openExternal: (url) => {
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      ipcRenderer.invoke('penmods:open-external', url);
    }
  },
});
