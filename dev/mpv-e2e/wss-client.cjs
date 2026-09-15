const tls = require('node:tls')
const crypto = require('node:crypto')

const port = Number(process.env.WSS_FIXTURE_PORT || 18444)
const key = crypto.randomBytes(16).toString('base64')
const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
  socket.write(`GET /api/desktop/v1/ws?roomId=fixture HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nOrigin: https://127.0.0.1\r\n\r\n`)
  console.log('WSS_FIXTURE_REQUEST_SENT')
})
let data = Buffer.alloc(0)
const timeout = setTimeout(() => { console.error('WSS_FIXTURE_HANDSHAKE_TIMEOUT'); socket.destroy(); process.exitCode = 1 }, 3000)
socket.on('data', chunk => {
  data = Buffer.concat([data, chunk])
  if (data.includes(Buffer.from('\r\n\r\n')) && data.includes(Buffer.from('server.hello'))) {
    console.log('WSS_FIXTURE_HANDSHAKE_OK')
    clearTimeout(timeout)
    socket.end()
  }
})
socket.on('error', error => { console.error(error); process.exitCode = 1 })
