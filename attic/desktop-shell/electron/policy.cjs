// Shared by main and the sandboxed preload bundle. No caller-selected native channels.
const commands = Object.freeze([
  'musicPartyRequest', 'clearMusicPartySession', 'musicPartyWsConnect', 'musicPartyWsSend',
  'musicPartyWsReceive', 'musicPartyWsDisconnect', 'musicPartyAudio', 'getDesktopSettings',
  'updateDesktopSettings', 'listOriginTrust', 'importOriginTrust', 'deleteOriginTrust',
  'promptSiteCredentials', 'clearSiteCredentials', 'verifyBackend', 'probeDesktopBackend',
  'probeDesktopReadiness', 'createDesktopRoom',
  'accessDesktopRoom', 'startDesktopSession', 'restoreDesktopSession', 'stopDesktopSession',
  'checkpointDesktopSession', 'suspendDesktopSession', 'rollbackDesktopSession', 'discardDesktopSessionCheckpoint',
  'executeRoomCommand', 'currentDesktopLaunch', 'getLinkleDevConfig', 'mediaRoots', 'mediaList', 'mediaSearch',
  'updateDesktopWindowChrome',
  'listAudioOutputDevices',
  'getDesktopWallpaperBackdrop',
  'getDesktopWindowMaterial',
  'fetchArtworkImage',
  'saveTextFile',
  'mediaRequest',
  'mediaImage',
  'windowControl',
])
const events = Object.freeze([
  'desktop://state', 'desktop://launch', 'desktop://session-reset', 'desktop://settings',
  'musicparty://audio-error',
  'watchparty:window-state',
])
// Only the local demo server may run without TLS; anywhere else plaintext http would
// carry the session cookie over the wire. Enforced here, never only in the renderer.
const loopbackHost = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i
function allowsOrigin(origin) {
  if (typeof origin !== 'string') return false
  let url
  try { url = new URL(origin) } catch { return false }
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && loopbackHost.test(url.hostname)
}
function validRequest(command, args) {
  if (!commands.includes(command) || !args || typeof args !== 'object' || Array.isArray(args)) return false
  if (command === 'musicPartyRequest' || command === 'musicPartyWsConnect') return allowsOrigin(args.input?.origin)
  if (command === 'clearMusicPartySession') return allowsOrigin(args.origin)
  if (command === 'listAudioOutputDevices') return Object.keys(args).length === 0
  if (command === 'getDesktopWallpaperBackdrop') return Object.keys(args).length === 0
  if (command === 'getDesktopWindowMaterial') return Object.keys(args).length === 0
  if (command === 'probeDesktopBackend') return Object.keys(args).length === 0
  if (command === 'probeDesktopReadiness') return Object.keys(args).length === 0
  if (command === 'getLinkleDevConfig') return Object.keys(args).length === 0
  if (command === 'fetchArtworkImage') {
    const keys = Object.keys(args)
    return keys.length === 1 && keys[0] === 'url' && typeof args.url === 'string' && args.url.length > 0 && args.url.length <= 2048
  }
  // 通用媒体调用：路由与动词的权威白名单在 Rust 侧（native_api::media_route_allowed），
  // 这里只挡住明显不该出现的形状（未知动词、非 /api/ 路径、超大查询或非对象正文）。
  if (command === 'mediaRequest') {
    const keys = Object.keys(args)
    if (keys.length !== 4 || !['method', 'path', 'query', 'body'].every(key => keys.includes(key))) return false
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(args.method)) return false
    if (typeof args.path !== 'string' || !args.path.startsWith('/api/') || args.path.length > 512) return false
    if (args.query !== null && (typeof args.query !== 'string' || args.query.length > 2048)) return false
    if (args.body !== null && (typeof args.body !== 'object' || Array.isArray(args.body))) return false
    return true
  }
  if (command === 'updateDesktopWindowChrome') return (args.title === 'Banguru' || args.title === 'Linkle') && (args.theme === 'dark' || args.theme === 'light') && (args.windowMaterial === 'auto' || args.windowMaterial === 'none')
  // 自绘窗口按钮（顶栏由页面画，原生 WCO 已拆掉，见 main.mjs 的 BrowserWindow 选项）。
  if (command === 'windowControl') return ['minimize', 'maximize', 'close'].includes(args.action)
  // 封面/海报取图：渲染层只给一个是 media 还是 poster 的 kind 加不透明 id，
  // 字节由侧车取、主进程转成 HTTP 响应。
  if (command === 'mediaImage') {
    const keys = Object.keys(args)
    return keys.length === 2 && keys.includes('kind') && keys.includes('id')
      && ['media', 'poster'].includes(args.kind)
      && typeof args.id === 'string' && args.id.length > 0 && args.id.length <= 512
  }
  // 导出落盘：渲染层只给「建议文件名 + 后缀 + 文本」，路径永远由系统保存对话框决定，
  // 因此这里不接受任何调用方传来的路径（写哪儿不由页面说了算）。
  if (command === 'saveTextFile') {
    const keys = Object.keys(args)
    const allow = ['suggestedName', 'extension', 'text']
    return keys.length === 3 && keys.every(key => allow.includes(key))
      && typeof args.suggestedName === 'string' && args.suggestedName.length > 0 && args.suggestedName.length <= 120 && !/[\u0000-\u001f/\\:*?"<>|]/.test(args.suggestedName)
      && ['txt', 'csv', 'json'].includes(args.extension)
      && typeof args.text === 'string' && Buffer.byteLength(args.text) <= 4 * 1024 * 1024
  }
  try { return Buffer.byteLength(JSON.stringify(args)) <= 1024 * 1024 - 256 } catch { return false }
}
module.exports = { commands, events, validRequest }
