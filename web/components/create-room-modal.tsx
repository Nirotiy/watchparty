"use client";

import React, { useState, useEffect } from "react";
import { X, ArrowRight, Folder } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { CreateRoomResponse, MediaSource } from "@/lib/contracts";

interface CreateRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (res: CreateRoomResponse) => void;
  onSelectInitialMedia?: () => void;
  selectedMedia?: MediaSource | null;
}

export function CreateRoomModal({
  isOpen,
  onClose,
  onSuccess,
  onSelectInitialMedia,
  selectedMedia,
}: CreateRoomModalProps) {
  const [nickname, setNickname] = useState("");
  const [usePin, setUsePin] = useState(false);
  const [pin, setPin] = useState(["", "", "", ""]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 常驻昵称：打开时默认带上次用过的昵称（与门禁同源 watchparty_last_nickname）。
  useEffect(() => {
    if (!isOpen) return;
    try {
      const saved = localStorage.getItem("watchparty_last_nickname");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setNickname((current) => (current ? current : saved));
    } catch {
      // 忽略存储失败
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handlePinChange = (idx: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...pin];
    next[idx] = val.slice(-1);
    setPin(next);
    if (val && idx < 3) {
      const nextInput = document.getElementById(`create-pin-${idx + 1}`);
      nextInput?.focus();
    }
  };

  // 粘贴完整 4 位 PIN：分发到各格
  const handlePinPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 4).split("");
    if (digits.length === 0) return;
    const next = ["", "", "", ""];
    digits.forEach((d, i) => {
      next[i] = d;
    });
    setPin(next);
    document.getElementById(`create-pin-${Math.min(digits.length, 3)}`)?.focus();
  };

  const handlePinKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !pin[idx] && idx > 0) {
      const prevInput = document.getElementById(`create-pin-${idx - 1}`);
      prevInput?.focus();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) {
      setErrorMsg("请输入您的昵称");
      return;
    }

    let pinStr: string | undefined = undefined;
    if (usePin) {
      pinStr = pin.join("");
      if (pinStr.length !== 4) {
        setErrorMsg("请输入完整的 4 位数字房间 PIN 码");
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    // 获取稳定 clientId
    let clientId = localStorage.getItem("watchparty_client_id");
    if (!clientId) {
      clientId = crypto.randomUUID();
      localStorage.setItem("watchparty_client_id", clientId);
    }

    try {
      const res = await api.createRoom({
        clientId,
        nickname: nickname.trim(),
        pin: pinStr,
        initialMedia: selectedMedia || undefined,
      });

      // 保存用户在此房间的访问凭据和房主身份
      localStorage.setItem(`token_${res.roomId}`, res.accessToken);
      if (res.ownerToken) {
        localStorage.setItem(`owner_${res.roomId}`, res.ownerToken);
      }
      localStorage.setItem("watchparty_last_nickname", nickname.trim());

      onSuccess(res);
    } catch (err: unknown) {
      const error = err as Error;
      setErrorMsg(error.message || "创建房间失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md gap-0 border-border bg-card p-0"
        aria-describedby={undefined}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
          <DialogTitle className="text-lg font-medium text-foreground">创建房间</DialogTitle>
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

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 px-4 py-4">
            {errorMsg && (
              <p
                className="flex items-center gap-2 text-sm text-destructive"
                role="alert"
                aria-live="polite"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
                <span>{errorMsg}</span>
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="owner-nickname" className="text-[13px] font-normal text-foreground/80">
                房主昵称
              </Label>
              <Input
                id="owner-nickname"
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="例如：Alice"
                maxLength={24}
                required
                className="text-sm"
              />
            </div>

            {/* 初始片源 */}
            <div className="space-y-1.5">
              <span id="initial-media-label" className="block text-[13px] text-foreground/80">
                初始片源 · 可选
              </span>
              <div className="flex items-center justify-between gap-2" aria-labelledby="initial-media-label">
                {selectedMedia ? (
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="truncate">
                      {"title" in selectedMedia && selectedMedia.title ? selectedMedia.title : "已选定媒体"}
                    </span>
                    <span className="shrink-0 rounded-[4px] bg-info-soft px-1.5 py-0.5 font-mono text-xs text-info">
                      {selectedMedia.kind.toUpperCase()}
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-ash">未选择</span>
                )}
                {onSelectInitialMedia && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onSelectInitialMedia}
                    className="shrink-0 text-xs"
                  >
                    <Folder className="size-3" />
                    <span>{selectedMedia ? "更改" : "从媒体库选择"}</span>
                  </Button>
                )}
              </div>
            </div>

            {/* PIN 码保护 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="use-pin-toggle" className="text-[13px] font-normal text-foreground/80">
                  启用 4 位 PIN 保护
                </Label>
                <Checkbox
                  id="use-pin-toggle"
                  checked={usePin}
                  onCheckedChange={(checked) => setUsePin(checked === true)}
                />
              </div>

              {usePin && (
                <div className="flex gap-2" role="group" aria-label="房间 PIN 码">
                  {pin.map((digit, idx) => (
                    <input
                      key={idx}
                      id={`create-pin-${idx}`}
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={1}
                      value={digit}
                      aria-label={`PIN 码第 ${idx + 1} 位`}
                      onChange={(e) => handlePinChange(idx, e.target.value)}
                      onKeyDown={(e) => handlePinKeyDown(idx, e)}
                      onPaste={handlePinPaste}
                      className="size-10 rounded-md border border-input bg-field text-center font-mono text-base font-bold text-foreground outline-none transition-colors focus:border-ring"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground hover:text-foreground">
              取消
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              <span>{isSubmitting ? "创建中…" : "立即创建"}</span>
              {!isSubmitting && (
                <span
                  aria-hidden="true"
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-white/30 bg-white/15 px-1.5 text-xs text-white/85 dark:border-black/30 dark:bg-[#151515] dark:text-[#f4f4f6]"
                >
                  ⏎
                </span>
              )}
              {isSubmitting && <ArrowRight className="size-3.5" />}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
