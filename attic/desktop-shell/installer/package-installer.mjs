import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const installerDirectory = dirname(fileURLToPath(import.meta.url))
const electronDirectory = resolve(installerDirectory, '..', 'electron')
const root = resolve(installerDirectory, '../..')
const version = JSON.parse(await readFile(join(electronDirectory, 'package.json'), 'utf8')).version
const args = process.argv.slice(2)
const preconfigured = args.includes('--preconfigured')
const payloadArgument = args.find(arg => arg.startsWith('--payload='))
const outputArgument = args.find(arg => arg.startsWith('--output='))
const payload = payloadArgument ? resolve(payloadArgument.slice('--payload='.length)) : null
const distributionRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Banguru', 'distribution')
  : join(root, 'artifacts', 'installer')
const output = outputArgument ? resolve(outputArgument.slice('--output='.length)) : join(distributionRoot, `Banguru-${version}-Setup.exe`)
if (args.some(arg => arg !== '--preconfigured' && !arg.startsWith('--payload=') && !arg.startsWith('--output='))) throw new Error('invalid_installer_argument')
if (preconfigured && payloadArgument) throw new Error('preconfigured_cannot_reuse_payload')

let payloadDirectory = payload
if (payloadDirectory) {
  if (!(await stat(join(payloadDirectory, 'Banguru.exe')).catch(() => null))) throw new Error('payload_missing_Banguru_exe')
} else {
  const raw = execFileSync(process.execPath, ['package-local.mjs', '--installed', ...(preconfigured ? ['--preconfigured'] : [])], { cwd: electronDirectory, encoding: 'utf8' })
  const record = JSON.parse(raw.trim())
  payloadDirectory = record.output
}
const pathMakensis = (() => {
  try { return execFileSync('where.exe', ['makensis.exe'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean) } catch { return null }
})()
const makensis = process.env.NSIS_MAKENSIS ?? pathMakensis ?? [
  'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  'C:\\Program Files\\NSIS\\makensis.exe',
].find(candidate => candidate && existsSync(candidate))
if (!makensis) {
  console.error(`NSIS compiler not found. Install NSIS 3.x or set NSIS_MAKENSIS. Payload is ready at ${payloadDirectory}`)
  process.exitCode = 2
} else {
  await mkdir(dirname(output), { recursive: true })
  const nsi = join(installerDirectory, 'Banguru.nsi')
  execFileSync(makensis, [
    `/DROOT=${root}`,
    `/DPAYLOAD=${payloadDirectory}`,
    `/DOUTFILE=${output}`,
    `/DVERSION=${version}`,
    nsi,
  ], { cwd: installerDirectory, stdio: 'inherit', windowsHide: true })
  console.log(JSON.stringify({ installer: output, payload: payloadDirectory, version }, null, 2))
}
