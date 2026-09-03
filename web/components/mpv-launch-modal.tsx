"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Tv, X, Copy, Check, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface MpvLaunchModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
  accessToken?: string;
}

type TicketState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; ticket: string; expiresAt: number }
  | { phase: "expired" }
  | { phase: "error"; message: string };

/**
 * “发射到 MPV”：签发一次性交接码（120s TTL，spec 9.2）并展示倒计时。
 * 交接码只展示与复制，不进入 URL、localStorage 或 shell 命令；
 * MPV 侧读取剪贴板或用 script-message 传入。
 */
export function MpvLaunchModal({ isOpen, onClose, roomId, accessToken }: MpvLaunchModalProps) {
  const [state, setState] = useState<TicketState>({ phase: "idle" });
  const [copied, setCopied] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const issue = useCallback(async () => {
    if (!accessToken) return;
    setState({ phase: "loading" });
    setCopied(false);
    try {
      const result = await api.issueHandoffTicket(roomId, accessToken);
      // 以本地收到响应的时刻为倒计时基准（服务端 epoch 与本地钟的微小偏差可接受）
      const remaining = Math.max(0, result.ticketExpiresAt - Date.now());
      setState({ phase: "ready", ticket: result.ticket, expiresAt: Date.now() + remaining });
      setRemainingMs(remaining);
      // 交接码自动进剪贴板：用户只需在 mpv 里按 Ctrl+J
      void navigator.clipboard?.writeText(result.ticket).then(() => setCopied(true)).catch(() => setCopied(false));
    } catch (err) {
      setState({ phase: "error", message: err instanceof Error ? err.message : "签发失败" });
    }
  }, [roomId, accessToken]);

  useEffect(() => {
    if (!isOpen) {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      setState({ phase: "idle" });
      setCopied(false);
      return;
    }
    void issue();
  }, [isOpen, issue]);

  useEffect(() => {
    if (state.phase !== "ready") return;
    tickRef.current = setInterval(() => {
      setRemainingMs((prev) => {
        const next = state.expiresAt - Date.now();
        if (next <= 0) {
          if (tickRef.current) clearInterval(tickRef.current);
          tickRef.current = null;
          setState({ phase: "expired" });
          return 0;
        }
        return next;
      });
    }, 250);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [state.phase, state]);

  if (!isOpen) return null;

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const ready = state.phase === "ready";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-5 shadow-2xl shadow-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Tv className="size-4 text-sky-400" />
            <span>发射到 MPV</span>
          </div>
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

        <div className="mt-4 space-y-3">
          {!accessToken && (
            <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-950/60 p-3 text-xs text-amber-300">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>尚未加入房间，无法签发交接码。</span>
            </div>
          )}

          {state.phase === "loading" && (
            <div className="flex items-center gap-2 p-3 text-xs text-neutral-400">
              <RefreshCw className="size-4 animate-spin" />
              正在生成交接码…
            </div>
          )}

          {state.phase === "error" && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded border border-rose-900/60 bg-rose-950/60 p-3 text-xs text-rose-300">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{state.message}</span>
              </div>
              <Button onClick={() => void issue()} variant="secondary" className="w-full">
                重试
              </Button>
            </div>
          )}

          {state.phase === "expired" && (
            <div className="space-y-3">
              <div className="rounded border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-400">
                交接码已过期。交接码是一次性的，请重新生成后再加入。
              </div>
              <Button onClick={() => void issue()} variant="secondary" className="w-full">
                <RefreshCw className="size-4" />
                重新生成
              </Button>
            </div>
          )}

          {ready && (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-400">
                  {copied ? "交接码已复制到剪贴板" : "交接码（一次性，120 秒内有效）"}
                </span>
                <span className="font-mono tabular-nums text-sky-400">{secondsLeft}s</span>
              </div>
              <div className="break-all rounded border border-neutral-800 bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed text-sky-300 select-all">
                {state.ticket}
              </div>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  void navigator.clipboard?.writeText(state.ticket).then(() => setCopied(true)).catch(() => undefined);
                }}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "已复制" : "复制交接码"}
              </Button>
              <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-neutral-500">
                <li>在目标电脑上用 mpv 加载 watchparty.lua（首次使用需配置 backend_origin）</li>
                <li>保持本页复制的交接码在其剪贴板中，按 Ctrl+J 加入房间</li>
                <li>MPV 会自动播放房间当前媒体并与所有人同步</li>
              </ol>
              <p className="text-[10px] text-neutral-600">
                交接码只能使用一次；过期或已使用后需重新生成。MPV 永远是普通成员，不会获得房主权限。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
