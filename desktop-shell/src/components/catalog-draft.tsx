import { useCallback, useEffect, useMemo, useState } from "react"

import { MaterialSymbol } from "@/components/material-symbol"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  bangumiSearch, mediaDraft, mediaDraftApply, mediaDraftCard, mediaDraftClassify, mediaDraftConfirm, mediaDraftEdit, mediaDraftJudge,
  mediaDraftKeepBinding, mediaDraftMerge, mediaDraftSplit, mediaDraftUnconfirm, mediaLibraryScan,
  type BangumiHit, type DraftApplyResult, type DraftCandidate, type DraftChild, type DraftItem, type DraftState, type DraftThresholds,
} from "@/lib/ipc"
import {
  applyHeadline, applyPlan, applyResultText, applySideEffects, bucketOfItem, draftBuckets, draftErrorCode, draftErrorText, emptyKind,
  bindingLabel, bindingMoveText, carrierKeyOf,
  DRAFT_BATCH_MAX, draftEditErrorText, errorData, filterDraft, judgeProgress, scoreTone, splitSummary, type DraftFilterKey,
} from "@/lib/draft-view"
import { cn } from "@/lib/utils"

const JUDGE_BATCH = 6

type Dialog = "apply" | "force" | null

/**
 * 草稿审阅与应用（方案 B：按卡片组织 + 过滤器与搜索，2026-09-28 用户拍板）。
 * 前三段（scan/classify/judge）只写草稿；apply 是唯一落库动作，未判完默认 409。
 */
export function CatalogDraft({ libraryId, libraryName, admin }: { libraryId: string; libraryName: string; admin: boolean }) {
  const [state, setState] = useState<DraftState | null>(null)
  // 初值 true：取数前不许同步 setState（effect 里同步 setState 会被 react-hooks 规则拦）。
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [filter, setFilter] = useState<DraftFilterKey>("all")
  const [query, setQuery] = useState("")
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState("")
  const [notice, setNotice] = useState("")
  const [lastApply, setLastApply] = useState<DraftApplyResult | null>(null)
  // children 不在列表里：展开哪张取哪张（§8.1），取过的缓存住。
  // ?item= 一次拿齐 children + candidates（列表投影里两者都没有）。
  const [detailCache, setDetailCache] = useState<Record<string, { children: DraftChild[]; candidates: DraftCandidate[] } | "loading" | "error">>({})
  const [stale, setStale] = useState<{ draftRev?: number; scanRev?: number } | null>(null)
  const [serverPending, setServerPending] = useState<number | null>(null)
  // 本批判定的行（judge 返回 items，只标这几行；列表整体仍刷新，因为 payload 只有几十 KB）。
  const [justJudged, setJustJudged] = useState<string[]>([])
  // 编辑：多选（合并）、改名、换条目搜索、拆分（勾"留下的"）。
  const [selected, setSelected] = useState<string[]>([])
  const [titleDraft, setTitleDraft] = useState<Record<string, string>>({})
  const [searchFor, setSearchFor] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [hits, setHits] = useState<BangumiHit[]>([])
  const [splitting, setSplitting] = useState<string | null>(null)
  const [keepIds, setKeepIds] = useState<string[]>([])

  const load = useCallback(async () => {
    if (!libraryId) return
    try {
      const next = await mediaDraft(libraryId)
      setState(next)
      setError("")
    } catch (failure) {
      setState(null)
      setError(draftErrorCode(failure) || "FAILED")
    } finally {
      setLoading(false)
    }
  }, [libraryId])

  // 换库由调用方 key= 重挂载；这里只取数（setState 全在异步回调里）。
  useEffect(() => { void load() }, [load])

  const rows = useMemo(() => filterDraft(state, filter, query), [state, filter, query])
  const chips = useMemo(() => draftBuckets(state), [state])
  const progress = useMemo(() => judgeProgress(state), [state])
  const plan = useMemo(() => applyPlan(state), [state])
  // 「由你定过」的卡（manual/rebind/unknown）：应用会整张跳过、不动绑定。
  const humanConfirmedCount = useMemo(() => (state?.draft ?? []).filter(item => item.confirmedBy && item.confirmedBy !== "auto").length, [state])
  const dropped = state?.diff?.dropped ?? []

  if (!admin) {
    return <p className="draft-hint">只有本机或管理员能审阅与应用草稿。</p>
  }

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label)
    setNotice("")
    try { await work() } finally { setBusy("") }
  }

  async function judgeNext() {
    await run("judge", async () => {
      try {
        // 只在"没草稿"时才分过类：judge 是唯一该走的批量入口，别顺手 classify（会清空已有判定）。
        const result = await mediaDraftJudge(libraryId, JUDGE_BATCH)
        setJustJudged(result.items ?? [])
        setNotice(`本轮判定 ${result.judged} 张：自动确认 ${result.confirmed}，还剩 ${result.pending} 张未判定。`)
        await load()
      } catch (failure) { setNotice(draftErrorText(failure, "判定失败")) }
    })
  }

  /** 展开一张：children 走 `?item=` 子请求（列表投影里没有）。 */
  async function loadDetail(itemKey: string) {
    if (detailCache[itemKey] && detailCache[itemKey] !== "error") return
    setDetailCache(current => ({ ...current, [itemKey]: "loading" }))
    try {
      const detail = await mediaDraftCard(libraryId, itemKey)
      setDetailCache(current => ({ ...current, [itemKey]: { children: detail.children ?? [], candidates: detail.candidates ?? [] } }))
    } catch {
      setDetailCache(current => ({ ...current, [itemKey]: "error" }))
    }
  }

  /** 所有编辑都走同一条：调接口 → 提示 → 重刷列表（返回的摘要里也有 diff，但列表要重取）。 */
  async function mutate(label: string, work: () => Promise<string | void>) {
    await run(label, async () => {
      try {
        const message = await work()
        if (message) setNotice(message)
        setDetailCache({})
        setJustJudged([])
        await load()
      } catch (failure) {
        setNotice(draftEditErrorText(failure))
      }
    })
  }

  async function editTitle(item: DraftItem, title: string) {
    const next = title.trim()
    if (!next || next === item.title) return
    await mutate("edit", async () => {
      await mediaDraftEdit({ libraryId, itemKey: item.itemKey, title: next })
      return `已改名：${next}（人工定，apply 不会再动它）`
    })
  }

  async function pickEntry(item: DraftItem, hit: { externalDb: string; externalId: string; title: string }) {
    await mutate("confirm", async () => {
      await mediaDraftConfirm({ libraryId, itemKey: item.itemKey, externalDb: hit.externalDb, externalId: hit.externalId })
      return `已绑到 ${hit.title}（人工定）`
    })
  }

  async function bindSearchEntry(item: DraftItem, hit: BangumiHit) {
    await mutate("rebind", async () => {
      await mediaDraftEdit({
        libraryId,
        itemKey: item.itemKey,
        title: hit.title,
        originalTitle: hit.originalTitle ?? null,
        year: hit.year ?? null,
        posterUrl: hit.imageUrl ?? null,
        externalDb: hit.externalDb,
        externalId: hit.externalId,
      })
      return `已绑到 ${hit.title}（人工定）`
    })
  }
  async function confirmTop(item: DraftItem) {
    await mutate("confirm", async () => {
      await mediaDraftConfirm({ libraryId, itemKey: item.itemKey })
      return `已确认第一个候选（人工定）`
    })
  }

  async function unconfirmDraft(item: DraftItem) {
    await mutate("unconfirm", async () => {
      await mediaDraftUnconfirm({ libraryId, itemKey: item.itemKey })
      return "已撤销人工决定：条目对和名字都留着，退回候选态"
    })
  }

  async function mergeSelected() {
    const keepKey = selected[0]
    const dropKeys = selected.slice(1)
    if (!keepKey || dropKeys.length === 0) return
    await mutate("merge", async () => {
      await mediaDraftMerge({ libraryId, keepKey, dropKeys })
      setSelected([])
      return `已合并 ${dropKeys.length + 1} 张（保留「${state?.draft.find(item => item.itemKey === keepKey)?.title ?? keepKey}」）`
    })
  }

  async function splitItem(item: DraftItem, keep: string[]) {
    await mutate("split", async () => {
      const result = await mediaDraftSplit({ libraryId, itemKey: item.itemKey, keep })
      setSplitting(null)
      setKeepIds([])
      return `已拆分：留在原卡 ${keep.length} 个文件，新立 ${result.createdKeys?.length ?? 0} 张待判定卡`
    })
  }

  async function keepBinding(row: { itemKey: string }, next: string) {
    await mutate("keep-binding", async () => {
      // next === row.itemKey 就是复位（后端认这条路，§9.1）。
      await mediaDraftKeepBinding({ libraryId, itemKey: row.itemKey, keepsBindingOnKey: next })
      return next === row.itemKey ? "绑定改回留在这张卡上" : "绑定改由选中的那份草稿承接（apply 时搬）"
    })
  }

  /** 换条目：先搜 Bangumi（与正式卡的换绑同一个搜索端点），再从命中里挑一条绑。 */
  async function searchEntries(query: string) {
    const q = query.trim()
    if (q.length < 2) { setNotice("搜索词至少 2 个字"); return }
    setBusy("search")
    setNotice("")
    try {
      const reply = await bangumiSearch(q)
      setHits(reply.items ?? [])
      if ((reply.items ?? []).length === 0) setNotice("没搜到条目，换个写法试试")
    } catch (failure) {
      setNotice(draftEditErrorText(failure, "搜索失败"))
    } finally {
      setBusy("")
    }
  }

  async function classify() {
    await run("classify", async () => {
      try {
        await mediaDraftClassify(libraryId)
        setNotice("已重新分类：判定被清空，请重新判定。")
        await load()
      } catch (failure) { setNotice(draftErrorText(failure, "重新分类失败")) }
    })
  }

  async function scan() {
    await run("scan", async () => {
      try {
        const result = await mediaLibraryScan(libraryId)
        setNotice(`已扫描：${result.files} 个文件（rev ${result.rev}）。接着做分类。`)
        try { await mediaDraftClassify(libraryId); await load() } catch { setError("CATALOG_DRAFT_EMPTY") }
      } catch (failure) { setNotice(draftErrorText(failure, "扫描失败")) }
    })
  }

  async function apply(force: boolean) {
    await run(force ? "force" : "apply", async () => {
      try {
        const result = await mediaDraftApply(libraryId, force)
        setLastApply(result)
        setDialog(null)
        setNotice("已应用：草稿落到正式卡。")
        await load()
      } catch (failure) {
        const code = draftErrorCode(failure)
        const data = errorData(failure)
        setNotice(draftErrorText(failure))
        // 未判完：默认拒绝，但把 force 的出口摆出来（代价写在弹层里）。
        if (code === "CATALOG_DRAFT_INCOMPLETE") {
          setDialog("force")
          // 用错误体里的数字，别拿上次 GET 的近似值。
          if (data.pending !== undefined) setServerPending(data.pending)
        } else setDialog(null)
        if (code === "CATALOG_STALE_SCAN") setStale({ draftRev: data.draftRev, scanRev: data.scanRev })
        if (code === "CATALOG_DRAFT_EMPTY") setError(code)
      }
    })
  }

  if (loading && !state && !error) return <p className="draft-hint">正在读取草稿…</p>

  // 「还没扫过」后端给的是 200 + 空草稿；409 CATALOG_DRAFT_EMPTY 也照旧认。
  if (error === "CATALOG_DRAFT_EMPTY" || emptyKind(state) !== null) {
    const kind = emptyKind(state)
    return (
      <div className="draft-empty">
        <MaterialSymbol name="library" className="size-5 text-muted-foreground" />
        <h4>{kind === "scanned-not-classified" ? `${libraryName} 扫描过，但还没有草稿` : `${libraryName} 还没有草稿`}</h4>
        <p>
          {kind === "scanned-not-classified"
            ? `快照里有 ${state?.scan?.files ?? 0} 个文件（rev ${state?.scan?.rev ?? 0}），但还没分组。分类只写草稿表，正式卡一行不动。`
            : "草稿是「先看后落」的中间层：扫描（枚举）→ 分类（分组）→ 判定（查条目）只写草稿表，正式卡一行不动；只有「应用」才会落库。"}
        </p>
        <ol className="draft-empty-steps">
          <li>1 扫描 · 枚举文件与修订号</li>
          <li>2 分类 · 分组落草稿</li>
          <li>3 判定 · 分批查条目站</li>
          <li>4 应用 · 草稿转正式卡</li>
        </ol>
        {kind === "scanned-not-classified" ? (
          <div className="draft-empty-actions">
            <Button disabled={Boolean(busy)} onClick={() => void classify()}>{busy === "classify" ? "正在分类…" : "开始分类"}</Button>
            <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void scan()}>{busy === "scan" ? "正在扫描…" : "重新扫描"}</Button>
          </div>
        ) : (
          <Button disabled={Boolean(busy)} onClick={() => void scan()}>{busy === "scan" ? "正在扫描…" : "开始扫描"}</Button>
        )}
      </div>
    )
  }

  if (!state) {
    return (
      <div className="draft-error" role="status">
        <b>{draftErrorText({ code: error }, "读取草稿失败")}</b>
        <div className="draft-error-actions">
          <Button size="sm" variant="outline" onClick={() => void load()}>重试</Button>
          {error === "CATALOG_DRAFT_EMPTY" ? null : <Button size="sm" variant="ghost" onClick={() => void classify()}>重新分类</Button>}
        </div>
      </div>
    )
  }

  return (
    <section className="draft" aria-label="草稿审阅">
      <header className="draft-bar">
        <div className="draft-bar-title">
          <b>{libraryName} · 草稿</b>
          <span className="draft-stats">
            {state.draft.length} 张卡 · {state.files} 个文件 · 扫描 rev {state.scan?.rev ?? "—"}（{state.scan?.files ?? "—"} 个文件）
          </span>
        </div>
        <span className="flex-1" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题 / 目录名…" aria-label="搜索草稿" className="h-8 w-56 text-xs" />
        <Button size="sm" variant="outline" disabled={Boolean(busy) || progress.pending === 0} onClick={() => void judgeNext()}>
          {busy === "judge" ? "正在判定…" : `继续判定下一批（≤${JUDGE_BATCH}）`}
        </Button>
        <Button size="sm" variant="accent" disabled={Boolean(busy)} onClick={() => setDialog("apply")}>
          应用草稿…{progress.pending > 0 ? `（${progress.pending} 张未判定）` : ""}
        </Button>
      </header>

      <div className="draft-progress">
        <div className="draft-progress-bar"><span style={{ width: `${progress.percent}%` }} /></div>
        <div className="draft-progress-meta">
          <span>本轮判定 <b>{progress.judged}</b> / {progress.total}（自动确认 {progress.auto} · 待人工 {progress.manual}）</span>
          <span className="text-muted-foreground">还剩 <b>{progress.pending}</b> 张未判定 · 条目站匿名限速 ~60 req/min</span>
        </div>
      </div>

      <div className="draft-chips" role="group" aria-label="差异与判定过滤">
        {chips.map(chip => (
          <button
            key={chip.key}
            type="button"
            className={cn("draft-chip", chip.tone, filter === chip.key && "on")}
            aria-pressed={filter === chip.key}
            title={chip.hint}
            onClick={() => setFilter(chip.key)}
          >
            <b>{chip.count}</b>{chip.label}
          </button>
        ))}
      </div>

      {stale ? (
        <div className="draft-banner warn">
          <MaterialSymbol name="sync" className="size-4" />
          <span>草稿来自旧快照（草稿 rev {stale.draftRev ?? "—"} / 扫描 rev {stale.scanRev ?? "—"}）：不能直接应用，先重新分类。</span>
          <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void classify()}>重新分类</Button>
        </div>
      ) : null}
      {state.diff && state.diff.dropped.length > 0 ? (
        <div className="draft-banner warn">
          <MaterialSymbol name="close" className="size-4" />
          <span>{state.diff.dropped.length} 张库里有、草稿没有：机器确认的会被删，人工碰过的保留。</span>
        </div>
      ) : null}

      {selected.length >= 2 ? (
        <div className="draft-merge-bar">
          <span>已选 <b>{selected.length}</b> 张 · 保留：</span>
          <select
            aria-label="合并后保留哪一张"
            value={selected[0]}
            onChange={(event) => setSelected(current => [event.target.value, ...current.filter(key => key !== event.target.value)])}
          >
            {selected.map(key => <option key={key} value={key}>{state.draft.find(item => item.itemKey === key)?.title ?? key}</option>)}
          </select>
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void mergeSelected()}>{busy === "merge" ? "正在合并…" : "合并这几张"}</Button>
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setSelected([])}>清空选择</Button>
          <span className="draft-hint">文件并集、候选按分数留最高；被吞的行里若有人工决定会先报冲突。</span>
        </div>
      ) : null}

      <table className="draft-table">
        <thead>
          <tr><th className="draft-pick"><span className="sr-only">选择</span></th><th>卡片 / 目录</th><th>文件</th><th>集数行</th><th>差异</th><th>判定</th><th>来源</th></tr>
        </thead>
        <tbody>
          {rows.map(item => (
            <DraftRow
              key={item.itemKey}
              item={item}
              state={state}
              open={openKey === item.itemKey}
              justJudged={justJudged.includes(item.itemKey)}
              detail={detailCache[item.itemKey] ?? null}
              picked={selected.includes(item.itemKey)}
              onPick={() => setSelected(current => current.includes(item.itemKey) ? current.filter(key => key !== item.itemKey) : [...current, item.itemKey])}
              onToggle={() => {
                const nextOpen = openKey !== item.itemKey
                setOpenKey(nextOpen ? item.itemKey : null)
                if (nextOpen) void loadDetail(item.itemKey)
              }}
              edit={{ busy, titleDraft, searchFor, searchQuery, hits, splitting, keepIds, setTitleDraft, setSearchFor, setSearchQuery, setSplitting, setKeepIds, searchEntries, editTitle, pickEntry, bindSearchEntry, confirmTop, unconfirmDraft, splitItem }}
            />
          ))}
          {dropped.map(row => (
            <tr key={`dropped-${row.id}`} className="draft-row dropped">
              <td>
                <div className="draft-cell-title">{row.title ?? row.itemKey}</div>
                <div className="draft-rel" title={row.itemKey}>{row.itemKey}</div>
              </td>
              <td className="draft-num">{typeof row.files === "number" ? row.files : row.files?.from ?? "—"}</td>
              <td className="draft-num">—</td>
              <td><span className="draft-tag warn">将删除</span></td>
              <td><span className="draft-tag dim">—</span></td>
              <td><span className="draft-tag dim">库里</span></td>
            </tr>
          ))}
          {rows.length === 0 && dropped.length === 0 ? (
            <tr><td colSpan={7} className="draft-none">这个筛选下没有卡片。</td></tr>
          ) : null}
        </tbody>
      </table>

      <p className="draft-caption">
        共 {state.draft.length} 行草稿（另有 {dropped.length} 行来自正式库）。
        「一致」按正式卡算是 {state.diff?.unchanged ?? 0} 张；表格里落在「一致」的草稿行是 {state.draft.filter(item => bucketOfItem(item, state.diff) === "unchanged").length} 行 —— 移动的 {state.diff?.moved.length ?? 0} 张另计。
      </p>

      {notice ? <p className="draft-notice" role="status">{notice}</p> : null}
      {lastApply ? <p className="draft-notice" role="status">{applyResultText(lastApply)}</p> : null}

      {dialog ? <ApplyDialog plane={plan} pending={serverPending ?? progress.pending} humanConfirmed={humanConfirmedCount} draft={state.draft} drift={state.diff?.confirmedDrift ?? []} added={state.diff?.added ?? []} onKeepBinding={(row, next) => void keepBinding(row, next)} force={dialog === "force"} busy={Boolean(busy)} onCancel={() => { setDialog(null); setServerPending(null) }} onConfirm={(force) => void apply(force)} /> : null}
    </section>
  )
}

interface RowEdit {
  busy: string
  titleDraft: Record<string, string>
  searchFor: string | null
  searchQuery: string
  hits: BangumiHit[]
  splitting: string | null
  keepIds: string[]
  setTitleDraft: (update: (current: Record<string, string>) => Record<string, string>) => void
  setSearchFor: (itemKey: string | null) => void
  setSearchQuery: (query: string) => void
  setSplitting: (itemKey: string | null) => void
  setKeepIds: (ids: string[]) => void
  searchEntries: (query: string) => Promise<void>
  editTitle: (item: DraftItem, title: string) => Promise<void>
  pickEntry: (item: DraftItem, hit: { externalDb: string; externalId: string; title: string }) => Promise<void>
  bindSearchEntry: (item: DraftItem, hit: BangumiHit) => Promise<void>
  confirmTop: (item: DraftItem) => Promise<void>
  unconfirmDraft: (item: DraftItem) => Promise<void>
  splitItem: (item: DraftItem, keep: string[]) => Promise<void>
}

function DraftRow({ item, state, open, justJudged, detail, picked, onPick, onToggle, edit }: {
  item: DraftItem
  state: DraftState
  open: boolean
  justJudged: boolean
  detail: { children: DraftChild[]; candidates: DraftCandidate[] } | "loading" | "error" | null
  picked: boolean
  onPick: () => void
  onToggle: () => void
  edit: RowEdit
}) {
  const candidates = typeof detail === "object" && detail !== null ? detail.candidates : []
  const children = typeof detail === "object" && detail !== null ? detail.children : null
  const bucket = bucketOfItem(item, state.diff)
  const moved = state.diff?.moved.find(row => row.itemKey === item.itemKey)
  const drift = state.diff?.confirmedDrift.find(row => row.itemKey === item.itemKey)
  const pending = item.lookupState !== "done"
  const title = item.confirmedBy ? item.title ?? item.rawName : item.title ?? item.query
  const chips: Array<{ text: string; tone: string }> = []
  if (bucket === "added") chips.push({ text: "新建", tone: "ok" })
  if (bucket === "dropped") chips.push({ text: "将删除", tone: "danger" })
  if (bucket === "moved") chips.push({ text: "移动", tone: "info" })
  if (bucket === "changed") chips.push({ text: "改写", tone: "info" })
  if (bucket === "confirmedDrift") chips.push({ text: "已确认漂移", tone: "warn" })

  return (
    <>
      <tr className={cn("draft-row", bucket !== "unchanged" && `is-${bucket}`, open && "open", justJudged && "just-judged")}>
        <td className="draft-pick">
          <input type="checkbox" aria-label={`选中 ${title || item.rawName}`} checked={picked} onChange={onPick} />
        </td>
        <td>
          <button type="button" className="draft-open" aria-expanded={open} onClick={onToggle}>
            <span className="draft-cell-title">{title || item.rawName}</span>
          </button>
          <div className="draft-rel" title={item.itemKey}>{item.itemKey}</div>
        </td>
        <td className="draft-num">{item.files}</td>
        <td className="draft-num">{item.subtitle ?? "—"}</td>
        <td>{chips.length ? chips.map(chip => <span key={chip.text} className={cn("draft-tag", chip.tone)}>{chip.text}</span>) : <span className="draft-tag dim">一致</span>}</td>
        <td>
          {pending
            ? <span className="draft-tag dim">未判定</span>
            : item.status === "candidate"
              ? <span className="draft-tag warn">待人工 {item.topScore?.toFixed(2) ?? ""}</span>
              : <span className="draft-tag ok">已判 {item.topScore?.toFixed(2) ?? ""}</span>}
        </td>
        <td>{item.confirmedBy ? <span className={cn("draft-tag", item.confirmedBy === "auto" ? "auto" : "manual")}>{CONFIRMED_LABEL[item.confirmedBy] ?? item.confirmedBy}</span> : <span className="draft-tag dim">未确认</span>}</td>
      </tr>
      {open ? (
        <tr className="draft-detail-row">
          <td colSpan={7}>
            <div className="draft-detail">
              {/* 编辑（§9 六个接口）：只写草稿，重新分类会整体丢掉这些改动。 */}
              <div className="draft-edit">
                <div className="draft-edit-row">
                  <span className="draft-edit-label">改名</span>
                  <Input
                    value={edit.titleDraft[item.itemKey] ?? title}
                    aria-label={`改标题 ${item.itemKey}`}
                    className="h-8 flex-1 text-xs"
                    onChange={(event) => edit.setTitleDraft(current => ({ ...current, [item.itemKey]: event.target.value }))}
                  />
                  <Button size="sm" variant="outline" disabled={Boolean(edit.busy)} onClick={() => void edit.editTitle(item, edit.titleDraft[item.itemKey] ?? title)}>保存</Button>
                </div>
                <div className="draft-edit-row">
                  <span className="draft-edit-label">换条目</span>
                  <Input
                    value={edit.searchFor === item.itemKey ? edit.searchQuery : ""}
                    placeholder="搜 Bangumi（≥2 字）…"
                    aria-label={`搜索条目 ${item.itemKey}`}
                    className="h-8 flex-1 text-xs"
                    onChange={(event) => { edit.setSearchFor(item.itemKey); edit.setSearchQuery(event.target.value) }}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void edit.searchEntries(edit.searchQuery) } }}
                  />
                  <Button size="sm" variant="outline" disabled={edit.busy === "search"} onClick={() => void edit.searchEntries(edit.searchQuery)}>{edit.busy === "search" ? "搜索中…" : "搜索"}</Button>
                </div>
                {edit.searchFor === item.itemKey && edit.hits.length > 0 ? (
                  <ul className="draft-hits">
                    {edit.hits.slice(0, 6).map(hit => (
                      <li key={`${hit.externalDb}-${hit.externalId}`}>
                        <span className="draft-cand-title">{hit.title}</span>
                        <span className="draft-cand-orig">{hit.originalTitle ?? ""}</span>
                        <span className="draft-cand-meta">{hit.year ?? "年份未知"} · {hit.externalDb} #{hit.externalId}</span>
                        <Button size="sm" variant="accent" disabled={Boolean(edit.busy)} onClick={() => void edit.bindSearchEntry(item, hit)}>绑这条</Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="draft-edit-row">
                  <Button size="sm" variant="outline" disabled={Boolean(edit.busy) || item.candidateCount === 0} title={item.candidateCount === 0 ? "没有候选，先判定一轮" : "确认候选列表里的第一条"} onClick={() => void edit.confirmTop(item)}>确认第一个候选</Button>
                  <Button size="sm" variant="ghost" disabled={Boolean(edit.busy) || !item.confirmedBy} onClick={() => void edit.unconfirmDraft(item)}>撤销人工决定</Button>
                  {children && children.length > 1 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={Boolean(edit.busy)}
                      onClick={() => {
                        const entering = edit.splitting !== item.itemKey
                        edit.setSplitting(entering ? item.itemKey : null)
                        if (entering) edit.setKeepIds(children.map(child => child.mediaId))
                      }}
                    >
                      {edit.splitting === item.itemKey ? "退出拆分" : "拆分这张…"}
                    </Button>
                  ) : null}
                </div>
                {edit.splitting === item.itemKey && children ? (
                  <div className="draft-split">
                    <p className="draft-hint">勾选<b>留在原卡</b>的文件（默认全勾 = 不拆）；没勾的按父目录自动成新卡（待判定）。</p>
                    <ul className="draft-file-list">
                      {children.map(child => (
                        <li key={child.mediaId}>
                          <label className="draft-split-file">
                            <input
                              type="checkbox"
                              checked={edit.keepIds.includes(child.mediaId)}
                              onChange={() => edit.setKeepIds(edit.keepIds.includes(child.mediaId) ? edit.keepIds.filter(id => id !== child.mediaId) : [...edit.keepIds, child.mediaId])}
                            />
                            <span className="draft-rel" title={child.relativePath}>{child.name}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="draft-edit-row">
                      <Button
                        size="sm"
                        disabled={Boolean(edit.busy) || edit.keepIds.length === 0 || edit.keepIds.length === children.length}
                        onClick={() => void edit.splitItem(item, edit.keepIds)}
                      >
                        {edit.busy === "split" ? "正在拆分…" : `拆分（留下 ${edit.keepIds.length} / ${children.length}）`}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
              {drift ? (
                <p className="draft-drift">
                  已确认卡漂移：文件 {typeof drift.files === "number" ? drift.files : `${drift.files.from} → ${drift.files.to}`}
                  {drift.subtitle ? ` · 集数行 ${drift.subtitle.from ?? "—"} → ${drift.subtitle.to ?? "—"}` : ""}
                  <span className="text-muted-foreground">（标题、绑定、封面都不动）</span>
                </p>
              ) : null}
              {moved?.fromKey ? <p className="draft-drift">键位更新：<span className="draft-rel">{moved.fromKey}</span> → 现在这个目录</p> : null}
              {item.lookupState !== "done" ? (
                <p className="draft-hint">还没判定：它只参与结构对齐，<b>绝不动绑定</b>。点上面的「继续判定下一批」把它送进队列。</p>
              ) : detail === "loading" ? (
                <p className="draft-hint">正在读取候选…</p>
              ) : candidates.length === 0 ? (
                <p className="draft-hint">
                  {item.candidateCount > 0 ? "候选读不到（展开时拉一次，失败就空着）。" : "判定没有提出候选（解析名太脏或条目站没有对应条目）。"}
                  应用后到标题墙右栏人工换绑。
                </p>
              ) : (
                <>
                  <div className="draft-cands-head">
                    <b>候选（{candidates.length}）</b>
                    <span className="text-muted-foreground">
                      分数 ≥ {autoScoreOf(state.thresholds).toFixed(2)} 的会直接绑定 · 点哪条就绑哪条
                    </span>
                  </div>
                  <ul className="draft-cands">
                    {candidates.map((candidate, index) => {
                      const bound = item.externalDb === candidate.externalDb && item.externalId === candidate.externalId
                      return (
                        <li key={`${candidate.externalDb}-${candidate.externalId}`} className={cn("draft-cand", index === 0 && "top", bound && "bound")}>
                          <button
                            type="button"
                            className="draft-cand-pick"
                            disabled={Boolean(edit.busy) || bound}
                            title={bound ? "已经是这一条了" : `绑到 ${candidate.title}`}
                            aria-label={`绑到 ${candidate.title}`}
                            onClick={() => void edit.pickEntry(item, candidate)}
                          >
                            <span className="draft-cand-title">{candidate.title}</span>
                            <span className="draft-cand-orig">{candidate.originalTitle ?? ""}</span>
                            <span className="draft-cand-meta">{candidate.year ?? "年份未知"} · {candidate.externalDb} #{candidate.externalId}</span>
                            <span className={cn("draft-cand-score", scoreTone(candidate.score, state.thresholds))}>{candidate.score.toFixed(2)}</span>
                            <span className="draft-cand-act">{bound ? (item.confirmedBy === "manual" || item.confirmedBy === "rebind" ? "已人工绑定" : "已绑定") : "绑这条"}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="draft-hint">点一条即人工确定该条目（apply 时不会再被自动覆盖）；要改回机器判定就按「撤销人工决定」。</p>
                </>
              )}
              {/* children 走 `?item=` 子请求（列表投影里没有），按库内目录分节。 */}
              <div className="draft-files">
                {detail === "loading" ? <p className="draft-hint">正在读取这一张的文件…</p>
                  : detail === "error" ? <p className="draft-hint">文件列表读不到（这一张可能已经不在了）。</p>
                  : children ? groupByDir(item.itemKey, children).map(group => (
                    <section key={group.dir || "(根)"}>
                      <h5>{group.label}<span className="muted">{group.items.length} 个文件</span></h5>
                      <ul className="draft-file-list">
                        {group.items.slice(0, 12).map(child => (
                          <li key={child.mediaId}><span className="draft-rel" title={child.relativePath}>{child.name}</span></li>
                        ))}
                        {group.items.length > 12 ? <li className="draft-hint">…还有 {group.items.length - 12} 个</li> : null}
                      </ul>
                    </section>
                  )) : null}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

const autoScoreOf = (thresholds: DraftThresholds | null) => thresholds?.autoScore ?? 0.86

/** 文件按所在目录分节（children 只有 relativePath，没有 relDir）：与卡同层的一组叫「正片」。 */
function groupByDir(itemKey: string, children: DraftChild[]): Array<{ dir: string; label: string; items: DraftChild[] }> {
  const dirOf = (path: string) => path.replace(/\/[^/]*$/, "")
  const base = dirOf(itemKey)
  const buckets = new Map<string, DraftChild[]>()
  for (const child of children) {
    const dir = dirOf(child.relativePath ?? "")
    buckets.set(dir, [...(buckets.get(dir) ?? []), child])
  }
  return [...buckets.entries()].map(([dir, items]) => ({
    dir,
    items,
    label: dir === base || dir === "" ? "正片" : dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir.replace(/^\/+/, ""),
  }))
}

const CONFIRMED_LABEL: Record<string, string> = { auto: "机器匹配", manual: "人工确认", rebind: "人工指定", unknown: "来源未知" }

function ApplyDialog({ plane, pending, humanConfirmed, draft, drift, added, onKeepBinding, force, busy, onCancel, onConfirm }: {
  plane: ReturnType<typeof applyPlan>
  pending: number
  humanConfirmed: number
  draft: DraftItem[]
  drift: NonNullable<DraftState["diff"]>["confirmedDrift"]
  added: NonNullable<DraftState["diff"]>["added"]
  onKeepBinding: (row: { itemKey: string; keepsBindingOnKey?: string }, next: string) => void
  force: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: (force: boolean) => void
}) {
  const sideEffects = applySideEffects({ pending, humanConfirmed })
  return (
    <div className="draft-dialog-scrim" role="dialog" aria-modal="true" aria-label={force ? "强行应用草稿" : "应用草稿"}>
      <div className={cn("draft-dialog", force && "danger")}>
        {force ? (
          <>
            <h4><span className="draft-tag danger">强行应用（force=1）</span></h4>
            <p>草稿里还有 <b>{pending} 张没判定</b>。强行应用会：</p>
            <ul className="draft-danger-list">
              <li>把未判定的卡按结构对齐写进库，它们会停在「未匹配」；</li>
              <li>这些卡上原有的<b>候选列表会被清空</b>，下一轮判定要重新查条目站；</li>
              <li><b>已经确认的绑定不会丢</b>（人工 / 人工指定 / 来源未知的都受保护）。</li>
            </ul>
            <p className="draft-danger-tail">日常做法是先判完再应用；只有「结构对不上、急着先落库」时才用它。</p>
          </>
        ) : (
          <>
            <h4>{applyHeadline(plane, pending)}</h4>
            <ul className="draft-plan">
              <li><b className="ok">新建 {plane.created} 张</b><span>草稿里有、库里没有的作品卡（带判定结果与海报）</span></li>
              <li><b className="dim">删除 {plane.removed} 张</b><span>机器确认的卡才会删；人工碰过的一律保留</span></li>
              <li><b className="dim">改写 {plane.rewritten} 张</b><span>未确认卡的标题/集数行重写成草稿的判定结果</span></li>
              <li><b className="dim">键位更新 {plane.moved} 张</b><span>同一堆文件换了目录，绑定与标题不动</span></li>
            </ul>
            {plane.drift > 0 ? (
              <div className="draft-drift-box">
                <span className="draft-tag warn">已确认卡漂移 {plane.drift} 张（单独处理）</span>
                <p>只刷子文件与集数行。<b>标题、绑定、封面都不会动</b>。</p>
                <ul className="draft-pair-list">
                  {drift.map(row => {
                    const split = splitSummary(row, added)
                    // 当前承接方读草稿行的 carriesKey（diff 的 keepsBindingOnKey 只是 apply 预览的推算值，会滞后一拍）。
                    const carrier = carrierKeyOf(draft.find(item => item.itemKey === row.itemKey) ?? { itemKey: row.itemKey })
                    return (
                      <li key={row.id}>
                        <span>{row.title}：文件 {split.equation ? <><b>{split.equation}</b></> : <>从 {row.files.from} → <b>{row.files.to}</b></>}</span>
                        {split.equation ? (
                          <span className="draft-pair">＋ 新卡：{split.labels.join(' / ')}（接走 {split.movedFiles} 个文件）</span>
                        ) : null}
                        {split.equation ? (
                          <span className="draft-bind">
                            ⬒ 绑定留在
                            <select
                              aria-label={`绑定留在哪一份 ${row.itemKey}`}
                              value={carrier}
                              disabled={busy}
                              onChange={(event) => onKeepBinding(row, event.target.value)}
                            >
                              {[row.itemKey, ...split.keys].map(key => (
                                <option key={key} value={key}>{bindingLabel({ itemKey: key, title: key === row.itemKey ? row.title : null }, draft)}</option>
                              ))}
                            </select>
                            另 <b>{split.keys.length}</b> 张新卡（未确认）从这批文件里长出来
                          </span>
                        ) : null}
                        {split.equation && bindingMoveText(row, draft, carrier) ? <span className="draft-bind warn">{bindingMoveText(row, draft, carrier)}</span> : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}
            <p className="draft-caption">其余 {plane.unchanged} 张一致，一张不动。</p>
            {sideEffects.length ? (
              <ul className="draft-side-effects">
                {sideEffects.map(line => <li key={line}>{line}</li>)}
              </ul>
            ) : null}
            {pending > 0 ? <p className="draft-hint">还有 {pending} 张未判定：直接应用会被服务端 409 拒绝，届时可以改用「强行应用」。</p> : null}
          </>
        )}
        <div className="draft-dialog-actions">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>
          {force
            ? <Button size="sm" variant="accent" className="draft-danger-btn" disabled={busy} onClick={() => onConfirm(true)}>{busy ? "正在应用…" : "仍然应用（危险）"}</Button>
            : <Button size="sm" variant="accent" disabled={busy} onClick={() => onConfirm(false)}>{busy ? "正在应用…" : "应用"}</Button>}
        </div>
      </div>
    </div>
  )
}
