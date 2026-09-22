import { useEffect, useRef, useState } from "react"
import { Button, Field, Input, MessageBar, MessageBarBody } from "@fluentui/react-components"
import { AddRegular, ArrowEnterRegular } from "@fluentui/react-icons"
import { useShellToast } from "@/components/shell-toast"
import { SessionGate } from "@/components/session-gate"

export function BanguruLobby({ busy, canJoin, canCreate, activeRoomId, onCreate, onJoin, onStart, launchRoomId }: { busy: boolean; canJoin: boolean; canCreate: boolean; activeRoomId: string | null; onCreate(nickname: string, pin?: string): Promise<boolean>; onJoin(roomId: string, nickname: string, pin?: string): Promise<boolean>; onStart(ticket: string): Promise<boolean>; launchRoomId: string | null }) {
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
  async function submit(create: boolean) {
    if (!ready) return
    setPending(true); setError("")
    try {
      const ok = await (create ? onCreate(nickname.trim(), pin || undefined) : onJoin(roomId, nickname.trim(), pin || undefined))
      if (!ok) throw new Error("request_failed")
      setPin("")
      if (create) notify("房间已创建。", "success")
    } catch {
      const message = create ? "无法创建房间，请检查连接后重试。" : "无法加入房间，请检查房间编号、昵称或 PIN。"
      setError(message)
    } finally { setPending(false) }
  }
  return <section className="banguru-lobby" aria-label="Banguru 一起看">
    <header className="lobby-header"><div><h1>Banguru</h1><p>通过房间编号或邀请加入观影。</p></div></header>
    {!canJoin ? <MessageBar className="lobby-service-hint"><MessageBarBody>请先在设置中配置 Banguru 后端站点。</MessageBarBody></MessageBar> : null}
    <div className="banguru-handoff"><h2>从网页接续观看</h2><SessionGate roomId={launchRoomId} starting={busy || pending || !canJoin || !canCreate} onStart={onStart} /></div>
    <div className="banguru-grid"><form onSubmit={event => { event.preventDefault(); void submit(false) }} aria-busy={pending}>
      <h2>通过房号加入</h2><p>输入网页房间地址中的房号。网页生成的一次性交接码请粘贴到上方。</p>
      <Field label="房间编号" required><Input ref={roomInput} value={roomId} onChange={(_, data) => setRoomId(data.value.trim())} placeholder="输入房间编号" disabled={pending} /></Field>
      <Field label="昵称" required><Input value={nickname} onChange={(_, data) => setNickname(data.value)} placeholder="显示给房间成员" disabled={pending} /></Field>
      <Field label="PIN（可选）" validationState={validPin ? "none" : "error"} validationMessage={validPin ? undefined : "请输入完整的 4 位 PIN"}><Input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(_, data) => setPin(data.value.replace(/\D/g, "").slice(0, 4))} placeholder="4 位 PIN" disabled={pending} /></Field>
      {error ? <MessageBar intent="error" layout="multiline" className="banguru-join-error"><MessageBarBody>{error}</MessageBarBody></MessageBar> : null}
      <Button type="submit" appearance="primary" icon={<ArrowEnterRegular />} disabled={!ready || !roomId || !canJoin}>{pending ? "正在处理" : "加入房间"}</Button>
    </form><aside><h2>创建房间</h2><p>使用左侧的昵称与可选 PIN 创建房间，随后进入观影会话。</p>{!canCreate ? <p>请先结束当前 Linkle 会话。</p> : null}<Button icon={<AddRegular />} disabled={!ready || !canJoin || !canCreate} onClick={() => void submit(true)}>创建并进入</Button></aside></div>
    {activeRoomId ? <p className="lobby-session-note">当前 Banguru 会话：<span>{activeRoomId}</span></p> : null}
  </section>
}
