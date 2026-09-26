import { useCallback, useEffect, useRef, useState } from "react"
import { createLobbySwitchTransaction, type LobbySwitchOptions } from "../../shared/lobby-switch-driver"
import type { SwitchTarget } from "../../shared/lobby-contract"
import { isDesktopRuntime } from "../../shared/desktop-runtime"

import type { DesktopCommand, DesktopUiState } from "@/lib/contracts"
import {
  currentDesktopLaunch,
  accessDesktopRoom,
  createDesktopRoom,
  errorMessage,
  executeRoomCommand,
  listenForLaunch,
  listenForState,
  listenForSessionReset,
  startDesktopSession,
  restoreDesktopSession,
  stopDesktopSession,
  checkpointDesktopSession,
  suspendDesktopSession,
  rollbackDesktopSession,
  discardDesktopSessionCheckpoint,
  getDesktopSettings,
  withAuthoritativeSnapshot,
} from "@/lib/ipc"

export type StatusTone = "idle" | "ready" | "warning" | "error"

export interface StatusMessage {
  text: string
  tone: StatusTone
}

export function useDesktopSession() {
  const runtimeAvailable = isDesktopRuntime()
  const [state, setState] = useState<DesktopUiState | null>(null)
  const [launchRoomId, setLaunchRoomId] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusMessage>({ text: "等待网页交接", tone: "idle" })
  const [starting, setStarting] = useState(false)
  const [readyForRestore, setReadyForRestore] = useState(false)
  const lobbySwitch = useRef<ReturnType<typeof createLobbySwitchTransaction> | null>(null)
  const lobbyOptions = useRef<Omit<LobbySwitchOptions, "watch"> | null>(null)

  /** The lobby supplies the existing connection and local focus owner once. */
  const switchTo = useCallback(async (target: SwitchTarget, options: Omit<LobbySwitchOptions, "watch">) => {
    if (!runtimeAvailable) throw new Error("desktop_runtime_unavailable")
    if (!lobbySwitch.current) {
      lobbyOptions.current = options
      lobbySwitch.current = createLobbySwitchTransaction({ ...options,
        current: () => lobbyOptions.current!.current(),
        nickname: () => lobbyOptions.current!.nickname(),
        focus: service => lobbyOptions.current!.focus(service),
        committed: identity => lobbyOptions.current!.committed(identity),
        watch: {
        checkpointDesktopSession, suspendDesktopSession, rollbackDesktopSession,
        discardDesktopSessionCheckpoint, getDesktopSettings, accessDesktopRoom, withAuthoritativeSnapshot,
      } })
    } else if (lobbyOptions.current?.music !== options.music) {
      throw new Error("lobby_connection_changed")
    }
    lobbyOptions.current = options
    setStarting(true)
    try {
      await lobbySwitch.current.switchTo(target)
      setStatus({ text: "已加入房间", tone: "ready" })
    } catch (error) {
      setStatus({ text: errorMessage(error, "切换房间失败"), tone: "error" })
      throw error
    } finally { setStarting(false) }
  }, [runtimeAvailable])

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
        } finally {
          if (!disposed) setReadyForRestore(true)
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

  const restore = useCallback(async () => {
    try {
      return await restoreDesktopSession()
    } catch (error) {
      setStatus({ text: errorMessage(error, "无法恢复上次会话"), tone: "error" })
      return false
    }
  }, [])

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

  const createRoom = useCallback(async (nickname: string, pin?: string) => {
    setStarting(true)
    try {
      await createDesktopRoom({ nickname, ...(pin ? { pin } : {}) })
      setStatus({ text: "房间已创建，正在载入", tone: "ready" })
      return true
    } catch (error) {
      setStatus({ text: errorMessage(error, "无法创建房间"), tone: "error" })
      throw error
    } finally { setStarting(false) }
  }, [])

  const accessRoom = useCallback(async (roomId: string, nickname: string, pin?: string) => {
    setStarting(true)
    try {
      await accessDesktopRoom({ roomId, nickname, ...(pin ? { pin } : {}) })
      setStatus({ text: "已加入房间，正在载入", tone: "ready" })
      return true
    } catch (error) {
      setStatus({ text: errorMessage(error, "无法加入房间"), tone: "error" })
      throw error
    } finally { setStarting(false) }
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

  return { accessRoom, command, createRoom, launchRoomId, readyForRestore, restore, setStatus, start, starting, state, status, stop, switchTo }
}
