import { useEffect, useRef, useState } from "react"
import { AddRegular, ArrowEnterRegular, PulseRegular } from "@fluentui/react-icons"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Input } from "@/components/ui/input"
import { MessageBar } from "@/components/ui/message-bar"
import { useShellToast } from "@/components/shell-toast"
import { SessionGate } from "@/components/session-gate"
import { errorMessage, type DesktopProbeReport, type DesktopReadinessReport } from "@/lib/ipc"
import { readinessParts, readinessSummary } from "@/components/setup-guide-steps"
import { LobbyError } from "../../shared/lobby-contract"

const LABEL = "mb-1.5 block text-xs text-[var(--text-secondary)]"

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

/**
 * Banguru 首页（2026-09-27 重设计，方案 A）：左「桌面服务」状态卡 + 右「进入房间」卡，
 * 交接码做页面底部一条横条。状态不再是 hover 气泡——它是这个页面的一等公民，
 * 运维细节（密钥模式、诊断码、监听端口）收进「检查服务器」的展开里。
 */
export function BanguruLobby({ busy, activeRoomId, onCreate, onJoin, onEnterRoom, onStart, launchRoomId, probe, canCreate, setupCompleted, setupOrigin, onReconfigure }: { busy: boolean; activeRoomId: string | null; onCreate(nickname: string, pin?: string): Promise<{ roomId: string }>; onJoin(roomId: string, nickname: string, pin?: string): Promise<void>; onEnterRoom(): void; onStart(ticket: string): Promise<boolean>; launchRoomId: string | null; probe: BanguruProbeState; canCreate: boolean; setupCompleted: boolean; setupOrigin: string | null; onReconfigure(): void }) {
  const [nickname, setNickname] = useState("")
  const [roomId, setRoomId] = useState("")
  const [pin, setPin] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  /** 单卡段选：加入 / 创建（用户 2026-10-02 拍板，方案 B）。 */
  const [mode, setMode] = useState<"join" | "create">("join")
  /** 后端生成的房号；创建成功后才落这里（不预生成、不冒用旧值）。 */
  const [created, setCreated] = useState("")
  const [showDetails, setShowDetails] = useState(false)
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
  const statusLead = probe.status === "error" ? (probe.error ?? "无法读取桌面服务状态")
    : probe.status === "unconfigured" ? "还没选过后端站点：先在设置里配置，或走一遍首启向导。"
    : probe.status === "checking" ? "正在检查桌面服务与协议能力…"
    : `协议 v${probe.protocolVersion ?? "?"} · 服务版本 ${probe.serviceVersion ?? "?"}`
  const capabilities: Array<[string, boolean | undefined]> = [
    ["创建", probe.capabilities?.createRoom], ["加入", probe.capabilities?.joinRoom], ["恢复", probe.capabilities?.restoreSession],
    ["搜索", probe.capabilities?.mediaSearch], ["队列", probe.capabilities?.mediaQueue], ["网页交接", probe.capabilities?.handoffCode],
  ]
  const readiness = readinessParts(probe.readiness)
  const readinessLine = readinessSummary(probe.readiness)
  const diagnostics = (probe.readiness?.diagnostics ?? []).map(entry => entry.code).filter(Boolean)
  async function submit(create: boolean) {
    if (!ready || !(create ? canCreateRoom : canJoin) || (!create && !roomId)) return
    setPending(true); setError("")
    try {
      if (create) {
        // 原生创建即建立桌面会话；界面停在结果块，由「进入房间」进房（创建≠进房，用户 2026-10-02 拍板）。
        const result = await onCreate(nickname.trim(), pin || undefined)
        setCreated(result.roomId)
        notify("房间已创建。", "success")
      } else {
        await onJoin(roomId, nickname.trim(), pin || undefined)
      }
      setPin("")
    } catch (failure) {
      const detail = failure instanceof LobbyError && failure.code === "switch-failed" ? failure.cause : failure
      const code = typeof detail === "object" && detail !== null && "code" in detail ? detail.code : null
      const message = code === "ROOM_PIN_REQUIRED" ? "该房间需要 4 位 PIN" : code === "ROOM_PIN_REJECTED" ? "PIN 码错误，请重试" : code === "ROOM_NOT_FOUND" ? "房间不存在或已解散，请检查房号" : code === "RATE_LIMITED" ? "尝试次数过多，请稍后再试" : code === "INVALID_REQUEST" ? "请求被拒绝：昵称需 1–24 字符，PIN 需为 4 位数字" : errorMessage(detail, create ? "无法创建房间，请检查连接后重试。" : "无法加入房间，请稍后重试。")
      setError(message)
    } finally { setPending(false) }
  }
  return <section className="banguru-lobby" aria-label="Banguru 一起看">
    <header className="lobby-header"><div><h1>Banguru <span className="banguru-lobby-subtitle">/ 入房</span></h1></div></header>
    <div className="bh-cols">
      <section className="bh-card" aria-label="桌面服务">
        <div className="bh-card-head">
          <span className={`bh-dot is-${probe.status}`} aria-hidden="true" />
          <h2>桌面服务</h2>
          <span className={`bh-pill is-${probe.status}`} role="status">{statusLabel}</span>
        </div>
        <p className="bh-lead">{statusLead}</p>
        <dl className="bh-rows">
          <div><dt>服务器</dt><dd className="mono">{probe.origin ?? "未配置"}</dd></div>
          <div><dt>媒体源</dt><dd>{(readiness.openlist ?? "未知").replace(/^媒体源：/, "")}</dd></div>
          <div><dt>媒体库</dt><dd>{(readiness.roots ?? "未知").replace(/^媒体库：/, "")}</dd></div>
        </dl>
        <div className="bh-pills">
          {capabilities.map(([label, ok]) => <span key={label} className={`bh-cap is-${ok === undefined ? "unknown" : ok ? "on" : "off"}`}>{label} {ok === undefined ? "未知" : ok ? "可用" : "不可用"}</span>)}
        </div>
        <div className="bh-actions">
          <Button variant="ghost" aria-expanded={showDetails} onClick={() => setShowDetails(open => !open)}><PulseRegular />检查服务器</Button>
        </div>
        {showDetails ? <div className="bh-details" role="region" aria-label="服务详情">
          <p>{probe.status === "error" ? (probe.error ?? "无法读取桌面服务状态") : probe.status === "unconfigured" ? "请在设置中配置 Banguru 后端站点。" : probe.status === "checking" ? "正在检查桌面服务与协议能力" : `协议 v${probe.protocolVersion ?? "?"} · 创建 ${probe.capabilities?.createRoom ? "可用" : "不可用"} · 加入 ${probe.capabilities?.joinRoom ? "可用" : "不可用"} · 恢复 ${probe.capabilities?.restoreSession ? "可用" : "不可用"} · 搜索 ${probe.capabilities?.mediaSearch ? "可用" : "不可用"} · 队列 ${probe.capabilities?.mediaQueue ? "可用" : "不可用"} · 网页交接 ${probe.capabilities?.handoffCode ? "可用" : "不可用"}`}</p>
          {probe.readiness ? <dl className="bh-rows">
            <div><dt>就绪状态</dt><dd>{probe.readiness.status}{readinessLine ? ` · ${readinessLine}` : ""}</dd></div>
            <div><dt>检查时间</dt><dd>{new Date(probe.readiness.checkedAt).toLocaleString()}{probe.readiness.cache?.fromCache ? "（缓存）" : ""}</dd></div>
            {probe.readiness.config?.mediaIdKey?.mode === "ephemeral" ? <div><dt>媒体 ID</dt><dd>临时密钥：后端重启后旧 mediaId 失效（仅影响排障）</dd></div> : null}
            {probe.readiness.listener?.boundPort ? <div><dt>监听</dt><dd className="mono">{probe.readiness.listener.host ?? "0.0.0.0"}:{probe.readiness.listener.boundPort}{probe.readiness.listener.secure ? " · https" : ""}</dd></div> : null}
            {probe.readiness.bootId ? <div><dt>bootId</dt><dd className="mono">{probe.readiness.bootId}</dd></div> : null}
            {diagnostics.length ? <div><dt>诊断码</dt><dd className="mono">{diagnostics.join(" · ")}</dd></div> : null}
          </dl> : <p className="bh-details-note">这个后端还没提供就绪文档（readiness），只有上面的协议与能力位。</p>}
        </div> : null}
        {setupCompleted ? <div className="bh-banner" role="status">
          <span>配置完成 · {setupOrigin ?? "未保存站点"} · 协议 v{probe.protocolVersion ?? "?"}</span>
          <Button variant="ghost" onClick={onReconfigure}>重新配置</Button>
        </div> : null}
      </section>

      <form className="bh-card" onSubmit={event => { event.preventDefault(); void submit(mode === "create") }} aria-busy={pending} aria-label="房间操作">
        <div className="bh-card-head bh-room-head">
          <div className="bh-seg" role="group" aria-label="加入或创建">
            {(["join", "create"] as const).map(value => (
              <Button key={value} type="button" variant="toggle" aria-pressed={mode === value} disabled={pending} onClick={() => { setMode(value); setError("") }}>{value === "join" ? "加入" : "创建"}</Button>
            ))}
          </div>
          {mode === "create" ? <span className="bh-seg-hint">房号由后端生成</span> : null}
        </div>
        {mode === "join" ? <>
          <p className="bh-lead">输入房间编号与昵称，PIN 可选。</p>
          <div className="my-3">
            <label className={LABEL} htmlFor="banguru-room-id">房间编号 <span aria-hidden="true">*</span></label>
            <Input id="banguru-room-id" ref={roomInput} value={roomId} onChange={event => { setRoomId(event.target.value.trim()); setError("") }} placeholder="room-…" disabled={pending || !canJoin} className="font-mono" />
          </div>
        </> : <p className="bh-lead">创建后展示房号给你分享，不用手填。</p>}
        <div className="my-3">
          <label className={LABEL} htmlFor="banguru-nickname">昵称 <span aria-hidden="true">*</span></label>
          <Input id="banguru-nickname" value={nickname} maxLength={24} onChange={event => setNickname(event.target.value)} placeholder="显示给房间成员" disabled={pending || (!canJoin && !canCreateRoom)} />
        </div>
        <div className="my-3">
          <label className={LABEL} htmlFor="banguru-pin">PIN（可选）</label>
          <Input id="banguru-pin" type="password" inputMode="numeric" autoComplete="off" aria-invalid={validPin ? undefined : true} value={pin} onChange={event => { setPin(event.target.value.replace(/\D/g, "").slice(0, 4)); setError("") }} placeholder={mode === "create" ? "留空为公开房间" : "私有房需要 4 位 PIN"} disabled={pending || (!canJoin && !canCreateRoom)} />
          {validPin ? null : <p className="mt-1.5 text-xs text-[#ff9d96]">请输入完整的 4 位 PIN</p>}
        </div>
        {error ? <MessageBar variant="error" className="banguru-join-error">{error}</MessageBar> : null}
        <div className="bh-actions">
          {mode === "join"
            ? <Button type="submit" variant="accent" disabled={!ready || !roomId || !canJoin}><ArrowEnterRegular />{pending ? "正在加入" : "加入房间"}</Button>
            : <Button type="submit" variant="accent" disabled={!ready || !canCreateRoom}><AddRegular />{pending ? "正在创建" : "创建房间"}</Button>}
        </div>
        {mode === "create" && created ? <div className="bh-created" role="status">
          <span className="bh-badge-ok">已创建</span>
          <span className="bh-created-id">{created}</span>
          <CopyButton value={created} />
          <span className="bh-created-spacer" aria-hidden="true" />
          <Button type="button" variant="accent" disabled={activeRoomId !== created} title={activeRoomId !== created ? "桌面会话建立后可用" : undefined} onClick={onEnterRoom}><ArrowEnterRegular />进入房间</Button>
        </div> : null}
        {mode === "create" && created ? <p className="bh-created-hint">把房号发给朋友，他们用「加入」进来。空房间会被回收，服务重启后房号不保证一直有效。</p> : null}
        {activeRoomId ? <p className="bh-session">当前 Banguru 会话：<span className="mono">{activeRoomId}</span></p> : null}
      </form>
    </div>

    {!serviceReady ? <MessageBar variant="info" className="lobby-service-hint">{probe.status === "error" ? "桌面服务不可用：展开左侧「检查服务器」看具体原因。" : probe.status === "checking" ? "正在检查桌面服务，请稍候。" : "请先在设置中配置 Banguru 后端站点。"}</MessageBar> : null}

    {canHandoff ? <section className="bh-strip" aria-label="从网页接续">
      <div className="bh-strip-copy"><h2>从网页接续</h2><p>在网页端生成一次性交接码，然后粘贴到这里恢复那个房间。</p></div>
      <SessionGate roomId={launchRoomId} starting={busy || pending} onStart={onStart} autoFocus={false} />
    </section> : null}
  </section>
}
