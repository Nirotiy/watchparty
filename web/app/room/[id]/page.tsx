"use client";

import React, { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { Lock, ArrowLeft, RefreshCw, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import RoomPlayer from "@/components/room-player";

interface RoomPageProps {
  params: Promise<{ id: string }>;
}

export default function DynamicRoomPage({ params }: RoomPageProps) {
  const resolvedParams = use(params);
  const roomId = resolvedParams.id;
  const router = useRouter();

  // 状态流转: checking -> need_auth | ready | not_found | error
  const [pageState, setPageState] = useState<"checking" | "need_auth" | "ready" | "not_found" | "error">("checking");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nickname, setNickname] = useState("");
  const [pinDigits, setPinDigits] = useState(["", "", "", ""]);
  const [isVerifying, setIsVerifying] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [cachedToken, setCachedToken] = useState<string | null>(null);

  // 1. 初始化检查房间状态与本地 Token 缓存
  useEffect(() => {
    let isMounted = true;

    async function checkRoom() {
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
            setPageState("ready");
          }
        } else {
          // 受保护房间：如果有本地 Token 则尝试进入，否则拦截进入 PIN 输入界面
          if (localToken) {
            setCachedToken(localToken);
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

    checkRoom();
    return () => {
      isMounted = false;
    };
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

  const handleKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !pinDigits[idx] && idx > 0) {
      const prevInput = document.getElementById(`pin-${idx - 1}`);
      prevInput?.focus();
    }
  };

  // 提交 PIN 码验证获取 Token
  const handleVerifyPin = async (e: React.FormEvent) => {
    e.preventDefault();
    const pinStr = pinDigits.join("");
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

  // 1. 房间检查中
  if (pageState === "checking") {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-black font-mono text-xs text-neutral-400">
        <div className="flex items-center gap-2">
          <div className="size-2 rounded-full bg-sky-400"></div>
          <span>正在连接并验证房间 /{roomId}...</span>
        </div>
      </div>
    );
  }

  // 2. 房间不存在 (404)
  if (pageState === "not_found") {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-black p-4 font-sans text-white">
        <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-6 text-center shadow-2xl space-y-4">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-neutral-800 bg-black text-neutral-500">
            <AlertTriangle className="size-6 text-amber-500" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-white">房间不存在或已解散</h2>
            <p className="font-mono text-xs text-neutral-500">/{roomId}</p>
          </div>
          <p className="text-xs text-neutral-400">
            请确认您输入的房间标识符是否正确，或返回大厅创建属于您的新房间。
          </p>
          <div className="pt-2">
            <button
              onClick={() => router.push("/")}
              className="flex w-full items-center justify-center gap-2 rounded bg-white py-2 text-xs font-semibold text-black hover:bg-neutral-200"
            >
              <ArrowLeft className="size-3.5" />
              <span>返回大厅首页</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 3. 错误状态
  if (pageState === "error") {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-black p-4 font-sans text-white">
        <div className="w-full max-w-sm rounded-lg border border-rose-900/40 bg-neutral-950 p-6 text-center shadow-2xl space-y-4">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-rose-900/50 bg-rose-950/40 text-rose-400">
            <AlertTriangle className="size-6" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-white">连接房间异常</h2>
            <p className="text-xs text-rose-300">{errorMessage}</p>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => router.push("/")}
              className="flex-1 rounded border border-neutral-800 bg-black py-2 text-xs text-neutral-400 hover:text-white"
            >
              返回首页
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded bg-white py-2 text-xs font-semibold text-black hover:bg-neutral-200"
            >
              <RefreshCw className="size-3.5" />
              <span>重试连接</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 4. 需要 PIN 码鉴权门禁
  if (pageState === "need_auth") {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-black p-4 font-sans text-white">
        <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-950 p-6 shadow-2xl shadow-black space-y-5">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Lock className="size-4 text-sky-400" />
              <span className="text-sm font-semibold text-white">房间受 PIN 码保护</span>
            </div>
            <span className="font-mono text-xs text-neutral-500">/{roomId}</span>
          </div>

          <form onSubmit={handleVerifyPin} className="space-y-4">
            {authError && (
              <div className="rounded border border-rose-900/50 bg-rose-950/40 p-2.5 text-xs text-rose-300">
                {authError}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-neutral-400">进入昵称</label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="例如：Bob"
                maxLength={24}
                required
                className="mt-1.5 w-full rounded border border-neutral-800 bg-black px-3 py-2 text-xs text-white placeholder-neutral-600 outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-400">4 位数字房间 PIN 码</label>
              <div className="mt-1.5 flex justify-center gap-2.5">
                {pinDigits.map((digit, idx) => (
                  <input
                    key={idx}
                    id={`pin-${idx}`}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleDigitChange(idx, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(idx, e)}
                    className="size-11 rounded border border-neutral-800 bg-black text-center font-mono text-base font-bold text-white outline-none focus:border-sky-500"
                  />
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => router.push("/")}
                className="flex-1 rounded border border-neutral-800 bg-black py-2 text-xs text-neutral-400 hover:text-white"
              >
                返回
              </button>
              <button
                type="submit"
                disabled={isVerifying}
                className="flex-1 rounded bg-sky-500 py-2 text-xs font-semibold text-black hover:bg-sky-400 disabled:opacity-50"
              >
                {isVerifying ? "验证中..." : "验证进入"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // 5. 准入通过：渲染真实播放器核心
  return <RoomPlayer roomId={roomId} accessToken={cachedToken || undefined} />;
}
