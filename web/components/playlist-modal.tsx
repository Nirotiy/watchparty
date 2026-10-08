"use client";

import React from "react";
import { Trash2, Play, Plus, X, ArrowUp, ArrowDown } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PlaylistItem } from "@/lib/contracts";
import { cn } from "@/lib/utils";

interface PlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  playlist: PlaylistItem[];
  currentPlaylistItemId?: string;
  onPlayItem: (itemId: string) => void;
  onRemoveItem: (itemId: string) => void;
  onMoveItem: (itemId: string, targetIndex: number) => void;
  onOpenMediaSelector: () => void;
  canPlayItem: boolean;
  canEditQueue: boolean;
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
  canPlayItem,
  canEditQueue,
}: PlaylistModalProps) {
  if (!isOpen) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-[520px] max-h-[90dvh] w-full flex-col gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-lg"
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
          <DialogTitle className="flex items-center gap-2 text-lg font-medium text-foreground">
            <span>播放清单</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">{playlist.length}/200</span>
          </DialogTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              className="h-7 text-xs"
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
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* 列表区 */}
        <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {playlist.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              清单为空
            </div>
          ) : (
            playlist.map((item, idx) => {
              const isCurrent = item.id === currentPlaylistItemId;
              const mediaTitle = "title" in item.media && item.media.title ? item.media.title : `媒体条目 #${idx + 1}`;

              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-sm px-2.5 py-2 text-sm transition-colors",
                    isCurrent ? "bg-muted text-foreground" : "hover:bg-accent",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="shrink-0 font-mono text-xs text-ash">{idx + 1}</span>
                    <span className="truncate">{mediaTitle}</span>
                    {isCurrent && (
                      <span className="shrink-0 rounded-[4px] bg-info-soft px-1.5 text-xs text-info">播放中</span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    {/* 上移 / 下移 */}
                    {canEditQueue && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6 text-muted-foreground hover:text-foreground"
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
                          className="size-6 text-muted-foreground hover:text-foreground"
                          disabled={idx === playlist.length - 1}
                          onClick={() => onMoveItem(item.id, idx + 1)}
                          title="下移"
                          aria-label={`下移：${mediaTitle}`}
                        >
                          <ArrowDown className="size-3" />
                        </Button>
                      </>
                    )}

                    {!isCurrent && canPlayItem && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 text-foreground hover:bg-white/10"
                        onClick={() => onPlayItem(item.id)}
                        title="立即切到此项"
                        aria-label={`立即播放：${mediaTitle}`}
                      >
                        <Play className="size-3" />
                      </Button>
                    )}
                    {canEditQueue && (
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
