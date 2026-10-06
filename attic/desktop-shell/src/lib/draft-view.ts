import type { CatalogApprovalLedgerRow, CatalogStructuralChanges, DraftDiff, DraftDiffItem, DraftErrorData, DraftItem, DraftState, DraftThresholds } from "@/lib/ipc"

/**
 * 草稿审阅（方案 B：按卡片 + 过滤器/搜索）的纯视图模型。
 * 与 React 无关，便于单测；差异桶计数来自服务端 diff，行级归属按 itemKey 认。
 */

export type DraftBucketKey = "all" | "added" | "dropped" | "moved" | "changed" | "confirmedDrift" | "unchanged"
export type DraftFilterKey = DraftBucketKey | "pending" | "review"

export interface DraftBucket {
  key: DraftFilterKey
  label: string
  count: number
  hint: string
  tone: "ok" | "warn" | "info" | "dim"
}

const BUCKET_META: Array<{ key: Exclude<DraftBucketKey, "all">; label: string; hint: string; tone: DraftBucket["tone"] }> = [
  { key: "added", label: "新建", hint: "草稿有、库里没有——应用时新建作品卡", tone: "ok" },
  { key: "dropped", label: "删除", hint: "库里有、草稿没有；人工碰过的一律保留", tone: "warn" },
  { key: "moved", label: "移动", hint: "同一堆文件换了目录，绑定不动", tone: "info" },
  { key: "changed", label: "改写", hint: "未确认卡的标题/集数行会重写", tone: "info" },
  { key: "confirmedDrift", label: "已确认漂移", hint: "只刷子文件与集数行；标题、绑定、封面都不动", tone: "warn" },
  { key: "unchanged", label: "一致", hint: "一张不动", tone: "dim" },
]

/** chips：六个差异桶 + 两个判定状态过滤（判定是常态操作，所以给它们同等的入口）。 */
export function draftBuckets(state: DraftState | null): DraftBucket[] {
  const diff = state?.diff ?? null
  const review = state?.draft.filter(item => item.lookupState === "done" && item.status === "candidate").length ?? 0
  const chips: DraftBucket[] = [{
    key: "all",
    label: "全部",
    count: state?.draft.length ?? 0,
    hint: "不筛",
    tone: "dim",
  }]
  for (const meta of BUCKET_META) {
    const rows = meta.key === "unchanged" ? null : (diff?.[meta.key] as DraftDiffItem[] | undefined)
    const count = rows ? rows.length : diff?.unchanged ?? 0
    chips.push({ ...meta, count })
  }
  chips.splice(1, 0, { key: "pending", label: "未判定", count: state?.pending ?? 0, hint: "还没查条目站", tone: "dim" })
  chips.push({ key: "review", label: "待人工", count: review, hint: "判过分但没过自动确认线", tone: "warn" })
  return chips
}

/**
 * 一张草稿卡属于哪个桶。都不是 → 一致。
 *
 * `dropped` 也在这里判：diff.dropped 说的是「库里有、草稿没有」，但库里有、草稿里也
 * 还留着、只是被判定为「这批文件已不在快照里」的行同样落这个桶。漏掉它的话，这些行
 * 会掉进「一致」显示成一张不动，而 apply 时那张卡其实会被删。
 */
export function bucketOfItem(item: DraftItem, diff: DraftDiff | null): Exclude<DraftFilterKey, "all" | "pending" | "review"> {
  if (!diff) return "unchanged"
  const hit = (rows: Array<{ itemKey: string }> | undefined) => (rows ?? []).some(row => row.itemKey === item.itemKey)
  if (hit(diff.added)) return "added"
  if (hit(diff.dropped)) return "dropped"
  if (hit(diff.moved)) return "moved"
  if (hit(diff.changed)) return "changed"
  if (hit(diff.confirmedDrift)) return "confirmedDrift"
  return "unchanged"
}

export function isPending(item: DraftItem): boolean {
  return item.lookupState !== "done"
}

/** 判定过、但没到自动确认线（待人工）——这批要人拍。 */
export function needsReview(item: DraftItem): boolean {
  return item.lookupState === "done" && item.status === "candidate"
}

export function filterDraft(state: DraftState | null, filter: DraftFilterKey, query: string): DraftItem[] {
  const rows = state?.draft ?? []
  const needle = query.trim().toLowerCase()
  return rows.filter(item => {
    if (filter === "pending" && !isPending(item)) return false
    if (filter === "review" && !needsReview(item)) return false
    if (filter !== "all" && filter !== "pending" && filter !== "review" && bucketOfItem(item, state?.diff ?? null) !== filter) return false
    if (!needle) return true
    return `${item.title ?? ""} ${item.rawName} ${item.query}`.toLowerCase().includes(needle)
  })
}

/** 表格里额外那几行：库里有、草稿没有（将被删除，人工卡会被保留）。 */
export function droppedRows(state: DraftState | null): DraftDiffItem[] {
  return state?.diff?.dropped ?? []
}

export interface JudgeProgress {
  judged: number
  total: number
  auto: number
  manual: number
  pending: number
  percent: number
}

export function judgeProgress(state: DraftState | null): JudgeProgress {
  const total = state?.draft.length ?? 0
  const pending = state?.pending ?? 0
  const judged = Math.max(0, total - pending)
  const auto = state?.draft.filter(item => item.confirmedBy === "auto").length ?? 0
  // 「待人工」= 判过但仍是候选态；judge 返回里 confirmed 只算自动确认的那部分。
  const manual = state?.draft.filter(item => needsReview(item)).length ?? 0
  return { judged, total, auto, manual, pending, percent: total ? Math.round((judged / total) * 100) : 0 }
}

export interface ApplyPlan {
  created: number
  removed: number
  rewritten: number
  moved: number
  drift: number
  unchanged: number
}

export function applyPlan(state: DraftState | null): ApplyPlan {
  const diff = state?.diff ?? null
  return {
    created: diff?.added.length ?? 0,
    removed: diff?.dropped.length ?? 0,
    rewritten: diff?.changed.length ?? 0,
    moved: diff?.moved.length ?? 0,
    drift: diff?.confirmedDrift.length ?? 0,
    unchanged: diff?.unchanged ?? 0,
  }
}

/** 应用对话框上的一句话（含 force 的两种口径）。 */
export function applyHeadline(plan: ApplyPlan, pending: number): string {
  const parts = [`新建 ${plan.created}`, `删除 ${plan.removed}`, `改写 ${plan.rewritten}`, `键位更新 ${plan.moved}`]
  if (plan.drift) parts.push(`漂移 ${plan.drift}`)
  return pending > 0 ? `将应用（还有 ${pending} 张未判定）· ${parts.join(" / ")}` : `将应用 · ${parts.join(" / ")}`
}

const DRAFT_ERROR_TEXT: Record<string, string> = {
  CATALOG_DRAFT_EMPTY: "这个库还没有草稿：先扫描再分类。",
  CATALOG_STALE_SCAN: "草稿来自旧快照（期间重新枚举过）。这份草稿不能直接应用，先重新分类。",
  CATALOG_DRAFT_INCOMPLETE: "还有未判定的草稿。默认拒绝应用；确要应用就用「强行应用」并接受代价。",
  CATALOG_UNAVAILABLE: "条目站暂时不可达。检查代理后重试；草稿和正式卡都没动。",
  ADMIN_FORBIDDEN: "只有本机或管理员能审阅与应用草稿。",
  MEDIA_NOT_FOUND: "这个库已经不在了，刷新一下列表。",
  INVALID_REQUEST: "请求不合法（库 id 或参数不对）。",
  // 批准门（§10.1）。这几个码本身不带人话，界面按码给动作；INVALID 的细分理由在 approvalInvalidText。
  CATALOG_APPROVAL_REQUIRED: "这次会动到卡片结构（建卡/删卡/移动文件），要人在本页批准一次。",
  CATALOG_NOTHING_TO_APPROVE: "没有需要批准的结构变更——直接「应用」就行。",
  CATALOG_APPROVAL_SECRET_REQUIRED: "服务端配了第二把批准密钥，本机没有出示（或出示的不对）。先把密钥配好再来批。",
  CATALOG_APPROVAL_INVALID: "批准失效了，请重新批准。",
  // 回滚的四个前置码 + 窗口（§11.1/§11.4）。
  CATALOG_ROLLBACK_TARGET_NOT_FOUND: "找不到那次应用（可能已经被清理）。",
  CATALOG_ROLLBACK_TARGET_NOT_APPLY: "那不是一次应用记录，撤不了。",
  CATALOG_ROLLBACK_WINDOW_CLOSED: "撤回窗口已经关了（48 小时）。这次改动已经落地，要调整就再改一次草稿。",
  CATALOG_ROLLBACK_NOT_RECORDED: "那次应用没留下反向记录，撤不了。",
  CATALOG_ROLLBACK_ALREADY_DONE: "这次应用已经撤过了。",
  CATALOG_ROLLBACK_CONFLICT: "你改动过涉及这次撤回的卡，整批没有动。",
}

/** `CATALOG_APPROVAL_INVALID` 的七个 reason + 兜底（§b 的文案表，两端同表）。 */
const APPROVAL_REASON_TEXT: Record<string, string> = {
  unknown: "这张批准不是本机签发的（服务端换过密钥或换了机器）——重新批准",
  used: "这张批准已经用过了（一次性，上一次失败也会消耗它）——重新批准",
  revoked: "这张批准已被撤销——重新批准",
  expired: "这张批准过期了（48 小时）——重新批准",
  "scan-revision": "批准之后库又扫了一遍——先「重新分类」再批准",
  "draft-revision": "批准之后草稿重分了——先「重新分类」再批准",
  "operations-changed": "批准之后差异变了（期间又改过草稿）——按新的差异重新批准",
}

export function approvalInvalidText(reason: string): string {
  return APPROVAL_REASON_TEXT[reason] ?? DRAFT_ERROR_TEXT.CATALOG_APPROVAL_INVALID
}

/** 批准/撤回这条链上的错误文案：先认 reason，再认码，最后兜底。 */
export function approvalErrorText(error: unknown, fallback = "批准没成功"): string {
  const code = draftErrorCode(error)
  const data = errorData(error)
  if (code === "CATALOG_APPROVAL_INVALID" && data.reason) return approvalInvalidText(data.reason)
  if (code === "CATALOG_ROLLBACK_CONFLICT") {
    const count = data.keys?.length ?? 0
    return count
      ? `这些卡在撤回之前被人改过（${count} 张）：${data.keys?.slice(0, 4).join("、")}${count > 4 ? " 等" : ""}——请逐张确认后再试；整批没有动。`
      : DRAFT_ERROR_TEXT.CATALOG_ROLLBACK_CONFLICT
  }
  return DRAFT_ERROR_TEXT[code] ?? fallback
}

/** 批准单的四类清单（§10.1）：`structural` 只给 itemKey，名字与细节从草稿/差异里 join。 */
export interface StructuralSheetRow {
  key: string
  label: string
  /** 副行：空壳原因、接走几个文件、文件现在落在哪。 */
  note?: string
}

export interface StructuralSheet {
  added: StructuralSheetRow[]
  dropped: StructuralSheetRow[]
  moved: StructuralSheetRow[]
  drift: Array<{ key: string; label: string; from: number; to: number }>
  total: number
}

export function structuralSheet(
  structural: CatalogStructuralChanges,
  draft: Array<{ itemKey: string; title?: string | null; query?: string; rawName?: string }>,
  diff: DraftDiff | null,
): StructuralSheet {
  const droppedRows = diff?.dropped ?? []
  const driftRows = diff?.confirmedDrift ?? []
  const addedRows = diff?.added ?? []
  const nameOf = (key: string, fallbackTitle?: string | null) =>
    (fallbackTitle ?? "").trim() || keyLabel(key, draft)
  return {
    added: structural.added.map(key => {
      const row = addedRows.find(entry => entry.itemKey === key)
      const moved = row?.fromFiles
      const from = row?.splitFromKey ? nameOf(row.splitFromKey) : null
      const note = moved && from ? `从「${from}」接走 ${moved} 个文件` : (moved ? `接走 ${moved} 个文件` : undefined)
      return { key, label: nameOf(key, row?.title ?? row?.query), note }
    }),
    dropped: structural.dropped.map(key => {
      const row = droppedRows.find(entry => entry.itemKey === key)
      const bits: string[] = []
      if (row?.missingPaths) bits.push(`空壳：${row.missingPaths} 个文件已不在快照`)
      if (row?.suggestedKeys?.length) bits.push(`文件现在落在：${row.suggestedKeys.slice(0, 3).map(other => nameOf(other)).join("、")}`)
      return { key, label: nameOf(key, row?.title), note: bits.length ? bits.join("；") : undefined }
    }),
    moved: structural.moved.map(key => {
      const row = (diff?.moved ?? []).find(entry => entry.itemKey === key)
      return { key, label: nameOf(key, row?.title ?? row?.query) }
    }),
    drift: structural.drift.map(row => {
      const match = driftRows.find(entry => entry.itemKey === row.itemKey)
      return { key: row.itemKey, label: nameOf(row.itemKey, match?.title), from: row.from, to: row.to }
    }),
    total: structural.added.length + structural.dropped.length + structural.moved.length + structural.drift.length,
  }
}

/** 撤回行（审阅页一行）：只认 `rollbackAvailable`，不自己推窗口（§13.1）。 */
export interface RollbackLine {
  approvalId: string
  text: string
  label: string
  keys: string[]
  counts: { created: number; removed: number; changed: number }
}

export function rollbackLine(items: CatalogApprovalLedgerRow[]): RollbackLine | null {
  const row = items.find(item => item.kind === "apply" && item.rollbackAvailable)
  if (!row) return null
  const counts = row.counts ?? { created: 0, removed: 0, changed: 0 }
  const cards = row.keys?.length ?? 0
  const text = `上次应用：＋${counts.created} −${counts.removed}${counts.changed ? `（${counts.changed} 张改写）` : ""} · ${cards} 张卡`
  return {
    approvalId: row.approvalId,
    text,
    label: `${row.approvedBy || "桌面端"} · ${row.appliedAt ? row.appliedAt.slice(0, 16).replace("T", " ") : ""}`.trim(),
    keys: row.keys ?? [],
    counts,
  }
}

/** 撤回批准单上的代价清单（§11.1：撤回是真逆，海报行会被接回来，别再写"可重抓"）。 */
export function rollbackSheet(input: { keys: string[]; counts: { created: number; removed: number; changed: number } }): string[] {
  const lines = [`这次撤回会还原 ${input.keys.length} 张卡：恢复 ${input.counts.removed} 张被删的、撤掉 ${input.counts.created} 张新建的`]
  if (input.counts.changed) lines.push(`${input.counts.changed} 张改写过的卡按记录改回去`)
  lines.push("海报会一起接回来；任何一张卡在应用之后被人动过，整批都不会动")
  lines.push("这张批准是一次性的，成功即消耗")
  return lines
}

export function draftErrorText(error: unknown, fallback = "草稿操作失败"): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""
  if (code === "CATALOG_REFRESH_NOT_LANDED") return "后台任务已结束，但结果未更新。请检查服务端日志。"
  if (code === "CATALOG_REFRESH_TIMEOUT") return "等待后台任务超时，任务可能仍在运行。请稍后读取结果。"
  return DRAFT_ERROR_TEXT[code] ?? fallback
}

export function draftErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""
}

/**
 * 候选分数分档。自动确认线与候选线都来自服务端 `thresholds`（§8.5），
 * 没给的时候才退回落值（老后端）。
 */
export function scoreTone(score: number, thresholds?: DraftThresholds | null): "hi" | "mid" | "low" {
  const auto = thresholds?.autoScore ?? 0.86
  const candidate = thresholds?.candidateScore ?? 0.5
  if (score >= auto) return "hi"
  if (score >= candidate) return "mid"
  return "low"
}

/** 应用结果文案（§8.6 给的口径）：skipped 是「你定过的」，deferred 是「还没判定的」。 */
export function applyResultText(result: { created: number; updated: number; skipped: number; deferred: number; posters: number; rollbackAvailable?: boolean }): string {
  const parts = [`新建 ${result.created}`, `更新 ${result.updated}`]
  if (result.skipped) parts.push(`${result.skipped} 张由你定过，未改动`)
  if (result.deferred) parts.push(`${result.deferred} 张还没判定，本次未改其绑定`)
  if (result.posters) parts.push(`海报 ${result.posters} 张`)
  if (result.rollbackAvailable) parts.push("可撤回（审阅页顶部）")
  return `已应用：${parts.join(" · ")}`
}

/** 409 的错误体（§8.3）：弹窗要的 pending / 版本号都从这里取。 */
export function errorData(error: unknown): DraftErrorData {
  const data = typeof error === "object" && error !== null && "data" in error ? (error as { data?: unknown }).data : null
  return typeof data === "object" && data !== null ? (data as DraftErrorData) : {}
}

export const DRAFT_BATCH_MAX = 20
export const DRAFT_BATCH_DEFAULT = 6

/**
 * ⚑↔＋ 成对提示：**只读权威字段**（§8.3，证据是文件路径归属，不是标题或文件数）。
 * added[] 的 splitFromKey/fromFiles 与 confirmedDrift/changed 的 splitIntoKeys 是同一件事的两面。
 */
export interface SplitPair {
  keys: string[]
  labels: string[]
  movedFiles: number
  /** 「48 → 24 + 24」；没劈卡时是 null。 */
  equation: string | null
  /** 绑定跟谁走（原始 itemKey；没劈卡时等于 row.itemKey）。 */
  keepsBindingOnKey: string
  /** 绑定留下那一份的可读名。 */
  keepLabel: string | null
  /** 新立的那几张的可读名。 */
  newLabels: string[]
}

/** 把 itemKey 换成人能读的标签：优先草稿卡自己的标题/查询词，其次末段目录名。 */
export function keyLabel(itemKey: string, draft: Array<{ itemKey: string; title?: string | null; query?: string; rawName?: string }>): string {
  const hit = draft.find(item => item.itemKey === itemKey)
  const fromCard = hit?.title?.trim() || hit?.query?.trim() || hit?.rawName?.trim()
  if (fromCard) return fromCard
  const segments = itemKey.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? itemKey
}

/**
 * 劈卡后「绑定留在谁身上」的人读名字。漂移行的 itemKey 就是那张**正式卡**的键，
 * 人看到的卡名是 row.title（草稿侧的 title 可能只是解析名），所以保留在"自己"身上时优先用它。
 *
 * `carrierKey` 是当前真正承接的那个键（草稿行的 `carriesKey`，没有承接方时就是自己）：
 * apply 确认框的下拉必须读它，因为 diff 里的 `keepsBindingOnKey` 只是一次快照推算，
 * 刚改过承接方、还没重刷 diff 的那一刻两者会分叉，下拉会「选完弹回去」。
 */
export function bindingLabel(
  row: { itemKey: string; title?: string | null },
  draft: Array<{ itemKey: string; title?: string | null; query?: string; rawName?: string }>,
  carrierKey?: string | null,
): string {
  const keepKey = carrierKey ?? (row as { keepsBindingOnKey?: string }).keepsBindingOnKey ?? row.itemKey
  if (keepKey === row.itemKey && (row.title ?? "").trim()) return (row.title ?? "").trim()
  return keyLabel(keepKey, draft)
}

/** 当前承接方：草稿行的 carriesKey 指回自己（或没人承接）时，承接方就是这张正式卡。 */
export function carrierKeyOf(row: { itemKey: string; carriesKey?: string | null }): string {
  return row.carriesKey && row.carriesKey !== "" ? row.carriesKey : row.itemKey
}

export function splitSummary(
  row: { files: { from: number; to: number }; splitIntoKeys?: string[] },
  added: Array<{ itemKey: string; query?: string; title?: string; fromFiles?: number; files?: number | { from: number; to: number } }>,
): SplitPair {
  const keys = row.splitIntoKeys ?? []
  const entries = keys.map(key => added.find(entry => entry.itemKey === key)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  const movedFiles = entries.reduce((sum, entry) => sum + (entry.fromFiles ?? (typeof entry.files === 'number' ? entry.files : 0)), 0)
  const keepsBindingOnKey = (row as { keepsBindingOnKey?: string }).keepsBindingOnKey ?? ''
  return {
    keys,
    labels: entries.map(entry => entry.query ?? entry.title ?? entry.itemKey),
    movedFiles,
    equation: entries.length ? `${row.files.from} → ${row.files.to} + ${movedFiles}` : null,
    keepsBindingOnKey,
    keepLabel: null,
    newLabels: entries.map(entry => entry.query ?? entry.title ?? entry.itemKey),
  }
}
/** 集号覆盖的人话（§16）：集号变了要重新应用，但**不算结构变更**（不会多出批准单）。 */
export function episodeNote(episodes?: { from: number; to: number } | null): string | null {
  if (!episodes || episodes.from === episodes.to) return null
  return `集号 ${episodes.from} → ${episodes.to}`
}

/** 应用确认框上的两句话（§8.6 的口径，读起来对着真数据核过）。 */
export function applySideEffects(input: { pending: number; humanConfirmed: number }): string[] {
  const lines: string[] = []
  if (input.humanConfirmed) lines.push(`${input.humanConfirmed} 张由你定过，未改动`)
  if (input.pending) lines.push(`${input.pending} 张还没判定，本次未改其绑定`)
  return lines
}

/**
 * 空态判定：后端在"还没扫过"时给的是 **200 + 空草稿**（cards 0 / scan.rev 0），
 * 不是 409 CATALOG_DRAFT_EMPTY（那个码留给了别的路径）。所以按数据判，别只认码。
 */
export { exclusionText } from "../../shared/catalog-exclusions.ts"

export function emptyKind(state: DraftState | null): "never-scanned" | "scanned-not-classified" | null {
  if (!state || state.draft.length > 0 || state.classifiedAt) return null
  return (state.scan?.rev ?? 0) > 0 ? "scanned-not-classified" : "never-scanned"
}

/** 草稿编辑的错误码（§9）：message 不承载语义，reason/keys 才是要点。 */
const EDIT_ERROR_TEXT: Record<string, string> = {
  DRAFT_CARD_NOT_FOUND: "这张卡已经不在了（可能刚被重分类或合并）——刷新一下",
  DRAFT_EDIT_INVALID: "这一步不合法",
  DRAFT_EDIT_CONFLICT: "有卡带着人工决定，先撤销它的人工决定再合",
  CATALOG_DRAFT_EMPTY: "这个库还没有草稿",
}

export function draftEditErrorText(error: unknown, fallback = "编辑失败"): string {
  const code = draftErrorCode(error)
  const data = errorData(error) as { reason?: string; keys?: string[] }
  if (code === "DRAFT_EDIT_INVALID") {
    const reason = data.reason ?? ""
    if (reason === "no-candidate") return "这张卡没有候选可确认——先判定一轮"
    if (reason === "unknown-candidate") return "选中的条目不在候选列表里"
    if (reason === "nothing-to-split") return "没有可拆出去的文件（至少要留一个或多个）"
    if (reason === "bad-carrier") return "承接绑定的那张卡不合法（要选这次拆出来的其中一份）"
    if (reason === "bad-keep-list") return "「留下的文件」这批 id 不合法（要非空字符串，单条 ≤1024 字）"
    if (reason === "unknown-media") {
      const count = data.keys?.length ?? 0
      return count ? `有 ${count} 个文件不属于这张卡（可能刚被重分类）——刷新后再拆` : "勾的文件里有不属于这张卡的（可能刚被重分类）——刷新后再拆"
    }
    return EDIT_ERROR_TEXT.DRAFT_EDIT_INVALID
  }
  if (code === "DRAFT_EDIT_CONFLICT") {
    const count = data.keys?.length ?? 0
    return count ? `有 ${count} 张带人工决定的卡在这批里，先撤销它们的人工决定再合` : EDIT_ERROR_TEXT.DRAFT_EDIT_CONFLICT
  }
  return EDIT_ERROR_TEXT[code] ?? draftErrorText(error, fallback)
}

/**
 * 绑定搬家的一句话（§9）：apply 时才搬，目标卡已有人工答案会跳过，原卡变未确认。
 * 只有「承接方不是自己」时才值得说。承接方同样取 `carriesKey`（不是 diff 的推算值）。
 */
export function bindingMoveText(
  row: { itemKey: string; title?: string | null; keepsBindingOnKey?: string },
  draft: Array<{ itemKey: string; title?: string | null; query?: string; rawName?: string }>,
  carrierKey?: string | null,
): string | null {
  const keepKey = carrierKey ?? row.keepsBindingOnKey ?? ""
  if (!keepKey || keepKey === row.itemKey) return null
  const from = (row.title ?? "").trim() || keyLabel(row.itemKey, draft)
  return `绑定将从「${from}」移到「${bindingLabel(row, draft, keepKey)}」，应用后原卡变未确认`
}
