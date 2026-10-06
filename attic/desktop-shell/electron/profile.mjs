import { existsSync, mkdtempSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

export const installationMarker = 'banguru-installed'

/** Installed profiles survive upgrades; portable and development profiles stay separate. */
export function desktopProfile({ defaultApp, executableDirectory, appData, localAppData, acceptanceProfile, checking }) {
  const installed = !defaultApp && existsSync(join(executableDirectory, installationMarker))
  const legacyPath = join(appData, 'WatchParty-Electron-Local')
  if (acceptanceProfile || checking) {
    return { installed: false, portable: false, legacyPath,
      userDataPath: acceptanceProfile ?? mkdtempSync(join(tmpdir(), 'watchparty-electron-smoke-')) }
  }
  if (installed && (!localAppData || !isAbsolute(localAppData))) throw new Error('installed_profile_path_missing')
  const portable = !defaultApp && !installed
  return { installed, portable, legacyPath,
    userDataPath: installed ? join(localAppData, 'Banguru', 'User Data')
      : portable ? join(executableDirectory, 'user-data') : legacyPath }
}
