"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { CircleHelp, Lock, Moon, Sun, X } from "lucide-react";
import { api } from "@/lib/api";
import { storeTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Keycap } from "@/components/ui/keycap";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CreateRoomModal } from "@/components/create-room-modal";
import { OpenListModal } from "@/components/openlist-modal";
import { CreateRoomResponse, MediaSource } from "@/lib/contracts";
import { cn } from "@/lib/utils";

interface RecentRoom {
  id: string;
  name: string;
  hasPin: boolean;
  lastVisited: number;
}

/** 播放器侧写入（q10a），大厅只读渲染；字段说明见 temp-html/lobby-local-data-contract-2026-10-08.md。 */
interface ContinueEntry {
  roomId: string;
  mediaTitle: string;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}

type StatusState = "probing" | "ok" | "no-media" | "down";

/** 接受房号，或整段邀请链接（/room/<id>、watchparty://<id>）。 */
function parseRoomInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const pathMatch = trimmed.match(/\/room\/([^/?#\s]+)/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  const schemeMatch = trimmed.match(/^watchparty:\/\/([^/?#\s]+)/);
  if (schemeMatch) return decodeURIComponent(schemeMatch[1]);
  return trimmed;
}

function formatVisited(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

/** 读本机继续观看记录（播放器侧写入）；坏数据一律丢弃，不做 mock 兜底。 */
function parseContinueList(raw: string | null): ContinueEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const list: ContinueEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item.roomId !== "string" || typeof item.mediaTitle !== "string") continue;
      if (typeof item.positionSeconds !== "number" || typeof item.durationSeconds !== "number" || typeof item.updatedAt !== "number") continue;
      if (seen.has(item.roomId)) continue;
      seen.add(item.roomId);
      list.push(item as ContinueEntry);
      if (list.length >= 12) break;
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function saveHistory(list: RecentRoom[]) {
  try {
    localStorage.setItem("watchparty_history", JSON.stringify(list));
  } catch {
    // 忽略存储失败
  }
}

const CONTINUE_TINTS = [
  "bg-[linear-gradient(150deg,#3b2b45,#7a5b8f)]",
  "bg-[linear-gradient(150deg,#233247,#41598c)]",
  "bg-[linear-gradient(150deg,#1f3a34,#3f7566)]",
  "bg-[linear-gradient(150deg,#3a2a24,#7a5648)]",
  "bg-[linear-gradient(150deg,#3d3524,#77683f)]",
];

function tintOf(roomId: string): string {
  let hash = 2166136261;
  for (const ch of roomId) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return CONTINUE_TINTS[hash % CONTINUE_TINTS.length];
}

export default function HomePage() {
  const router = useRouter();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isBrowseOpen, setIsBrowseOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isLibraryFullPage, setIsLibraryFullPage] = useState(false);
  const [initialSelectedMedia, setInitialSelectedMedia] = useState<MediaSource | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  const [joinInput, setJoinInput] = useState("");
  const [history, setHistory] = useState<RecentRoom[]>([]);
  const [continueList, setContinueList] = useState<ContinueEntry[]>([]);
  const [mounted, setMounted] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [status, setStatus] = useState<StatusState>("probing");
  const [probeTick, setProbeTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 从 localStorage 读取真实记录 (零 mock)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    try {
      const stored = localStorage.getItem("watchparty_history");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setHistory(parsed.filter((item): item is RecentRoom => item && typeof item.id === "string"));
        }
      }
    } catch {
      // 忽略解析失败
    }
    setContinueList(parseContinueList(localStorage.getItem("watchparty_continue")));
  }, []);

  useEffect(() => {
    if (mounted) inputRef.current?.focus();
  }, [mounted]);

  // 服务状态点：只探测后端可达性/媒体库能力位；失败不阻塞页面（加入/建房本来就需要后端）。
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setStatus((current) => (current === "probing" ? "down" : current));
    }, 5000);
    api
      .getMediaCapabilities()
      .then((capabilities) => {
        if (!cancelled) setStatus(capabilities.libraries ? "ok" : "no-media");
      })
      .catch(() => {
        if (!cancelled) setStatus("down");
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [probeTick]);

  const openRoom = (roomId: string) => {
    if (!roomId) return;
    router.push(`/room/${encodeURIComponent(roomId)}`);
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    openRoom(parseRoomInput(joinInput));
  };

  const visibleContinue = continueList.slice(0, 3);
  // 键盘导航：继续观看在前、最近访问在后，合成一条序列（与视觉顺序一致）。
  const navRooms = [...visibleContinue.map((entry) => entry.roomId), ...history.map((room) => room.id)];

  const handleJoinInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (joinInput.trim() || navRooms.length === 0) return;
      e.preventDefault();
      setSelectedIndex((prev) => {
        const next = e.key === "ArrowDown" ? prev + 1 : prev - 1;
        return Math.max(0, Math.min(next, navRooms.length - 1));
      });
      return;
    }
    if (e.key === "Enter" && !joinInput.trim() && selectedIndex >= 0 && navRooms[selectedIndex]) {
      e.preventDefault();
      openRoom(navRooms[selectedIndex]);
      return;
    }
    if (e.key === "Escape") {
      setJoinInput("");
      setSelectedIndex(-1);
    }
  };

  const handleCreateSuccess = (res: CreateRoomResponse) => {
    setIsCreateModalOpen(false);
    setInitialSelectedMedia(null);
    const nextItem: RecentRoom = {
      id: res.roomId,
      name: `房间 ${res.roomId}`,
      hasPin: false,
      lastVisited: Date.now(),
    };
    const nextHistory = [nextItem, ...history.filter((h) => h.id !== res.roomId)].slice(0, 10);
    setHistory(nextHistory);
    saveHistory(nextHistory);
    router.push(`/room/${encodeURIComponent(res.roomId)}`);
  };

  const removeRecent = (roomId: string) => {
    const nextHistory = history.filter((room) => room.id !== roomId);
    setHistory(nextHistory);
    setSelectedIndex(-1);
    saveHistory(nextHistory);
  };

  const handleClearHistory = () => {
    setHistory([]);
    setSelectedIndex(-1);
    try {
      localStorage.removeItem("watchparty_history");
    } catch {
      // 忽略
    }
  };

  const removeContinue = (roomId: string) => {
    const nextList = continueList.filter((entry) => entry.roomId !== roomId);
    setContinueList(nextList);
    setSelectedIndex(-1);
    try {
      localStorage.setItem("watchparty_continue", JSON.stringify(nextList));
    } catch {
      // 忽略
    }
  };

  const handleClearContinue = () => {
    setContinueList([]);
    setSelectedIndex(-1);
    try {
      localStorage.removeItem("watchparty_continue");
    } catch {
      // 忽略
    }
  };

  // 选中片源 = 带着它去建房（浏览/建房选片两条入口共用同一语义）。
  const selectMediaForRoom = (media: MediaSource) => {
    setInitialSelectedMedia(media);
    setIsBrowseOpen(false);
    setIsPickerOpen(false);
    setIsCreateModalOpen(true);
  };

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background font-sans text-foreground">
      {/* 顶行：wordmark ＋ 键盘速查 ＋ 创建房间（次级；浏览片源是主入口） */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-2">
          <img src="/banguru-logo.svg" alt="" className="size-5" />
          <span className="text-sm font-medium tracking-tight">Banguru</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="切换亮/暗主题"
            onClick={() => storeTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")}
          >
            <Moon className="size-4 dark:hidden" />
            <Sun className="hidden size-4 dark:block" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="键盘速查" onClick={() => setIsHelpOpen(true)}>
            <CircleHelp className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setInitialSelectedMedia(null);
              setIsCreateModalOpen(true);
            }}
          >
            创建房间
          </Button>
        </div>
      </header>

      <main className="flex flex-1 justify-center overflow-y-auto px-6">
        <div className="w-full max-w-2xl pt-16 pb-12">
          {/* launcher：输入行（入房）＋ 主行动（浏览片源） */}
          <form onSubmit={handleJoin} className="flex items-stretch gap-2 max-sm:flex-col">
            <div className="relative flex-1">
              <input
                ref={inputRef}
                type="text"
                value={joinInput}
                onChange={(e) => {
                  setJoinInput(e.target.value);
                  setSelectedIndex(-1);
                }}
                onKeyDown={handleJoinInputKeyDown}
                placeholder="输入房号，或粘贴邀请链接"
                aria-label="房号或邀请链接"
                className="h-10 w-full rounded-md border border-input bg-field px-3 pr-12 font-mono text-sm text-foreground outline-none transition-colors placeholder:font-sans placeholder:text-ash focus:border-ring"
              />
              <Keycap className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">⏎</Keycap>
            </div>
            <Button type="button" size="lg" className="px-5" onClick={() => setIsBrowseOpen(true)}>
              浏览片源
            </Button>
          </form>

          {/* 继续观看：行式 + 细进度条（播放器侧写入，空则整块隐藏） */}
          {mounted && visibleContinue.length > 0 && (
            <section className="mt-8">
              <div className="flex items-center justify-between px-2">
                <span className="text-xs text-muted-foreground">继续观看</span>
                <button
                  type="button"
                  onClick={handleClearContinue}
                  className="text-xs text-ash transition-colors hover:text-foreground"
                >
                  清除
                </button>
              </div>
              <ul className="mt-1.5">
                {visibleContinue.map((entry, index) => {
                  const percent =
                    entry.durationSeconds > 0
                      ? Math.max(0, Math.min(100, Math.round((entry.positionSeconds / entry.durationSeconds) * 100)))
                      : null;
                  return (
                    <li key={entry.roomId} className="relative">
                      <div
                        className={cn(
                          "group relative flex w-full items-center justify-between gap-3 rounded-md px-2 py-2",
                          selectedIndex === index ? "bg-muted" : "hover:bg-accent",
                        )}
                      >
                        <button
                          type="button"
                          className="absolute inset-0 rounded-md outline-none focus-visible:border focus-visible:border-ring"
                          aria-label={`进入 ${entry.roomId}`}
                          onClick={() => openRoom(entry.roomId)}
                          onMouseEnter={() => setSelectedIndex(index)}
                        />
                        <span className="pointer-events-none relative flex min-w-0 items-center gap-2.5">
                          <span className={cn("h-[45px] w-[30px] shrink-0 rounded-[4px] border border-border", tintOf(entry.roomId))} />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{entry.mediaTitle}</span>
                            <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="font-mono">{entry.roomId}</span>
                              <span>· 上次 {formatVisited(entry.updatedAt)}</span>
                            </span>
                          </span>
                        </span>
                        <span className="pointer-events-none relative flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                          {percent !== null && (
                            <>
                              <span className="h-1 w-24 overflow-hidden rounded-full bg-foreground/10">
                                <span className="block h-full rounded-full bg-foreground" style={{ width: `${percent}%` }} />
                              </span>
                              <span className="font-mono">{percent}%</span>
                            </>
                          )}
                          {selectedIndex === index && <Keycap>⏎</Keycap>}
                        </span>
                        <button
                          type="button"
                          aria-label={`删除 ${entry.roomId} 的观看记录`}
                          onClick={() => removeContinue(entry.roomId)}
                          className="relative flex size-5 shrink-0 items-center justify-center rounded text-ash opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* 最近访问：↑↓ 选择，⏎ 进入 */}
          {mounted && history.length > 0 && (
            <section className="mt-8">
              <div className="flex items-center justify-between px-2">
                <span className="text-xs text-muted-foreground">最近访问</span>
                <button
                  type="button"
                  onClick={handleClearHistory}
                  className="text-xs text-ash transition-colors hover:text-foreground"
                >
                  清除
                </button>
              </div>
              <ul className="mt-1.5">
                {history.map((room, index) => {
                  const navIndex = visibleContinue.length + index;
                  return (
                    <li key={room.id} className="relative">
                      <div
                        className={cn(
                          "group relative flex w-full items-center justify-between gap-3 rounded-md px-2 py-2",
                          selectedIndex === navIndex ? "bg-muted" : "hover:bg-accent",
                        )}
                      >
                        <button
                          type="button"
                          className="absolute inset-0 rounded-md outline-none focus-visible:border focus-visible:border-ring"
                          aria-label={`进入 ${room.id}`}
                          onClick={() => openRoom(room.id)}
                          onMouseEnter={() => setSelectedIndex(navIndex)}
                        />
                        <span className="pointer-events-none relative flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-sm">{room.id}</span>
                          {room.hasPin && <Lock className="size-3 shrink-0 text-muted-foreground" />}
                        </span>
                        <span className="pointer-events-none relative flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                          <span>{formatVisited(room.lastVisited)}</span>
                          {selectedIndex === navIndex && <Keycap>⏎</Keycap>}
                        </span>
                        <button
                          type="button"
                          aria-label={`删除 ${room.id}`}
                          onClick={() => removeRecent(room.id)}
                          className="relative flex size-5 shrink-0 items-center justify-center rounded text-ash opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* 状态行：点 + 文字；异常同位置展开细节 */}
          <div className="mt-10 flex min-h-5 items-center gap-2.5 px-2 text-xs text-muted-foreground" role="status">
            {status === "probing" && (
              <>
                <span className="size-1.5 rounded-full bg-stone" aria-hidden="true" />
                <span>检查中</span>
              </>
            )}
            {status === "ok" && (
              <>
                <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
                <span>服务正常</span>
              </>
            )}
            {status === "no-media" && (
              <>
                <span className="size-1.5 rounded-full bg-warn" aria-hidden="true" />
                <span>媒体库未配置</span>
              </>
            )}
            {status === "down" && (
              <>
                <span className="size-1.5 rounded-full bg-destructive" aria-hidden="true" />
                <span>无法连接后端</span>
                <button
                  type="button"
                  className="text-ash transition-colors hover:text-foreground"
                  onClick={() => {
                    setStatus("probing");
                    setProbeTick((tick) => tick + 1);
                  }}
                >
                  重试
                </button>
              </>
            )}
          </div>
        </div>
      </main>

      {/* 创建房间 Pop-up 弹窗 */}
      <CreateRoomModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleCreateSuccess}
        onSelectInitialMedia={() => setIsPickerOpen(true)}
        selectedMedia={initialSelectedMedia}
      />

      {/* 媒体库：浏览片源（房外只读）＋ 建房选片，共用同一实例 */}
      <OpenListModal
        isOpen={isBrowseOpen || isPickerOpen}
        onClose={() => {
          setIsBrowseOpen(false);
          setIsPickerOpen(false);
        }}
        roomless
        fullPage={isLibraryFullPage}
        onToggleFullPage={() => setIsLibraryFullPage((value) => !value)}
        onPlayNow={selectMediaForRoom}
        onAddToQueue={selectMediaForRoom}
        onBatchAdd={(medias) => {
          if (medias.length > 0) {
            selectMediaForRoom(medias[0]);
          }
        }}
      />

      {/* 键盘速查 */}
      <Dialog open={isHelpOpen} onOpenChange={setIsHelpOpen}>
        <DialogContent className="max-w-sm">
          <DialogTitle>键盘</DialogTitle>
          <div className="space-y-0.5">
            {[
              { label: "移动选择", keys: ["↑", "↓"] },
              { label: "进入", keys: ["⏎"] },
              { label: "清空输入", keys: ["Esc"] },
              { label: "本面板", keys: ["?"] },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm">
                <span>{row.label}</span>
                <span className="flex items-center gap-1">
                  {row.keys.map((key) => (
                    <Keycap key={key}>{key}</Keycap>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
