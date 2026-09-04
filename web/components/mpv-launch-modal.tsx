"use client";

import React, { useState, useEffect, useRef } from "react";
import { Tv, X, Copy, Check, RefreshCw, AlertCircle } from "lucide-react";
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
 * “发射到 MPV”：签发一次性交接码（120s TTL，spec 9.2）并展示倒计时。
 * 交接码只展示与复制，不进入 URL、localStorage 或 shell 命令；
 * MPV 侧读取剪贴板或经 IPC socket 传入。
 * 另提供 watchparty://<roomId> 快捷方式复制（阶段 4：已加入过的房间静默恢复）。
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
      .issueHandoffTicket(roomId, accessToken)
      .then((result) => {
        if (cancelled) return;
        // 以本地收到响应的时刻为倒计时基准（服务端 epoch 与本地钟的微小偏差可接受）
        const remaining = Math.max(0, result.ticketExpiresAt - Date.now());
        setState({ phase: "ready", ticket: result.ticket, expiresAt: Date.now() + remaining });
        setRemainingMs(remaining);
        // 交接码自动进剪贴板：用户只需在 mpv 里按 Ctrl+J
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
      className="max-w-md gap-0 border-border bg-card p-5"
      aria-describedby={undefined}
    >
      <div className="flex items-center justify-between border-b border-border pb-3">
        <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Tv className="size-4 text-sky-400" />
          <span>发射到 MPV</span>
        </DialogTitle>
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

      <div className="mt-4 space-y-3">
        {state.phase === "loading" && (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground" aria-live="polite">
            <RefreshCw className="size-4" aria-hidden />
            正在生成交接码…
          </div>
        )}

        {state.phase === "error" && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{state.message}</span>
            </div>
            {accessToken && (
              <Button
                onClick={() => {
                  setState({ phase: "loading" });
                  setCopied(false);
                  setClipboardFailed(false);
                  setIssueNonce((n) => n + 1);
                }}
                variant="outline"
                className="w-full"
              >
                重试
              </Button>
            )}
          </div>
        )}

        {state.phase === "expired" && (
          <div className="space-y-3">
            <div className="rounded border border-border bg-secondary p-3 text-xs text-muted-foreground">
              交接码已过期。交接码是一次性的，请重新生成后再加入。
            </div>
            <Button
              onClick={() => {
                setState({ phase: "loading" });
                setCopied(false);
                setClipboardFailed(false);
                setIssueNonce((n) => n + 1);
              }}
              variant="outline"
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
                {copied ? "交接码已复制到剪贴板" : "交接码（一次性，120 秒内有效）"}
              </span>
              <span className="font-mono tabular-nums text-sky-400">{secondsLeft}s</span>
            </div>
            <div className="break-all rounded border border-border bg-secondary p-3 font-mono text-[11px] leading-relaxed text-sky-300 select-all">
              {state.ticket}
            </div>
            <Button
              variant="default"
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
              <p className="text-[11px] text-amber-400" role="status">
                自动复制失败（可能是非 HTTPS 环境），请手动选中上方交接码复制。
              </p>
            )}
            <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
              <li>在目标电脑上用 mpv 加载 watchparty.lua（首次使用需配置 backend_origin）</li>
              <li>保持本页复制的交接码在其剪贴板中，按 Ctrl+J 加入房间</li>
              <li>MPV 会自动播放房间当前媒体并与所有人同步</li>
            </ol>

            {/* watchparty:// 快捷方式：已加入过的房间可静默恢复（阶段 4） */}
            <div className="rounded border border-border bg-secondary/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-foreground">重新打开此房间</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{watchpartyUrl}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(watchpartyUrl)
                      .then(() => setLinkCopied(true))
                      .catch(() => undefined);
                  }}
                >
                  {linkCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  <span>{linkCopied ? "已复制链接" : "复制快捷方式"}</span>
                </Button>
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                在装好插件的电脑上打开此链接即可恢复连接（URL 只携带房间号，不含交接码）。
              </p>
            </div>

            <p className="text-[10px] text-muted-foreground">
              交接码只能使用一次；过期或已使用后需重新生成。MPV 永远是普通成员，不会获得房主权限。
            </p>
          </>
        )}
      </div>
    </DialogContent>
  );
}
