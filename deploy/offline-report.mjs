import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

const root = path.resolve(process.argv[2] ?? '')
if (!root.startsWith(path.resolve('D:/WatchParty-Diagnostics') + path.sep)) throw new Error('Independent diagnostic root required')
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
const comparison = read('inventory-comparison.json')
const preparation = read('draft-preparation.json')
const packages = read('package-result.json')
const target = read('target-check-result.json')
const db = new DatabaseSync(path.join(root, 'data/watchparty-catalog.sqlite'), { readOnly: true })
const drafts = db.prepare('SELECT library_id,item_key,title,status,external_db,external_id,children,candidates FROM catalog_draft ORDER BY library_id,item_key').all().map(row => ({ ...row, children: JSON.parse(row.children), candidates: JSON.parse(row.candidates) }))
db.close()
for (const bundle of packages.bundles) {
  const directory = path.join(root, 'data/catalog-sidecars/offline-bundles', bundle.bundleId)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  for (const entry of manifest.entries) {
    const collection = JSON.parse(fs.readFileSync(path.join(directory, entry.collection.file), 'utf8'))
    const draft = drafts.find(card => card.library_id === manifest.libraryId && card.item_key === entry.itemKey)
    if (!draft || draft.title !== collection.title || draft.external_db !== collection.external.db || draft.external_id !== collection.external.id) throw new Error('Package identity differs from current reviewed draft')
  }
}
const sourceFiles = ['package.json', 'server/core/http/library-routes.ts', 'server/mcp/catalog-mcp.ts', 'server/media/catalog-names.ts', 'server/media/catalog-store.ts', 'server/media/library-service.ts', 'server/media/catalog-offline.ts', 'server/test/catalog-edit.test.ts', 'server/test/catalog-mcp.test.ts', 'server/test/catalog-offline.test.ts']
const evidence = { generatedAt: new Date().toISOString(), ...packages, target, localComparison: comparison,
  sourceSha256: Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  storedEpisodeTitles: drafts.reduce((count, card) => count + card.children.filter(child => child.episodeTitle).length, 0),
  unresolved: drafts.filter(card => !card.external_id).map(card => ({ libraryId: card.library_id, itemKey: card.item_key, title: card.title, files: card.children.length, status: card.status, candidates: card.candidates.map(hit => ({ externalDb: hit.externalDb, externalId: hit.externalId, title: hit.title, year: hit.year, score: hit.score })) })) }
fs.writeFileSync(path.join(root, 'review-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const rows = values => values.map(value => `<tr>${value.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')
const list = values => `<ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WatchParty 离线草稿包审阅</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font:15px/1.65 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:26px 20px 70px}h1{font-size:26px;margin:0 0 18px}h2{font-size:19px;margin-top:30px;border-top:1px solid #444;padding-top:14px}p{margin:10px 0}code{font-family:ui-monospace,monospace;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:8px 7px;text-align:left;vertical-align:top;border-bottom:1px solid #333;overflow-wrap:anywhere}th{font-weight:600}ul{padding-left:22px}li{margin:6px 0;overflow-wrap:anywhere}details{margin:14px 0}summary{cursor:pointer}.warn{color:#ffcf79}.ok{color:#a1e6c0}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #333;padding:12px;font:13px/1.6 ui-monospace,monospace}@media(max-width:600px){main{padding:20px 12px}body{font-size:14px}th,td{padding:7px 4px}h1{font-size:23px}}</style></head><body><main>
<h1>WatchParty 离线草稿包审阅</h1>
<p>2026-10-01。本次交付是可审阅的离线草稿，生产尚未应用。视频文件没有上传或删除。当前线上镜像尚不包含离线导入接口，不能把包已上传理解为功能已上线。</p>
<h2>本机重新对账</h2><p>用户启动本机 OpenList 后，隔离副本重新枚举。VPS 同时以相同深度和扩展名重新列目录，并通过已部署后端读取了目标 media ID。三份清单一致，全部大小可核对。</p>
<table><thead><tr><th>库</th><th>本机 / VPS</th><th>缺失 / 新增 / 大小冲突</th></tr></thead><tbody>${rows(comparison.libraries.map(library => [library.libraryId, `${library.localFiles} / ${library.targetFiles}`, `${library.missing.length} / ${library.added.length} / ${library.sizeMismatches.length}`]))}</tbody></table>
<p>旧快照的差异确实来自目录内容已变化，并非本机与 VPS 各有不同文件。首次重枚举在 Anime 请求超时，scan revision 没推进，未计作通过；随后扫描成功，Anime revision 4→5、TV 2→3、Film 3→4。</p>
<h2>相对旧快照的结构提案</h2><table><thead><tr><th>库</th><th>真正缺失</th><th>移动</th><th>新增</th><th>排空旧卡</th></tr></thead><tbody>${rows(preparation.reports.map(report => [report.libraryId, report.missing.length, report.moves.length, report.added.length, report.emptied.length]))}</tbody></table>
<p>药屋少女 24 集使用双向唯一的同文件名、同大小对应，保留原卡 itemKey 和绑定，只在草稿替换成员路径；未以文件名推断其它移动。侍战队真剑者 49 集形成一张新增草稿卡。以上均待结构批准，不能由 MCP 自签。</p>
${preparation.reports.map(report => `<details><summary>${escape(report.libraryId)} 全部路径变化与排空卡</summary><h3>缺失</h3>${list(report.missing.map(file => file.relativePath))}<h3>移动</h3>${list(report.moves.map(move => `${move.from} → ${move.to}，${move.size} B`))}<h3>新增</h3>${list(report.added.map(file => file.relativePath))}<h3>排空卡</h3>${list(report.emptied.map(card => `${card.title}；${card.itemKey}；原确认者 ${card.confirmedBy ?? '未人工确认'}`))}</details>`).join('')}
<h2>包与 VPS 副本结果</h2><table><thead><tr><th>库</th><th>卡 / 成员 / 海报</th><th>副本暂存</th><th>阻断</th></tr></thead><tbody>${rows(target.reports.map(report => [report.libraryId, `${report.cards} / ${report.members} / ${report.posters}`, report.staged ? '已暂存为草稿' : '拒绝暂存', `${report.conflicts.length} 个冲突，${report.unassigned.length} 条未归属`]))}</tbody></table>
<p>共 66 张草稿卡、62 张实际海报。已经持久化 ${evidence.storedEpisodeTitles} 条分集标题；其余集名不是已补齐，详见卡片绑定与文件角色。压缩包只包含 3 份 manifest、66 份 collection 和 62 份海报，共 131 个文件，${packages.archiveBytes} B。按 manifest 白名单打包，未打包数据库、配置、凭据、CA 密钥、media ID 或视频。</p>
<p>压缩包 SHA-256：<code>${escape(packages.archiveSha256)}</code>，本机与 VPS 回读一致。manifest 锁定路径、大小和资产摘要；暂存前再次检查。归档包含明确标为不通过的 Anime 草稿，供审阅，不能整包强行导入。</p>
<p>VPS 验收使用一次性容器、network none、独立 SQLite 与海报目录，挂入本次媒体模块源码，不继承生产环境或批准密钥。正式卡前后逐项一致，副本批准台账 ${target.approvalsBefore}→${target.approvalsAfter}，integrity_check=${escape(target.integrity)}。</p>
<h2>需要裁决</h2><p class="warn">Anime 尚未通过，不能上线。保留 VPS 人工决定的规则仍然生效。</p>
${target.reports.flatMap(report => report.conflicts).map(conflict => `<p>人工卡冲突：${escape(conflict.reason)}，<code>${escape(conflict.itemKey ?? conflict.path)}</code>。来自深渊两部总集篇文件当前两端都不存在，包不会静默删除该人工卡。</p>`).join('')}
<p>另有 28 条附加视频被现有 groupScanFiles 的 extra-directory 规则忽略，旧快照没有明确排除标记。离线检查将它们列为未归属并阻断，等待选择明确排除或归入附加视频。三组为高达0079三部曲 9 条、四叠半神话大系 11 条、混沌武士 8 条。</p>
${target.reports.filter(report => report.unassigned.length).map(report => `<details><summary>${escape(report.libraryId)} 28 条未归属文件</summary>${list(report.unassigned)}</details>`).join('')}
<p>下列卡在本地检索后仍未确认绑定，保留供人类审阅，不能计为刮削完成。候选只用于选择，尚未应用为绑定。没有自动覆盖 VPS 人工绑定。</p><table><thead><tr><th>库</th><th>标题</th><th>文件</th><th>候选</th></tr></thead><tbody>${rows(evidence.unresolved.map(card => [card.libraryId, card.title, card.files, card.candidates.map(hit => `${hit.title} (${hit.externalDb}:${hit.externalId}，${hit.score})`).join('；') || '无候选']))}</tbody></table>
<h2>实现与验证</h2><p>离线 export/check/stage 复用 collection 契约和既有 draft/apply/approval。MCP 只增加导出、检查、暂存三个动词，没有批准动词。分集标题与角色持久化到 children，显式 null 不被文件名猜测补回；海报按内容寻址，旧回滚字节可保留。scan/classify 在跑时拒绝暂存。</p>
<p class="ok">npm test：251/251；typecheckServer：零错；git diff --check 通过。离线测试 8 条纳入默认全套，验证不联网读取与应用、真实文件级集号差异、重启、人工冲突拒绝、摘要/资源篡改拒绝、202 暂存互斥、未归属阻断、排除不绕批准且回滚保留、父目录符号链接与包总量上限。</p>
<p>失败记录：新 HTTP 测试最初使用错误海报路由返回 404，改为既有 /api/media/posters/:id 后通过；VPS 快照工具首次不识别容器缓存路径，拒绝复制，补齐固定挂载映射后在新目录重做并 integrity_check=ok；工作台首次引用未导出的 isEpisodeFile，执行前失败，改为复用导出的现有规则。部分早期临时只读查询也因错误表名或 shell 引号失败，没有作为证据。一次全绿不代表可靠性估计，结论来自具体拒绝和持久化断言。</p>
<h2>接手路径与后续门槛</h2><pre>本机副本：D:/WatchParty-Diagnostics/offline-workbench-20261001
包：offline-draft-review-20261001.tar.gz
证据：review-evidence.json、package-result.json、target-check-result.json、backend-tests.log
详细变化：draft-preparation.json
VPS 独立工作区：/opt/watchparty-offline-20261001
目标快照：catalog-baseline-complete/MANIFEST.txt（VACUUM INTO + integrity_check）
旧失败快照：catalog-baseline（不完整，不可用于回滚）
副本验收库：target-check/watchparty-catalog.sqlite
实现：server/media/catalog-offline.ts、catalog-store.ts、library-service.ts
操作者脚本：deploy/offline-workbench.mjs、package-offline.mjs、check-offline-copy.mjs
只读复核：deploy/read-openlist-inventory.py、read-vps-catalog-inventory.py
快照：deploy/offline-vps-snapshot.py
此轮未 commit、未推送新代码、未构建或切换生产镜像。
不要删包再重导覆盖已有摘要。下一版用新工作台目录与新审阅包。
1. 用户裁决人工缺失卡、28 条附加视频和未绑定卡。
2. 修改副本，出新包，重新核对清单、摘要及人工冲突。
3. scoped commit/push 与手动 GHCR 构建需按本次授权边界继续确认；不改写历史。
4. 新后端镜像在独立服务验证网页批准拒绝/通过、离线详情/海报、结构 apply/rollback。
5. 给用户审阅具体差异和一致性快照后，再取得生产镜像切换与 catalog 应用确认。
6. 结构批准只能由人在专用界面点，脚本与 MCP 不持批准密钥。
7. 当前生产与本地真库、MusicParty、OpenList 进程、共享侧车、ACL、安全软件均未改。</pre>
</main></body></html>`
fs.writeFileSync(path.join('temp-html', 'watchparty-offline-draft-review-2026-10-01.html'), html)
console.log(JSON.stringify({ cards: drafts.length, storedEpisodeTitles: evidence.storedEpisodeTitles, unresolved: evidence.unresolved, htmlBytes: Buffer.byteLength(html) }))
