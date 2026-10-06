const { spawn } = require('node:child_process')
const path = require('node:path')
const root = __dirname
const server = spawn(process.execPath, [path.join(root, 'wss-fixture.cjs')], { stdio: ['ignore', 'inherit', 'inherit'] })
setTimeout(() => {
  const client = spawn(process.execPath, [path.join(root, 'wss-client.cjs')], { stdio: 'inherit' })
  client.on('exit', code => { server.kill(); process.exit(code ?? 1) })
}, 300)
