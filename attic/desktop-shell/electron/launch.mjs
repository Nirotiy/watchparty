import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { developmentRuntime } from './dev-runtime.mjs'
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
environment.WATCHPARTY_LOCAL_LAUNCH = '1'
const child = spawn(await developmentRuntime(), [fileURLToPath(new URL('.', import.meta.url)), ...process.argv.slice(2)], {
  env: environment, stdio: 'inherit', windowsHide: true,
})
child.on('error', () => { console.error('electron_launch_failed'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
