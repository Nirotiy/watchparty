const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = __dirname
const server = https.createServer({
  key: fs.readFileSync(path.join(root, 'key.pem')),
  cert: fs.readFileSync(path.join(root, 'cert.pem')),
})
server.on('connection', () => console.log('wss fixture connection'))
server.on('secureConnection', () => console.log('wss fixture secure connection'))
server.on('request', (request, response) => {
  console.log(`wss fixture request ${request.method} ${request.url}`)
  response.writeHead(200)
  response.end('ok')
})
server.on('clientError', (error) => console.log(`wss fixture clientError ${error.code || error.message}`))

server.on('upgrade', (request, socket) => {
  console.log(`wss fixture upgrade ${request.method} ${request.url}`)
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string') return socket.destroy()
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const body = Buffer.from(JSON.stringify({ type: 'server.hello', payload: { apiVersion: '2026-01', minimumClientVersion: '0.2.0' } }))
  socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]))
  socket.on('error', () => {})
})

server.listen(Number(process.env.WSS_FIXTURE_PORT || 18444), '127.0.0.1', () => {
  console.log(`wss fixture listening on ${server.address().port}`)
})
