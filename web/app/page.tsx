"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowRight, Clock, Trash2, KeyRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreateRoomModal } from "@/components/create-room-modal";
import { OpenListModal } from "@/components/openlist-modal";
import { CreateRoomResponse, MediaSource } from "@/lib/contracts";

interface RecentRoom {
  id: string;
  name: string;
  hasPin: boolean;
  lastVisited: number;
}

export default function HomePage() {
  const router = useRouter();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isOpenListSelectorOpen, setIsOpenListSelectorOpen] = useState(false);
  const [initialSelectedMedia, setInitialSelectedMedia] = useState<MediaSource | null>(null);

  const [joinRoomId, setJoinRoomId] = useState("");
  const [history, setHistory] = useState<RecentRoom[]>([]);
  const [mounted, setMounted] = useState(false);

  // 从 localStorage 读取真实历史访问记录 (零 mock)
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
  }, []);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = joinRoomId.trim();
    if (cleanId) {
      router.push(`/room/${encodeURIComponent(cleanId)}`);
    }
  };

  const handleCreateSuccess = (res: CreateRoomResponse) => {
    setIsCreateModalOpen(false);
    // 写入真实历史记录
    const nextItem: RecentRoom = {
      id: res.roomId,
      name: `房间 ${res.roomId}`,
      hasPin: false,
      lastVisited: Date.now(),
    };
    const nextHistory = [nextItem, ...history.filter((h) => h.id !== res.roomId)].slice(0, 10);
    setHistory(nextHistory);
    try {
      localStorage.setItem("watchparty_history", JSON.stringify(nextHistory));
    } catch {
      // 忽略
    }
    router.push(`/room/${encodeURIComponent(res.roomId)}`);
  };

  const handleClearHistory = () => {
    setHistory([]);
    try {
      localStorage.removeItem("watchparty_history");
    } catch {
      // 忽略
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col bg-black font-sans text-white select-none">
      {/* 顶部微型导航 */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-6 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <div className="flex size-5 items-center justify-center rounded bg-white text-black">
            <Sparkles className="size-3" />
          </div>
          <span className="font-bold tracking-tight text-sm text-white">WatchParty</span>
          <span className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            v1.0
          </span>
        </div>
      </header>

      {/* 主体区域 */}
      <main className="flex flex-1 flex-col items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          {/* 主标题区 */}
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              极简 • 毫秒级协同观影
            </h1>
            <p className="text-xs text-muted-foreground">
              原生支持 OpenList 海量媒体索引、HTTPS 直链、YouTube 与 ASS 特效字幕
            </p>
          </div>

          {/* 操作卡片：创建 / 加入 */}
          <div className="rounded-lg border border-border bg-card p-6 space-y-6 shadow-2xl shadow-black">
            {/* 1. 创建房间入口 */}
            <div className="space-y-2">
              <Button
                onClick={() => setIsCreateModalOpen(true)}
                className="w-full bg-white py-2.5 text-xs font-semibold text-black hover:bg-primary/90"
              >
                <Plus className="size-4" />
                <span>创建新的观影房间</span>
              </Button>
            </div>

            <div className="relative flex items-center justify-center">
              <div className="w-full border-t border-border"></div>
              <span className="absolute bg-card px-2 font-mono text-[10px] text-muted-foreground uppercase">
                OR
              </span>
            </div>

            {/* 2. 加入已有房间 */}
            <form onSubmit={handleJoin} className="space-y-3">
              <label className="block text-xs font-medium text-muted-foreground">加入已有房间</label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={joinRoomId}
                  onChange={(e) => setJoinRoomId(e.target.value)}
                  placeholder="输入房号，如：alpha-4"
                  className="flex-1 bg-black font-mono text-xs"
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!joinRoomId.trim()}
                  className="font-semibold"
                >
                  <span>进入</span>
                  <ArrowRight className="size-3.5" />
                </Button>
              </div>
            </form>
          </div>

          {/* 3. 本机访问历史 (仅在有真实历史时展示) */}
          {mounted && history.length > 0 && (
            <div className="rounded-lg border border-border bg-black/80 p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="size-3.5" />
                  <span>本机最近访问</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearHistory}
                  className="text-[11px] text-muted-foreground hover:text-rose-400"
                >
                  <Trash2 className="size-3" />
                  <span>清除历史</span>
                </Button>
              </div>

              <div className="space-y-1.5">
                {history.map((room) => (
                  <Button
                    key={room.id}
                    variant="outline"
                    onClick={() => router.push(`/room/${encodeURIComponent(room.id)}`)}
                    className="w-full justify-between border-border bg-card/80 p-2 text-xs font-normal text-foreground/85 hover:border-border hover:text-white"
                  >
                    <span className="flex items-center gap-2 font-mono">
                      <span className="text-white">{room.name || room.id}</span>
                      {room.hasPin && <KeyRound className="size-3 text-amber-500/80" />}
                    </span>
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {new Date(room.lastVisited).toLocaleDateString()}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 创建房间 Pop-up 弹窗 */}
      <CreateRoomModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleCreateSuccess}
        onSelectInitialMedia={() => setIsOpenListSelectorOpen(true)}
        selectedMedia={initialSelectedMedia}
      />

      {/* 创建房间时的媒体库点播弹窗 */}
      <OpenListModal
        isOpen={isOpenListSelectorOpen}
        onClose={() => setIsOpenListSelectorOpen(false)}
        onPlayNow={(media) => {
          setInitialSelectedMedia(media);
          setIsOpenListSelectorOpen(false);
        }}
        onAddToQueue={(media) => {
          setInitialSelectedMedia(media);
          setIsOpenListSelectorOpen(false);
        }}
        onBatchAdd={(medias) => {
          if (medias.length > 0) {
            setInitialSelectedMedia(medias[0]);
          }
          setIsOpenListSelectorOpen(false);
        }}
      />
    </div>
  );
}
