import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { collectionPath } from '../server/media/collection-sidecar.ts'

const root = path.resolve(process.argv[2] ?? '')
const researchFile = path.resolve(process.argv[3] ?? '')
if (!root.startsWith(path.resolve('D:/WatchParty-Diagnostics') + path.sep)) throw new Error('Diagnostic root required')
const output = path.join(root, 'review-upload/bundles/media-review.html')
if (fs.existsSync(output) && !process.argv.includes('--replace-generated')) throw new Error('Review already exists; preserve prior decisions')
const sharp = createRequire(new URL('../web/package.json', import.meta.url))('sharp')
const researchSource = JSON.parse(fs.readFileSync(researchFile, 'utf8'))
const research = researchSource.reports ?? (researchSource.metadata ?? []).map(item => ({
  external: { db: item.db, id: item.id }, details: [item], recommendation: ''
}))
const bdFile = path.join(root, 'bd-exclusion-suggestions.json')
const bdReports = fs.existsSync(bdFile) ? JSON.parse(fs.readFileSync(bdFile, 'utf8')).suggestions : []
const bdByKey = new Map(bdReports.map(item => [`${item.libraryId}\n${item.itemKey}`, item]))
const parser = fs.readFileSync(path.join(root, 'papaparse.min.js'), 'utf8')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const summaryCounts = { cards: 0, pending: 0, files: 0, excluded: 0, deletions: 0 }
const notes = {
  'gundam-films': '三部独立电影，建议拆为三张卡。9 个 PV/menu 已按你的裁决排除。旧候选 26851 是书籍，已剔除。',
  minister: '正片三季共 21 集。额外文件标称 Christmas.Special.1982，尚未确认与数据库特别篇的对应，不能直接认定为 1984 特辑。',
  wulin: '文件 01–80 为 MKV，81 为 MP4。TMDB 当前列 81 集，但第 81 个文件的内容身份仍须人工确认。',
}
const cards = []
const rows = []
const bundles = JSON.parse(fs.readFileSync(path.join(root, 'bundle-results.json'), 'utf8')).reports
const libraryNames = { lib_anime: '动画', lib_tv: '剧集', lib_film: '电影' }
for (const report of bundles) {
  const directory = path.join(root, 'review-upload/bundles/offline-bundles', report.bundleId)
  const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json'))
  assert.equal(sha(manifestBytes), report.bundleSha256)
  const manifest = JSON.parse(manifestBytes)
  const claimed = new Set()
  for (const entry of manifest.entries) {
    const bytes = fs.readFileSync(path.join(directory, entry.collection.file))
    assert.equal(sha(bytes), entry.collection.sha256)
    const collection = JSON.parse(bytes)
    const evidence = research.find(item =>
      item.libraryId === report.libraryId && item.itemKey === entry.itemKey) ?? research.find(item =>
      item.external?.db === collection.external?.db && String(item.external?.id ?? '') === String(collection.external?.id ?? ''))
    const bdReview = bdByKey.get(`${report.libraryId}\n${entry.itemKey}`) ?? null
    const bdFiles = new Map((bdReview?.files ?? []).map(file => [file.relativePath, file]))
    const cardIndex = cards.length
    const id = 'C' + String(cardIndex + 1).padStart(3, '0')
    let poster = ''
    if (entry.poster) {
      const bytes = fs.readFileSync(path.join(directory, entry.poster.file))
      assert.equal(sha(bytes), entry.poster.sha256)
      const thumbnail = await sharp(bytes).resize({ width: 72, height: 104, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 40 }).toBuffer()
      poster = 'data:image/jpeg;base64,' + thumbnail.toString('base64')
    }
    cards.push({ id, l: report.libraryId, k: entry.itemKey, bp: collection.basePath || '/', b: report.bundleSha256, t: collection.title,
      o: collection.originalTitle, y: collection.year, db: collection.external?.db ?? '', xid: collection.external?.id ?? '',
      poster, pending: !collection.external?.id, kind: 'card',
      note: evidence ? notes[evidence.reviewId] ?? evidence.recommendation : '',
      refs: evidence?.details?.filter(detail => detail.db !== 'bangumi' || detail.type === 2).map(detail => ({
        db: detail.db, id: detail.id, t: detail.title, date: detail.date, eps: detail.episodeCount, url: detail.url,
      })) ?? [], bd: bdReview ? { fingerprint: bdReview.fingerprint, count: bdReview.count,
        inspect: bdReview.files.filter(file => file.action === 'inspect').length,
        reference: bdReview.reference, warnings: bdReview.warnings } : null })
    for (const member of collection.members) {
      const relativePath = collectionPath(collection.basePath, member.path)
      assert(relativePath, 'Invalid collection path')
      assert(!claimed.has(relativePath), 'Duplicate member')
      claimed.add(relativePath)
      const bdFile = bdFiles.get(relativePath)
      rows.push({ c: cardIndex, p: member.path, s: member.season ?? null, e: member.episode ?? null,
        t: member.title ?? null, r: member.role ?? 'other', z: member.size ?? null, x: false,
        ba: bdFile?.action ?? null, br: bdFile?.reasons ?? [], bc: bdFile?.confidence ?? null,
        bf: bdReview?.fingerprint ?? null })
    }
  }
  if (manifest.exclusions.length) {
    const cardIndex = cards.length
    cards.push({ id: 'EX-' + report.libraryId, l: report.libraryId, k: '', b: report.bundleSha256, t: '已排除的 BD 额外内容',
      db: '', xid: '', pending: false, kind: 'excluded', poster: '', refs: [], note: `${manifest.exclusions.length} 条已裁决排除，原文件保留。` })
    for (const item of manifest.exclusions) {
      assert(!claimed.has(item.relativePath), 'Excluded file still claimed by card')
      const size = manifest.inventory.find(file => file.relativePath === item.relativePath)?.size
      rows.push({ c: cardIndex, p: item.relativePath, s: null, e: null, t: null, r: 'bonus', z: size, x: true })
    }
  }
  for (const proposal of manifest.deletions) {
    cards.push({ id: 'DEL-' + report.libraryId, l: report.libraryId, k: proposal.itemKey, b: report.bundleSha256,
      t: '来自深渊 总集篇 · 删除提案', db: '', xid: '', pending: false, kind: 'deletion', poster: '', refs: [],
      note: '两部文件均缺失。你已允许草稿提出删除，生产仍须人工批准。', fingerprint: proposal.decisionSha256 })
  }
  const members = [...claimed, ...manifest.exclusions.map(item => item.relativePath)].sort()
  assert.deepEqual(members, manifest.inventory.map(item => item.relativePath).sort(), 'Inventory must be fully accounted for')
}
summaryCounts.cards = cards.filter(card => card.kind === 'card').length
summaryCounts.pending = cards.filter(card => card.pending).length
summaryCounts.files = rows.filter(row => !row.x).length
summaryCounts.excluded = rows.filter(row => row.x).length
summaryCounts.deletions = cards.filter(card => card.kind === 'deletion').length
const data = JSON.stringify({ version: 1, cards, rows, libraryNames }).replace(/</g, '\\u003c')
const fallback = cards.map(card => `<li>${esc(card.id)} · ${esc(libraryNames[card.l])} · ${esc(card.t)} · ${esc(card.db ? card.db + ':' + card.xid : card.kind === 'card' ? '未绑定' : card.kind === 'deletion' ? '删除提案' : '已排除')}</li>`).join('')
const html = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WatchParty r3 媒体归属审阅</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font:14px/1.5 system-ui,sans-serif;letter-spacing:0}button,input,select,textarea{font:inherit;color:#fff;background:#141414;border:1px solid #555;border-radius:3px;padding:6px 8px}button{cursor:pointer}button:hover{background:#282828}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #7bdcb5;outline-offset:2px}a{color:#8ecaff;overflow-wrap:anywhere}h1{font-size:20px;margin:0}h2{font-size:19px;margin:0;overflow-wrap:anywhere}p{margin:6px 0}header{padding:14px 20px;border-bottom:1px solid #333}header .top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.status{color:#7bdcb5;min-height:22px}.note{color:#ccc}.layout{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:calc(100vh - 125px)}aside{border-right:1px solid #333;padding:12px;align-self:start;position:sticky;top:0;max-height:100vh;overflow:auto}.filters{display:grid;gap:8px;margin-bottom:12px}.filters input,.filters select{width:100%}.card-list{display:grid;gap:0}.card-link{border:0;border-bottom:1px solid #333;border-radius:0;text-align:left;background:#000;padding:10px 8px;width:100%}.card-link[aria-current=true]{background:#202020;border-left:3px solid #7bdcb5}.card-link strong{display:block;font-size:13px;overflow-wrap:anywhere}.meta{font-size:12px;color:#bbb}.pending{color:#ffd27d}.reviewed{color:#7bdcb5}.workspace{padding:18px 20px;min-width:0}.card-head{display:flex;gap:16px;margin-bottom:14px}.poster{width:72px;height:104px;object-fit:contain;flex:none;background:#111}.card-info{min-width:0}.source-path{font-size:12px;overflow-wrap:anywhere;color:#bbb}.card-fields{display:grid;grid-template-columns:minmax(160px,2fr) minmax(100px,1fr) minmax(100px,1fr) minmax(90px,1fr);gap:8px;margin:14px 0}.field{display:grid;gap:3px;min-width:0;font-size:12px}.field input,.field select,.field textarea{width:100%;min-width:0}.evidence{border-top:1px solid #333;border-bottom:1px solid #333;padding:10px 0;margin:12px 0}.evidence ul{margin:6px 0;padding-left:20px}.file-top{display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin:14px 0}.file-top input{max-width:100%;width:240px}.file-row{display:grid;grid-template-columns:minmax(230px,1fr) 115px 65px 65px 55px;gap:8px;padding:10px 0;border-bottom:1px solid #333;align-items:start}.file-heading{font-size:12px;color:#bbb}.filename{overflow-wrap:anywhere;min-width:0;font-size:13px}.filename summary{cursor:pointer}.file-row input{width:100%;min-width:0}.file-row input[type=checkbox]{width:18px;height:18px;margin:6px 0}.file-row.hidden-file .filename{color:#ccc}.expanded{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.expanded .wide{grid-column:1/-1}.original{font-size:12px;color:#bbb}.danger{color:#ffb5b5}.empty{padding:24px 0;color:#bbb}.notice{border-top:1px solid #333;margin-top:10px;padding-top:8px;font-size:12px;color:#bbb}footer{border-top:1px solid #333;padding:10px 20px;color:#bbb;font-size:12px}details.instructions{margin-top:8px;color:#ccc;font-size:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@media(max-width:760px){header{padding:12px}aside{position:static;max-height:260px;border-right:0;border-bottom:1px solid #333}.layout{display:block}.workspace{padding:14px 12px}.card-fields{grid-template-columns:1fr 1fr}.file-row{grid-template-columns:minmax(0,1fr) 90px 48px 48px 40px;gap:5px}.filename{font-size:12px}.file-row input{padding:5px 3px}.expanded{grid-template-columns:1fr}.expanded .wide{grid-column:auto}.card-head{gap:10px}.poster{width:60px;height:88px}.file-heading{font-size:11px}}@media(max-width:420px){.file-row{grid-template-columns:minmax(0,1fr) 70px 40px 40px 32px}.file-row input{font-size:12px}.file-heading{font-size:10px}}
</style></head><body>
<header><div class="top"><h1>WatchParty r3 · 媒体归属审阅</h1><div class="toolbar"><button id="export">↓ 导出裁决 CSV</button><button id="import">↑ 载入裁决 CSV</button><input id="csv-file" type="file" accept=".csv,text/csv" hidden></div></div><p class="note">${summaryCounts.cards} 张卡 · ${summaryCounts.files} 条卡片文件 · ${summaryCounts.excluded} 条 BD 排除 · ${summaryCounts.pending} 张待绑定 · ${summaryCounts.deletions} 张删除提案</p><div id="status" class="status" role="status" aria-live="polite">原始草稿，生产未应用</div><details class="instructions"><summary>裁决与保存</summary><p>同一个目标组代表同一张卡；拆分时给文件填写不同组名，例如 G1、G2、G3。文件展开后可单独指定目标标题、绑定与角色。新组须填写标题和绑定，未确定可保留待审。</p><p>CSV 包含全部文件与裁决值。修改保留在当前页面内存，关闭前请导出 CSV。重新打开后可载入继续。CSV 不会修改数据库、视频或原始包。候选仅为研究建议，未自动套用。</p></details></header>
<noscript><section style="padding:20px"><h2>卡片清单</h2><p>当前环境未启用脚本，以下为只读清单；可在本机浏览器打开完整审阅页。</p><ul>${fallback}</ul></section></noscript>
<div class="layout" id="app" hidden><aside><div class="filters"><input id="search" aria-label="搜索卡片或文件" placeholder="搜索标题、文件名或路径"><select id="library" aria-label="媒体库"><option value="">全部库</option><option value="lib_anime">动画</option><option value="lib_tv">剧集</option><option value="lib_film">电影</option></select><select id="view" aria-label="审阅范围"><option value="pending">${summaryCounts.pending} 张待绑定</option><option value="all">全部卡片</option><option value="reviewed">已审阅</option><option value="excluded">已排除内容</option><option value="deletion">删除提案</option></select></div><div id="list" class="card-list"></div></aside><main id="workspace" class="workspace"></main></div>
<footer>源包摘要锁定 r5。BD 建议仅供批量人工确认，本轮未自动排除；时长为空表示本轮未提供时长。</footer>
<script id="review-data" type="application/json">${data}</script>
<script>${parser.replace(/<\/script/gi, '<\\/script')}</script>
<script>
'use strict';
const data=JSON.parse(document.getElementById('review-data').textContent);
const cardEdits=data.cards.map(c=>({title:c.t,db:c.db,id:c.xid,decision:c.kind==='deletion'?'propose-delete':c.kind==='excluded'?'exclude':'pending',note:''}));
const edits=data.rows.map(r=>({group:data.cards[r.c].id,title:'',db:'',id:'',season:r.s===null?'':String(r.s),episode:r.e===null?'':String(r.e),episodeTitle:r.t??'',role:r.r??'other',excluded:r.x,decision:r.x?'exclude':'pending',note:''}));
const rowIndexes=data.cards.map((c,index)=>data.rows.map((r,i)=>r.c===index?i:-1).filter(i=>i>=0));
let selected=data.cards.findIndex(c=>c.pending);if(selected<0)selected=data.cards.findIndex(c=>c.kind==='card');let dirty=false,fileFilter='';
const $=id=>document.getElementById(id);$('view').value=data.cards.some(c=>c.pending)?'pending':'all';
const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const option=(v,text,current)=>'<option value="'+escapeHtml(v)+'"'+(v===current?' selected':'')+'>'+escapeHtml(text)+'</option>';
function fullPath(index){const r=data.rows[index],c=data.cards[r.c];return c.kind==='excluded'||r.p.startsWith('/')?r.p:c.bp.replace(/\/$/,'')+'/'+r.p;}
function summary(c,index){return data.libraryNames[c.l]+' · '+(c.kind==='deletion'?'删除提案':rowIndexes[index].length+' 文件')+' · '+(cardEdits[index].decision==='approved'?'已审阅':c.pending?'待绑定':c.kind==='excluded'?'已排除':'现有绑定');}
function setStatus(message,error=false){$('status').textContent=message;$('status').classList.toggle('danger',error);}
function changed(){dirty=true;setStatus('有未导出的裁决');}
function filterCards(){const query=$('search').value.trim().toLowerCase(),lib=$('library').value,view=$('view').value;return data.cards.map((c,i)=>({c,i})).filter(({c,i})=>(!lib||lib===c.l)&&(view==='all'||view==='pending'&&c.pending||view==='reviewed'&&cardEdits[i].decision==='approved'||view===c.kind)&&( !query||(c.t+' '+c.k+' '+c.id).toLowerCase().includes(query)||rowIndexes[i].some(j=>fullPath(j).toLowerCase().includes(query))));}
function renderList(){const visible=filterCards();$('list').innerHTML=visible.map(({c,i})=>'<button class="card-link" data-card="'+i+'" aria-current="'+(i===selected)+'"><strong>'+escapeHtml(c.id+' · '+c.t)+'</strong><span class="meta '+(c.pending?'pending':'')+'">'+escapeHtml(summary(c,i))+'</span></button>').join('')||'<p class="empty">没有匹配的卡片</p>';return visible;}
function field(label,key,value,type='text',scope='card'){return '<label class="field">'+escapeHtml(label)+'<input data-'+scope+'-field="'+key+'" type="'+type+'" value="'+escapeHtml(value)+'"'+(type==='number'?' min="0" step="1"':'')+'></label>';}
function decisionSelect(value,scope){return '<label class="field">裁决<select data-'+scope+'-field="decision">'+option('pending','待审',value)+option('approved','确认',value)+option('hold','暂缓',value)+option('exclude','排除',value)+'</select></label>';}
function renderCard(){const c=data.cards[selected],edit=cardEdits[selected];if(!c){$('workspace').innerHTML='<p class="empty">请选择卡片</p>';return;}
const reference=c.refs.map(r=>'<li><a href="'+escapeHtml(r.url)+'" rel="noopener noreferrer">'+escapeHtml(r.t)+'</a> · '+escapeHtml(r.db+':'+r.id)+' · '+escapeHtml(r.date??'')+' · 数据库 '+escapeHtml(r.eps)+' 集</li>').join('');
$('workspace').innerHTML='<div class="card-head">'+(c.poster?'<img class="poster" src="'+c.poster+'" alt="'+escapeHtml(c.t)+'海报">':'')+'<div class="card-info"><h2>'+escapeHtml(c.t)+'</h2><p>'+escapeHtml(c.id+' · '+summary(c,selected))+'</p><p class="source-path">'+escapeHtml(c.k)+'</p><p class="original">'+escapeHtml((c.o??'')+' '+(c.y??'')+' '+(c.db?c.db+':'+c.xid:'未绑定'))+'</p></div></div>'+(c.note?'<p class="pending">'+escapeHtml(c.note)+'</p>':'')+(reference?'<section class="evidence"><strong>已核对条目，尚未裁决</strong><ul>'+reference+'</ul></section>':'');
if(c.bd)$('workspace').insertAdjacentHTML('beforeend','<section class="evidence"><strong>BD 附加内容建议（仅供人工确认）</strong><p>'+escapeHtml('建议排除 '+c.bd.count.proposedExclusions+' · 需检查 '+c.bd.inspect+' · 数据库集数 '+(c.bd.count.expectedEpisodes??'未知')+' · 保留后 '+c.bd.count.remaining+' 个文件。理由见逐文件标记。')+'</p><p class="note">'+escapeHtml(c.bd.warnings.join('、')||'未发现序列警告')+'；时长数据未提供。本页不会自动应用建议。</p>'+(c.bd.count.proposedExclusions?'<button type="button" data-action="accept-bd">确认本组全部建议排除</button>':'')+'</section>');
if(c.kind==='deletion'){$('workspace').insertAdjacentHTML('beforeend','<div class="card-fields"><label class="field">删除提案<select data-card-field="decision">'+option('propose-delete','允许草稿提出删除',edit.decision)+option('hold','暂缓删除',edit.decision)+'</select></label>'+field('备注','note',edit.note)+'</div><p class="note">生产卡未删除；正式删除仍须走人工批准。</p>');return;}
$('workspace').insertAdjacentHTML('beforeend','<div class="card-fields">'+field('目标标题','title',edit.title)+'<label class="field">目标条目库<select data-card-field="db">'+option('','未绑定',edit.db)+option('bangumi','Bangumi',edit.db)+option('tmdb','TMDB',edit.db)+'</select></label>'+field('目标条目 ID','id',edit.id)+decisionSelect(edit.decision,'card')+'</div>'+field('卡片备注','note',edit.note)+'<div class="file-top"><strong id="file-count"></strong><input id="file-search" aria-label="筛选当前卡文件" placeholder="筛选这张卡的文件" value="'+escapeHtml(fileFilter)+'"></div><div class="file-row file-heading"><span>文件 / 展开详情</span><span>目标组</span><span>季</span><span>集</span><span>排除</span></div><div id="files"></div>');renderFiles();}
function renderFiles(){const visible=rowIndexes[selected].filter(i=>data.rows[i].p.toLowerCase().includes(fileFilter.toLowerCase()));$('file-count').textContent=visible.length+' / '+rowIndexes[selected].length+' 个文件';$('files').innerHTML=visible.map(i=>{const r=data.rows[i],e=edits[i];return '<div class="file-row '+(e.excluded?'hidden-file':'')+'" data-row="'+i+'"><details class="filename"><summary>'+escapeHtml(r.p.split('/').pop())+'</summary><p class="source-path">'+escapeHtml(fullPath(i))+'</p><p class="original">当前：'+escapeHtml('S'+(r.s??'?')+' E'+(r.e??'?')+' · '+(r.r??'other')+' · '+(r.z===null?'大小未知':(r.z/1048576).toFixed(1)+' MiB'))+'</p><div class="expanded">'+field('目标标题覆盖','title',e.title,'text','row')+field('目标条目库覆盖','db',e.db,'text','row')+field('目标条目 ID 覆盖','id',e.id,'text','row')+'<label class="field">角色<select data-row-field="role">'+option('episode','正片',e.role)+option('bonus','附加内容',e.role)+option('other','其它',e.role)+'</select></label>'+field('分集标题','episodeTitle',e.episodeTitle,'text','row')+decisionSelect(e.decision,'row')+field('文件备注','note',e.note,'text','row')+'</div></details><input aria-label="'+escapeHtml(r.p)+'目标组" data-row-field="group" value="'+escapeHtml(e.group)+'"><input aria-label="季号" type="number" min="0" step="1" data-row-field="season" value="'+escapeHtml(e.season)+'"><input aria-label="集号" type="number" min="0" step="1" data-row-field="episode" value="'+escapeHtml(e.episode)+'"><input aria-label="排除文件" type="checkbox" data-row-field="excluded"'+(e.excluded?' checked':'')+'></div>';}).join('');$('files').querySelectorAll('[data-row]').forEach(element=>{const r=data.rows[Number(element.dataset.row)];if(!r.ba)return;const labels={ 'propose-exclusion':'建议排除','inspect':'需检查','keep':'建议保留' };const reasons=r.br.join('、');element.querySelector('.filename').insertAdjacentHTML('beforeend','<p class="original">BD 建议：'+escapeHtml(labels[r.ba]||r.ba)+' · '+escapeHtml(reasons)+' · 置信度 '+escapeHtml(r.bc||'无')+'</p>');});}
function render(){renderList();renderCard();}
['search','library','view'].forEach(id=>$(id).addEventListener(id==='search'?'input':'change',()=>{const visible=renderList();if(!visible.some(item=>item.i===selected)){selected=visible[0]?.i??-1;fileFilter='';render();}}));
$('list').addEventListener('click',event=>{const button=event.target.closest('[data-card]');if(button){selected=Number(button.dataset.card);fileFilter='';render();}});
$('workspace').addEventListener('click',event=>{const button=event.target.closest('[data-action="accept-bd"]');if(!button)return;let accepted=0;for(const index of rowIndexes[selected]){const row=data.rows[index];if(row.ba!=='propose-exclusion'||!row.bf)continue;edits[index].excluded=true;edits[index].decision='exclude';accepted++;}renderFiles();changed();setStatus('已确认本组 '+accepted+' 条建议排除；尚未写入离线包或生产');});
$('workspace').addEventListener('input',event=>{
  const input=event.target;
  if(input.id==='file-search'){fileFilter=input.value;renderFiles();return;}
  if(input.dataset.cardField){
    cardEdits[selected][input.dataset.cardField]=input.value;
    if(input.dataset.cardField==='decision'&&input.value==='exclude'){
      rowIndexes[selected].forEach(i=>{edits[i].excluded=true;edits[i].decision='exclude';});renderFiles();
    }
    changed();renderList();
  }else if(input.dataset.rowField){
    const index=Number(input.closest('[data-row]').dataset.row),key=input.dataset.rowField;
    edits[index][key]=input.type==='checkbox'?input.checked:input.value;
    if(key==='excluded')edits[index].decision=input.checked?'exclude':cardEdits[data.rows[index].c].decision==='exclude'?'hold':'pending';
    if(key==='decision'&&input.value==='exclude'){
      edits[index].excluded=true;input.closest('[data-row]').querySelector('[data-row-field="excluded"]').checked=true;
    }
    changed();
  }
});
const headers=['recordType','bundleSha256','libraryId','sourceItemKey','relativePath','currentTitle','currentDb','currentId','currentSeason','currentEpisode','currentEpisodeTitle','currentRole','size','currentExcluded','bdSuggestion','bdReasons','bdConfidence','bdFingerprint','targetGroup','targetTitle','targetDb','targetId','targetSeason','targetEpisode','targetEpisodeTitle','targetRole','excluded','decision','note'];
function csvRows(){const records=data.rows.map((r,i)=>{const c=data.cards[r.c],ce=cardEdits[r.c],e=edits[i];return ['file',c.b,c.l,c.k,fullPath(i),c.t,c.db,c.xid,r.s??'',r.e??'',r.t??'',r.r??'other',r.z??'',String(r.x),r.ba??'',r.br.join('; '),r.bc??'',r.bf??'',e.group,e.title||ce.title,e.db||ce.db,e.id||ce.id,e.season,e.episode,e.episodeTitle,e.role,String(e.excluded),e.decision==='pending'?ce.decision:e.decision,e.note||ce.note];});data.cards.forEach((c,i)=>{if(c.kind==='deletion')records.push(['deletion',c.b,c.l,c.k,'',c.t,'','','','','','','','','','','','','','','','','','','','','',cardEdits[i].decision,cardEdits[i].note]);});return records;}
function makeCsv(){return '\uFEFF'+Papa.unparse({fields:headers,data:csvRows()},{newline:'\r\n',escapeFormulae:/^[=+\-@\t\r']/});}
function downloadCsv(){const bytes=makeCsv(),url=URL.createObjectURL(new Blob([bytes],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='watchparty-r3-media-decisions.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);dirty=false;setStatus('裁决 CSV 已导出');}
function restored(value){return /^'[=+\-@\t\r']/.test(value)?value.slice(1):value;}
function loadCsv(text){
  const parsed=Papa.parse(text.replace(/^\uFEFF/,''),{header:true,skipEmptyLines:'greedy'});
  if(parsed.errors.length||headers.some(key=>!parsed.meta.fields?.includes(key)))throw new Error('CSV 列名或引号格式不正确');
  const expected=new Map(data.rows.map((r,i)=>[data.cards[r.c].l+'\n'+fullPath(i),i]));
  const deletions=new Map(data.cards.map((c,i)=>c.kind==='deletion'?[c.l+'\n'+c.k,i]:null).filter(Boolean));
  const seen=new Set(),next=structuredClone(edits),nextCards=structuredClone(cardEdits);
  for(const raw of parsed.data){
    const row=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,restored(v)]));
    if(row.recordType==='deletion'){
      const key=row.libraryId+'\n'+row.sourceItemKey,index=deletions.get(key),c=data.cards[index];
      if(index===undefined||seen.has('del:'+key)||row.bundleSha256!==c.b||row.currentTitle!==c.t||!['propose-delete','hold'].includes(row.decision))throw new Error('删除提案不匹配');
      seen.add('del:'+key);nextCards[index].decision=row.decision;nextCards[index].note=row.note;continue;
    }
    if(row.recordType!=='file')throw new Error('未知记录类型');
    const key=row.libraryId+'\n'+row.relativePath,index=expected.get(key);
    if(index===undefined||seen.has(key))throw new Error('文件未知或重复');
    seen.add(key);
    const r=data.rows[index],c=data.cards[r.c];
    if(row.bundleSha256!==c.b||row.sourceItemKey!==c.k||row.currentTitle!==c.t||row.currentDb!==c.db||row.currentId!==c.xid||row.currentSeason!==String(r.s??'')||row.currentEpisode!==String(r.e??'')||row.currentEpisodeTitle!==(r.t??'')||row.currentRole!==(r.r??'other')||row.size!==String(r.z??'')||row.currentExcluded!==String(r.x)||row.bdSuggestion!==(r.ba??'')||row.bdReasons!==r.br.join('; ')||row.bdConfidence!==(r.bc??'')||row.bdFingerprint!==(r.bf??''))throw new Error('原始记录或 BD 建议指纹与 r5 不匹配');
    if(!row.targetGroup.trim()||!['episode','bonus','other'].includes(row.targetRole)||!['true','false'].includes(row.excluded)||!['pending','approved','hold','exclude'].includes(row.decision)||row.targetDb&&!['bangumi','tmdb'].includes(row.targetDb)||row.targetId&&!/^\d+$/.test(row.targetId)||['targetSeason','targetEpisode'].some(k=>row[k]!==''&&!/^\d+$/.test(row[k])))throw new Error('裁决字段有无效值');
    next[index]={group:row.targetGroup,title:row.targetTitle,db:row.targetDb,id:row.targetId,season:row.targetSeason,episode:row.targetEpisode,episodeTitle:row.targetEpisodeTitle,role:row.targetRole,excluded:row.excluded==='true',decision:row.decision,note:row.note};
  }
  if(seen.size!==data.rows.length+deletions.size)throw new Error('CSV 缺少文件或删除提案，未载入任何裁决');
  data.cards.forEach((c,i)=>{
    if(c.kind==='deletion'||!rowIndexes[i].length)return;
    const rs=rowIndexes[i].map(j=>next[j]);
    for(const key of ['title','db','id','note']){
      if(rs.every(r=>r[key]===rs[0][key]))nextCards[i][key]=rs[0][key];
      rs.forEach(r=>{if(r[key]===nextCards[i][key])r[key]='';});
    }
    nextCards[i].decision=rs.every(r=>r.decision===rs[0].decision)?rs[0].decision:'pending';
    rs.forEach(r=>{if(r.decision===nextCards[i].decision)r.decision='pending';});
  });
  edits.splice(0,edits.length,...next);cardEdits.splice(0,cardEdits.length,...nextCards);
  dirty=false;render();setStatus('已载入 '+parsed.data.length+' 条裁决，生产未应用');return parsed.data.length;
}
$('export').addEventListener('click',()=>{try{downloadCsv();}catch(error){setStatus(error.message,true);}});$('import').addEventListener('click',()=>$('csv-file').click());$('csv-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>8*1024*1024)throw new Error('CSV 过大');loadCsv(await file.text());}catch(error){setStatus(error.message,true);}event.target.value='';});
addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
$('app').hidden=false;render();
</script></body></html>`
assert(Buffer.byteLength(html) < 2 * 1024 * 1024, 'Self-contained review exceeds 2 MiB')
assert(!/"mediaId"|"cachePath"|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(html), 'Private fields in review')
for (const script of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (!script[0].includes('application/json')) new Script(script[1])
}
fs.writeFileSync(output, html, { flag: process.argv.includes('--replace-generated') ? 'w' : 'wx' })
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(html), ...summaryCounts, rows: rows.length, productionApplied: false }))
