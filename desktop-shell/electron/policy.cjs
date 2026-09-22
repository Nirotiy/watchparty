// Shared by main and the sandboxed preload bundle. No caller-selected native channels.
const commands = Object.freeze([
  'musicPartyRequest', 'clearMusicPartySession', 'musicPartyWsConnect', 'musicPartyWsSend',
  'musicPartyWsReceive', 'musicPartyWsDisconnect', 'musicPartyAudio', 'getDesktopSettings',
  'updateDesktopSettings', 'listOriginTrust', 'importOriginTrust', 'deleteOriginTrust',
  'promptSiteCredentials', 'clearSiteCredentials', 'verifyBackend', 'createDesktopRoom',
  'accessDesktopRoom', 'startDesktopSession', 'restoreDesktopSession', 'stopDesktopSession',
  'checkpointDesktopSession', 'suspendDesktopSession', 'rollbackDesktopSession', 'discardDesktopSessionCheckpoint',
  'executeRoomCommand', 'currentDesktopLaunch', 'mediaRoots', 'mediaList', 'mediaSearch',
  'updateDesktopWindowChrome',
  'listAudioOutputDevices',
  'getDesktopWallpaperBackdrop',
])
const events = Object.freeze([
  'desktop://state', 'desktop://launch', 'desktop://session-reset', 'desktop://settings',
  'musicparty://audio-error',
])
function validRequest(command, args) {
  if (!commands.includes(command) || !args || typeof args !== 'object' || Array.isArray(args)) return false
  if (command === 'listAudioOutputDevices') return Object.keys(args).length === 0
  if (command === 'getDesktopWallpaperBackdrop') return Object.keys(args).length === 0
  if (command === 'updateDesktopWindowChrome') return (args.title === 'Banguru' || args.title === 'Linkle') && (args.theme === 'dark' || args.theme === 'light') && (args.windowMaterial === 'auto' || args.windowMaterial === 'none')
  try { return Buffer.byteLength(JSON.stringify(args)) <= 1024 * 1024 - 256 } catch { return false }
}
module.exports = { commands, events, validRequest }
