"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Folder,
  Film,
  Search,
  X,
  Play,
  Tv,
  ListPlus,
  ChevronRight,
  Link as LinkIcon,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import { canAttemptBrowserPlayback } from "@/lib/mkv/compatibility";
import { MediaImage } from "@/components/media-image";
import {
  MediaBreadcrumb,
  MediaLibrary,
  MediaLibraryItem,
  MediaLibraryKind,
  MediaSource,
  YouTubePlaybackCapabilities,
} from "@/lib/contracts";
import { classifyYouTubeInput } from "@/lib/youtube";
import { mediaErrorText } from "@/lib/media-error-text";
import { isNonMedia, toDetail, toWall, type Wall, type WallDetail } from "@/lib/catalog-view";
import { CatalogRail, CatalogWall, UnmatchedLine } from "@/components/catalog-wall";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Keycap } from "@/components/ui/keycap";
import { cn } from "@/lib/utils";
import { getBatchRetryItems, type BatchOperationResult, type OperationResult } from "@/lib/media-operation-result";

const KIND_LABEL: Record<MediaLibraryKind, string> = {
  anime: "番剧",
  movie: "电影",
  tv: "剧集",
  other: "其他",
};

/** YouTube 识别标记（来源说明，不引入品牌色）。 */
function YouTubeChip() {
  return (
    <span className="shrink-0 rounded-[4px] border border-border px-1.5 text-[10px] text-muted-foreground">
      YouTube
    </span>
  );
}

// 草稿编辑页已下线（2026-10-08）：片源管理交由 MCP/agent，网页端只保留浏览与点播。
const MODE_LABEL: Record<"titles" | "files", string> = {
  titles: "标题",
  files: "文件",
};

interface OpenListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPlayNow: (media: MediaSource) => boolean | void | Promise<boolean | void>;
  onPlayOnDesktop?: (media: MediaSource) => boolean | void | Promise<boolean | void>;
  onAddToQueue: (media: MediaSource) => OperationResult | boolean | void | Promise<OperationResult | boolean | void>;
  onBatchAdd: (medias: MediaSource[]) => BatchOperationResult<MediaSource> | boolean | void | Promise<BatchOperationResult<MediaSource> | boolean | void>;
  queueResult?: BatchOperationResult<MediaSource> | null;
  onReconcileQueue?: (result: BatchOperationResult<MediaSource>) => Promise<BatchOperationResult<MediaSource>>;
  /** 裁决 ②：媒体库可以是整页。弹窗是"房间内快速挑一个"，整页是浏览与整理。 */
  fullPage?: boolean;
  onToggleFullPage?: () => void;
  /** 房外只读浏览（首页/建房流程）：写操作置灰，主行动＝用此片开房。 */
  roomless?: boolean;
}

/** Authenticated library artwork; failures retain the existing icon fallback. */
function ArtworkThumb({ posterId, fallback }: { posterId?: string | null; fallback: React.ReactNode }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-border bg-muted">
      {posterId
        ? <MediaImage src={`/api/media/artwork/${encodeURIComponent(posterId)}`} alt="" loading="lazy" className="size-full object-cover" fallback={fallback} />
        : fallback}
    </span>
  );
}

export function OpenListModal({
  isOpen,
  onClose,
  onPlayNow,
  onPlayOnDesktop,
  onAddToQueue,
  onBatchAdd,
  queueResult = null,
  onReconcileQueue,
  fullPage = false,
  onToggleFullPage,
  roomless = false,
}: OpenListModalProps) {
  // 多源库（phase 1）：能力位为真走 /api/media/libraries + list?libraryId=，
  // 顺序、面包屑路径都按服务端返回渲染，客户端不排序、不拼路径。
  const [libraries, setLibraries] = useState<MediaLibrary[]>([]);
  const [youtubeCapability, setYoutubeCapability] = useState<YouTubePlaybackCapabilities | null>(null);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("/");
  const [breadcrumbs, setBreadcrumbs] = useState<MediaBreadcrumb[]>([]);
  const [items, setItems] = useState<MediaLibraryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [folderPosterId, setFolderPosterId] = useState<string | null>(null);
  // 相位 3：标题/文件开关（默认标题）+ 标题墙状态 + 非视频文件的显示开关。
  const [mode, setMode] = useState<"titles" | "files">("titles");
  const [wall, setWall] = useState<Wall | null>(null);
  const [wallDetail, setWallDetail] = useState<WallDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  // 冠军稿的「只看待确认」：只在已载入的那一页里筛，不额外打请求。
  const [onlyReview, setOnlyReview] = useState(false);
  // 切到整页时 Dialog 会卸载，Radix 会顺手报一次 close —— 用一个"正在换壳"的开关挡掉它。
  // （开关在事件里置位、在换壳落地后复位，不在渲染期写 ref。）
  const switchingShellRef = useRef(false);
  useEffect(() => { switchingShellRef.current = false; }, [fullPage]);

  // 加载与错误状态 (绝对零 mock 降级)
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const queueBusyRef = useRef(false);
  const queueSessionRef = useRef(0);
  useEffect(() => { if (!isOpen) queueSessionRef.current += 1; }, [isOpen]);

  // 键盘层：列表选择 + 速查面板；搜索框为唯一输入焦点。
  const [kbIndex, setKbIndex] = useState(-1);
  const [showKeyHelp, setShowKeyHelp] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const addToQueue = async (media: MediaSource): Promise<boolean> => {
    if (queueBusyRef.current || queueResult?.status === "uncertain") return false;
    queueBusyRef.current = true;
    setQueueBusy(true);
    const session = queueSessionRef.current;
    try {
      const result = await onAddToQueue(media);
      return typeof result === "object" ? result.status === "succeeded" : result !== false;
    } catch {
      if (session === queueSessionRef.current) setErrorMsg("添加结果未知，请核对房间清单后再操作");
      return false;
    } finally {
      queueBusyRef.current = false;
      setQueueBusy(false);
    }
  };

  const playNow = async (media: MediaSource) => {
    if (await onPlayNow(media) !== false) handleClose();
  };

  const reconcileQueue = async () => {
    if (!queueResult || !onReconcileQueue || queueBusyRef.current) return;
    queueBusyRef.current = true;
    setQueueBusy(true);
    const session = queueSessionRef.current;
    try {
      const result = await onReconcileQueue(queueResult);
      if (session === queueSessionRef.current) setErrorMsg(result.status === "uncertain"
        ? "已核对最新快照，仍无法确认是否写入；请勿重复添加" : null);
    } catch {
      if (session === queueSessionRef.current) setErrorMsg("快照核对失败，添加结果仍未知");
    } finally {
      queueBusyRef.current = false;
      setQueueBusy(false);
    }
  };

  const retryRemaining = async () => {
    if (!queueResult || queueBusyRef.current) return;
    const retry = getBatchRetryItems(queueResult);
    if (!retry?.length) return;
    queueBusyRef.current = true;
    setQueueBusy(true);
    try { await submitBatch(retry); }
    catch { setErrorMsg("添加结果未知，请核对房间清单后再操作"); }
    finally { queueBusyRef.current = false; setQueueBusy(false); }
  };

  // 搜索态与搜索分页
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeSearchQuery, setActiveSearchQuery] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<MediaLibraryItem[]>([]);
  const [searchHasMore, setSearchHasMore] = useState<boolean>(false);
  const [searchNextCursor, setSearchNextCursor] = useState<string | undefined>(undefined);
  const requestSequenceRef = useRef(0);
  const wallSequenceRef = useRef(0);
  const detailSequenceRef = useRef(0);
  const activeSearchQueryRef = useRef<string | null>(null);
  useEffect(() => { activeSearchQueryRef.current = activeSearchQuery; }, [activeSearchQuery]);

  // 直链粘贴识别：搜索框里出现 https:// 即切换为"直链识别"视图（渲染期派生，无需状态）。
  const pendingLink = searchQuery.trim().startsWith("https://") ? searchQuery.trim() : null;
  // YouTube 契约分类（镜像后端规则）：watch?v= / youtu.be / 裸 11 位 ID；片单/频道/Shorts/embed 就地说明不支持。
  const pendingLinkKind = pendingLink ? classifyYouTubeInput(pendingLink) : null;
  const bareQuery = pendingLink ? "" : searchQuery.trim();
  const bareQueryKind = bareQuery && !/\s/.test(bareQuery) ? classifyYouTubeInput(bareQuery) : null;
  const bareYouTubeId = bareQueryKind?.kind === "video" ? bareQueryKind.videoId : null;
  const youtubeLinkNote = pendingLinkKind?.kind === "video" && youtubeCapability?.requiresBrowserAccess === true
    ? `浏览器内嵌播放 · 需能访问 youtube.com${youtubeCapability.requiresPlaybackApiKey === false ? " · 无需 API key" : ""}`
    : null;

  const activeLibrary = libraries.find((library) => library.id === activeLibraryId) ?? null;

  // 1. 获取目录内容 (真机接口请求，彻底删除 mock fallback)
  const loadDirectory = useCallback(async (libraryId: string, path: string, cursor?: string) => {
    const requestSequence = ++requestSequenceRef.current;
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.getMediaList(libraryId, path, cursor);
      if (requestSequence !== requestSequenceRef.current) return;
      if (cursor) {
        setItems((prev) => [...prev, ...(res.items || [])]);
      } else {
        setItems(res.items || []);
      }
      setBreadcrumbs(res.breadcrumbs || []);
      setFolderPosterId(res.posterId ?? null);
      setHasMore(res.hasMore || false);
      setNextCursor(res.nextCursor);
    } catch (err: unknown) {
      if (requestSequence !== requestSequenceRef.current) return;
      setErrorMsg(mediaErrorText(err, "无法加载媒体目录，请检查网络或后端 Gateway"));
      if (!cursor) { setItems([]); setFolderPosterId(null) }
    } finally {
      if (requestSequence === requestSequenceRef.current) setIsLoading(false);
    }
  }, []);

  // 2. 库内文件名搜索（分页模式）
  const loadSearch = useCallback(async (query: string, libraryId: string, cursor?: string) => {
    if (!query.trim()) return;
    const requestSequence = ++requestSequenceRef.current;
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res = await api.searchMedia(query.trim(), libraryId, cursor);
      if (requestSequence !== requestSequenceRef.current) return;
      if (cursor) {
        setSearchResults((prev) => [...prev, ...(res.items || [])]);
      } else {
        setSearchResults(res.items || []);
      }
      setSearchHasMore(res.hasMore || false);
      setSearchNextCursor(res.nextCursor);
    } catch (err: unknown) {
      if (requestSequence !== requestSequenceRef.current) return;
      setErrorMsg(mediaErrorText(err, "搜索失败，请稍后重试"));
      if (!cursor) setSearchResults([]);
    } finally {
      if (requestSequence === requestSequenceRef.current) setIsLoading(false);
    }
  }, []);

  // 3. 标题库：列表 / 详情 / 候选写回 / 刮削状态
  const loadWall = useCallback(async (libraryId: string, cursor?: string, q?: string) => {
    const sequence = ++wallSequenceRef.current;
    setIsLoading(true);
    try {
      const page = await api.getCatalog(libraryId, cursor, q);
      if (sequence !== wallSequenceRef.current) return;
      const next = toWall(page);
      setWall((prev) => (cursor && prev ? { ...next, cards: [...prev.cards, ...next.cards] } : next));
      setErrorMsg(null);
    } catch (err: unknown) {
      if (sequence !== wallSequenceRef.current) return;
      if (!cursor) setWall(null);
      setErrorMsg(mediaErrorText(err, "无法读取标题库"));
    } finally {
      if (sequence === wallSequenceRef.current) setIsLoading(false);
    }
  }, []);

  const openWallDetail = useCallback(async (itemId: string) => {
    const sequence = ++detailSequenceRef.current;
    setSelectedId(itemId);
    setWallDetail(null);
    setCatalogBusy(true);
    try {
      const detail = await api.getCatalogItem(itemId);
      if (sequence !== detailSequenceRef.current) return;
      setWallDetail(toDetail(detail));
    } catch (err: unknown) {
      if (sequence !== detailSequenceRef.current) return;
      setWallDetail(null);
      setErrorMsg(mediaErrorText(err, "无法读取这个条目"));
    } finally {
      if (sequence === detailSequenceRef.current) setCatalogBusy(false);
    }
  }, []);

  // 打开时读库列表，再落第一个库的首页（服务端顺序，客户端不排序）
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    const loadTimer = window.setTimeout(() => {
      void (async () => {
        setIsLoading(true);
        setErrorMsg(null);
        try {
          const listed = await api.getMediaLibraries();
          if (!live) return;
          setLibraries(listed);
          // 播放平台契约只作展示说明（内嵌/无需 key/需能访问 youtube）；旧后端缺字段不阻塞任何流程。
          void api.getMediaCapabilities().then((capabilities) => {
            if (live) setYoutubeCapability(capabilities.platforms?.youtube ?? null);
          }).catch(() => { if (live) setYoutubeCapability(null); });
          const first = listed[0];
          if (!first) {
            setItems([]);
            setBreadcrumbs([]);
            setErrorMsg(null);
            setIsLoading(false);
            return;
          }
          setActiveLibraryId(first.id);
          setCurrentPath("/");
          setMode("titles");
          setWall(null);
          setWallDetail(null);
          setSelectedId(null);
          setCatalogBusy(false);
          setActiveSearchQuery(null);
          setSearchQuery("");
          setKbIndex(-1);
          setShowKeyHelp(false);
          // 默认进标题（裁决 ②）；文件视图切过去时再载入。
          await loadWall(first.id);
        } catch (err: unknown) {
          if (!live) return;
          setItems([]);
          setErrorMsg(mediaErrorText(err, "无法读取媒体库列表"));
          setIsLoading(false);
        }
      })();
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(loadTimer);
      requestSequenceRef.current += 1;
      wallSequenceRef.current += 1;
      detailSequenceRef.current += 1;
    };
  }, [isOpen, loadDirectory, loadWall]);

  // 打开后把焦点交给搜索框（搜索优先）。
  useEffect(() => {
    if (!isOpen) return;
    const focusTimer = window.setTimeout(() => searchInputRef.current?.focus(), 60);
    return () => window.clearTimeout(focusTimer);
  }, [isOpen]);

  const clearSearch = (restoreTitles = true) => {
    requestSequenceRef.current += 1;
    wallSequenceRef.current += 1;
    detailSequenceRef.current += 1;
    setActiveSearchQuery(null);
    setSearchQuery("");
    setSearchResults([]);
    setSearchHasMore(false);
    setSearchNextCursor(undefined);
    setErrorMsg(null);
    setIsLoading(false);
    setCatalogBusy(false);
    setKbIndex(-1);
    if (restoreTitles && mode === "titles" && activeLibraryId) {
      setWallDetail(null);
      setSelectedId(null);
      void loadWall(activeLibraryId);
    }
  };

  /** 搜索即输入（250ms 防抖）；空串恢复浏览，https:// 交给直链识别。 */
  const runSearch = useCallback(async (query: string) => {
    if (!activeLibraryId) return;
    setActiveSearchQuery(query);
    setSearchResults([]);
    setSearchHasMore(false);
    setSearchNextCursor(undefined);
    setKbIndex(-1);
    if (mode === "titles") {
      detailSequenceRef.current += 1;
      setCatalogBusy(false);
      setSelectedId(null);
      setWallDetail(null);
      await loadWall(activeLibraryId, undefined, query);
      return;
    }
    await loadSearch(query, activeLibraryId);
  }, [activeLibraryId, mode, loadWall, loadSearch]);

  useEffect(() => {
    if (!isOpen) return;
    const query = searchQuery.trim();
    if (query.startsWith("https://")) return; // 直链视图由渲染期派生，无需调度
    const timer = window.setTimeout(() => {
      if (!query) {
        if (activeSearchQueryRef.current !== null) clearSearch();
        return;
      }
      void runSearch(query);
    }, 250);
    return () => window.clearTimeout(timer);
    // runSearch/clearSearch 均为序号隔离的幂等入口；只在输入变化时重排计时。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, isOpen]);

  const submitBatch = async (medias: MediaSource[]) => {
    const result = await onBatchAdd(medias);
    // The lobby only selects initial media and retains its existing void callback.
    if (typeof result !== "object" && result !== false) handleClose();
  };

  /** 摊成整页 / 收回到弹窗：只为这次动画挡住 Radix 的假 close。 */
  const toggleShell = () => {
    if (!onToggleFullPage) return;
    switchingShellRef.current = true;
    onToggleFullPage();
  };

  /** 切库/进目录/回上层的唯一入口：路径只用服务端给的 relativePath 或面包屑 path。 */
  const openPath = useCallback((libraryId: string, path: string) => {
    requestSequenceRef.current += 1;
    setActiveSearchQuery(null);
    setSearchQuery("");
    setSearchResults([]);
    setCurrentPath(path);
    void loadDirectory(libraryId, path);
  }, [loadDirectory, setActiveSearchQuery, setSearchQuery, setSearchResults, setCurrentPath]);

  const selectLibrary = (libraryId: string) => {
    clearSearch(false);
    setCatalogBusy(false);
    setItems([]);
    setBreadcrumbs([]);
    setHasMore(false);
    setNextCursor(undefined);
    setActiveLibraryId(libraryId);
    setCurrentPath("/");
    setWall(null);
    setWallDetail(null);
    setSelectedId(null);
    setShowAllFiles(false);
    setOnlyReview(false);
    setKbIndex(-1);
    setShowKeyHelp(false);
    if (mode === "titles") {
      void loadWall(libraryId);
      return;
    }
    void loadDirectory(libraryId, "/");
  };

  /** 换模式只补自己缺的那半。 */
  const selectMode = (next: "titles" | "files") => {
    if (next === mode) return;
    clearSearch(false);
    setWall(null);
    setWallDetail(null);
    setSelectedId(null);
    setMode(next);
    setShowAllFiles(false);
    setOnlyReview(false);
    setKbIndex(-1);
    setShowKeyHelp(false);
    if (!activeLibraryId) return;
    if (next === "titles") {
      void loadWall(activeLibraryId);
      return;
    }
    void loadDirectory(activeLibraryId, currentPath);
  };

  /** 标题墙里点一张卡：右栏出详情（季/集与候选）。 */
  const openCard = (card: { id: string }) => {
    void openWallDetail(card.id);
  };

  /** 确认/拒绝是标题库仅有的两种写入。 */
  const reviewCandidate = async (action: "confirm" | "reject", candidateId: string) => {
    if (!wallDetail || catalogBusy) return;
    const sequence = ++detailSequenceRef.current;
    setCatalogBusy(true);
    try {
      const next = action === "confirm"
        ? await api.confirmCatalogItem(wallDetail.id, candidateId)
        : await api.rejectCatalogItem(wallDetail.id, candidateId);
      if (sequence !== detailSequenceRef.current) return;
      setWallDetail(toDetail(next));
      if (activeLibraryId) void loadWall(activeLibraryId, undefined, activeSearchQuery ?? undefined);
      setErrorMsg(null);
    } catch (err: unknown) {
      if (sequence !== detailSequenceRef.current) return;
      setErrorMsg(mediaErrorText(err, action === "confirm" ? "确认没写成功" : "拒绝没写成功"));
    } finally {
      if (sequence === detailSequenceRef.current) setCatalogBusy(false);
    }
  };

  if (!isOpen) return null;

  const isSearching = activeSearchQuery !== null;
  const displayItems = isSearching ? searchResults : items;
  const visibleItems = mode === "files" && !showAllFiles ? displayItems.filter(item => !isNonMedia(item)) : displayItems;
  const hiddenFiles = mode === "files" ? displayItems.filter(item => isNonMedia(item)).length : 0;
  const wallCardsAll = (wall?.cards ?? []).filter(card => card.status !== "unmatched");
  const reviewCount = wallCardsAll.filter(card => card.needsReview).length;
  const wallCards = onlyReview ? wallCardsAll.filter(card => card.needsReview) : wallCardsAll;
  const unmatchedCount = (wall?.cards ?? []).filter(card => card.status === "unmatched").length;
  const modeOptions: ReadonlyArray<"titles" | "files"> = ["titles", "files"];

  const moveKbSelection = (delta: number) => {
    const length = mode === "titles" ? wallCards.length : visibleItems.length;
    if (!length) return;
    const next = kbIndex < 0
      ? (delta > 0 ? 0 : length - 1)
      : Math.max(0, Math.min(kbIndex + delta, length - 1));
    setKbIndex(next);
    if (mode === "titles") {
      const card = wallCards[next];
      if (!card) return;
      // 键盘游标和右栏必须指向同一条目；只挪高亮会让高亮和详情对不上。
      void openWallDetail(card.id);
      document.querySelector(`[data-card-id="${CSS.escape(card.id)}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    document.querySelector(`[data-kb-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const activateSelection = (queueInstead: boolean) => {
    if (mode === "titles") {
      const card = wallCards[kbIndex];
      if (card) openCard(card);
      return;
    }
    const item = visibleItems[kbIndex];
    if (!item) return;
    if (item.type === "dir") {
      if (activeLibraryId) openPath(activeLibraryId, item.relativePath || "/");
      return;
    }
    const media: MediaSource = { kind: "openlist", mediaId: item.id, title: item.name, container: item.extension || "mp4" };
    if (queueInstead && !roomless) void addToQueue(media);
    else void playNow(media);
  };

  /** YouTube 提交：规范化 {kind:"youtube", videoId, title}；服务端仍做最终校验。 */
  const submitYouTube = async (videoId: string, play: boolean) => {
    const media: MediaSource = { kind: "youtube", videoId, title: "YouTube 视频" };
    if (play) {
      await playNow(media);
      return;
    }
    if (!await addToQueue(media)) return;
    handleClose();
  };

  const submitLink = async (url: string, play: boolean) => {
    const classified = classifyYouTubeInput(url);
    if (classified?.kind === "video") return submitYouTube(classified.videoId, play);
    if (classified?.kind === "unsupported") return; // 该形态后端拒绝：行内已给出原因，不发请求。
    if (!url.startsWith("https://")) return;
    const isHls = url.toLowerCase().includes(".m3u8");
    const media: MediaSource = isHls
      ? { kind: "hls", url, title: "HLS 实时流" }
      : { kind: "http", url, title: "HTTPS 媒体直链" };
    if (play) {
      await playNow(media);
      return;
    }
    if (!await addToQueue(media)) return;
    handleClose();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (searchQuery) {
        e.preventDefault();
        e.stopPropagation();
        setSearchQuery("");
        return;
      }
      return; // 交给 Radix（弹窗关闭）或整页壳
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (pendingLink) { void submitLink(pendingLink, roomless ? true : !e.altKey); return; }
      const query = searchQuery.trim();
      if (query) { void runSearch(query); return; }
      activateSelection(e.altKey);
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); moveKbSelection(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveKbSelection(-1); return; }
  };

  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "?" && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      setShowKeyHelp((value) => !value);
      return;
    }
    if (e.key === "Escape") {
      if (showKeyHelp) {
        e.stopPropagation();
        setShowKeyHelp(false);
        return;
      }
      if (fullPage) onClose();
      return;
    }
    // ↑↓/⏎ 原本只挂在搜索框上（搜索优先，打开时自动聚焦）。但点过一次海报之后
    // 焦点就跑到海报按钮上了，键盘导航会静默失效。这里给非输入目标补上同一套；
    // 搜索框自己那套在 handleSearchKeyDown，不在这里重复处理。
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveKbSelection(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveKbSelection(-1); return; }
    if (e.key === "Enter") { e.preventDefault(); activateSelection(e.altKey); return; }
  };

  // 一键入队当前目录全部可由任一正式客户端播放的文件。
  const handleBatchAddCurrentDir = async () => {
    if (!activeLibraryId || queueBusyRef.current || queueResult?.status === "uncertain") return;
    queueBusyRef.current = true;
    setQueueBusy(true);
    const session = queueSessionRef.current;
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const allItems = [...items];
      let cursor = hasMore ? nextCursor : undefined;
      while (cursor && allItems.length < 200) {
        const page = await api.getMediaList(activeLibraryId, currentPath, cursor);
        allItems.push(...page.items);
        cursor = page.hasMore ? page.nextCursor : undefined;
      }

      const supported = allItems
        .filter(
          (item) =>
            item.type === "file" &&
            (item.compatibility.browser === "supported" ||
              item.compatibility.desktop === "supported"),
        )
        .slice(0, 200)
        .map((it) => ({
          kind: "openlist" as const,
          mediaId: it.id,
          title: it.name,
          container: it.extension || "mp4",
        }));

      if (supported.length > 0) {
        if (session !== queueSessionRef.current) return;
        await submitBatch(supported);
      }
    } catch (error: unknown) {
      setErrorMsg(mediaErrorText(error, "批量读取目录失败"));
    } finally {
      setIsLoading(false);
      queueBusyRef.current = false;
      setQueueBusy(false);
    }
  };

  const handleClose = () => {
    clearSearch(false);
    onClose();
  };

  // 右栏只在"详情已到"或"详情在路上"时占位。没选中就把整幅宽度让给标题墙，
  // 不留空框、也不写"选一张海报…"那类解释句（DESIGN.md §9.1）。
  // （放在 handleClose 之后：回调引用它，避免前向引用触发 React Compiler 报错。）
  const railLoading = catalogBusy && wallDetail === null;
  // 点下去到详情回来之间必须有可见变化：详情走一趟可能要几秒，只把海报边框
  // 提亮一下，看起来就是"点了没反应"。
  const rail = wallDetail ? (
    <CatalogRail
      detail={wallDetail}
      busy={catalogBusy}
      roomless={roomless}
      onConfirm={(candidateId) => void reviewCandidate("confirm", candidateId)}
      onReject={(candidateId) => void reviewCandidate("reject", candidateId)}
      onPlay={async (media) => { if (await onPlayNow(media) !== false) handleClose(); }}
      onAddToQueue={(media) => { void addToQueue(media); }}
      onPlayDesktop={onPlayOnDesktop ? async (media) => { if (await onPlayOnDesktop(media) !== false) handleClose(); } : undefined}
    />
  ) : railLoading ? (
    <aside
      className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-card p-3.5"
      aria-busy="true"
      aria-label="标题详情读取中"
    >
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
        正在读取详情
      </p>
    </aside>
  ) : null;
  const railVisible = rail !== null;

  const panel = (
    <div className="relative flex min-h-0 flex-1 flex-col" onKeyDown={handlePanelKeyDown}>
        {/* ================= 头部：标题 · 库切换 · 状态与工具 ================= */}
        <div className="flex shrink-0 items-center gap-4 px-4 py-3">
          {/* 整页模式没有 Radix Dialog，DialogTitle 会抛错 —— 两种壳各用各的标题元素。 */}
          {fullPage ? (
            <span className="text-lg font-medium text-foreground">媒体库</span>
          ) : (
            <DialogTitle className="text-lg font-medium text-foreground">媒体库</DialogTitle>
          )}

          {/* 库切换：顺序与健康位都按服务端返回，客户端不排序 */}
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto" role="group" aria-label="媒体库">
            {libraries.map((library) => (
              <button
                key={library.id}
                type="button"
                aria-pressed={library.id === activeLibraryId}
                title={`${library.sourceName} · ${KIND_LABEL[library.kind]}`}
                onClick={() => selectLibrary(library.id)}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
                  library.id === activeLibraryId
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 rounded-full", library.health === "ok" ? "bg-ok" : "bg-destructive")}
                />
                <span>{library.name}</span>
                <span className="opacity-60">{KIND_LABEL[library.kind]}</span>
              </button>
            ))}
            {libraries.length === 0 && !isLoading && (
              <span className="px-2 text-xs text-muted-foreground">没有可用的库</span>
            )}
          </div>

          <span className="flex-1" />

          {onToggleFullPage ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleShell}
              aria-label={fullPage ? "收起到弹窗" : "整页打开"}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              {fullPage ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleClose}
            aria-label="关闭媒体库"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* ================= 搜索行：搜索即输入 · 视图分段 ================= */}
        <div className="flex shrink-0 items-center gap-2 px-4 pb-3">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ash" aria-hidden="true" />
            <Input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={mode === "files" ? "搜索文件名，或粘贴直链" : "搜索标题，或粘贴直链"}
              aria-label={`在 ${activeLibrary?.name ?? "媒体库"} 中${mode === "files" ? "搜索文件名" : "搜索标题"}`}
              className="h-10 pl-9 pr-20 text-sm"
            />
            {searchQuery ? (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <Keycap className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">⏎</Keycap>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="视图">
            {modeOptions.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => selectMode(value)}
                className={cn(
                  "h-7 rounded-full px-2.5 text-xs transition-colors",
                  mode === value
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {MODE_LABEL[value]}
              </button>
            ))}
          </div>

          {mode === "titles" && reviewCount > 0 ? (
            <button
              type="button"
              aria-pressed={onlyReview}
              onClick={() => setOnlyReview((value) => !value)}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
                onlyReview ? "bg-warn-soft font-medium text-warn" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              待确认 {reviewCount}
            </button>
          ) : null}
        </div>

        {/* ================= 清单操作结果（结构化批量反馈） ================= */}
        {queueResult && (
          <div role="status" aria-label="清单操作结果" className="shrink-0 border-b border-border px-4 pb-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("size-1.5 shrink-0 rounded-full",
                queueResult.status === "succeeded" ? "bg-ok" : queueResult.status === "uncertain" ? "bg-warn" : "bg-destructive")} />
              <span>
                已成功 {queueResult.addedCount} 项 · {queueResult.status === "uncertain" ? "结果未知" : "失败"} {queueResult.stopped ? 1 : 0} 项 · 未执行 {queueResult.remaining.length} 项
              </span>
              <span className="flex-1" />
              {queueResult.status === "uncertain" && onReconcileQueue ? (
                <Button variant="secondary" size="sm" disabled={queueBusy} onClick={() => void reconcileQueue()} className="h-7 text-xs">
                  <RefreshCw className="size-3" />核对房间清单
                </Button>
              ) : null}
              {queueResult.status === "failed" && getBatchRetryItems(queueResult)?.length ? (
                <Button variant="secondary" size="sm" disabled={queueBusy} onClick={() => void retryRemaining()} className="h-7 text-xs">
                  <RefreshCw className="size-3" />重试未完成项
                </Button>
              ) : null}
            </div>
            {queueResult.stopped && (
              <p className="mt-1 break-words text-xs text-destructive">
                {queueResult.stopped.item.title || "媒体"}：{queueResult.stopped.result.error.message.replace(/https?:\/\/[^\s]+/gi, "[链接已隐藏]")}
              </p>
            )}
            {(queueResult.succeeded.length > 0 || queueResult.remaining.length > 0) && (
              <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                {queueResult.succeeded.length > 0 && <details><summary className="cursor-pointer transition-colors hover:text-foreground">已成功项</summary><ul className="max-h-28 overflow-y-auto">{queueResult.succeeded.map(({ item, index }) => <li key={index}>{index + 1}. {item.title || "媒体"}</li>)}</ul></details>}
                {queueResult.remaining.length > 0 && <details><summary className="cursor-pointer transition-colors hover:text-foreground">未执行项</summary><ul className="max-h-28 overflow-y-auto">{queueResult.remaining.map(({ item, index }) => <li key={index}>{index + 1}. {item.title || "媒体"}</li>)}</ul></details>}
              </div>
            )}
          </div>
        )}

        {/* 裸 11 位 ID：不打断搜索，内联与直链一致的 YouTube 动作 */}
        {bareYouTubeId ? (
          <div className="shrink-0 border-b border-border px-4 py-2" data-testid="youtube-id-row">
            <div className="flex items-center gap-2 text-xs">
              <span className="flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px] text-foreground/80">
                <YouTubeChip />
                {bareYouTubeId}
              </span>
              <span className="flex-1" />
              <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => void submitYouTube(bareYouTubeId, true)}>
                播放
              </Button>
              <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={roomless} onClick={() => void submitYouTube(bareYouTubeId, false)}>
                加入清单
              </Button>
            </div>
          </div>
        ) : null}

        {/* ================= 直链识别：粘贴 https:// 后的行内动作 ================= */}
        {pendingLink ? (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-lg rounded-lg border border-border bg-card p-2">
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <LinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate font-mono">{pendingLink}</span>
                {pendingLinkKind?.kind === "video" ? <YouTubeChip /> : null}
              </div>
              {pendingLinkKind?.kind === "unsupported" ? (
                <p role="alert" className="px-2 py-1.5 text-sm text-destructive">
                  {pendingLinkKind.reason}
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void submitLink(pendingLink, true)}
                    className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-sm transition-colors hover:bg-accent"
                  >
                    <span>播放此链接</span>
                    <Keycap>⏎</Keycap>
                  </button>
                  <button
                    type="button"
                    disabled={roomless}
                    onClick={() => void submitLink(pendingLink, false)}
                    className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-sm transition-colors enabled:hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span>加入播放清单</span>
                    {roomless ? null : <Keycap>⌥⏎</Keycap>}
                  </button>
                  {youtubeLinkNote ? (
                    <p className="px-2 py-1 text-[10px] text-muted-foreground">{youtubeLinkNote}</p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : mode === "titles" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 pt-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{wall ? `${wallCardsAll.length} 个标题` : "正在读取标题库…"}</span>
              {activeSearchQuery ? (
                <button
                  type="button"
                  onClick={() => clearSearch()}
                  className="flex items-center gap-1 rounded-full border border-border px-2 text-foreground/80 transition-colors hover:text-foreground"
                >
                  标题：{activeSearchQuery}
                  <X className="size-3" aria-hidden="true" />
                </button>
              ) : null}
              {isLoading && wall ? <span className="text-ash">更新中…</span> : null}
            </div>

            {errorMsg ? (
              <div className="flex items-center justify-between gap-3 text-sm text-destructive" role="alert">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
                  <span className="truncate">{errorMsg}</span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => activeLibraryId && void loadWall(activeLibraryId, undefined, activeSearchQuery ?? undefined)}
                >
                  重试
                </Button>
              </div>
            ) : null}

            {wall ? (
              wallCards.length === 0 ? (
                <div className="flex flex-1 items-center gap-2 text-sm text-muted-foreground" role="status">
                  <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
                  这个库还没有标题
                </div>
              ) : (
                <div className={cn("grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden", railVisible && (fullPage ? "lg:grid-cols-[minmax(0,1fr)_360px]" : "lg:grid-cols-[minmax(0,1fr)_320px]"))}>
                  {/* 只有墙滚；右栏固定在自己的高度里（产品负责人 2026-09-27）。 */}
                  <div className="min-h-0 overflow-y-auto pr-1 @container">
                    <CatalogWall cards={wallCards} selectedId={selectedId} onSelect={openCard} />
                  </div>
                  {rail}
                </div>
              )
            ) : (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">正在读取标题库…</div>
            )}

            <div className="flex items-center justify-between gap-3">
              <UnmatchedLine
                count={unmatchedCount}
                hiddenFiles={0}
                showAllFiles={false}
                onShowFiles={() => selectMode("files")}
                onToggleFiles={() => undefined}
              />
              {wall?.hasMore && wall.nextCursor ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={catalogBusy}
                  onClick={() => activeLibraryId && void loadWall(activeLibraryId, wall.nextCursor ?? undefined, activeSearchQuery ?? undefined)}
                  className="shrink-0 text-xs"
                >
                  载入更多标题
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {/* 路径与批量操作 */}
          <div className="mb-2 flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-1 font-mono">
              <button
                type="button"
                onClick={() => activeLibraryId && openPath(activeLibraryId, "/")}
                className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 transition-colors hover:text-foreground"
              >
                <Folder className="size-3" aria-hidden="true" />
                <span>{activeLibrary?.name ?? "媒体库"}</span>
              </button>
              {/* 第一格面包屑就是库根：不再额外顶一个同名按钮 */}
              {breadcrumbs.slice(1).map((crumb) => (
                <React.Fragment key={crumb.path}>
                  <ChevronRight className="size-3 text-ash" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => activeLibraryId && openPath(activeLibraryId, crumb.path)}
                    aria-current={crumb.path === currentPath ? "page" : undefined}
                    className={cn(
                      "rounded-sm px-1 py-0.5 transition-colors hover:text-foreground",
                      crumb.path === currentPath ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </div>

            {!isSearching && items.some((it) => it.type === "file") && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleBatchAddCurrentDir()}
                disabled={roomless || queueBusy || queueResult?.status === "uncertain"}
                className="h-7 shrink-0 text-xs"
              >
                <ListPlus className="size-3" />
                <span>添加当前文件夹全部剧集</span>
              </Button>
            )}
          </div>

          {/* 当前目录自己的封面（相位 2）：只有这一层有 poster.jpg 时才有 */}
          {folderPosterId && !isSearching && !errorMsg && (
            <div className="relative mb-3 h-24 overflow-hidden rounded-lg border border-border bg-muted">
              <MediaImage
                src={`/api/media/artwork/${encodeURIComponent(folderPosterId)}`}
                alt=""
                className="size-full object-cover"
              />
              <span className="absolute bottom-2 left-3 max-w-[80%] truncate rounded-[4px] bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                {breadcrumbs[breadcrumbs.length - 1]?.name ?? activeLibrary?.name ?? "媒体库"}
              </span>
            </div>
          )}
          {errorMsg && (
            <div className="mb-3 flex items-center justify-between gap-3 text-sm text-destructive" role="alert">
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
                <span className="truncate">{errorMsg}</span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={() => {
                  if (!activeLibraryId) return;
                  if (activeSearchQuery) {
                    void loadSearch(activeSearchQuery, activeLibraryId);
                  } else {
                    void loadDirectory(activeLibraryId, currentPath);
                  }
                }}
              >
                <RefreshCw className="size-3" />
                <span>重试</span>
              </Button>
            </div>
          )}

          {isLoading && displayItems.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : displayItems.length === 0 ? (
            errorMsg ? null : (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              {isSearching ? `未找到与“${activeSearchQuery}”匹配的媒体文件` : "当前目录为空"}
            </div>
            )
          ) : (
            <div className="space-y-0.5">
              {visibleItems.map((item, index) => {
                const isDir = item.type === "dir";
                const isBrowserPlayable = canAttemptBrowserPlayback(item);
                const isDesktopPlayable = item.compatibility.desktop === "supported";
                const isDesktopOnly = !isBrowserPlayable && isDesktopPlayable;
                const media: MediaSource = {
                  kind: "openlist",
                  mediaId: item.id,
                  title: item.name,
                  container: item.extension || "mp4",
                };

                return (
                  <div
                    key={item.id}
                    data-kb-row={index}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-sm px-2.5 py-2 transition-colors",
                      kbIndex === index ? "bg-muted" : "hover:bg-accent",
                      !isDir && !isBrowserPlayable && !isDesktopPlayable && "opacity-60",
                    )}
                  >
                    <div
                      onClick={() => {
                        if (isDir && activeLibraryId) {
                          openPath(activeLibraryId, item.relativePath || "/");
                        }
                      }}
                      className={cn("flex min-w-0 flex-1 items-center gap-2.5", isDir && "cursor-pointer")}
                    >
                      {isDir ? (
                        <ArtworkThumb posterId={item.posterId} fallback={<Folder className="size-4 text-muted-foreground" aria-hidden="true" />} />
                      ) : (
                        <ArtworkThumb posterId={item.posterId} fallback={<Film className="size-4 text-muted-foreground" aria-hidden="true" />} />
                      )}
                      <span className="min-w-0 truncate text-sm">{item.name}</span>
                      {item.relativePath && (
                        <span className="truncate font-mono text-xs text-ash">
                          {item.relativePath}
                        </span>
                      )}
                      {!isBrowserPlayable && (
                        <span className={cn(
                          "shrink-0 rounded-[4px] px-1.5 py-0.5 text-xs",
                          isDesktopPlayable ? "bg-info-soft text-info" : "bg-elevated text-muted-foreground",
                        )}>
                          {isDesktopPlayable ? "桌面端 / MPV" : item.compatibility.browserReason || "浏览器不支持"}
                        </span>
                      )}
                    </div>

                    {!isDir && kbIndex === index && (
                      <span className="flex shrink-0 items-center gap-1">
                        {isBrowserPlayable && <Keycap>⏎</Keycap>}
                        {isBrowserPlayable && <Keycap>⌥⏎</Keycap>}
                      </span>
                    )}

                    {!isDir && isBrowserPlayable && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={(e) => { e.stopPropagation(); void playNow(media); }}
                        >
                          <Play className="size-3" />
                          <span>{roomless ? "用此片开房" : "播放"}</span>
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={roomless || queueBusy || queueResult?.status === "uncertain"}
                          onClick={(e) => { e.stopPropagation(); void addToQueue(media); }}
                        >
                          <ListPlus className="size-3" />
                          <span>加入清单</span>
                        </Button>
                      </div>
                    )}

                    {!isDir && isDesktopOnly && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            void (async () => {
                              if (onPlayOnDesktop) {
                                const accepted = await onPlayOnDesktop(media);
                                if (accepted === false) return;
                              } else {
                                if (await onPlayNow(media) === false) return;
                              }
                              handleClose();
                            })();
                          }}
                        >
                          <Tv className="size-3" />
                          <span>{roomless ? "用此片开房" : onPlayOnDesktop ? "桌面端播放" : "选择此媒体"}</span>
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={roomless || queueBusy || queueResult?.status === "uncertain"}
                          onClick={(e) => { e.stopPropagation(); void addToQueue(media); }}
                        >
                          <ListPlus className="size-3" />
                          <span>加入清单</span>
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}

              {hiddenFiles > 0 ? (
                <UnmatchedLine
                  count={0}
                  hiddenFiles={hiddenFiles}
                  showAllFiles={showAllFiles}
                  onShowFiles={() => undefined}
                  onToggleFiles={() => setShowAllFiles((show) => !show)}
                />
              ) : null}

              {((!isSearching && hasMore) || (isSearching && searchHasMore)) && (
                <div className="pt-3 text-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (!activeLibraryId) return;
                      if (isSearching) {
                        void loadSearch(activeSearchQuery, activeLibraryId, searchNextCursor);
                      } else {
                        void loadDirectory(activeLibraryId, currentPath, nextCursor);
                      }
                    }}
                    disabled={isLoading}
                    className="text-xs"
                  >
                    {isLoading ? "加载中…" : "加载更多"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        )}

        {/* ================= 键盘速查（? 呼出） ================= */}
        {showKeyHelp && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-6 dark:bg-black/60"
            onClick={() => setShowKeyHelp(false)}
          >
            <div
              role="dialog"
              aria-label="键盘"
              className="w-full max-w-sm rounded-lg border border-border bg-card p-4"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-lg font-medium text-foreground">键盘</span>
                <Keycap>?</Keycap>
              </div>
              <div className="mt-2 space-y-0.5">
                {[
                  { label: "移动选择", keys: ["↑", "↓"] },
                  { label: "打开 / 播放", keys: ["⏎"] },
                  ...(roomless ? [] : [{ label: "加入播放清单", keys: ["⌥", "⏎"] }]),
                  { label: "清空搜索 / 关闭", keys: ["Esc"] },
                  { label: "本面板", keys: ["?"] },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm">
                    <span>{row.label}</span>
                    <span className="flex items-center gap-1">{row.keys.map((key) => <Keycap key={key}>{key}</Keycap>)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
    </div>
  );

  if (fullPage) {
    return <div className="fixed inset-0 z-50 flex flex-col items-center overflow-hidden bg-background">
      <div className="flex min-h-0 w-full max-w-[min(94vw,2240px)] flex-1 flex-col">{panel}</div>
    </div>;
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !switchingShellRef.current) handleClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[min(86dvh,900px)] w-[min(92vw,1440px)] max-w-[min(92vw,1440px)] flex-col gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-[min(92vw,1440px)]"
      >
        {panel}
      </DialogContent>
    </Dialog>
  );
}
