"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Folder,
  Film,
  Search,
  X,
  Play,
  ListPlus,
  ChevronRight,
  Link as LinkIcon,

  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import { AllowedOpenListRoot, MediaSource, OpenListItem } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface OpenListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPlayNow: (media: MediaSource) => void;
  onAddToQueue: (media: MediaSource) => void;
  onBatchAdd: (medias: MediaSource[]) => void | Promise<void>;
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
  onAddToQueue,
  onBatchAdd,
}: OpenListModalProps) {
  // 当前根目录与路径
  const [selectedRoot, setSelectedRoot] = useState<AllowedOpenListRoot>("Anime");
  const [currentPath, setCurrentPath] = useState<string>("/");
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);
  const [items, setItems] = useState<OpenListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);

  // 加载与错误状态 (绝对零 mock 降级)
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 搜索态与搜索分页
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeSearchQuery, setActiveSearchQuery] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<OpenListItem[]>([]);
  const [searchHasMore, setSearchHasMore] = useState<boolean>(false);
  const [searchNextCursor, setSearchNextCursor] = useState<string | undefined>(undefined);
  const requestSequenceRef = useRef(0);

  // 直链手动添加模式
  const [isManualUrlMode, setIsManualUrlMode] = useState<boolean>(false);
  const [customUrl, setCustomUrl] = useState<string>("");
  const [customTitle, setCustomTitle] = useState<string>("");

  // 1. 获取目录内容 (真机接口请求，彻底删除 mock fallback)
  const loadDirectory = useCallback(async (root: AllowedOpenListRoot, path: string, cursor?: string) => {
    const requestSequence = ++requestSequenceRef.current;
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.getMediaList(root, path, cursor);
      if (requestSequence !== requestSequenceRef.current) return;
      // 自然排序
      const sorted = [...(res.items || [])].sort((a: OpenListItem, b: OpenListItem) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      );

      if (cursor) {
        setItems((prev) => [...prev, ...sorted]);
      } else {
        setItems(sorted);
      }
      setBreadcrumbs(res.breadcrumbs || []);
      setHasMore(res.hasMore || false);
      setNextCursor(res.nextCursor);
    } catch (err: unknown) {
      if (requestSequence !== requestSequenceRef.current) return;
      const error = err as Error;
      setErrorMsg(error.message || "无法加载媒体目录，请检查网络或后端 Gateway");
      if (!cursor) setItems([]);
    } finally {
      if (requestSequence === requestSequenceRef.current) setIsLoading(false);
    }
  }, []);

  // 2. 执行全局搜索
  const loadSearch = useCallback(async (query: string, root: AllowedOpenListRoot, cursor?: string) => {
    if (!query.trim()) return;
    const requestSequence = ++requestSequenceRef.current;
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res = await api.searchMedia(query.trim(), root, cursor);
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
      const error = err as Error;
      setErrorMsg(error.message || "搜索失败，请稍后重试");
      if (!cursor) setSearchResults([]);
    } finally {
      if (requestSequence === requestSequenceRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const loadTimer = window.setTimeout(() => {
      void loadDirectory(selectedRoot, currentPath);
    }, 0);
    return () => {
      window.clearTimeout(loadTimer);
      requestSequenceRef.current += 1;
    };
  }, [isOpen, selectedRoot, currentPath, loadDirectory]);

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
    setActiveSearchQuery(query);
    setSearchResults([]);
    setSearchHasMore(false);
    setSearchNextCursor(undefined);
    await loadSearch(query, selectedRoot);
  };

  const handleClose = () => {
    clearSearch();
    onClose();
  };

  if (!isOpen) return null;

  const isSearching = activeSearchQuery !== null;
  const displayItems = isSearching ? searchResults : items;

  // 一键入队当前目录全部支持文件
  const handleBatchAddCurrentDir = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const allItems = [...items];
      let cursor = hasMore ? nextCursor : undefined;
      while (cursor && allItems.length < 200) {
        const page = await api.getMediaList(selectedRoot, currentPath, cursor);
        allItems.push(...page.items);
        cursor = page.hasMore ? page.nextCursor : undefined;
      }

      const supported = allItems
      .filter((item) => item.type === "file" && item.compatibility !== "unsupported")
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
      )
      .slice(0, 200)
      .map((it) => ({
        kind: "openlist" as const,
        mediaId: it.id,
        title: it.name,
        container: it.extension || "mp4",
        displayPath: `${selectedRoot}${currentPath}`,
      }));

      if (supported.length > 0) {
        await onBatchAdd(supported);
        handleClose();
      }
    } catch (error: unknown) {
      setErrorMsg(error instanceof Error ? error.message : "批量读取目录失败");
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="flex h-[620px] max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ================= 头部工具条 ================= */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
              <Film className="size-4 text-sky-400" />
              <span>点播媒体库</span>
            </div>

            {/* 根目录 Tab */}
            <div className="flex rounded border border-neutral-800 bg-black p-0.5 text-xs">
              {(["Anime", "Film", "TV Shows"] as AllowedOpenListRoot[]).map((root) => (
                <Button
                  key={root}
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedRoot(root);
                    setCurrentPath("/");
                    clearSearch();
                  }}
                  className={cn(
                    "px-2.5",
                    selectedRoot === root
                      ? "bg-sky-500 font-semibold text-black hover:bg-sky-500 hover:text-black"
                      : "font-normal text-neutral-400 hover:text-white",
                  )}
                >
                  {root === "Anime" ? "番剧 (Anime)" : root === "Film" ? "电影 (Film)" : "剧集 (TV)"}
                </Button>
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsManualUrlMode(!isManualUrlMode)}
              className={cn(
                isManualUrlMode
                  ? "border-sky-500 bg-sky-950/40 text-sky-400"
                  : "bg-black text-neutral-400 hover:text-white",
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
            className="text-neutral-400 hover:bg-neutral-800 hover:text-white"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* 直链输入栏 */}
        {isManualUrlMode && (
          <div className="border-b border-neutral-800 bg-neutral-900/60 p-4 space-y-2.5">
            <div className="text-xs font-semibold text-neutral-300">手动添加外部 HTTPS 直链 / HLS 流</div>
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
        <div className="flex shrink-0 border-b border-neutral-800/80 bg-neutral-900/30 px-5 py-2">
          <form onSubmit={handleSearch} className="flex w-full min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-2.5 top-2 size-3.5 text-neutral-500" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="在当前分类全局搜索..."
                aria-label={`在 ${selectedRoot} 分类中搜索`}
                className="h-8 w-full bg-black pl-8 text-xs"
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={isLoading}
              className="shrink-0 whitespace-nowrap text-neutral-300"
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
                className="shrink-0 whitespace-nowrap text-neutral-400 hover:text-white"
              >
                清除搜索
              </Button>
            )}
          </form>
        </div>

        {/* 面包屑与批量操作 */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800/80 bg-black/40 px-5 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-mono text-neutral-400">
            <Button variant="ghost" size="sm" onClick={() => setCurrentPath("/")} className="h-6 px-1 font-normal hover:text-white">
              <Folder className="size-3 text-sky-400" />
              <span>{selectedRoot}</span>
            </Button>
            {breadcrumbs.map((crumb, idx) => (
              <React.Fragment key={idx}>
                <ChevronRight className="size-3 text-neutral-600" />
                <span className="text-white">{crumb}</span>
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
                  if (activeSearchQuery) {
                    void loadSearch(activeSearchQuery, selectedRoot);
                  } else {
                    void loadDirectory(selectedRoot, currentPath);
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
            <div className="flex h-48 items-center justify-center font-mono text-xs text-neutral-500">
              加载媒体中...
            </div>
          ) : displayItems.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-xs text-neutral-600 space-y-1">
              <span>{isSearching ? `未找到与“${activeSearchQuery}”匹配的媒体文件` : "当前目录为空"}</span>
              {isSearching && (
                <span className="text-[11px] text-neutral-500">
                  如果确认文件存在，请检查 OpenList 是否已启用并构建搜索索引
                </span>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {displayItems.map((item) => {
                const isDir = item.type === "dir";
                const isSupported = item.compatibility !== "unsupported";

                return (
                  <div
                    key={item.id}
                    className={`flex items-center justify-between rounded border p-2.5 text-xs transition ${
                      isDir
                        ? "border-neutral-800/80 bg-neutral-950 hover:border-neutral-700 hover:bg-neutral-900"
                        : isSupported
                        ? "border-neutral-800/60 bg-black text-neutral-200 hover:border-sky-500/50"
                        : "border-neutral-900 bg-neutral-950/40 text-neutral-600 opacity-60"
                    }`}
                  >
                    <div
                      onClick={() => {
                        if (isDir) {
                          setCurrentPath(currentPath === "/" ? `/${item.name}` : `${currentPath}/${item.name}`);
                        }
                      }}
                      className={`flex flex-1 items-center gap-2.5 truncate pr-3 ${
                        isDir ? "cursor-pointer" : ""
                      }`}
                    >
                      {isDir ? (
                        <Folder className="size-4 text-sky-400 shrink-0" />
                      ) : (
                        <Film className="size-4 text-neutral-400 shrink-0" />
                      )}
                      <span className={`truncate ${isDir ? "font-medium text-white" : ""}`}>
                        {item.name}
                      </span>
                      {item.displayPath && (
                        <span className="font-mono text-[10px] text-neutral-600 truncate">
                          ({item.displayPath})
                        </span>
                      )}
                      {!isSupported && (
                        <span className="rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-[9px] text-neutral-500">
                          {item.compatibilityReason || "格式不受支持"}
                        </span>
                      )}
                    </div>

                    {!isDir && isSupported && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          size="sm"
                          className="h-7 bg-white px-2 text-[11px] font-semibold text-black hover:bg-neutral-200"
                          onClick={() => {
                            onPlayNow({
                              kind: "openlist",
                              mediaId: item.id,
                              title: item.name,
                              container: item.extension || "mp4",
                              displayPath: item.displayPath || `${selectedRoot}${currentPath}`,
                            });
                            handleClose();
                          }}
                        >
                          <Play className="size-3 fill-black" />
                          <span>立即播放</span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px] text-neutral-300"
                          onClick={() => {
                            onAddToQueue({
                              kind: "openlist",
                              mediaId: item.id,
                              title: item.name,
                              container: item.extension || "mp4",
                              displayPath: item.displayPath || `${selectedRoot}${currentPath}`,
                            });
                          }}
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
                      if (isSearching) {
                        void loadSearch(activeSearchQuery, selectedRoot, searchNextCursor);
                      } else {
                        void loadDirectory(selectedRoot, currentPath, nextCursor);
                      }
                    }}
                    disabled={isLoading}
                    className="text-neutral-300"
                  >
                    {isLoading ? "正在加载更多..." : "加载更多项目"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
