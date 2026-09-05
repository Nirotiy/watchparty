import { useCallback, useEffect, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"

import type { DesktopCommand, DesktopUiState } from "@/lib/contracts"
import {
  currentDesktopLaunch,
  errorMessage,
  executeRoomCommand,
  listenForLaunch,
  listenForState,
  listenForSessionReset,
  startDesktopSession,
  stopDesktopSession,
} from "@/lib/ipc"

export type StatusTone = "idle" | "ready" | "warning" | "error"

export interface StatusMessage {
  text: string
  tone: StatusTone
}

export function useDesktopSession() {
  const runtimeAvailable = isTauri()
  const [state, setState] = useState<DesktopUiState | null>(null)
  const [launchRoomId, setLaunchRoomId] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusMessage>({ text: "等待网页交接", tone: "idle" })
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!runtimeAvailable) {
      setStatus({ text: "浏览器预览模式 · 原生运行时未连接", tone: "idle" })
      return
    }

    let disposed = false
    const unlisteners: Array<() => void> = []

    function applyLaunch(roomId: string) {
      setLaunchRoomId(roomId)
      setStatus({ text: `准备加入房间 /${roomId}`, tone: "idle" })
    }

    void Promise.all([
      listenForSessionReset(() => {
        setState(null)
        setLaunchRoomId(null)
        setStatus({ text: "站点配置已更新，请重新加入房间", tone: "idle" })
      }),
      listenForLaunch(({ roomId }) => applyLaunch(roomId)),
      listenForState((nextState) => {
        setState(nextState)
        if (nextState.error) {
          setStatus({ text: nextState.error.message, tone: "error" })
        } else if (nextState.connection === "ready") {
          setStatus({ text: "桌面会话已连接", tone: "ready" })
        } else if (nextState.connection === "backoff") {
          setStatus({ text: "网络暂时不可用，正在自动重试", tone: "warning" })
        }
      }),
    ])
      .then(async (subscriptions) => {
        if (disposed) {
          subscriptions.forEach((unsubscribe) => unsubscribe())
          return
        }
        unlisteners.push(...subscriptions)
        // Replay any deep link that fired before these listeners registered.
        try {
          const launch = await currentDesktopLaunch()
          if (launch && !disposed) applyLaunch(launch.roomId)
        } catch (error: unknown) {
          if (!disposed) setStatus({ text: errorMessage(error, "无法读取启动信息"), tone: "error" })
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setStatus({ text: errorMessage(error, "无法连接桌面运行时"), tone: "error" })
      })

    return () => {
      disposed = true
      unlisteners.forEach((unsubscribe) => unsubscribe())
    }
  }, [runtimeAvailable])

  const start = useCallback(async (ticket: string) => {
    if (!runtimeAvailable) {
      setStatus({ text: "请在 WatchParty 桌面应用中兑换交接码", tone: "warning" })
      return false
    }
    setStarting(true)
    setStatus({ text: "正在兑换交接码", tone: "idle" })
    try {
      // The runtime rejects sessions that join a room other than the deep-linked one.
      await startDesktopSession(ticket, launchRoomId)
      setStatus({ text: "交接码已兑换，正在载入房间", tone: "ready" })
      return true
    } catch (error) {
      setStatus({ text: errorMessage(error, "无法加入房间"), tone: "error" })
      return false
    } finally {
      setStarting(false)
    }
  }, [runtimeAvailable, launchRoomId])

  const command = useCallback(async (value: DesktopCommand) => {
    try {
      const acknowledgement = await executeRoomCommand(value)
      if (!acknowledgement.ok) {
        setStatus({ text: acknowledgement.error?.message ?? "操作未被房间接受", tone: "error" })
        return false
      }
      return true
    } catch (error) {
      setStatus({ text: errorMessage(error, "操作失败"), tone: "error" })
      return false
    }
  }, [])

  const stop = useCallback(async () => {
    try {
      await stopDesktopSession()
      setState(null)
      setStatus({ text: "已退出房间", tone: "idle" })
      return true
    } catch (error) {
      setStatus({ text: errorMessage(error, "退出失败"), tone: "error" })
      return false
    }
  }, [])

  return { command, launchRoomId, setStatus, start, starting, state, status, stop }
}
