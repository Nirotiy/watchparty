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

  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  MediaBreadcrumb,
  MediaLibrary,
  MediaLibraryItem,
  MediaLibraryKind,
  MediaSource,
} from "@/lib/contracts";
import { mediaErrorText } from "@/lib/media-error-text";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<MediaLibraryKind, string> = {
  anime: "番剧",
  movie: "电影",
  tv: "剧集",
  other: "其他",
};

const HEALTH_LABEL: Record<string, string> = {
  ok: "可用",
  unreachable: "连不上",
  auth_failed: "鉴权失败",
  root_missing: "路径不存在",
  not_configured: "未配置",
};

interface OpenListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPlayNow: (media: MediaSource) => void;
  onPlayOnDesktop?: (media: MediaSource) => boolean | void | Promise<boolean | void>;
  onAddToQueue: (media: MediaSource) => void;
  onBatchAdd: (medias: MediaSource[]) => void | Promise<void>;
}

/** 库封面（相位 2）：同源 <img>，走 Next 的 /api 重写，失败就退回图标。 */
function ArtworkThumb({ posterId, fallback }: { posterId?: string | null; fallback: React.ReactNode }) {
  const [failed, setFailed] = React.useState(false);
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-black">
      {posterId && !failed
        ? <img src={`/api/media/artwork/${encodeURIComponent(posterId)}`} alt="" loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
        : fallback}
    </span>
  );
}

function parseYouTubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    let candidate: string | null = null;
    if (hostname === "youtu.be") candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      candidate =
        url.searchParams.get("v") ??
        url.pathname.match(/^\/(?:embed|shorts)\/([^/?]+)/)?.[1] ??
        null;
    }
    return candidate && /^[a-zA-Z0-9_-]{11}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function OpenListModal({
  isOpen,
  onClose,
  onPlayNow,
  onPlayOnDesktop,
  onAddToQueue,
  onBatchAdd,
}: OpenListModalProps) {
  // 多源库（phase 1）：能力位为真走 /api/media/libraries + list?libraryId=，
  // 顺序、面包屑路径都按服务端返回渲染，客户端不排序、不拼路径。
  const [libraries, setLibraries] = useState<MediaLibrary[]>([]);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("/");
  const [breadcrumbs, setBreadcrumbs] = useState<MediaBreadcrumb[]>([]);
  const [items, setItems] = useState<MediaLibraryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [folderPosterId, setFolderPosterId] = useState<string | null>(null);

  // 加载与错误状态 (绝对零 mock 降级)
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 搜索态与搜索分页
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeSearchQuery, setActiveSearchQuery] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<MediaLibraryItem[]>([]);
  const [searchHasMore, setSearchHasMore] = useState<boolean>(false);
  const [searchNextCursor, setSearchNextCursor] = useState<string | undefined>(undefined);
  const requestSequenceRef = useRef(0);

  // 直链手动添加模式
  const [isManualUrlMode, setIsManualUrlMode] = useState<boolean>(false);
  const [customUrl, setCustomUrl] = useState<string>("");
  const [customTitle, setCustomTitle] = useState<string>("");

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

  // 打开时读能力位与库列表，再落第一个库的首页（服务端顺序，客户端不排序）
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
          await loadDirectory(first.id, "/");
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
    };
  }, [isOpen, loadDirectory]);

  const clearSearch = useCallback(() => {
    requestSequenceRef.current += 1;
    setActiveSearchQuery(null);
    setSearchQuery("");
    setSearchResults([]);
    setSearchHasMore(false);
    setSearchNextCursor(undefined);
    setErrorMsg(null);
    setIsLoading(false);
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) {
      clearSearch();
      return;
    }
    if (!activeLibraryId) return;
    setActiveSearchQuery(query);
    setSearchResults([]);
    setSearchHasMore(false);
    setSearchNextCursor(undefined);
    await loadSearch(query, activeLibraryId);
  };

  const handleClose = () => {
    clearSearch();
    onClose();
  };

  /** 切库/进目录/回上层的唯一入口：路径只用服务端给的 relativePath 或面包屑 path。 */
  const openPath = useCallback((libraryId: string, path: string) => {
    setCurrentPath(path);
    void loadDirectory(libraryId, path);
  }, [loadDirectory]);

  const selectLibrary = (libraryId: string) => {
    clearSearch();
    setActiveLibraryId(libraryId);
    setCurrentPath("/");
    void loadDirectory(libraryId, "/");
  };

  if (!isOpen) return null;

  const isSearching = activeSearchQuery !== null;
  const displayItems = isSearching ? searchResults : items;

  // 一键入队当前目录全部可由任一正式客户端播放的文件。
  const handleBatchAddCurrentDir = async () => {
    if (!activeLibraryId) return;
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
        await onBatchAdd(supported);
        handleClose();
      }
    } catch (error: unknown) {
      setErrorMsg(mediaErrorText(error, "批量读取目录失败"));
    } finally {
      setIsLoading(false);
    }
  };

  // 添加自定义直链 (仅允许 https)
  const handleAddCustomUrl = (playImmediately: boolean) => {
    if (!customUrl.trim().startsWith("https://")) {
      setErrorMsg("直链必须以 https:// 开头");
      return;
    }

    const url = customUrl.trim();
    const youtubeVideoId = parseYouTubeVideoId(url);
    const isHls = url.toLowerCase().includes(".m3u8");
    const media: MediaSource = youtubeVideoId
      ? { kind: "youtube", videoId: youtubeVideoId, title: customTitle.trim() || "YouTube 视频" }
      : isHls
        ? { kind: "hls", url, title: customTitle.trim() || "HLS 实时流" }
        : { kind: "http", url, title: customTitle.trim() || "HTTPS 媒体直链" };

    if (playImmediately) {
      onPlayNow(media);
    } else {
      onAddToQueue(media);
    }
    handleClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[620px] max-h-[92dvh] w-full max-w-4xl flex-col gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-4xl"
      >
        {/* ================= 头部工具条 ================= */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-3">
            <DialogTitle className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Film className="size-4 text-sky-400" />
              <span>点播媒体库</span>
            </DialogTitle>

            {/* 库切换器：顺序与健康位都按服务端返回，客户端不排序 */}
            <div className="flex flex-wrap rounded border border-border bg-black p-0.5 text-xs" role="group" aria-label="媒体库">
              {libraries.map((library) => (
                <Button
                  key={library.id}
                  variant="ghost"
                  size="sm"
                  aria-pressed={library.id === activeLibraryId}
                  title={`${library.sourceName} · ${KIND_LABEL[library.kind]} · ${HEALTH_LABEL[library.health] ?? library.health}`}
                  onClick={() => selectLibrary(library.id)}
                  className={cn(
                    "gap-1.5 px-2.5",
                    library.id === activeLibraryId
                      ? "bg-sky-500 font-semibold text-black hover:bg-sky-500 hover:text-black"
                      : "font-normal text-muted-foreground hover:text-white",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      library.health === "ok" ? "bg-emerald-400" : "bg-rose-400",
                      library.id === activeLibraryId && library.health === "ok" && "bg-emerald-900",
                      library.id === activeLibraryId && library.health !== "ok" && "bg-rose-900",
                    )}
                  />
                  <span>{library.name}</span>
                  <span className="opacity-70">{KIND_LABEL[library.kind]}</span>
                </Button>
              ))}
              {libraries.length === 0 && !isLoading && (
                <span className="px-2.5 py-1 text-muted-foreground">没有可用的库</span>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsManualUrlMode(!isManualUrlMode)}
              className={cn(
                isManualUrlMode
                  ? "border-sky-500 bg-sky-950/40 text-sky-400"
                  : "bg-black text-muted-foreground hover:text-white",
              )}
            >
              <LinkIcon className="size-3" />
              <span>直链添加</span>
            </Button>
          </div>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleClose}
            aria-label="关闭媒体库"
            className="text-muted-foreground hover:bg-accent hover:text-white"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* 直链输入栏 */}
        {isManualUrlMode && (
          <div className="border-b border-border bg-secondary/60 p-4 space-y-2.5">
            <div className="text-xs font-semibold text-foreground/85">手动添加外部 HTTPS 直链 / HLS 流</div>
            <div className="flex flex-1 gap-2">
              <Input
                type="text"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://example.com/video.mp4 或 .m3u8"
                className="h-8 flex-1 bg-black font-mono text-xs"
              />
              <Input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="片名备注 (可选)"
                className="h-8 w-48 bg-black text-xs"
              />
              <Button size="sm" onClick={() => handleAddCustomUrl(true)} className="bg-sky-500 font-semibold text-black hover:bg-sky-400">
                立即播放
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleAddCustomUrl(false)}>
                加入清单
              </Button>
            </div>
          </div>
        )}

        {/* 当前分类全局搜索 */}
        <div className="flex shrink-0 border-b border-border bg-secondary/30 px-5 py-2">
          <form onSubmit={handleSearch} className="flex w-full min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="在当前库里搜索文件名..."
                aria-label={`在 ${activeLibrary?.name ?? "媒体库"} 中搜索`}
                className="h-8 w-full bg-black pl-8 text-xs"
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={isLoading}
              className="shrink-0 whitespace-nowrap text-foreground/85"
            >
              搜索
            </Button>
            {isSearching && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  clearSearch();
                }}
                className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-white"
              >
                清除搜索
              </Button>
            )}
          </form>
        </div>

        {/* 面包屑与批量操作 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-black/40 px-5 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-mono text-muted-foreground">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => activeLibraryId && openPath(activeLibraryId, "/")}
              className="h-6 px-1 font-normal hover:text-white"
            >
              <Folder className="size-3 text-sky-400" />
              <span>{activeLibrary?.name ?? "媒体库"}</span>
            </Button>
            {/* 第一格面包屑就是库根：不再额外顶一个同名按钮 */}
            {breadcrumbs.slice(1).map((crumb) => (
              <React.Fragment key={crumb.path}>
                <ChevronRight className="size-3 text-muted-foreground" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => activeLibraryId && openPath(activeLibraryId, crumb.path)}
                  aria-current={crumb.path === currentPath ? "page" : undefined}
                  className={cn(
                    "h-6 px-1 font-mono font-normal hover:text-white",
                    crumb.path === currentPath ? "text-white" : "text-muted-foreground",
                  )}
                >
                  {crumb.name}
                </Button>
              </React.Fragment>
            ))}
          </div>

          {!isSearching && items.some((it) => it.type === "file") && (
            <Button
              variant="link"
              size="sm"
              onClick={() => void handleBatchAddCurrentDir()}
              className="h-6 px-1 text-[11px] font-medium text-sky-400 underline-offset-2 hover:text-sky-300 hover:no-underline"
            >
              <ListPlus className="size-3.5" />
              <span>+ 添加当前文件夹全部剧集至播放清单</span>
            </Button>
          )}
        </div>

        {/* ================= 主体列表区域 ================= */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* 当前目录自己的封面（相位 2）：只有这一层有 poster.jpg 时才有 */}
          {folderPosterId && !isSearching && !errorMsg && (
            <div className="relative mb-3 h-24 overflow-hidden rounded border border-border bg-black">
              <img
                src={`/api/media/artwork/${encodeURIComponent(folderPosterId)}`}
                alt=""
                className="size-full object-cover"
                onError={(event) => { event.currentTarget.style.display = "none" }}
              />
              <span className="absolute bottom-2 left-3 max-w-[80%] truncate rounded bg-black/60 px-2 py-0.5 text-xs font-semibold text-white">
                {breadcrumbs[breadcrumbs.length - 1]?.name ?? activeLibrary?.name ?? "媒体库"}
              </span>
            </div>
          )}
          {errorMsg && (
            <div className="mb-3 flex items-center justify-between rounded border border-rose-900/50 bg-rose-950/30 p-3 text-xs text-rose-300">
              <div className="flex items-center gap-2">
                <AlertCircle className="size-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  if (!activeLibraryId) return;
                  if (activeSearchQuery) {
                    void loadSearch(activeSearchQuery, activeLibraryId);
                  } else {
                    void loadDirectory(activeLibraryId, currentPath);
                  }
                }}
                className="h-6 px-1 text-white underline-offset-2"
              >
                <RefreshCw className="size-3" />
                <span>重试</span>
              </Button>
            </div>
          )}

          {isLoading && displayItems.length === 0 ? (
            <div className="flex h-48 items-center justify-center font-mono text-xs text-muted-foreground">
              加载媒体中...
            </div>
          ) : displayItems.length === 0 ? (
            errorMsg ? null : (
            <div className="flex h-48 flex-col items-center justify-center text-xs text-muted-foreground space-y-1">
              <span>{isSearching ? `未找到与“${activeSearchQuery}”匹配的媒体文件` : "当前目录为空"}</span>
              {isSearching && (
                <span className="text-[11px] text-muted-foreground">
                  如果确认文件存在，请检查 OpenList 是否已启用并构建搜索索引
                </span>
              )}
            </div>
            )
          ) : (
            <div className="space-y-1">
              {displayItems.map((item) => {
                const isDir = item.type === "dir";
                // 严格等于 supported 才可播：maybe 与未知值都不放行（handoff §2 D7）。
                const isBrowserPlayable = item.compatibility.browser === "supported";
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
                    className={`flex items-center justify-between rounded border p-2.5 text-xs transition ${
                      isDir
                        ? "border-border bg-card hover:border-ring hover:bg-secondary"
                        : isBrowserPlayable
                        ? "border-border bg-black text-foreground/90 hover:border-sky-500/50"
                        : isDesktopPlayable
                        ? "border-sky-900/70 bg-sky-950/20 text-foreground/90 hover:border-sky-700"
                        : "border-border bg-card/40 text-muted-foreground opacity-60"
                    }`}
                  >
                    <div
                      onClick={() => {
                        if (isDir && activeLibraryId) {
                          openPath(activeLibraryId, item.relativePath || "/");
                        }
                      }}
                      className={`flex flex-1 items-center gap-2.5 truncate pr-3 ${
                        isDir ? "cursor-pointer" : ""
                      }`}
                    >
                      {isDir ? (
                        <ArtworkThumb posterId={item.posterId} fallback={<Folder className="size-4 text-sky-400" />} />
                      ) : (
                        <ArtworkThumb posterId={item.posterId} fallback={<Film className="size-4 text-muted-foreground" />} />
                      )}
                      <span className={`truncate ${isDir ? "font-medium text-white" : ""}`}>
                        {item.name}
                      </span>
                      {!isDir && isDesktopPlayable && !isBrowserPlayable && (
                        <span className="shrink-0 rounded border border-sky-800 bg-sky-950/40 px-1 py-0.5 text-[9px] text-sky-300">
                          桌面端 / MPV
                        </span>
                      )}
                      {item.relativePath && (
                        <span className="font-mono text-[10px] text-muted-foreground truncate">
                          ({item.relativePath})
                        </span>
                      )}
                      {!isBrowserPlayable && (
                        <span className="rounded border border-border bg-secondary px-1 py-0.5 text-[9px] text-muted-foreground">
                          {item.compatibility.browserReason || "浏览器不承担此媒体格式"}
                        </span>
                      )}
                    </div>

                    {!isDir && isBrowserPlayable && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          size="sm"
                          className="h-7 bg-white px-2 text-[11px] font-semibold text-black hover:bg-primary/90"
                          onClick={() => {
                            onPlayNow(media);
                            handleClose();
                          }}
                        >
                          <Play className="size-3 fill-black" />
                          <span>立即播放</span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px] text-foreground/85"
                          onClick={() => onAddToQueue(media)}
                        >
                          <ListPlus className="size-3" />
                          <span>加入清单</span>
                        </Button>
                      </div>
                    )}

                    {!isDir && isDesktopOnly && (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          className="h-7 bg-sky-500 px-2 text-[11px] font-semibold text-black hover:bg-sky-400"
                          onClick={async () => {
                            if (onPlayOnDesktop) {
                              const accepted = await onPlayOnDesktop(media);
                              if (accepted === false) return;
                            } else {
                              onPlayNow(media);
                            }
                            handleClose();
                          }}
                        >
                          <Tv className="size-3" />
                          <span>{onPlayOnDesktop ? "桌面端播放" : "选择此媒体"}</span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px] text-foreground/85"
                          onClick={() => onAddToQueue(media)}
                        >
                          <ListPlus className="size-3" />
                          <span>加入清单</span>
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}

              {((!isSearching && hasMore) || (isSearching && searchHasMore)) && (
                <div className="pt-2 text-center">
                  <Button
                    variant="outline"
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
                    className="text-foreground/85"
                  >
                    {isLoading ? "正在加载更多..." : "加载更多项目"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
