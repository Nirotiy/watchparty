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

// Windows transparent windows need an explicit caption hit region. The caption and its
// buttons are drawn here, outside React, so the playback page can drop the whole bar:
// the native overlay cannot be collapsed at runtime (setTitleBarOverlay only restyles),
// and the player wants the full window.
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
        position: fixed; top: 0; left: 0; z-index: 30;
        width: env(titlebar-area-width, 100%); height: 48px;
        display: flex; align-items: stretch; justify-content: space-between;
        background: var(--card); color: var(--foreground); font: 600 16px "Segoe UI",system-ui;
        -webkit-app-region: drag; app-region: drag; user-select: none;
      }
      #watchparty-titlebar .wpc-title { display: flex; align-items: center; padding-left: 20px; min-width: 0; overflow: hidden; white-space: nowrap; }
      .wpc-buttons { display: flex; align-items: stretch; -webkit-app-region: no-drag; app-region: no-drag; }
      .wpc-btn {
        width: 46px; display: grid; place-items: center; border: 0; padding: 0; margin: 0;
        background: transparent; color: inherit; cursor: default;
        font: 10px/1 "Segoe Fluent Icons", "Segoe MDL2 Assets";
      }
      .wpc-btn:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
      .wpc-btn:active { background: color-mix(in srgb, currentColor 18%, transparent); }
      .wpc-btn.wpc-close:hover { background: #c42b1c; color: #fff; }
      .wpc-btn.wpc-close:active { background: #b1271b; color: #fff; }
      .wpc-btn:focus-visible { outline: 2px solid var(--accent, #60cdff); outline-offset: -2px; }
      /* 播放页整屏不留顶栏（App 切 playback-mode）：窗口按钮由 RoomView 的悬浮控件承载。 */
      html.playback-mode { --desktop-title-height: 0px; }
      html.playback-mode body { padding-top: 0; }
      html.playback-mode #watchparty-titlebar { display: none; }
      html[data-electron-fullscreen] { --desktop-title-height: 0px; }
      html[data-electron-fullscreen] #watchparty-titlebar { display: none; }
    `
    document.head.append(style)
    const caption = document.createElement('header')
    caption.id = 'watchparty-titlebar'
    caption.setAttribute('aria-hidden', 'true')
    const title = document.createElement('span')
    title.className = 'wpc-title'
    const buttons = document.createElement('div')
    buttons.className = 'wpc-buttons'
    const glyphs = { minimize: '\uE921', maximize: '\uE922', restore: '\uE923', close: '\uE8BB' }
    const control = (action, glyph, className, label) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `wpc-btn ${className}`
      button.dataset.action = action
      button.tabIndex = -1
      button.setAttribute('aria-label', label)
      button.textContent = glyph
      button.addEventListener('click', () => { void ipcRenderer.invoke('watchparty:request', 'windowControl', { action }) })
      return button
    }
    const minimizeButton = control('minimize', glyphs.minimize, 'wpc-minimize', '最小化')
    const maximizeButton = control('maximize', glyphs.maximize, 'wpc-maximize', '最大化')
    const closeButton = control('close', glyphs.close, 'wpc-close', '关闭')
    buttons.append(minimizeButton, maximizeButton, closeButton)
    caption.append(title, buttons)
    document.body.prepend(caption)
    ipcRenderer.on('watchparty:fullscreen', (_event, fullscreen) => {
      root.toggleAttribute('data-electron-fullscreen', fullscreen === true)
    })
    ipcRenderer.on('watchparty:window-state', (_event, state) => {
      const maximized = state?.maximized === true
      maximizeButton.textContent = maximized ? glyphs.restore : glyphs.maximize
      maximizeButton.setAttribute('aria-label', maximized ? '向下还原' : '最大化')
    })
  }, { once: true })
}
