"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search } from "lucide-react";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ExcludeFiles, ExclusionList } from "./catalog-exclusion-controls";
const exclusionApi = { read: api.catalogExclusions, write: api.draftExclusion };
import type { BangumiHit, CatalogApprovalLedgerRow, CatalogStructuralChanges, DraftApplyResult, DraftCandidate, DraftChild, DraftItem, DraftState } from "@/lib/contracts";
import {
  applyHeadline,
  applyPlan,
  applyResultText,
  applySideEffects,
  approvalErrorText,
  bindingLabel,
  bindingMoveText,
  carrierKeyOf,
  draftEditErrorText,
  episodeNote,
  emptyKind,
  rollbackLine,
  rollbackSheet,
  splitSummary,
  structuralSheet,
  bucketOfItem,
  draftBuckets,
  draftErrorCode,
  draftErrorText,
  DRAFT_BATCH_MAX,
  errorData,
  filterDraft,
  judgeProgress,
  scoreTone,
  type DraftFilterKey,
  type RollbackLine,
  type StructuralSheet,
} from "@/lib/draft-view";

// 服务端 ?max 上限 20，超了直接 400（§8.2）。
const JUDGE_BATCH = Math.min(6, DRAFT_BATCH_MAX);

/** 服务端只落"人是从哪一端点的"，不落用户体系（§10.4）。 */
const APPROVED_BY = "网页";

/**
 * 批准单（§10.1）：结构变更要人在本页换一张一次性凭证；撤回走同一个组件（§11.1）。
 * token 不落盘、不进状态、不显示。
 */
interface ApprovalSheet {
  mode: "apply" | "rollback";
  structural?: CatalogStructuralChanges;
  rollbackOf?: string;
  keys: string[];
  counts: { created: number; removed: number; changed: number };
  force: boolean;
  failed?: string;
}

const CONFIRMED_LABEL: Record<string, string> = { auto: "机器匹配", manual: "人工确认", rebind: "人工指定", unknown: "来源未知" };

const tag = (tone: string) =>
  cn(
    "mr-1 inline-block rounded-full border px-1.5 text-[11px] leading-[17px]",
    tone === "ok" ? "border-emerald-900 text-emerald-300"
      : tone === "warn" ? "border-amber-700 text-amber-300"
      : tone === "info" ? "border-sky-600 text-sky-300"
      : tone === "manual" ? "border-sky-500 bg-sky-500 text-black"
      : "border-border text-muted-foreground",
  );

/**
 * 草稿审阅与应用（方案 B：按卡片组织 + 过滤器与搜索，2026-09-28 用户拍板）。
 * 前三段（scan/classify/judge）只写草稿；apply 是唯一落库动作，未判完默认 409。
 */
export function CatalogDraft({ libraryId, libraryName }: { libraryId: string; libraryName: string }) {
  const [state, setState] = useState<DraftState | null>(null);
  // 初值 true：取数前不许同步 setState（effect 里同步 setState 会被 react-hooks 规则拦）。
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<DraftFilterKey>("all");
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"apply" | "force" | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [lastApply, setLastApply] = useState<DraftApplyResult | null>(null);
  // children 不在列表里：展开哪张取哪张（§8.1）。
  // ?item= 一次拿齐 children + candidates（列表投影里两者都没有）。
  const [detailCache, setDetailCache] = useState<Record<string, { children: DraftChild[]; candidates: DraftCandidate[] } | "loading" | "error">>({});
  const [stale, setStale] = useState<{ draftRev?: number; scanRev?: number } | null>(null);
  const [serverPending, setServerPending] = useState<number | null>(null);
  // judge 返回本批 itemKey：只给这几行加标记（列表整体仍刷新，payload 只有几十 KB）。
  const [justJudged, setJustJudged] = useState<string[]>([]);
  // 编辑（§9 六个接口）：多选合并、改名、换条目搜索、拆分勾「留下的」。
  const [selected, setSelected] = useState<string[]>([]);
  const [titleDraft, setTitleDraft] = useState<Record<string, string>>({});
  const [searchFor, setSearchFor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [hits, setHits] = useState<BangumiHit[]>([]);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [keepIds, setKeepIds] = useState<string[]>([]);
  // 批准门：台账（判"能不能撤"只看 rollbackAvailable）、能力位（软边界标注）、批准单。
  const [ledger, setLedger] = useState<CatalogApprovalLedgerRow[]>([]);
  const [approvalMode, setApprovalMode] = useState<"secret" | "loopback-admin" | null>(null);
  const [sheet, setSheet] = useState<ApprovalSheet | null>(null);

  const load = useCallback(async () => {
    if (!libraryId) return
    try {
      // 台账与能力位都是"读不到也不用弹错"的旁路数据（§11.4）。
      const [next, approvals, caps] = await Promise.all([
        api.getDraft(libraryId),
        api.catalogApprovals(libraryId).catch((failure) => {
          const code = (failure as { code?: string } | null)?.code ?? "unknown"
          if (code === "ADMIN_FORBIDDEN") console.warn("[catalog] 批准台账读取被拒（403）：检查 admin 门")
          return null
        }),
        api.getMediaCapabilities().catch(() => null),
      ])
      setState(next)
      setLedger(approvals?.items ?? [])
      setApprovalMode(caps?.catalogApproval ?? null)
      setError("")
    } catch (failure) {
      setState(null)
      setError(draftErrorCode(failure) || "FAILED")
    } finally {
      setLoading(false)
    }
  }, [libraryId]);

  // 换库由调用方用 key= 重挂载；这里只负责取数（setState 在异步回调里，避免 effect 内同步 setState）。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 取数是异步的，setState 都落在 await 之后
    void load();
  }, [load]);

  const rows = useMemo(() => filterDraft(state, filter, query), [state, filter, query]);
  const chips = useMemo(() => draftBuckets(state), [state]);
  const progress = useMemo(() => judgeProgress(state), [state]);
  const plan = useMemo(() => applyPlan(state), [state]);
  // 「由你定过」的卡（manual/rebind/unknown）：应用会整张跳过、不动绑定。
  const humanConfirmedCount = useMemo(() => (state?.draft ?? []).filter((item) => item.confirmedBy && item.confirmedBy !== "auto").length, [state]);
  // 撤回行：只认台账里的 rollbackAvailable（windowClosed 不冒充可撤回，§13.1）。
  const rollback = useMemo(() => rollbackLine(ledger), [ledger]);
  const approvalSheet = useMemo(
    () => (sheet?.structural ? structuralSheet(sheet.structural, state?.draft ?? [], state?.diff ?? null) : null),
    [sheet, state],
  );

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setNotice("");
    try {
      await work();
    } finally {
      setBusy("");
    }
  }

  /** 所有编辑走同一条：调接口 → 提示 → 清细节缓存 → 重刷列表。 */
  async function mutate(label: string, work: () => Promise<string | void>) {
    await run(label, async () => {
      try {
        const message = await work();
        if (message) setNotice(message);
        setDetailCache({});
        setJustJudged([]);
        await load();
      } catch (failure) {
        setNotice(draftEditErrorText(failure));
      }
    });
  }

  async function editTitle(item: DraftItem, title: string) {
    const next = title.trim();
    if (!next || next === item.title) return;
    await mutate("edit", async () => {
      await api.editDraft(libraryId, { itemKey: item.itemKey, title: next });
      return `已改名：${next}（人工定，apply 不会再动它）`;
    });
  }

  /** 候选点哪条绑哪条，以及搜索结果里挑一条。 */
  async function pickEntry(item: DraftItem, hit: { externalDb: string; externalId: string; title: string }) {
    await mutate("confirm", async () => {
      await api.confirmDraft(libraryId, { itemKey: item.itemKey, externalDb: hit.externalDb, externalId: hit.externalId });
      return `已绑到 ${hit.title}（人工定）`;
    });
  }

  async function bindSearchEntry(item: DraftItem, hit: BangumiHit) {
    await mutate("rebind", async () => {
      await api.editDraft(libraryId, {
        itemKey: item.itemKey,
        title: hit.title,
        originalTitle: hit.originalTitle ?? null,
        year: hit.year ?? null,
        posterUrl: hit.imageUrl ?? null,
        externalDb: hit.externalDb,
        externalId: hit.externalId,
      });
      return `已绑到 ${hit.title}（人工定）`;
    });
  }

  async function confirmTop(item: DraftItem) {
    await mutate("confirm", async () => {
      await api.confirmDraft(libraryId, { itemKey: item.itemKey });
      return "已确认第一个候选（人工定）";
    });
  }

  async function unconfirmDraft(item: DraftItem) {
    await mutate("unconfirm", async () => {
      await api.unconfirmDraft(libraryId, { itemKey: item.itemKey });
      return "已撤销人工决定：条目对和名字都留着，退回候选态";
    });
  }

  async function mergeSelected() {
    const keepKey = selected[0];
    const dropKeys = selected.slice(1);
    if (!keepKey || dropKeys.length === 0) return;
    await mutate("merge", async () => {
      await api.mergeDraft(libraryId, { keepKey, dropKeys });
      setSelected([]);
      return `已合并 ${dropKeys.length + 1} 张（保留「${state?.draft.find((item) => item.itemKey === keepKey)?.title ?? keepKey}」）`;
    });
  }

  async function splitItem(item: DraftItem, keep: string[]) {
    await mutate("split", async () => {
      const result = await api.splitDraft(libraryId, { itemKey: item.itemKey, keep });
      setSplitting(null);
      setKeepIds([]);
      return `已拆分：留在原卡 ${keep.length} 个文件，新立 ${result.createdKeys?.length ?? 0} 张待判定卡`;
    });
  }

  async function keepBinding(row: { itemKey: string }, next: string) {
    await mutate("keep-binding", async () => {
      // next === row.itemKey 就是复位，后端认这条路（§9.1）。
      await api.keepDraftBinding(libraryId, { itemKey: row.itemKey, keepsBindingOnKey: next });
      return next === row.itemKey ? "绑定改回留在这张卡上" : "绑定改由选中的那份草稿承接（apply 时搬）";
    });
  }

  /** 换条目：搜 Bangumi（与正式卡换绑同一个搜索端点），再从命中里挑一条绑。 */
  async function searchEntries(query: string) {
    const q = query.trim();
    if (q.length < 2) {
      setNotice("搜索词至少 2 个字");
      return;
    }
    setBusy("search");
    setNotice("");
    try {
      const reply = await api.bangumiSearch(q);
      setHits(reply.items ?? []);
      if ((reply.items ?? []).length === 0) setNotice("没搜到条目，换个写法试试");
    } catch (failure) {
      setNotice(draftEditErrorText(failure, "搜索失败"));
    } finally {
      setBusy("");
    }
  }

  async function judgeNext() {
    await run("judge", async () => {
      try {
        // "继续判定下一批"只走 judge：classify 是整批重做，会清空已有判定（§8 末）。
        const result = await api.judgeDraft(libraryId, JUDGE_BATCH);
        setJustJudged(result.items ?? []);
        setNotice(`本轮判定 ${result.judged} 张：自动确认 ${result.confirmed}，还剩 ${result.pending} 张未判定。`);
        await load();
      } catch (failure) {
        setNotice(draftErrorText(failure, "判定失败"));
      }
    });
  }

  /** 展开一张：children 走 ?item= 子请求。 */
  async function loadDetail(itemKey: string) {
    if (detailCache[itemKey] && detailCache[itemKey] !== "error") return;
    setDetailCache((current) => ({ ...current, [itemKey]: "loading" }));
    try {
      const detail = await api.getDraftCard(libraryId, itemKey);
      setDetailCache((current) => ({ ...current, [itemKey]: { children: detail.children ?? [], candidates: detail.candidates ?? [] } }));
    } catch {
      setDetailCache((current) => ({ ...current, [itemKey]: "error" }));
    }
  }

  async function classify() {
    await run("classify", async () => {
      try {
        await api.classifyDraft(libraryId);
        setNotice("已重新分类：判定被清空，请重新判定。");
        await load();
      } catch (failure) {
        setNotice(draftErrorText(failure, "重新分类失败"));
      }
    });
  }

  async function scan() {
    await run("scan", async () => {
      try {
        const result = await api.scanLibrary(libraryId);
        setNotice(`已扫描：${result.files} 个文件（rev ${result.rev}）。接着做分类。`);
        setBusy("classify");
        await api.classifyDraft(libraryId);
        await load();
        setNotice(`已扫描并分类：${result.files} 个文件（rev ${result.rev}）。请重新判定。`);
      } catch (failure) {
        setNotice(draftErrorText(failure, "扫描或分类失败"));
      }
    });
  }

  async function apply(force: boolean) {
    await run(force ? "force" : "apply", async () => {
      try {
        const result = await api.applyDraft(libraryId, force);
        setLastApply(result);
        setDialog(null);
        setNotice("已应用：草稿落到正式卡。");
        await load();
      } catch (failure) {
        const code = draftErrorCode(failure);
        const data = errorData(failure);
        setNotice(draftErrorText(failure));
        // 结构变更要人批准（§10.1）：原地换批准单；409 只带 structural，标题/missingPaths 得另读 classify。
        if (code === "CATALOG_APPROVAL_REQUIRED" && data.structural) {
          setDialog(null);
          setSheet({ mode: "apply", structural: data.structural, keys: [], counts: { created: 0, removed: 0, changed: 0 }, force });
          await load();
          return;
        }
        if (code === "CATALOG_DRAFT_INCOMPLETE") {
          setDialog("force");
          // 用错误体里的数字（§8.3），别拿上次 GET 的近似值。
          if (data.pending !== undefined) setServerPending(data.pending);
        } else setDialog(null);
        if (code === "CATALOG_STALE_SCAN") setStale({ draftRev: data.draftRev, scanRev: data.scanRev });
        if (code === "CATALOG_DRAFT_EMPTY") setError(code);
      }
    });
  }

  function openRollback(line: RollbackLine) {
    setNotice("");
    setSheet({ mode: "rollback", rollbackOf: line.approvalId, keys: line.keys, counts: line.counts, force: false });
  }

  /**
   * 批准 + 立刻执行：一次点击里的两个连续请求，token 不落盘、不进状态、不显示（§10.1）。
   * 失败即烧掉那张凭证（先消费后执行），所以每次点都重新走 /approval。
   */
  async function approveAndRun() {
    if (!sheet) return;
    const target = sheet;
    await run(target.mode === "apply" ? "approval" : "rollback", async () => {
      try {
        const issued = await api.catalogApproval(libraryId, { approvedBy: APPROVED_BY, rollbackOf: target.rollbackOf }, approvalMode ?? "secret");
        if (target.mode === "apply") {
          const result = await api.catalogApplyApproved(libraryId, { approvalToken: issued.approvalToken, force: target.force });
          setLastApply(result);
          setSheet(null);
          setNotice(target.force ? "已批准并应用（强行应用）。" : "已批准并应用：草稿落到正式卡。");
        } else {
          const done = await api.catalogRollback(libraryId, { rollbackOf: target.rollbackOf ?? "", approvalToken: issued.approvalToken });
          setSheet(null);
          setNotice(`已撤回：还原 ${done.restored} 张，撤销 ${done.removed} 张新建。`);
        }
        await load();
      } catch (failure) {
        const code = draftErrorCode(failure);
        const data = errorData(failure);
        const text = approvalErrorText(failure);
        setNotice(text);
        if (code === "CATALOG_APPROVAL_INVALID" && target.mode === "apply" && data.structural) {
          // 原地重画：409 带的是**当前** structural，清单不清空、按钮回到「批准并应用」。
          setSheet({ ...target, structural: data.structural, failed: text });
        } else if (code === "CATALOG_ROLLBACK_CONFLICT") {
          setSheet({ ...target, failed: text });
        } else {
          // 结构已经没了 / 窗口关了 / 找不到 / 已撤：这份清单不再成立，关掉重刷。
          setSheet(null);
        }
        await load();
      }
    });
  }

  if (loading && !state && !error) {
    return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />正在读取草稿…</p>;
  }

  // 「还没扫过」后端给的是 200 + 空草稿；409 CATALOG_DRAFT_EMPTY 也照旧认。
  if (error === "CATALOG_DRAFT_EMPTY" || emptyKind(state) === "never-scanned" || emptyKind(state) === "scanned-not-classified") {
    return (
      <div className="grid justify-items-start gap-2 rounded-lg border border-dashed border-border p-4">
        <h4 className="text-sm font-semibold">
          {emptyKind(state) === "scanned-not-classified" ? `${libraryName} 扫描过，但还没有草稿` : `${libraryName} 还没有草稿`}
        </h4>
        <p className="max-w-[78ch] text-xs text-muted-foreground">
          {emptyKind(state) === "scanned-not-classified"
            ? `快照里有 ${state?.scan?.files ?? 0} 个文件（rev ${state?.scan?.rev ?? 0}），但还没分组。分类只写草稿表，正式卡一行不动。`
            : "草稿是「先看后落」的中间层：扫描（枚举）→ 分类（分组）→ 判定（查条目）只写草稿表，正式卡一行不动；只有「应用」才会落库。"}
        </p>
        <ol className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
          <li className="rounded-full border border-border px-2">1 扫描 · 枚举文件与修订号</li>
          <li className="rounded-full border border-border px-2">2 分类 · 分组落草稿</li>
          <li className="rounded-full border border-border px-2">3 判定 · 分批查条目站</li>
          <li className="rounded-full border border-border px-2">4 应用 · 草稿转正式卡</li>
        </ol>
        {emptyKind(state) === "scanned-not-classified" ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={Boolean(busy)} onClick={() => void classify()}>{busy === "classify" ? "正在分类…" : "开始分类"}</Button>
            <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void scan()}>{busy === "scan" ? "正在扫描…" : "重新扫描"}</Button>
          </div>
        ) : (
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void scan()}>{busy === "scan" ? "正在扫描…" : "开始扫描"}</Button>
        )}
      </div>
    );
  }

  if (!state) {
    return (
      <div className="grid gap-2 rounded-md border border-l-2 border-border border-l-amber-500 p-3 text-xs" role="status">
        <b>{draftErrorText({ code: error }, "读取草稿失败")}</b>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()}>重试</Button>
          <Button size="sm" variant="ghost" onClick={() => void classify()}>重新分类</Button>
        </div>
      </div>
    );
  }

  return (
    <section className="grid min-w-0 grid-cols-1 gap-2.5" aria-label="草稿审阅" inert={sheet !== null || dialog !== null}>
      <ExclusionList libraryId={libraryId} api={exclusionApi} reload={load} classify={classify} version={state} />
      <header className="flex flex-wrap items-center gap-2">
        <div className="grid gap-0.5">
          <b className="text-sm">{libraryName} · 草稿</b>
          <span className="text-[11.5px] text-muted-foreground">
            {state.draft.length} 张卡 · {state.files} 个文件 · 扫描 rev {state.scan?.rev ?? "—"}（{state.scan?.files ?? "—"} 个文件）
          </span>
        </div>
        <span className="flex-1" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题 / 目录名…"
          aria-label="搜索草稿"
          className="h-8 w-52 rounded-md border border-input bg-[var(--fill-control)] px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
        />
        <Button size="sm" variant="outline" disabled={Boolean(busy) || progress.pending === 0} onClick={() => void judgeNext()}>
          {busy === "judge" ? "正在判定…" : `继续判定下一批（≤${JUDGE_BATCH}）`}
        </Button>
        <Button size="sm" variant="default" disabled={Boolean(busy)} onClick={() => setDialog("apply")}>
          应用草稿…{progress.pending > 0 ? `（${progress.pending} 张未判定）` : ""}
        </Button>
      </header>

      <div className="grid gap-1.5">
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <span className="block h-full bg-sky-500" style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="flex flex-wrap justify-between gap-3 text-xs">
          <span>本轮判定 <b>{progress.judged}</b> / {progress.total}（自动确认 {progress.auto} · 待人工 {progress.manual}）</span>
          <span className="text-muted-foreground">还剩 <b>{progress.pending}</b> 张未判定 · 条目站匿名限速 ~60 req/min</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="差异与判定过滤">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-xs",
              filter === chip.key ? "border-sky-500 bg-sky-950/60 text-white" : "border-border bg-black text-muted-foreground",
            )}
            aria-pressed={filter === chip.key}
            title={chip.hint}
            onClick={() => setFilter(chip.key)}
          >
            <b className={cn("tabular-nums", chip.tone === "ok" ? "text-emerald-400" : chip.tone === "warn" ? "text-amber-300" : chip.tone === "info" ? "text-sky-300" : "text-white")}>{chip.count}</b>
            {chip.label}
          </button>
        ))}
      </div>

      {stale ? (
        <div className="flex items-center gap-2 rounded-md border border-l-2 border-border border-l-amber-500 bg-amber-500/5 px-2.5 py-1.5 text-xs">
          <span>草稿来自旧快照（草稿 rev {stale.draftRev ?? "—"} / 扫描 rev {stale.scanRev ?? "—"}）：不能直接应用，先重新分类。</span>
          <button type="button" className="underline" onClick={() => void classify()}>重新分类</button>
        </div>
      ) : null}
      {(state.diff?.dropped.length ?? 0) > 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-l-2 border-border border-l-amber-500 bg-amber-500/5 px-2.5 py-1.5 text-xs">
          <span>{state.diff?.dropped.length} 张库里有、草稿没有：机器确认的会被删，人工碰过的保留。</span>
        </div>
      ) : null}
      {rollback ? (
        <div className="flex items-center gap-2 rounded-md border border-l-2 border-border border-l-sky-500 bg-sky-500/5 px-2.5 py-1.5 text-xs">
          <span>
            {rollback.text}
            {rollback.label ? <span className="text-muted-foreground">（{rollback.label}）</span> : null}
          </span>
          <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => openRollback(rollback)}>
            {busy === "rollback" ? "正在撤回…" : "撤回这次…"}
          </Button>
        </div>
      ) : null}

      {selected.length >= 2 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-sky-500 bg-sky-950/40 px-2.5 py-1.5 text-xs">
          <span>已选 <b>{selected.length}</b> 张 · 保留：</span>
          <select
            aria-label="合并后保留哪一张"
            className="h-6 rounded-md border border-input bg-[var(--fill-control)] px-1.5 text-xs"
            value={selected[0]}
            onChange={(event) => setSelected((current) => [event.target.value, ...current.filter((key) => key !== event.target.value)])}
          >
            {selected.map((key) => <option key={key} value={key}>{state.draft.find((item) => item.itemKey === key)?.title ?? key}</option>)}
          </select>
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void mergeSelected()}>{busy === "merge" ? "正在合并…" : "合并这几张"}</Button>
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setSelected([])}>清空选择</Button>
          <span className="text-muted-foreground">文件并集、候选按分数留最高；被吞的行里若有人工决定会先报冲突。</span>
        </div>
      ) : null}

      <div className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="w-7 border-b border-border p-1.5"><span className="sr-only">选择</span></th>
            <th className="border-b border-border p-1.5 text-left font-semibold text-muted-foreground">卡片 / 目录</th>
            <th className="border-b border-border p-1.5 text-left font-semibold text-muted-foreground">文件</th>
            <th className="border-b border-border p-1.5 text-left font-semibold text-muted-foreground">集数行</th>
            <th className="border-b border-border p-1.5 text-left font-semibold text-muted-foreground">差异</th>
            <th className="border-b border-border p-1.5 text-left font-semibold text-muted-foreground">判定</th>
            <th className="border-b border-border p-1.5 text-left font-semibold text-muted-foreground">来源</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <DraftRow
              key={item.itemKey}
              item={item}
              state={state}
              open={openKey === item.itemKey}
              justJudged={justJudged.includes(item.itemKey)}
              detail={detailCache[item.itemKey] ?? null}
              picked={selected.includes(item.itemKey)}
              onPick={() => setSelected((current) => (current.includes(item.itemKey) ? current.filter((key) => key !== item.itemKey) : [...current, item.itemKey]))}
              onToggle={() => {
                const nextOpen = openKey !== item.itemKey;
                setOpenKey(nextOpen ? item.itemKey : null);
                if (nextOpen) void loadDetail(item.itemKey);
              }}
              edit={{ busy, titleDraft, searchFor, searchQuery, hits, splitting, keepIds, setTitleDraft, setSearchFor, setSearchQuery, setSplitting, setKeepIds, searchEntries, editTitle, pickEntry, bindSearchEntry, confirmTop, unconfirmDraft, splitItem, reload: async () => { setDetailCache({}); setOpenKey(null); await load(); } }}
            />
          ))}
          {(state.diff?.dropped ?? []).map((row) => (
            <tr key={`dropped-${row.id}`} className="bg-red-500/5">
              <td className="border-b border-border p-1.5" />
              <td className="border-b border-border p-1.5 align-top">
                <div className="font-semibold">{row.title ?? row.itemKey}</div>
                <div className="mt-0.5 max-w-[520px] truncate font-mono text-[11px] text-muted-foreground">{row.itemKey}</div>
              </td>
              <td className="border-b border-border p-1.5 align-top tabular-nums text-muted-foreground">{typeof row.files === "number" ? row.files : row.files?.from ?? "—"}</td>
              <td className="border-b border-border p-1.5 align-top tabular-nums text-muted-foreground">—</td>
              <td className="border-b border-border p-1.5 align-top"><span className={tag("warn")}>将删除</span></td>
              <td className="border-b border-border p-1.5 align-top"><span className={tag("dim")}>—</span></td>
              <td className="border-b border-border p-1.5 align-top"><span className={tag("dim")}>库里</span></td>
            </tr>
          ))}
          {rows.length === 0 && (state.diff?.dropped.length ?? 0) === 0 ? (
            <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">这个筛选下没有卡片。</td></tr>
          ) : null}
        </tbody>
      </table>
      </div>

      <p className="text-[11.5px] text-muted-foreground">
        共 {state.draft.length} 行草稿（另有 {state.diff?.dropped.length ?? 0} 行来自正式库）。「一致」按正式卡算是 {state.diff?.unchanged ?? 0} 张；
        表格里落在「一致」的草稿行是 {state.draft.filter((item) => bucketOfItem(item, state.diff) === "unchanged").length} 行 —— 移动的 {state.diff?.moved.length ?? 0} 张另计。
      </p>

      {notice ? <p className="rounded-md border border-border bg-black px-2.5 py-1.5 text-xs" role="status">{notice}</p> : null}
      {lastApply ? <p className="rounded-md border border-border bg-black px-2.5 py-1.5 text-xs" role="status">{applyResultText(lastApply)}</p> : null}

      {sheet ? (
        <ApplyDialog
          plan={plan}
          pending={serverPending ?? progress.pending}
          humanConfirmed={humanConfirmedCount}
          draft={state.draft}
          drift={state.diff?.confirmedDrift ?? []}
          added={state.diff?.added ?? []}
          force={sheet.force}
          busy={Boolean(busy)}
          onCancel={() => setSheet(null)}
          onConfirm={() => void approveAndRun()}
          keepBinding={keepBinding}
          approval={{
            mode: sheet.mode,
            sheet: approvalSheet,
            failed: sheet.failed,
            force: sheet.force,
            softBoundary: approvalMode === "loopback-admin",
            rollback: sheet.mode === "rollback" ? { keys: sheet.keys, counts: sheet.counts } : null,
          }}
        />
      ) : dialog ? (
        <ApplyDialog
          plan={plan}
          pending={serverPending ?? progress.pending}
          humanConfirmed={humanConfirmedCount}
          draft={state.draft}
          drift={state.diff?.confirmedDrift ?? []}
          added={state.diff?.added ?? []}
          force={dialog === "force"}
          busy={Boolean(busy)}
          onCancel={() => { setDialog(null); setServerPending(null); }}
          onConfirm={(force) => void apply(force)}
          keepBinding={keepBinding}
        />
      ) : null}
    </section>
  );
}

/** 展开面板要的编辑能力：由 CatalogDraft 持有的那批状态与回调（一个 bundle 少传十几根线）。 */
interface RowEdit {
  reload: () => Promise<void>;
  busy: string;
  titleDraft: Record<string, string>;
  searchFor: string | null;
  searchQuery: string;
  hits: BangumiHit[];
  splitting: string | null;
  keepIds: string[];
  setTitleDraft: (next: Record<string, string>) => void;
  setSearchFor: (next: string | null) => void;
  setSearchQuery: (next: string) => void;
  setSplitting: (next: string | null) => void;
  setKeepIds: (next: string[]) => void;
  searchEntries: (query: string) => Promise<void>;
  editTitle: (item: DraftItem, title: string) => Promise<void>;
  pickEntry: (item: DraftItem, hit: { externalDb: string; externalId: string; title: string }) => Promise<void>;
  bindSearchEntry: (item: DraftItem, hit: BangumiHit) => Promise<void>;
  confirmTop: (item: DraftItem) => Promise<void>;
  unconfirmDraft: (item: DraftItem) => Promise<void>;
  splitItem: (item: DraftItem, keep: string[]) => Promise<void>;
}

function DraftRow({ item, state, open, justJudged, detail, picked, onPick, onToggle, edit }: {
  item: DraftItem;
  state: DraftState;
  open: boolean;
  justJudged: boolean;
  detail: { children: DraftChild[]; candidates: DraftCandidate[] } | "loading" | "error" | null;
  picked: boolean;
  onPick: () => void;
  onToggle: () => void;
  edit: RowEdit;
}) {
  const candidates = typeof detail === "object" && detail !== null ? detail.candidates : [];
  const children = typeof detail === "object" && detail !== null ? detail.children : null;
  const bucket = bucketOfItem(item, state.diff);
  const moved = state.diff?.moved.find((row) => row.itemKey === item.itemKey);
  const drift = state.diff?.confirmedDrift.find((row) => row.itemKey === item.itemKey);
  const pending = item.lookupState !== "done";
  const title = item.title ?? (pending ? item.rawName : item.query);
  const chips: Array<{ text: string; tone: string }> = [];
  if (bucket === "added") chips.push({ text: "新建", tone: "ok" });
  if (bucket === "moved") chips.push({ text: "移动", tone: "info" });
  if (bucket === "changed") chips.push({ text: "改写", tone: "info" });
  if (bucket === "confirmedDrift") chips.push({ text: "已确认漂移", tone: "warn" });
  if (bucket === "dropped") chips.push({ text: "将删除", tone: "danger" });

  return (
    <>
      <tr className={cn(bucket === "added" && "bg-emerald-500/5", bucket === "confirmedDrift" && "bg-amber-500/5", bucket === "dropped" && "bg-red-500/5", open && "bg-white/5", justJudged && "shadow-[inset_3px_0_0_var(--accent)]")}>
        <td className="border-b border-border p-1.5 align-top">
          <input type="checkbox" className="mt-0.5" checked={picked} aria-label={`选择 ${title || item.rawName}`} onChange={onPick} />
        </td>
        <td className="border-b border-border p-1.5 align-top">
          <button type="button" className="text-left font-semibold hover:underline" aria-expanded={open} onClick={onToggle}>{title || item.rawName}</button>
          <div className="mt-0.5 max-w-[520px] truncate font-mono text-[11px] text-muted-foreground" title={item.itemKey}>{item.itemKey}</div>
        </td>
        <td className="border-b border-border p-1.5 align-top tabular-nums text-muted-foreground">{item.files}</td>
        <td className="border-b border-border p-1.5 align-top tabular-nums text-muted-foreground">{item.subtitle ?? "—"}</td>
        <td className="border-b border-border p-1.5 align-top">{chips.length ? chips.map((chip) => <span key={chip.text} className={tag(chip.tone)}>{chip.text}</span>) : <span className={tag("dim")}>一致</span>}</td>
        <td className="border-b border-border p-1.5 align-top">
          {pending ? <span className={tag("dim")}>未判定</span>
            : item.status === "candidate" ? <span className={tag("warn")}>待人工 {item.topScore?.toFixed(2) ?? ""}</span>
            : <span className={tag("ok")}>已判 {item.topScore?.toFixed(2) ?? ""}</span>}
        </td>
        <td className="border-b border-border p-1.5 align-top">
          {item.confirmedBy ? <span className={tag(item.confirmedBy === "auto" ? "ok" : "manual")}>{CONFIRMED_LABEL[item.confirmedBy] ?? item.confirmedBy}</span> : <span className={tag("dim")}>未确认</span>}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={7} className="border-b border-border p-1.5">
            <div className="grid gap-2 rounded-md border border-border bg-black p-2.5">
              {drift ? (
                <p className="text-xs">
                  已确认卡漂移：文件 {typeof drift.files === "number" ? drift.files : `${drift.files.from} → ${drift.files.to}`}
                  {drift.subtitle ? ` · 集数行 ${drift.subtitle.from ?? "—"} → ${drift.subtitle.to ?? "—"}` : ""}
                  <span className="text-muted-foreground">（标题、绑定、封面都不动）</span>
                </p>
              ) : null}
              {moved?.fromKey ? <p className="text-xs">键位更新：<span className="font-mono text-[11px] text-muted-foreground">{moved.fromKey}</span> → 现在这个目录</p> : null}

              {/* 改名 */}
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[11.5px] text-muted-foreground">改名</span>
                <input
                  className="h-7 min-w-0 flex-1 rounded-md border border-input bg-[var(--fill-control)] px-2 text-xs"
                  value={edit.titleDraft[item.itemKey] ?? title ?? ""}
                  disabled={Boolean(edit.busy)}
                  onChange={(event) => edit.setTitleDraft({ ...edit.titleDraft, [item.itemKey]: event.target.value })}
                />
                <Button size="sm" variant="outline" className="h-7" disabled={Boolean(edit.busy)} onClick={() => void edit.editTitle(item, edit.titleDraft[item.itemKey] ?? title ?? "")}>保存</Button>
              </div>

              {/* 换条目：搜 Bangumi，命中哪条绑哪条（与正式卡换绑同一个搜索端点）。 */}
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[11.5px] text-muted-foreground">换条目</span>
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-2 top-2 size-3.5 text-muted-foreground" />
                  <input
                    className="h-7 w-full rounded-md border border-input bg-[var(--fill-control)] pl-7 pr-2 text-xs"
                    placeholder="搜 Bangumi（≥2 字）…"
                    value={edit.searchFor === item.itemKey ? edit.searchQuery : ""}
                    disabled={Boolean(edit.busy)}
                    onChange={(event) => { edit.setSearchFor(item.itemKey); edit.setSearchQuery(event.target.value); }}
                    onKeyDown={(event) => { if (event.key === "Enter") void edit.searchEntries(edit.searchQuery); }}
                  />
                </div>
                <Button size="sm" variant="outline" className="h-7" disabled={Boolean(edit.busy)} onClick={() => void edit.searchEntries(edit.searchQuery)}>搜索</Button>
              </div>
              {edit.searchFor === item.itemKey && edit.hits.length > 0 ? (
                <ul className="grid gap-1">
                  {edit.hits.slice(0, 8).map((hit) => (
                    <li key={`${hit.externalDb}-${hit.externalId}`} className="grid grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto_auto] items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                      <span className="truncate">{hit.title}</span>
                      <span className="truncate text-[11.5px] text-muted-foreground">{hit.originalTitle ?? ""}</span>
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">{hit.year ?? "年份未知"} · {hit.externalDb} #{hit.externalId}</span>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={Boolean(edit.busy)} onClick={() => void edit.bindSearchEntry(item, hit)}>绑这条</Button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* 判定动作 */}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="h-7" disabled={Boolean(edit.busy) || item.candidateCount === 0 || pending} onClick={() => void edit.confirmTop(item)}>确认第一个候选</Button>
                <Button size="sm" variant="ghost" className="h-7" disabled={Boolean(edit.busy) || !item.confirmedBy} onClick={() => void edit.unconfirmDraft(item)}>撤销人工决定</Button>
                {children && children.length > 1 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={Boolean(edit.busy)}
                    onClick={() => { edit.setSplitting(edit.splitting === item.itemKey ? null : item.itemKey); edit.setKeepIds(children.map((child) => child.mediaId)); }}
                  >
                    拆分这张…
                  </Button>
                ) : null}
              </div>

              {/* 拆分：勾「留在原卡」的那批，其余按父目录自动分组各成新卡。 */}
              {children ? <ExcludeFiles libraryId={state.libraryId} files={children} api={exclusionApi} reload={edit.reload} /> : null}
              {edit.splitting === item.itemKey && children ? (
                <div className="grid gap-1.5 rounded-md border border-border p-2">
                  <p className="text-xs">勾选<b>留在原卡</b>的文件；没勾的按父目录自动分组，各立一张未判定新卡。</p>
                  <ul className="grid gap-[3px]">
                    {children.map((child) => (
                      <li key={child.mediaId}>
                        <label className="flex items-center gap-2 text-[11.5px]">
                          <input
                            type="checkbox"
                            checked={edit.keepIds.includes(child.mediaId)}
                            onChange={() => edit.setKeepIds(edit.keepIds.includes(child.mediaId) ? edit.keepIds.filter((id) => id !== child.mediaId) : [...edit.keepIds, child.mediaId])}
                          />
                          <span className="truncate font-mono text-muted-foreground" title={child.relativePath}>{child.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center gap-2">
                    <Button size="sm" className="h-7" disabled={Boolean(edit.busy) || edit.keepIds.length === 0 || edit.keepIds.length === children.length} onClick={() => void edit.splitItem(item, edit.keepIds)}>按这个分法拆</Button>
                    <Button size="sm" variant="ghost" className="h-7" disabled={Boolean(edit.busy)} onClick={() => edit.setSplitting(null)}>取消</Button>
                    <span className="text-[11.5px] text-muted-foreground">留下 {edit.keepIds.length} / {children.length}</span>
                  </div>
                </div>
              ) : null}

              {pending ? (
                <p className="text-xs text-muted-foreground">还没判定：它只参与结构对齐，<b>绝不动绑定</b>。点上面的「继续判定下一批」把它送进队列。</p>
              ) : detail === "loading" ? (
                <p className="text-xs text-muted-foreground">正在读取候选…</p>
              ) : candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {item.candidateCount > 0 ? "候选读不到（展开时拉一次，失败就空着）。" : "判定没有提出候选（解析名太脏或条目站没有对应条目）。"}
                  用上面的「换条目」搜一条绑上。
                </p>
              ) : (
                <>
                  <div className="flex items-baseline gap-2 text-xs">
                    <b>候选（{candidates.length}）</b>
                    <span className="text-muted-foreground">分数 ≥ {(state.thresholds?.autoScore ?? 0.86).toFixed(2)} 的会直接绑定</span>
                  </div>
                  <ul className="grid gap-1">
                    {candidates.map((candidate, index) => {
                      const bound = item.externalDb === candidate.externalDb && item.externalId === candidate.externalId;
                      return (
                        <li
                          key={`${candidate.externalDb}-${candidate.externalId}`}
                          className={cn("rounded-md border text-xs", index === 0 && !bound ? "border-sky-500" : "border-border", bound && "border-emerald-600")}
                        >
                          <button
                            type="button"
                            className="grid w-full grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto_auto_auto] items-center gap-2 px-2 py-1 text-left hover:bg-white/5 disabled:cursor-default disabled:hover:bg-transparent"
                            disabled={Boolean(edit.busy) || bound}
                            aria-label={bound ? `已绑定 ${candidate.title}` : `绑到 ${candidate.title}`}
                            onClick={() => void edit.pickEntry(item, candidate)}
                          >
                            <span className="truncate">{candidate.title}</span>
                            <span className="truncate text-[11.5px] text-muted-foreground">{candidate.originalTitle ?? ""}</span>
                            <span className="whitespace-nowrap text-[11px] text-muted-foreground">{candidate.year ?? "年份未知"} · {candidate.externalDb} #{candidate.externalId}</span>
                            <span className={cn("tabular-nums", scoreTone(candidate.score, state.thresholds) === "hi" ? "font-semibold text-emerald-400" : scoreTone(candidate.score, state.thresholds) === "low" ? "text-muted-foreground" : "")}>{candidate.score.toFixed(2)}</span>
                            <span className={cn("whitespace-nowrap text-[11px]", bound ? "text-emerald-400" : "text-muted-foreground")}>
                              {bound ? (item.confirmedBy === "manual" || item.confirmedBy === "rebind" ? "已人工绑定" : "已绑定") : "绑这条"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="text-xs text-muted-foreground">点哪条就绑哪条（人工定，apply 不会再被自动覆盖）；要交回机器判定就按「撤销人工决定」。</p>
                </>
              )}
              {/* children 走 ?item= 子请求（列表投影里没有），按库内目录分节。 */}
              <div className="grid gap-2">
                {detail === "loading" ? <p className="text-xs text-muted-foreground">正在读取这一张的文件…</p>
                  : detail === "error" ? <p className="text-xs text-muted-foreground">文件列表读不到（这一张可能已经不在了）。</p>
                  : children ? groupByDir(item.itemKey, children).map((group) => (
                    <section key={group.dir || "(根)"}>
                      <h5 className="mb-1 flex justify-between gap-2 text-[11.5px] font-semibold text-muted-foreground">
                        <span>{group.label}</span><span className="font-normal opacity-80">{group.items.length} 个文件</span>
                      </h5>
                      <ul className="grid gap-[3px]">
                        {group.items.slice(0, 12).map((child) => (
                          <li key={child.mediaId}><span className="font-mono text-[11px] text-muted-foreground" title={child.relativePath}>{child.name}</span></li>
                        ))}
                        {group.items.length > 12 ? <li className="text-xs text-muted-foreground">…还有 {group.items.length - 12} 个</li> : null}
                      </ul>
                    </section>
                  )) : null}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** 文件按所在目录分节（children 只有 relativePath，没有 relDir）：与卡同层的一组叫「正片」。 */
function groupByDir(itemKey: string, children: DraftChild[]): Array<{ dir: string; label: string; items: DraftChild[] }> {
  const dirOf = (path: string) => path.replace(/\/[^/]*$/, "");
  const base = dirOf(itemKey);
  const buckets = new Map<string, DraftChild[]>();
  for (const child of children) {
    const dir = dirOf(child.relativePath ?? "");
    buckets.set(dir, [...(buckets.get(dir) ?? []), child]);
  }
  return [...buckets.entries()].map(([dir, items]) => ({
    dir,
    items,
    label: dir === base || dir === "" ? "正片" : dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir.replace(/^\/+/, ""),
  }));
}

function ApplyDialog({ plan, pending, humanConfirmed, draft, drift, added, force, busy, onCancel, onConfirm, keepBinding, approval }: {
  plan: ReturnType<typeof applyPlan>;
  pending: number;
  humanConfirmed: number;
  draft: DraftItem[];
  drift: NonNullable<DraftState["diff"]>["confirmedDrift"];
  added: NonNullable<DraftState["diff"]>["added"];
  force: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (force: boolean) => void;
  keepBinding: (row: { itemKey: string }, next: string) => Promise<void>;
  /** 批准单模式（§10.1）：同一个组件，换标题与主文案；撤回走它时 mode="rollback"。 */
  approval?: ApprovalView | null;
}) {
  if (approval) return <ApprovalDialog view={approval} busy={busy} onCancel={onCancel} onConfirm={() => onConfirm(false)} />;
  return <ApplyPlanDialog plan={plan} pending={pending} humanConfirmed={humanConfirmed} draft={draft} drift={drift} added={added} force={force} busy={busy} onCancel={onCancel} onConfirm={onConfirm} keepBinding={keepBinding} />;
}

interface ApprovalView {
  mode: "apply" | "rollback";
  sheet: StructuralSheet | null;
  failed?: string;
  force: boolean;
  softBoundary: boolean;
  rollback: { keys: string[]; counts: { created: number; removed: number; changed: number } } | null;
}

/**
 * 批准单（§10.1/§11.1）：结构变更与撤回都要人在这一屏上换一张一次性凭证。
 * 清单只有 itemKey（409 不带 diff），名字与空壳原因从草稿/差异里 join；join 不到退 itemKey 末段。
 */
function ApprovalDialog({ view, busy, onCancel, onConfirm }: { view: ApprovalView; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { sheet, mode } = view;
  const groups: Array<{ title: string; rows: Array<{ key: string; label: string; note?: string }> }> = sheet ? [
    { title: `新建 ${sheet.added.length} 张`, rows: sheet.added },
    { title: `删除 ${sheet.dropped.length} 张`, rows: sheet.dropped },
    { title: `移动 ${sheet.moved.length} 张（只换目录，绑定与标题不动）`, rows: sheet.moved },
  ].filter((group) => group.rows.length > 0) : [];
  const rollbackLines = mode === "rollback" && view.rollback ? rollbackSheet(view.rollback) : [];
  const rollbackKeys = view.rollback?.keys ?? [];
  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-5" role="dialog" aria-modal="true" aria-label={mode === "rollback" ? "批准撤回" : "批准结构变更"}>
      <div className="grid w-full max-w-[560px] gap-2 rounded-xl border border-border bg-[var(--fill-menu)] p-3.5 shadow-2xl">
        {mode === "rollback" ? (
          <>
            <h4 className="text-sm font-semibold"><span className={tag("warn")}>撤回上次应用</span></h4>
            <ul className="grid gap-1.5 text-xs">
              {rollbackLines.map((line) => (
                <li key={line} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2.5"><b className="text-muted-foreground">·</b><span>{line}</span></li>
              ))}
            </ul>
            {rollbackKeys.length ? (
              <p className="text-xs text-muted-foreground">
                涉及 {rollbackKeys.length} 张卡：{rollbackKeys.slice(0, 6).join("、")}{rollbackKeys.length > 6 ? ` 等 ${rollbackKeys.length} 张` : ""}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <h4 className="text-sm font-semibold">这次会动到 {sheet?.total ?? 0} 张卡，需要批准</h4>
            <p className="text-xs text-muted-foreground">
              批准是一次性的：只对「现在这份结构差异」有效，期间又改过草稿就要重新批；成功即消耗。
            </p>
            {sheet && sheet.total === 0 ? (
              <p className="text-xs text-muted-foreground">结构差异已经变成 0 了——关掉这一层直接「应用」即可。</p>
            ) : sheet ? (
              <div className="grid max-h-[46vh] gap-2 overflow-auto">
                {groups.map((group) => (
                  <section key={group.title} className="grid gap-0.5">
                    <h5 className="text-[11.5px] font-semibold text-muted-foreground">{group.title}</h5>
                    <ul className="grid gap-0.5 text-xs">
                      {group.rows.map((row) => (
                        <li key={row.key} className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate">{row.label}</span>
                          {row.note ? <span className="shrink-0 text-[11.5px] text-muted-foreground">{row.note}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
                {sheet.drift.length ? (
                  <section className="grid gap-0.5">
                    <h5 className="text-[11.5px] font-semibold text-muted-foreground">已确认卡换掉了文件集合 {sheet.drift.length} 张</h5>
                    <ul className="grid gap-0.5 text-xs">
                      {sheet.drift.map((row) => (
                        <li key={row.key} className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate">{row.label}</span>
                          <span className="shrink-0 text-[11.5px] text-muted-foreground">文件 {row.from} → {row.to}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">清单读不到（草稿可能刚被重分过）——刷新后再看一次。</p>
            )}
            {view.softBoundary ? (
              <p className="text-xs text-muted-foreground">当前是软边界：服务端没配第二把批准密钥，本机管理员就能批。</p>
            ) : null}
          </>
        )}
        {view.failed ? <p className="text-xs text-red-300">{view.failed}</p> : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>
          <Button size="sm" variant="default" disabled={busy} onClick={onConfirm}>
            {busy ? "正在执行…" : mode === "rollback" ? "批准并撤回" : view.force ? "批准并应用（强行）" : "批准并应用"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ApplyPlanDialog({ plan, pending, humanConfirmed, draft, drift, added, force, busy, onCancel, onConfirm, keepBinding }: {
  plan: ReturnType<typeof applyPlan>;
  pending: number;
  humanConfirmed: number;
  draft: DraftItem[];
  drift: NonNullable<DraftState["diff"]>["confirmedDrift"];
  added: NonNullable<DraftState["diff"]>["added"];
  force: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (force: boolean) => void;
  keepBinding: (row: { itemKey: string }, next: string) => Promise<void>;
}) {
  const sideEffects = applySideEffects({ pending, humanConfirmed });
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-5" role="dialog" aria-modal="true" aria-label={force ? "强行应用草稿" : "应用草稿"}>
      <div className={cn("grid w-full max-w-[560px] gap-2 rounded-xl border bg-[var(--fill-menu)] p-3.5 shadow-2xl", force ? "border-red-800" : "border-border")}>
        {force ? (
          <>
            <h4 className="text-sm font-semibold"><span className={tag("danger")}>强行应用（force=1）</span></h4>
            <p className="text-xs">草稿里还有 <b>{pending} 张没判定</b>。强行应用会：</p>
            <ul className="list-disc pl-5 text-xs">
              <li>把未判定的卡按结构对齐写进库，它们会停在「未匹配」；</li>
              <li>这些卡上原有的<b>候选列表会被清空</b>，下一轮判定要重新查条目站；</li>
              <li><b>已经确认的绑定不会丢</b>（人工 / 人工指定 / 来源未知的都受保护）。</li>
            </ul>
            <p className="text-xs text-red-300">日常做法是先判完再应用；只有「结构对不上、急着先落库」时才用它。</p>
          </>
        ) : (
          <>
            <h4 className="text-sm font-semibold">{applyHeadline(plan, pending)}</h4>
            <ul className="grid gap-1.5 text-xs">
              <li className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2.5"><b className="text-emerald-400">新建 {plan.created} 张</b><span className="text-muted-foreground">草稿里有、库里没有的作品卡（带判定结果与海报）</span></li>
              <li className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2.5"><b className="text-muted-foreground">删除 {plan.removed} 张</b><span className="text-muted-foreground">机器确认的卡才会删；人工碰过的一律保留</span></li>
              <li className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2.5"><b className="text-muted-foreground">改写 {plan.rewritten} 张</b><span className="text-muted-foreground">未确认卡的标题/集数行重写成草稿的判定结果</span></li>
              <li className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2.5"><b className="text-muted-foreground">键位更新 {plan.moved} 张</b><span className="text-muted-foreground">同一堆文件换了目录，绑定与标题不动</span></li>
            </ul>
            {plan.drift > 0 ? (
              <div className="grid gap-1.5 rounded-md border border-amber-700 bg-amber-500/5 p-2.5">
                <span className={tag("warn")}>已确认卡漂移 {plan.drift} 张（单独处理）</span>
                <p className="text-xs text-muted-foreground">只刷子文件与集数行。<b>标题、绑定、封面都不会动</b>。</p>
                <ul className="grid gap-1.5 text-xs">
                  {drift.map((row) => {
                    const split = splitSummary(row, added);
                    return (
                      <li key={row.id} className="grid gap-0.5">
                        <span>{row.title}：文件 {split.equation ? <b>{split.equation}</b> : <>从 {row.files.from} → <b>{row.files.to}</b></>}</span>
                        {episodeNote(row.episodes) ? <span className="text-[11.5px] text-muted-foreground">{episodeNote(row.episodes)}（只刷集号，不算结构变更、不用批准）</span> : null}
                        {split.equation ? (
                          <span className="text-[11.5px] text-muted-foreground">＋ 新卡：{split.labels.join(" / ")}（接走 {split.movedFiles} 个文件）</span>
                        ) : null}
                        {split.equation ? (
                          <span className="grid gap-1 text-[11.5px] text-sky-300">
                            <span>⬒ 绑定留在：</span>
                            <select
                              aria-label={`${row.title} 的绑定留在哪一份`}
                              className="h-6 max-w-[280px] rounded-md border border-input bg-[var(--fill-control)] px-1.5 text-xs"
                              value={carrierKeyOf(draft.find((item) => item.itemKey === row.itemKey) ?? { itemKey: row.itemKey })}
                              disabled={busy}
                              onChange={(event) => void keepBinding(row, event.target.value)}
                            >
                              {[row.itemKey, ...split.keys].map((key) => (
                                <option key={key} value={key}>{bindingLabel({ itemKey: key, title: key === row.itemKey ? row.title : null }, draft)}</option>
                              ))}
                            </select>
                            <span>另 <b>{split.keys.length}</b> 张新卡（未确认）从这批文件里长出来</span>
                          </span>
                        ) : null}
                        {split.equation ? <span className="text-[11.5px] text-muted-foreground">{bindingMoveText(row, draft, carrierKeyOf(draft.find((item) => item.itemKey === row.itemKey) ?? { itemKey: row.itemKey }))}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            <p className="text-[11.5px] text-muted-foreground">其余 {plan.unchanged} 张一致，一张不动。</p>
            {sideEffects.length ? (
              <ul className="grid gap-1 text-xs text-muted-foreground">
                {sideEffects.map((line) => <li key={line}>· {line}</li>)}
              </ul>
            ) : null}
            {pending > 0 ? <p className="text-xs text-muted-foreground">还有 {pending} 张未判定：直接应用会被服务端 409 拒绝，届时可以改用「强行应用」。</p> : null}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>
          {force ? (
            <Button size="sm" disabled={busy} className="bg-red-800 text-white hover:bg-red-700" onClick={() => onConfirm(true)}>{busy ? "正在应用…" : "仍然应用（危险）"}</Button>
          ) : (
            <Button size="sm" variant="default" disabled={busy} onClick={() => onConfirm(false)}>{busy ? "正在应用…" : "应用"}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
