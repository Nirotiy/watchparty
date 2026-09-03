"use client";

import React from "react";
import { ListVideo, Trash2, Play, Plus, X, Layers, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlaylistItem } from "@/lib/contracts";

interface PlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  playlist: PlaylistItem[];
  currentPlaylistItemId?: string;
  onPlayItem: (itemId: string) => void;
  onRemoveItem: (itemId: string) => void;
  onMoveItem: (itemId: string, targetIndex: number) => void;
  onOpenMediaSelector: () => void;
  isLocked: boolean;
  isOwner: boolean;
}

export function PlaylistModal({
  isOpen,
  onClose,
  playlist,
  currentPlaylistItemId,
  onPlayItem,
  onRemoveItem,
  onMoveItem,
  onOpenMediaSelector,
  isLocked,
  isOwner,
}: PlaylistModalProps) {
  if (!isOpen) return null;

  const canControl = !isLocked || isOwner;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[520px] max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-5 shadow-2xl shadow-black"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <ListVideo className="size-4 text-sky-400" />
            <span>房间播放清单 (上限 200 项)</span>
            <span className="font-mono text-xs text-neutral-500">[{playlist.length}/200]</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onClose();
                onOpenMediaSelector();
              }}
            >
              <Plus className="size-3" />
              <span>添加片源</span>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="关闭"
              className="text-neutral-400 hover:bg-neutral-800 hover:text-white"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* 列表区 */}
        <div className="flex-1 overflow-y-auto pt-3 space-y-1.5">
          {playlist.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-xs text-neutral-600">
              <Layers className="mb-2 size-6 text-neutral-700" />
              <span>播放清单暂无项目，点击右上角「添加片源」从媒体库中选取</span>
            </div>
          ) : (
            playlist.map((item, idx) => {
              const isCurrent = item.id === currentPlaylistItemId;
              const mediaTitle = "title" in item.media && item.media.title ? item.media.title : `媒体条目 #${idx + 1}`;

              return (
                <div
                  key={item.id}
                  className={`flex items-center justify-between rounded border p-2.5 text-xs transition ${
                    isCurrent
                      ? "border-sky-500/80 bg-sky-950/30 text-white"
                      : "border-neutral-800/80 bg-black text-neutral-300 hover:border-neutral-700"
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate pr-3">
                    <span className="font-mono text-[11px] text-neutral-500">{idx + 1}.</span>
                    <span className="truncate font-medium">{mediaTitle}</span>
                    {isCurrent && (
                      <span className="rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[9px] font-bold text-sky-400">
                        PLAYING
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* 上移 / 下移 */}
                    {canControl && (
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6 text-neutral-500 hover:bg-neutral-800 hover:text-white"
                          disabled={idx === 0}
                          onClick={() => onMoveItem(item.id, idx - 1)}
                          title="上移"
                        >
                          <ArrowUp className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6 text-neutral-500 hover:bg-neutral-800 hover:text-white"
                          disabled={idx === playlist.length - 1}
                          onClick={() => onMoveItem(item.id, idx + 1)}
                          title="下移"
                        >
                          <ArrowDown className="size-3" />
                        </Button>
                      </div>
                    )}

                    {!isCurrent && canControl && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 bg-white text-black hover:bg-neutral-200"
                        onClick={() => onPlayItem(item.id)}
                        title="立即切到此项"
                      >
                        <Play className="size-3 fill-black" />
                      </Button>
                    )}
                    {canControl && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 text-neutral-500 hover:bg-neutral-800 hover:text-rose-400"
                        onClick={() => onRemoveItem(item.id)}
                        title="从清单中移除"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
