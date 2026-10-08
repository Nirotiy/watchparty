"use client";

import React, { useState, useEffect, useRef } from "react";
import { X, Copy, Check, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface MpvLaunchModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
  accessToken?: string;
}

type TicketState =
  | { phase: "loading" }
  | { phase: "ready"; ticket: string; expiresAt: number }
  | { phase: "expired" }
  | { phase: "error"; message: string };

/**
 * “桌面播放”：签发 Tauri 一次性交接码（5 分钟 TTL）并展示倒计时。
 * 交接码只展示与复制，不进入 URL、localStorage 或 shell 命令；
 * Tauri 只通过 watchparty://<roomId> 接收公开 roomId，再由用户粘贴交接码。
 *
 * 状态承载在仅打开时挂载的内部组件上：重新打开即全新签发，无需重置 effect。
 */
export function MpvLaunchModal({ isOpen, onClose, roomId, accessToken }: MpvLaunchModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {isOpen && (
        <MpvLaunchContent roomId={roomId} accessToken={accessToken} onClose={onClose} />
      )}
    </Dialog>
  );
}

function MpvLaunchContent({
  roomId,
  accessToken,
  onClose,
}: {
  roomId: string;
  accessToken?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<TicketState>(
    accessToken ? { phase: "loading" } : { phase: "error", message: "尚未加入房间，无法签发交接码。" },
  );
  const [issueNonce, setIssueNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  const [clipboardFailed, setClipboardFailed] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 签发交接码；仅在异步回调中更新状态（组件挂载即视为 loading）。
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    api
      .issueHandoffTicket(roomId, accessToken, "desktop")
      .then((result) => {
        if (cancelled) return;
        // 以本地收到响应的时刻为倒计时基准（服务端 epoch 与本地钟的微小偏差可接受）
        const remaining = Math.max(0, result.ticketExpiresAt - Date.now());
        setState({ phase: "ready", ticket: result.ticket, expiresAt: Date.now() + remaining });
        setRemainingMs(remaining);
        // 交接码自动进剪贴板，URL scheme 始终只携带公开 roomId。
        void navigator.clipboard
          ?.writeText(result.ticket)
          .then(() => !cancelled && setCopied(true))
          .catch(() => !cancelled && setClipboardFailed(true));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ phase: "error", message: err instanceof Error ? err.message : "签发失败" });
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, accessToken, issueNonce]);

  // 倒计时：interval 外部系统节拍，到点进入 expired 并停表。
  const ticketExpiresAt = state.phase === "ready" ? state.expiresAt : null;
  useEffect(() => {
    if (ticketExpiresAt === null) return;
    tickRef.current = setInterval(() => {
      const next = ticketExpiresAt - Date.now();
      if (next <= 0) {
        if (tickRef.current) clearInterval(tickRef.current);
        tickRef.current = null;
        setState({ phase: "expired" });
        setRemainingMs(0);
        return;
      }
      setRemainingMs(next);
    }, 250);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [ticketExpiresAt]);

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const ready = state.phase === "ready";
  const watchpartyUrl = `watchparty://${roomId}`;

  return (
    <DialogContent
      showCloseButton={false}
      className="max-w-md gap-0 border-border bg-card p-0"
      aria-describedby={undefined}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
        <DialogTitle className="text-lg font-medium text-foreground">在桌面端播放</DialogTitle>
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

      <div className="space-y-3 px-4 py-4">
        {state.phase === "loading" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <span className="size-1.5 rounded-full bg-warn" />
            正在生成交接码…
          </p>
        )}

        {state.phase === "error" && (
          <div className="space-y-3">
            <p className="flex items-start gap-2 text-sm text-destructive" role="alert" aria-live="polite">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" />
              <span className="break-words">{state.message}</span>
            </p>
            {accessToken && (
              <Button
                onClick={() => {
                  setState({ phase: "loading" });
                  setCopied(false);
                  setClipboardFailed(false);
                  setIssueNonce((n) => n + 1);
                }}
                variant="secondary"
                className="w-full"
              >
                重试
              </Button>
            )}
          </div>
        )}

        {state.phase === "expired" && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <span className="size-1.5 rounded-full bg-warn" />
              交接码已过期
            </p>
            <Button
              onClick={() => {
                setState({ phase: "loading" });
                setCopied(false);
                setClipboardFailed(false);
                setIssueNonce((n) => n + 1);
              }}
              variant="secondary"
              className="w-full"
            >
              <RefreshCw className="size-4" />
              重新生成
            </Button>
          </div>
        )}

        {ready && (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground" aria-live="polite">
                {copied ? "交接码已复制到剪贴板" : "交接码 · 一次性 · 5 分钟内有效"}
              </span>
              <span className="font-mono tabular-nums text-foreground/80">{secondsLeft}s</span>
            </div>
            <div className="break-all rounded-md border border-border bg-muted p-3 font-mono text-[13px] leading-relaxed text-foreground/90 select-all">
              {state.ticket}
            </div>
            <Button
              className="w-full"
              onClick={() => {
                window.location.href = watchpartyUrl;
              }}
            >
              打开桌面端
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(state.ticket)
                  .then(() => {
                    setCopied(true);
                    setClipboardFailed(false);
                  })
                  .catch(() => setClipboardFailed(true));
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "已复制" : "复制交接码"}
            </Button>
            {clipboardFailed && (
              <p className="text-xs text-warn" role="status">
                自动复制失败（可能是非 HTTPS 环境），请手动选中上方交接码复制
              </p>
            )}

            {/* Tauri 是 watchparty:// 的唯一协议处理器。 */}
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{watchpartyUrl}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(watchpartyUrl)
                    .then(() => setLinkCopied(true))
                    .catch(() => undefined);
                }}
              >
                {linkCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                <span>{linkCopied ? "已复制" : "复制"}</span>
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              只含房号，不含交接码。桌面端始终是普通成员，不会获得房主权限。
            </p>
          </>
        )}
      </div>
    </DialogContent>
  );
}
