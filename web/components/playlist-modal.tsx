"use client";

import React from "react";
import { ListVideo, Trash2, Play, Plus, X, Layers, ArrowUp, ArrowDown } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[520px] max-h-[90dvh] w-full flex-col gap-0 overflow-hidden border-border bg-card p-5 sm:max-w-lg"
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-border pb-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ListVideo className="size-4 text-sky-400" />
            <span>房间播放清单 (上限 200 项)</span>
            <span className="font-mono text-xs text-muted-foreground">[{playlist.length}/200]</span>
          </DialogTitle>
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
              className="text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* 列表区 */}
        <div className="flex-1 overflow-y-auto pt-3 space-y-1.5">
          {playlist.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-xs text-muted-foreground">
              <Layers className="mb-2 size-6 text-muted-foreground/50" />
              <span>播放清单暂无项目，点击右上角「添加片源」从媒体库中选取</span>
            </div>
          ) : (
            playlist.map((item, idx) => {
              const isCurrent = item.id === currentPlaylistItemId;
              const mediaTitle = "title" in item.media && item.media.title ? item.media.title : `媒体条目 #${idx + 1}`;

              return (
                <div
                  key={item.id}
                  className={`flex items-center justify-between rounded border p-2.5 text-xs transition-colors ${
                    isCurrent
                      ? "border-sky-500/80 bg-sky-950/30 text-white"
                      : "border-border bg-black text-foreground/85 hover:border-ring"
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate pr-3">
                    <span className="font-mono text-[11px] text-muted-foreground">{idx + 1}.</span>
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
                          className="size-6 text-muted-foreground hover:bg-accent hover:text-foreground"
                          disabled={idx === 0}
                          onClick={() => onMoveItem(item.id, idx - 1)}
                          title="上移"
                          aria-label={`上移：${mediaTitle}`}
                        >
                          <ArrowUp className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6 text-muted-foreground hover:bg-accent hover:text-foreground"
                          disabled={idx === playlist.length - 1}
                          onClick={() => onMoveItem(item.id, idx + 1)}
                          title="下移"
                          aria-label={`下移：${mediaTitle}`}
                        >
                          <ArrowDown className="size-3" />
                        </Button>
                      </div>
                    )}

                    {!isCurrent && canControl && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 bg-white text-black hover:bg-primary/90"
                        onClick={() => onPlayItem(item.id)}
                        title="立即切到此项"
                        aria-label={`立即播放：${mediaTitle}`}
                      >
                        <Play className="size-3 fill-black" />
                      </Button>
                    )}
                    {canControl && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 text-muted-foreground hover:bg-accent hover:text-destructive"
                        onClick={() => onRemoveItem(item.id)}
                        title="从清单中移除"
                        aria-label={`移除：${mediaTitle}`}
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
      </DialogContent>
    </Dialog>
  );
}
