import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = path.resolve(process.argv[2] ?? '')
if (!root.startsWith(path.resolve('D:/WatchParty-Diagnostics') + path.sep)) throw new Error('Independent diagnostic root required')
const destination = path.join(root, 'review-upload')
if (fs.existsSync(destination)) throw new Error('Upload staging directory already exists')
fs.mkdirSync(destination)
const source = path.join(root, 'data/catalog-sidecars/offline-bundles')
const summaries = []
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
for (const report of JSON.parse(fs.readFileSync(path.join(root, 'bundle-results.json'), 'utf8')).reports) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(report.bundleId)) throw new Error('Unsafe bundle ID')
  const directory = path.join(source, report.bundleId)
  const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json'))
  if (sha(manifestBytes) !== report.bundleSha256) throw new Error('Reviewed manifest changed')
  const manifest = JSON.parse(manifestBytes)
  const files = [{ file: 'manifest.json', sha256: sha(manifestBytes), bytes: manifestBytes.length }, ...manifest.entries.flatMap(entry => [entry.collection, ...(entry.poster ? [entry.poster] : [])])]
  const target = path.join(destination, 'bundles/offline-bundles', report.bundleId)
  let bytes = 0
  for (const asset of files) {
    if (asset.file !== 'manifest.json' && !/^(collections|posters)\/[a-zA-Z0-9_-]+\.(json|png|jpg|webp)$/.test(asset.file)) throw new Error('Unexpected package file')
    const location = path.join(directory, asset.file)
    if (fs.lstatSync(location).isSymbolicLink()) throw new Error('Symbolic link in package')
    const content = fs.readFileSync(location)
    if (sha(content) !== asset.sha256 || content.length !== asset.bytes) throw new Error('Asset changed after review')
    if (asset.file.endsWith('.json')) {
      const text = content.toString('utf8')
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9_.-]{20,}|[?&](?:password|token|x-amz-signature|x-oss-signature)=/i.test(text)) throw new Error(`Sensitive data detected in ${report.bundleId}/${asset.file}`)
      const inspect = value => {
        if (!value || typeof value !== 'object') return
        for (const [key, child] of Object.entries(value)) {
          if (/^(?:password|username|authorization|apiKey|secret|approvalToken|tokenHash|mediaId|cachePath)$/i.test(key)) throw new Error(`Private field detected in ${report.bundleId}/${asset.file}`)
          inspect(child)
        }
      }
      inspect(JSON.parse(text))
    }
    fs.mkdirSync(path.dirname(path.join(target, asset.file)), { recursive: true })
    fs.copyFileSync(location, path.join(target, asset.file), fs.constants.COPYFILE_EXCL)
    bytes += content.length
  }
  summaries.push({ bundleId: report.bundleId, manifestSha256: report.bundleSha256, files: files.length, bytes, checkPassed: report.passed })
}
const revision = fs.existsSync(path.join(root, 'draft-decisions.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'draft-decisions.json'), 'utf8')).revision : ''
if (revision && !/^r[0-9]+$/.test(revision)) throw new Error('Invalid revision')
const archive = path.join(root, `offline-draft-review-20261001${revision ? '-' + revision : ''}.tar.gz`)
if (fs.existsSync(archive)) throw new Error('Archive already exists')
const result = spawnSync('tar', ['-czf', archive, '-C', destination, 'bundles'], { stdio: 'inherit' })
if (result.status !== 0) throw new Error('Packaging failed')
const receipt = { schema: 1, productionApplied: false, credentialScanPassed: true, archiveSha256: sha(fs.readFileSync(archive)), archiveBytes: fs.statSync(archive).size, bundles: summaries }
fs.writeFileSync(path.join(root, 'package-result.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
