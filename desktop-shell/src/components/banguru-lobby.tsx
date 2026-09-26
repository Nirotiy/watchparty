import { useEffect, useRef, useState } from "react"
import { Button, Field, Input, MessageBar, MessageBarBody } from "@fluentui/react-components"
import { AddRegular, ArrowEnterRegular } from "@fluentui/react-icons"
import { useShellToast } from "@/components/shell-toast"
import { SessionGate } from "@/components/session-gate"
import { errorMessage, type DesktopProbeReport, type DesktopReadinessReport } from "@/lib/ipc"
import { readinessSummary } from "@/components/setup-guide-steps"
import { LobbyError } from "../../shared/lobby-contract"

export interface BanguruProbeState {
  status: "unconfigured" | "checking" | "online" | "error"
  origin?: string
  protocolVersion?: number
  serviceVersion?: string
  capabilities?: DesktopProbeReport["capabilities"]
  error?: string
  /** `null` = backend predates readiness or the probe failed; `undefined` = not probed yet. */
  readiness?: DesktopReadinessReport | null
}

export function BanguruLobby({ busy, activeRoomId, onCreate, onJoin, onStart, launchRoomId, probe, canCreate, setupCompleted, setupOrigin, onReconfigure }: { busy: boolean; activeRoomId: string | null; onCreate(nickname: string, pin?: string): Promise<void>; onJoin(roomId: string, nickname: string, pin?: string): Promise<void>; onStart(ticket: string): Promise<boolean>; launchRoomId: string | null; probe: BanguruProbeState; canCreate: boolean; setupCompleted: boolean; setupOrigin: string | null; onReconfigure(): void }) {
  const [nickname, setNickname] = useState("")
  const [roomId, setRoomId] = useState("")
  const [pin, setPin] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const roomInput = useRef<HTMLInputElement>(null)
  const notify = useShellToast()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const editing = event.target instanceof HTMLElement && (event.target.matches("input,textarea,select") || event.target.isContentEditable)
      if ((!editing && event.key === "/") || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) { event.preventDefault(); roomInput.current?.focus() }
    }
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
  const validPin = !pin || pin.length === 4
  const ready = Boolean(nickname.trim()) && validPin && !busy && !pending
  const serviceReady = probe.status === "online"
  const canJoin = serviceReady && Boolean(probe.capabilities?.joinRoom)
  const canCreateRoom = serviceReady && Boolean(probe.capabilities?.createRoom) && canCreate
  const canHandoff = serviceReady && Boolean(probe.capabilities?.handoffCode)
  const statusLabel = probe.status === "online" ? `在线 · ${probe.serviceVersion ?? "服务正常"}` : probe.status === "checking" ? "检查中" : probe.status === "unconfigured" ? "未配置" : "服务异常"
  const statusDetails = probe.status === "error" ? (probe.error ?? "无法读取桌面服务状态") : probe.status === "unconfigured" ? "请在设置中配置 Banguru 后端站点" : probe.status === "checking" ? "正在检查桌面服务与协议能力" : `协议 v${probe.protocolVersion ?? "?"} · 创建 ${probe.capabilities?.createRoom ? "可用" : "不可用"} · 加入 ${probe.capabilities?.joinRoom ? "可用" : "不可用"} · 恢复 ${probe.capabilities?.restoreSession ? "可用" : "不可用"} · 搜索 ${probe.capabilities?.mediaSearch ? "可用" : "不可用"} · 队列 ${probe.capabilities?.mediaQueue ? "可用" : "不可用"} · 网页交接 ${probe.capabilities?.handoffCode ? "可用" : "不可用"}`
  const readinessLine = readinessSummary(probe.readiness)
  async function submit(create: boolean) {
    if (!ready || !(create ? canCreateRoom : canJoin) || (!create && !roomId)) return
    setPending(true); setError("")
    try {
      await (create ? onCreate(nickname.trim(), pin || undefined) : onJoin(roomId, nickname.trim(), pin || undefined))
      setPin("")
      if (create) notify("房间已创建。", "success")
    } catch (failure) {
      const detail = failure instanceof LobbyError && failure.code === "switch-failed" ? failure.cause : failure
      const code = typeof detail === "object" && detail !== null && "code" in detail ? detail.code : null
      const message = code === "ROOM_PIN_REQUIRED" ? "该房间需要 4 位 PIN" : code === "ROOM_PIN_REJECTED" ? "PIN 码错误，请重试" : code === "ROOM_NOT_FOUND" ? "房间不存在或已解散，请检查房号" : errorMessage(detail, create ? "无法创建房间，请检查连接后重试。" : "无法加入房间，请稍后重试。")
      setError(message)
    } finally { setPending(false) }
  }
  return <section className="banguru-lobby" aria-label="Banguru 一起看">
    <header className="lobby-header"><div><h1>Banguru <span className="banguru-lobby-subtitle">/ 入房</span></h1><p>输入信息后立即加入，桌面端会自动保存可恢复会话。</p></div><div className={`banguru-service-status is-${probe.status}`} tabIndex={0} role="status" aria-label={`桌面服务状态：${statusLabel}`}><span className="banguru-service-dot" aria-hidden="true" /><span>{statusLabel}</span><div className="banguru-service-tooltip" role="tooltip"><strong>{statusLabel}</strong><span>{statusDetails}</span></div></div></header>
    {setupCompleted ? <div className="flex items-center justify-between gap-3 border-y border-[var(--stroke-card)] py-2 text-xs text-[var(--text-secondary)]" role="status"><span>配置完成 · {setupOrigin ?? "未保存站点"} · 协议 v{probe.protocolVersion ?? "?"}{readinessLine ? <small className="lobby-service-hint">{readinessLine}</small> : null}</span><Button appearance="subtle" size="small" onClick={onReconfigure}>重新配置</Button></div> : null}
    {!serviceReady && <MessageBar className="lobby-service-hint"><MessageBarBody>{probe.status === "error" ? "桌面服务不可用。将鼠标悬浮右上角状态查看具体错误。" : probe.status === "checking" ? "正在检查桌面服务，请稍候。" : "请先在设置中配置 Banguru 后端站点。"}</MessageBarBody></MessageBar>}
    <div className="banguru-grid banguru-grid-primary"><form onSubmit={event => { event.preventDefault(); void submit(false) }} aria-busy={pending}>
      <h2>欢迎回来</h2><p>输入房间编号与昵称，PIN 可选。</p>
      <Field label="房间编号" required><Input ref={roomInput} value={roomId} onChange={(_, data) => { setRoomId(data.value.trim()); setError("") }} placeholder="输入房间编号" disabled={pending || !canJoin} /></Field>
      <Field label="昵称" required><Input value={nickname} onChange={(_, data) => setNickname(data.value)} placeholder="显示给房间成员" disabled={pending || (!canJoin && !canCreateRoom)} /></Field>
      <Field label="PIN（可选）" validationState={validPin ? "none" : "error"} validationMessage={validPin ? undefined : "请输入完整的 4 位 PIN"}><Input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(_, data) => { setPin(data.value.replace(/\D/g, "").slice(0, 4)); setError("") }} placeholder="4 位 PIN" disabled={pending || (!canJoin && !canCreateRoom)} /></Field>
      {error ? <MessageBar intent="error" layout="multiline" className="banguru-join-error"><MessageBarBody>{error}</MessageBarBody></MessageBar> : null}
      <div className="banguru-lobby-actions"><Button type="submit" appearance="primary" icon={<ArrowEnterRegular />} disabled={!ready || !roomId || !canJoin}>{pending ? "正在处理" : "加入房间"}</Button><Button icon={<AddRegular />} disabled={!ready || !canCreateRoom} onClick={() => void submit(true)}>创建并进入</Button></div>
    </form>{canHandoff ? <aside><h2>从网页接续</h2><p>在网页端生成一次性交接码，然后粘贴到此处恢复房间。</p><SessionGate roomId={launchRoomId} starting={busy || pending} onStart={onStart} autoFocus={false} /></aside> : null}</div>
    {activeRoomId ? <p className="lobby-session-note">当前 Banguru 会话：<span>{activeRoomId}</span></p> : null}
  </section>
}
