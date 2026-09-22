import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [fileURLToPath(new URL('.', import.meta.url)), ...process.argv.slice(2)], {
  env: environment, stdio: 'inherit', windowsHide: true,
})
child.on('error', () => { console.error('electron_launch_failed'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
