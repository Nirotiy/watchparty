import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
environment.WATCHPARTY_LOCAL_LAUNCH = '1'
// Electron 44 crashes during Chromium sandbox startup in the Windows Git Bash
// environment used by this project. Keep the workaround in the launcher so
// every local check and the dev app use the same runtime configuration.
const child = spawn(require('electron'), ['--no-sandbox', fileURLToPath(new URL('.', import.meta.url)), ...process.argv.slice(2)], {
  env: environment, stdio: 'inherit', windowsHide: true,
})
child.on('error', () => { console.error('electron_launch_failed'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
