/** Electron preload 暴露的桌面能力（浏览器打开时为 undefined） */
export {};

declare global {
  interface Window {
    penmodsDesktop?: {
      isDesktop: boolean;
      platform: string;
      versions: { electron: string; chrome: string; node: string };
      openExternal: (url: string) => void;
    };
  }
}
