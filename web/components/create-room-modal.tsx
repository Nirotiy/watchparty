"use client";

import React, { useState } from "react";
import { Lock, X, ArrowRight, AlertCircle, Folder } from "lucide-react";
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-6 shadow-2xl shadow-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Lock className="size-4 text-sky-400" />
            <span>创建专属观影房间</span>
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

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {errorMsg && (
            <div className="flex items-center gap-2 rounded border border-rose-900/50 bg-rose-950/40 p-2.5 text-xs text-rose-300">
              <AlertCircle className="size-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-neutral-400">房主昵称</Label>
            <Input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="例如：Alice"
              maxLength={24}
              required
            />
          </div>

          {/* 初始片源 */}
          <div>
            <label className="block text-xs font-medium text-neutral-400">初始片源 (可选)</label>
            <div className="mt-1.5 flex items-center justify-between rounded border border-neutral-800 bg-black p-2.5 text-xs">
              {selectedMedia ? (
                <div className="flex items-center gap-2 truncate pr-2">
                  <span className="font-medium text-white truncate">
                    {"title" in selectedMedia && selectedMedia.title ? selectedMedia.title : "已选定媒体"}
                  </span>
                  <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-400">
                    {selectedMedia.kind.toUpperCase()}
                  </span>
                </div>
              ) : (
                <span className="text-neutral-500">未选择初始媒体，可在进入房间后点播</span>
              )}
              {onSelectInitialMedia && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onSelectInitialMedia}
                  className="shrink-0"
                >
                  <Folder className="size-3 text-sky-400" />
                  <span>{selectedMedia ? "更改" : "从媒体库选择"}</span>
                </Button>
              )}
            </div>
          </div>

          {/* PIN 码保护选项 */}
          <div className="rounded border border-neutral-800/80 bg-black/60 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="use-pin-toggle" className="text-xs text-neutral-300">启用 4 位数字房间 PIN 码</Label>
              <Checkbox
                id="use-pin-toggle"
                checked={usePin}
                onCheckedChange={(checked) => setUsePin(checked === true)}
                className="accent-sky-500"
              />
            </div>

            {usePin && (
              <div className="space-y-1.5 pt-1">
                <div className="text-[11px] text-neutral-500">
                  开启后，任何访客均需输入此 4 位数字密码方可进入：
                </div>
                <div className="flex gap-2">
                  {pin.map((digit, idx) => (
                    <input
                      key={idx}
                      id={`create-pin-${idx}`}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handlePinChange(idx, e.target.value)}
                      onKeyDown={(e) => handlePinKeyDown(idx, e)}
                      className="size-10 rounded border border-neutral-800 bg-neutral-900 text-center font-mono text-base font-bold text-white outline-none focus:border-sky-500"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isSubmitting}
              className="bg-sky-500 font-semibold text-black hover:bg-sky-400"
            >
              <span>{isSubmitting ? "创建中..." : "立即创建"}</span>
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
