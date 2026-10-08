"use client";

import React, { useState, useEffect, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { applyTheme, resolveTheme } from "@/lib/theme";
import RoomPlayer from "@/components/room-player";

interface RoomPageProps {
  params: Promise<{ id: string }>;
}

/** 门禁成功（含输码/链接入房）即写一次到访：大厅"最近访问"的数据源。 */
function recordRoomVisit(roomId: string, hasPin: boolean) {
  try {
    const stored = localStorage.getItem("watchparty_history");
    const parsed = stored ? JSON.parse(stored) : [];
    const list = Array.isArray(parsed)
      ? parsed.filter((item): item is { id: string; name?: string; hasPin?: boolean; lastVisited?: number } => Boolean(item) && typeof item.id === "string")
      : [];
    const existing = list.find((item) => item.id === roomId);
    const nextItem = {
      id: roomId,
      name: existing?.name ?? `房间 ${roomId}`,
      hasPin: hasPin || existing?.hasPin === true,
      lastVisited: Date.now(),
    };
    const next = [nextItem, ...list.filter((item) => item.id !== roomId)].slice(0, 10);
    localStorage.setItem("watchparty_history", JSON.stringify(next));
  } catch {
    // 忽略存储失败
  }
}

export default function DynamicRoomPage({ params }: RoomPageProps) {
  const resolvedParams = use(params);
  const roomId = resolvedParams.id;
  const router = useRouter();

  // 状态流转: checking -> need_auth | ready | not_found | error
  const [pageState, setPageState] = useState<"checking" | "need_auth" | "ready" | "not_found" | "error">("checking");
  const [recheckNonce, setRecheckNonce] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nickname, setNickname] = useState("");
  const [pinDigits, setPinDigits] = useState(["", "", "", ""]);
  const [isVerifying, setIsVerifying] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [cachedToken, setCachedToken] = useState<string | null>(null);

  // 播放器面恒黑：房间 ready 时在 html 上钉 .dark（弹窗 portal 到 body 也一并覆盖）；
  // 离开房间/回到门禁时恢复用户主题（两态手动＋首访跟系统）。
  useEffect(() => {
    if (pageState !== "ready") return;
    document.documentElement.classList.add("dark");
    return () => applyTheme(resolveTheme());
  }, [pageState]);

  // 1. 初始化检查房间状态与本地 Token 缓存；recheckNonce 变化时重新检查（token 失效降级）。
  useEffect(() => {
    let isMounted = true;

    async function checkRoom() {
      setPageState("checking");
      setErrorMessage(null);
      try {
        // 先检查本地是否有现成的 Token
        const localToken = localStorage.getItem(`token_${roomId}`);
        const savedNickname = localStorage.getItem("watchparty_last_nickname") || "访客";
        setNickname(savedNickname);

        // 调用探针探测房间
        const info = await api.getRoomInfo(roomId);

        if (!isMounted) return;

        if (!info.isProtected) {
          // 免密房间：若已有 Token 直接进入，否则自动请求 access
          if (localToken) {
            setCachedToken(localToken);
            recordRoomVisit(roomId, false);
            setPageState("ready");
          } else {
            let clientId = localStorage.getItem("watchparty_client_id");
            if (!clientId) {
              clientId = crypto.randomUUID();
              localStorage.setItem("watchparty_client_id", clientId);
            }
            const accessRes = await api.accessRoom(roomId, {
              clientId,
              nickname: savedNickname,
            });
            localStorage.setItem(`token_${roomId}`, accessRes.accessToken);
            setCachedToken(accessRes.accessToken);
            recordRoomVisit(roomId, false);
            setPageState("ready");
          }
        } else {
          // 受保护房间：如果有本地 Token 则尝试进入，否则拦截进入 PIN 输入界面
          if (localToken) {
            setCachedToken(localToken);
            recordRoomVisit(roomId, true);
            setPageState("ready");
          } else {
            setPageState("need_auth");
          }
        }
      } catch (err: unknown) {
        if (!isMounted) return;
        const error = err as Error & { code?: string; status?: number };
        if (error.code === "ROOM_NOT_FOUND" || error.status === 404) {
          setPageState("not_found");
        } else {
          setPageState("error");
          setErrorMessage(error.message || "无法连接到房间服务，请检查网络");
        }
      }
    }

    void checkRoom();
    return () => {
      isMounted = false;
    };
  }, [roomId, recheckNonce]);

  // Token 失效（服务端重启 / 房间解散重建）：清除本地凭据并重新走门禁流程，
  // 避免用户被旧 token 永久卡在错误屏。
  const handleAuthInvalid = useCallback(() => {
    localStorage.removeItem(`token_${roomId}`);
    setCachedToken(null);
    setPinDigits(["", "", "", ""]);
    setRecheckNonce((n) => n + 1);
  }, [roomId]);

  // 处理 PIN 码输入跳格
  const handleDigitChange = (idx: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...pinDigits];
    next[idx] = val.slice(-1);
    setPinDigits(next);
    setAuthError(null);

    if (val && idx < 3) {
      const nextInput = document.getElementById(`pin-${idx + 1}`);
      nextInput?.focus();
    }
  };

  // 粘贴完整 4 位 PIN：分发到各格并自动提交
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 4).split("");
    if (digits.length === 0) return;
    const next = ["", "", "", ""];
    digits.forEach((d, i) => {
      next[i] = d;
    });
    setPinDigits(next);
    setAuthError(null);
    if (digits.length === 4) {
      document.getElementById(`pin-3`)?.blur();
      void submitPin(next.join(""));
    } else {
      document.getElementById(`pin-${digits.length}`)?.focus();
    }
  };

  const handleKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !pinDigits[idx] && idx > 0) {
      const prevInput = document.getElementById(`pin-${idx - 1}`);
      prevInput?.focus();
    }
  };

  // 提交 PIN 码验证获取 Token
  const submitPin = async (pinStr: string) => {
    if (pinStr.length !== 4) {
      setAuthError("请输入完整的 4 位数字密码");
      return;
    }

    setIsVerifying(true);
    setAuthError(null);

    let clientId = localStorage.getItem("watchparty_client_id");
    if (!clientId) {
      clientId = crypto.randomUUID();
      localStorage.setItem("watchparty_client_id", clientId);
    }

    try {
      const res = await api.accessRoom(roomId, {
        clientId,
        nickname: nickname.trim() || "访客",
        pin: pinStr,
      });

      localStorage.setItem(`token_${roomId}`, res.accessToken);
      localStorage.setItem("watchparty_last_nickname", nickname.trim());
      setCachedToken(res.accessToken);
      recordRoomVisit(roomId, true);
      setPageState("ready");
    } catch (err: unknown) {
      const error = err as Error & { code?: string };
      if (error.code === "INVALID_PIN") {
        setAuthError("PIN 码不正确，请重新输入");
      } else if (error.code === "RATE_LIMITED") {
        setAuthError("错误次数过多已被限速，请 5 分钟后再试");
      } else {
        setAuthError(error.message || "验证失败，请重试");
      }
    } finally {
      setIsVerifying(false);
    }
  };

  const handleVerifyPin = (e: React.FormEvent) => {
    e.preventDefault();
    void submitPin(pinDigits.join(""));
  };

  // 1. 房间检查中
  if (pageState === "checking") {
    return (
      <div
        className="flex h-dvh w-screen flex-col items-center justify-center gap-3 bg-background font-sans text-foreground"
        aria-busy="true"
        aria-live="polite"
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="size-1.5 rounded-full bg-ok" />
          <span>正在连接</span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">/{roomId}</span>
      </div>
    );
  }

  // 2. 房间不存在 (404)
  if (pageState === "not_found") {
    return (
      <div className="flex h-dvh w-screen items-center justify-center bg-background p-6 font-sans text-foreground">
        <div className="w-full max-w-sm space-y-4">
          <h2 className="text-lg font-medium text-foreground">房间不存在或已解散</h2>
          <p className="font-mono text-xs text-muted-foreground">/{roomId}</p>
          <div className="pt-2">
            <Button variant="secondary" onClick={() => router.push("/")} className="w-full">
              返回大厅
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // 3. 错误状态
  if (pageState === "error") {
    return (
      <div className="flex h-dvh w-screen items-center justify-center bg-background p-6 font-sans text-foreground">
        <div className="w-full max-w-sm space-y-4">
          <h2 className="text-lg font-medium text-foreground">连接房间异常</h2>
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert" aria-live="polite">
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
            <span>{errorMessage}</span>
          </p>
          <div className="flex gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => router.push("/")}
              className="text-muted-foreground hover:text-foreground"
            >
              返回首页
            </Button>
            <Button onClick={() => window.location.reload()} className="flex-1">
              <RefreshCw className="size-3.5" />
              <span>重试连接</span>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // 4. 需要 PIN 码鉴权门禁
  if (pageState === "need_auth") {
    return (
      <div className="flex h-dvh w-screen items-center justify-center bg-background p-6 font-sans text-foreground">
        <form onSubmit={handleVerifyPin} className="w-full max-w-sm space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-foreground">输入 PIN 进入</h2>
            <span className="font-mono text-xs text-muted-foreground">/{roomId}</span>
          </div>

          {authError && (
            <p className="flex items-center gap-2 text-sm text-destructive" role="alert" aria-live="polite">
              <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
              <span>{authError}</span>
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="gate-nickname" className="text-[13px] font-normal text-foreground/80">
              昵称
            </Label>
            <Input
              id="gate-nickname"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="例如：Bob"
              maxLength={24}
              required
              className="text-sm"
            />
          </div>

          <div>
            <span id="pin-group-label" className="sr-only">
              4 位数字房间 PIN 码
            </span>
            <div
              className="flex justify-center gap-2.5"
              role="group"
              aria-labelledby="pin-group-label"
            >
              {pinDigits.map((digit, idx) => (
                <input
                  key={idx}
                  id={`pin-${idx}`}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={1}
                  value={digit}
                  aria-label={`PIN 码第 ${idx + 1} 位`}
                  onChange={(e) => handleDigitChange(idx, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(idx, e)}
                  onPaste={handlePaste}
                  className="size-11 rounded-md border border-input bg-field text-center font-mono text-base font-bold text-foreground outline-none transition-colors focus:border-ring"
                />
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push("/")}
              className="text-muted-foreground hover:text-foreground"
            >
              返回
            </Button>
            <Button type="submit" disabled={isVerifying} className="flex-1">
              {isVerifying ? "验证中…" : "进入"}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  // 5. 准入通过：渲染真实播放器核心
  return (
    <RoomPlayer
      roomId={roomId}
      accessToken={cachedToken || undefined}
      onAuthInvalid={handleAuthInvalid}
    />
  );
}
