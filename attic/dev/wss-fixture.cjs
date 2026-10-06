const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')

const root = __dirname
const server = https.createServer({
  key: fs.readFileSync(process.env.WSS_FIXTURE_KEY || path.join(root, 'key.pem')),
  cert: fs.readFileSync(process.env.WSS_FIXTURE_CERT || path.join(root, 'cert.pem')),
})
server.on('connection', () => console.log('wss fixture connection'))
server.on('secureConnection', () => console.log('wss fixture secure connection'))
server.on('request', (request, response) => {
  console.log(`wss fixture request ${request.method} ${request.url}`)
  response.writeHead(200)
  response.end('ok')
})
server.on('clientError', (error) => console.log(`wss fixture clientError ${error.code || error.message}`))

server.on('upgrade', (request, socket, head) => {
  console.log(`wss fixture upgrade ${request.method} ${request.url}`)
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string') return socket.destroy()
  const strict = process.env.WSS_FIXTURE_STRICT === '1'
  if (strict) {
    const headers = request.headers
    if (request.url !== '/api/desktop/v1/ws?roomId=fixture' ||
        headers.origin !== `https://127.0.0.1:${server.address().port}` ||
        headers['x-desktop-api-version'] !== '2026-01' ||
        headers['x-desktop-client-version'] !== '0.2.0' ||
        headers.cookie !== 'MP_SESSION=fixture-session; MP_CSRF=fixture-csrf; MP_ROOM_ACCESS=fixture-room') {
      socket.destroy()
      throw new Error('WSS fixture handshake headers did not match')
    }
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const body = Buffer.from(JSON.stringify({ type: 'server.hello', payload: { apiVersion: '2026-01', minimumClientVersion: '0.2.0' } }))
  const hello = Buffer.concat([Buffer.from([0x81, body.length]), body])
  socket.on('error', () => {})
  if (!strict) { socket.write(hello); return }

  // This fixture accepts only small, unfragmented masked text messages.
  // Buffer TCP chunks because a single WebSocket frame may arrive in several reads.
  let pending = Buffer.alloc(0)
  let negotiated = false
  socket.setTimeout(5000, () => socket.destroy())
  const consume = chunk => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 2) {
      assert.equal(pending[0], 0x81, 'expected a complete text frame')
      assert.ok(pending[1] & 0x80, 'client frames must be masked')
      const length = pending[1] & 0x7f
      assert.ok(length < 126, 'fixture accepts payloads below 126 bytes')
      if (pending.length < length + 6) return
      const mask = pending.subarray(2, 6)
      const payload = Buffer.from(pending.subarray(6, 6 + length))
      pending = pending.subarray(6 + length)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      const event = JSON.parse(payload.toString('utf8'))
      if (!negotiated) {
        assert.deepEqual(event, { type: 'client.hello', payload: { apiVersion: '2026-01', clientVersion: '0.2.0' } })
        negotiated = true
        socket.write(hello)
        process.send?.({ type: 'hello-validated' })
      } else {
        assert.deepEqual(event, { type: 'fixture.echo', payload: { nonce: 'rust-roundtrip' } })
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
        process.send?.({ type: 'roundtrip-validated' })
      }
    }
  }
  socket.on('data', consume)
  if (head.length) consume(head)
})

server.listen(Number(process.env.WSS_FIXTURE_PORT || 18444), '127.0.0.1', () => {
  console.log(`wss fixture listening on ${server.address().port}`)
  process.send?.({ type: 'ready', port: server.address().port, pid: process.pid })
})
