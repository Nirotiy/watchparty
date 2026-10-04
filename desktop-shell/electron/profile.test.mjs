import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { desktopProfile, installationMarker } from './profile.mjs'

test('installed upgrades retain a stable profile outside the installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'banguru-profile-test-'))
  try {
    const options = { appData: join(root, 'roaming'), localAppData: join(root, 'local') }
    const first = join(root, 'install-v1')
    const second = join(root, 'install-v2')
    for (const folder of [first, second]) {
      mkdirSync(folder)
      writeFileSync(join(folder, installationMarker), '')
    }
    const before = desktopProfile({ ...options, executableDirectory: first })
    mkdirSync(before.userDataPath, { recursive: true })
    writeFileSync(join(before.userDataPath, 'settings.json'), '{"nickname":"retain"}')
    const after = desktopProfile({ ...options, executableDirectory: second })
    assert.equal(after.installed, true)
    assert.equal(after.portable, false)
    assert.equal(after.userDataPath, join(options.localAppData, 'Banguru', 'User Data'))
    assert.equal(before.userDataPath, after.userDataPath)
    assert.equal(readFileSync(join(after.userDataPath, 'settings.json'), 'utf8'), '{"nickname":"retain"}')
    const isolated = desktopProfile({ ...options, executableDirectory: second, acceptanceProfile: join(root, 'fixture') })
    assert.equal(isolated.installed, false)
    assert.equal(isolated.userDataPath, join(root, 'fixture'))
    assert.throws(() => desktopProfile({ ...options, localAppData: undefined, executableDirectory: second }), /installed_profile_path_missing/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('portable and development data paths remain separate from installed data', () => {
  const options = { executableDirectory: tmpdir(), appData: join(tmpdir(), 'roaming'), localAppData: join(tmpdir(), 'local') }
  const portable = desktopProfile(options)
  const development = desktopProfile({ ...options, defaultApp: true })
  assert.equal(portable.portable, true)
  assert.equal(portable.userDataPath, join(options.executableDirectory, 'user-data'))
  assert.equal(development.userDataPath, join(options.appData, 'WatchParty-Electron-Local'))
  assert.equal(development.installed, false)
})
