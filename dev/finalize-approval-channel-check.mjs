// Read back the isolated copy after validation, and label this as final state rather than a pre-action backup.
import { DatabaseSync } from 'node:sqlite'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.tmpdir(), 'watchparty-approval-channel-0930')
const lines = ['Isolated copy final validation state; NOT a pre-action production backup.', `checkedAt=${new Date().toISOString()}`, 'copyMethod=VACUUM INTO']
for (const name of ['watchparty-library.sqlite', 'watchparty-catalog.sqlite']) {
  const db = new DatabaseSync(path.join(root, 'iso/data', name), { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('isolated integrity check failed')
    lines.push(`${name}: integrity_check=ok`)
    if (name.includes('catalog')) {
      const scan = db.prepare("SELECT MAX(rev) rev, COUNT(*) files FROM catalog_scan WHERE library_id='lib_anime'").get()
      lines.push(`lib_anime: rev=${scan.rev}, files=${scan.files}`)
      lines.push(`catalog_approvals=${db.prepare('SELECT COUNT(*) n FROM catalog_approvals').get().n}`)
    } else lines.push(`libraries=${db.prepare('SELECT COUNT(*) n FROM media_libraries').get().n}`)
  } finally { db.close() }
}
await writeFile(path.join(root, 'MANIFEST.txt'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
