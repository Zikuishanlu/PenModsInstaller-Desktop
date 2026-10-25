import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 桌面版（Electron）禁用 service worker：本地服务本身就是最新资源，
// SW 缓存只会在升级后留下旧文件。
if ('serviceWorker' in navigator && !window.penmodsDesktop) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      console.log('ServiceWorker registration failed')
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
