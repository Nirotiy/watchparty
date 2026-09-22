const { contextBridge, ipcRenderer } = require('electron')
// Sandboxed preload cannot require local modules. Build inserts the shared allowlist here.
const commands = /* COMMANDS */ []
const events = /* EVENTS */ []
contextBridge.exposeInMainWorld('watchpartyDesktop', Object.freeze({
  runtime: 'electron',
  invoke(command, args = {}) {
    if (!commands.includes(command)) return Promise.reject(new Error('invalid_desktop_command'))
    return ipcRenderer.invoke('watchparty:request', command, args).then(reply => {
      if (Object.hasOwn(reply, 'error')) throw reply.error
      return reply.result
    })
  },
  listen(event, handler) {
    if (!events.includes(event) || typeof handler !== 'function') throw new Error('invalid_desktop_event')
    const listener = (_event, payload) => handler({ payload })
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  },
}))

// Windows transparent windows need an explicit caption hit region. Window buttons
// remain native Electron controls; no window-management capability enters React.
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const root = document.documentElement
    root.dataset.electronChrome = 'true'
    const style = document.createElement('style')
    style.textContent = `
      html[data-electron-chrome] { --desktop-title-height: 48px; }
      html[data-electron-chrome] body { padding-top: var(--desktop-title-height); }
      html[data-electron-chrome] #root { min-height: 0; }
      html[data-electron-chrome] #root .h-screen { height: calc(100vh - var(--desktop-title-height)); }
      #watchparty-titlebar {
        position: fixed; top: 0; left: 0;
        width: env(titlebar-area-width, calc(100% - 138px)); height: 48px;
        display: flex; align-items: center; padding-left: 20px;
        background: var(--card); color: var(--foreground); font: 600 16px "Segoe UI",system-ui;
        -webkit-app-region: drag; app-region: drag; user-select: none;
      }
      html[data-electron-fullscreen] { --desktop-title-height: 0px; }
      html[data-electron-fullscreen] #watchparty-titlebar { display: none; }
    `
    document.head.append(style)
    const caption = document.createElement('header')
    caption.id = 'watchparty-titlebar'
    caption.setAttribute('aria-hidden', 'true')
    document.body.prepend(caption)
    ipcRenderer.on('watchparty:fullscreen', (_event, fullscreen) => {
      root.toggleAttribute('data-electron-fullscreen', fullscreen === true)
    })
  }, { once: true })
}
