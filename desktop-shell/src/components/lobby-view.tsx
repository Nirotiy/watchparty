import { useEffect, useRef, useState, type ReactNode } from "react"
import { Button, Checkbox, Field, Input, MessageBar, MessageBarBody } from "@fluentui/react-components"
import { AddRegular, ArrowClockwiseRegular, ChevronLeftRegular, DeleteRegular, EditRegular, KeyRegular, MusicNote2Regular, PulseRegular, SearchRegular } from "@fluentui/react-icons"
import { useShellToast } from "@/components/shell-toast"
import type { LobbyFacade } from "@/hooks/use-lobby-facade"
import { probeMusicParty, type MusicPartyProbe } from "../../shared/musicparty-adapter"
import { invoke } from "../../shared/desktop-runtime"
import type { RoomIdentity, RoomSummaryRecord } from "../../shared/lobby-contract"

type Filter = "all" | "public" | "private"
// Browsing preferences live only for this app run, and are scoped to the service origin.
const browsing = new Map<string, { query: string; filter: Filter; selected: string | null; scroll: number }>()

export function LobbyView({ facade, origin, busy, activeRoom, onRedeemInvite, accountPanel }: {
  facade: LobbyFacade
  origin: string
  busy: boolean
  activeRoom: RoomIdentity | null
  onRedeemInvite: (code: string) => Promise<{ roomId: string; roomName?: string }>
  /** 服务与账号的配置面板：由 App 组装，点顶部卡片的按钮后替换探测内容（用户 2026-09-25）。 */
  accountPanel?: ReactNode
}) {
  const cached = browsing.get(origin)
  const [rooms, setRooms] = useState<RoomSummaryRecord[]>([])
  const [selected, setSelected] = useState<string | null>(cached?.selected ?? null)
  const [query, setQuery] = useState(cached?.query ?? "")
  const [filter, setFilter] = useState<Filter>(cached?.filter ?? "all")
  const [formError, setFormError] = useState("")
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [probing, setProbing] = useState(false)
  const [checked, setChecked] = useState<MusicPartyProbe | null>(null)
  const [invite, setInvite] = useState("")
  const [inviteError, setInviteError] = useState("")
  const [inviteBusy, setInviteBusy] = useState(false)
  const [form, setForm] = useState<"join" | "create" | "rename" | "delete" | null>(null)
  const [target, setTarget] = useState<RoomSummaryRecord | null>(null)
  const [renameFrom, setRenameFrom] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [privateRoom, setPrivateRoom] = useState(false)
  const [showAccount, setShowAccount] = useState(false)
  const [discard, setDiscard] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const request = useRef(0)
  const notify = useShellToast()
  // Naming the missing thing (a guest identity, a credential) is the difference between a
  // hint and a dead end; a bare "connect first" line under the toolbar was noise instead
  // (用户 2026-09-24)：服务连不上时右上角的 popup 已经在说这件事了。
  const createBlockedReason = facade.canCreateRoom ? null
    : facade.createReadiness.isGuest ? "访客会话不能创建房间。用邀请码加入一个房间后即可建房。"
    : facade.createReadiness.serverSupportsCreate && !facade.createReadiness.hasAccount ? "本机还没有 Linkle 凭据，请先输入邀请码。"
    : null
  const visible = rooms.filter(room => room.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (filter === "all" || room.visibility === filter))
  const room = target ?? rooms.find(item => item.roomId === selected) ?? null
  const disabled = busy || pending
  // A rename opens with the current name already filled in, so "dirty" has to mean "changed".
  const dirty = form === "rename" ? name !== renameFrom : Boolean(name || password || privateRoom)
  const inside = (item: RoomSummaryRecord | null) => Boolean(item && activeRoom?.service === "musicparty" && activeRoom.origin === item.origin && activeRoom.roomId === item.roomId)
  // The page shows the connection's own probe; a manual check only adds a fresher reading.
  const probe = checked ?? facade.probe
  const probeTone = probe && probe.status !== "ok" ? probe.status === "incompatible" ? " nt" : " no" : ""

  async function refresh() {
    const id = ++request.current
    setLoading(true)
    try { const result = await facade.listRooms(); if (id === request.current) setRooms(result) }
    // 顶部 popup（用户 2026-09-24）：这条错误属于「这块内容读不出来」，压在列表上方会跟着列表一起被忽略。
    // 没填地址时不弹——连接卡本身就在讲这件事，进一次大厅弹一次等于噪音。
    catch { if (id === request.current && origin) notify("无法读取 Linkle 房间列表。请在「服务与账号」检查服务器地址，确认服务运行后重试。", "error", "top") }
    finally { if (id === request.current) setLoading(false) }
  }
  useEffect(() => {
    const saved = browsing.get(origin)
    setQuery(saved?.query ?? ""); setFilter(saved?.filter ?? "all"); setSelected(saved?.selected ?? null)
    setRooms([]); setChecked(null); void refresh()
    return () => { request.current++ }
  }, [origin])
  useEffect(() => { browsing.set(origin, { query, filter, selected, scroll: browsing.get(origin)?.scroll ?? 0 }) }, [origin, query, filter, selected])
  useEffect(() => { if (!loading && list.current) list.current.scrollTop = browsing.get(origin)?.scroll ?? 0 }, [loading, origin])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || dialog.current?.open) return
      const element = event.target instanceof HTMLElement ? event.target : null
      const editing = Boolean(element?.matches("input,textarea,select") || element?.isContentEditable)
      if ((event.key === "/" && !editing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) { event.preventDefault(); search.current?.focus() }
    }
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key)
  }, [])
  /** The dialog always works on one explicit room: rows act on their own row, not on a stale selection. */
  function open(next: NonNullable<typeof form>, forRoom: RoomSummaryRecord | null = room) {
    trigger.current = document.activeElement as HTMLElement
    setTarget(forRoom); setName(""); setRenameFrom(""); setPassword(""); setPrivateRoom(false); setDiscard(false); setFormError(""); setForm(next); dialog.current?.showModal()
  }
  /** A rename starts from the room's current name. */
  function openManage(next: "rename" | "delete", forRoom: RoomSummaryRecord) {
    const current = next === "rename" ? forRoom.name : ""
    trigger.current = document.activeElement as HTMLElement
    setTarget(forRoom); setName(current); setRenameFrom(current); setPassword(""); setPrivateRoom(false); setDiscard(false); setFormError(""); setForm(next); dialog.current?.showModal()
  }
  function requestClose() { if (pending) return; if (dirty) setDiscard(true); else dialog.current?.close() }
  /** Read-only server probe (health / capabilities / account) through the native channel. */
  async function checkServer() {
    if (probing || !origin) return
    setProbing(true)
    try { setChecked(await probeMusicParty({ origin, nativeInvoke: invoke })) }
    catch { notify("无法完成服务器探测，请稍后重试。", "error") }
    finally { setProbing(false) }
  }
  /** The invite is the shortest path into a friend's room, so it lives on the first screen. */
  async function redeemInvite(event: React.FormEvent) {
    event.preventDefault()
    const code = invite.trim()
    if (!code || inviteBusy) return
    setInviteBusy(true); setInviteError("")
    try {
      const result = await onRedeemInvite(code)
      setInvite("")
      notify(`已进入 ${result.roomName ?? result.roomId}`, "success")
    } catch (error) {
      setInviteError(error instanceof Error && error.message && error.message !== "http-error" ? error.message : "邀请兑换失败，请确认邀请码有效")
    } finally { setInviteBusy(false) }
  }
  async function submit() {
    if (disabled) return
    setPending(true); setFormError("")
    try {
      if (form === "create") { await facade.createRoom({ name: name.trim(), isPrivate: privateRoom, password: privateRoom ? password : undefined }); await refresh(); notify("房间已创建。选择它后确认加入。", "success") }
      else if (form === "join" && room) { await facade.joinRoom(room, password || undefined) }
      else if (form === "rename" && room) { await facade.renameRoom(room, name); await refresh(); notify("房间名称已更新。", "success") }
      else if (form === "delete" && room) { const gone = room; await facade.deleteRoom(gone); setRooms(items => items.filter(item => item.roomId !== gone.roomId)); setSelected(null); setTarget(null); await refresh(); notify(`已删除「${gone.name}」，队列、聊天与成员关系一并清除。`, "success") }
      dialog.current?.close()
    } catch (error) {
      // The bridge names why management was refused; repeating a generic "check permissions" would
      // hide the difference between "not your room" and "your session expired".
      const reason = error instanceof Error ? error.message : ""
      setFormError(reason === "room_manage_forbidden" ? "这台机器不是该房间的创建者，或服务端未开放房主管理。"
        : reason === "room_manage_unauthorized" ? "本机凭据已失效，请重新输入邀请码。"
        : reason === "room_manage_not-found" ? "该房间已经不存在，请刷新列表。"
        : form === "create" ? "无法创建房间，请检查连接和创建权限。"
        : form === "rename" || form === "delete" ? "房间管理失败，请稍后重试。"
        : "无法加入房间，请检查密码和服务连接后重试。")
    }
    finally { setPending(false) }
  }
  return <section className="linkle-lobby" aria-label="Linkle 一起听">
    <header className="lobby-header"><div><h1>Linkle</h1><p>先确认连接，再决定去哪个房间。</p></div></header>

    <div className="lobby-connect">
      <section className="lobby-card" aria-label={showAccount ? "服务与账号" : "当前服务器"}>
        {showAccount ? <>
          <div className="lobby-card-head">
            <strong>服务与账号</strong>
            <span className="lobby-head-right">
              {probe ? <span className={`lobby-account${probe.account ? "" : " muted"}`}>{probe.account ? probe.account.displayName || probe.account.publicId : "本机尚未登录"}</span> : null}
              <Button appearance="subtle" size="small" icon={<ChevronLeftRegular />} aria-label="返回服务器信息" title="返回服务器信息" onClick={() => setShowAccount(false)} />
            </span>
          </div>
          <div className="lobby-account-panel">{accountPanel}</div>
        </> : <>
          <div className="lobby-card-head">
            <span className={`lobby-dot${probe?.status === "incompatible" ? " nt" : probe?.status === "unreachable" ? " no" : ""}`} aria-hidden="true" />
            <strong>{probe ? probe.status === "ok" ? "已连接" : probe.status === "incompatible" ? "版本不兼容" : "无法连接" : "正在检查服务器"}</strong>
            {probe?.apiVersion ? <span className="lobby-tag">API {probe.apiVersion}</span> : null}
            {probe ? <span className={`lobby-account${probe.account ? "" : " muted"}`}>{probe.account ? probe.account.displayName || probe.account.publicId : "本机尚未登录"}</span> : null}
          </div>
          <dl className="lobby-kv">
            <dt>服务器</dt><dd className="mono">{origin || "未配置"}</dd>
            <dt>服务版本</dt><dd>{probe?.serverVersion ?? "未知"}</dd>
            <dt>已启用平台</dt><dd>{probe?.providers.length ? probe.providers.join(" · ") : "未知"}</dd>
          </dl>
          <p className={`lobby-note${probeTone}`} role="status">{probe?.message ?? "还没有这台服务器的探测结果。"}</p>
          <div className="lobby-card-actions">
            <Button icon={<PulseRegular />} onClick={() => void checkServer()} disabled={probing || !origin}>{probing ? "正在检查" : "检查服务器"}</Button>
            <Button appearance="subtle" onClick={() => setShowAccount(true)}>服务与账号</Button>
          </div>
        </>}
      </section>

      <section className="lobby-card" aria-label="邀请码">
        <div className="lobby-card-head"><KeyRegular className="lobby-card-icon" /><strong>有邀请码？</strong></div>
        <p className="lobby-note">输入朋友给的邀请码，直接进入那个房间。</p>
        <form className="lobby-invite" onSubmit={event => void redeemInvite(event)}>
          <Input value={invite} onChange={(_, data) => { setInvite(data.value); setInviteError("") }} placeholder="粘贴邀请码" aria-label="邀请码" disabled={inviteBusy} />
          <Button type="submit" appearance="primary" disabled={inviteBusy || !invite.trim()}>{inviteBusy ? "正在进入" : "进入房间"}</Button>
        </form>
        {inviteError ? <MessageBar intent="error"><MessageBarBody>{inviteError}</MessageBarBody></MessageBar> : null}
      </section>
    </div>

    <div className="lobby-rooms">
      <div className="lobby-rooms-head">
        <div className="lobby-rooms-title"><h2>浏览房间</h2><span className="muted">{visible.length} 个</span></div>
        <div className="lobby-filters" role="group" aria-label="房间访问类型">
          {([["all", "全部"], ["public", "公开"], ["private", "私密"]] as const).map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? "lobby-chip on" : "lobby-chip"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <div className="lobby-rooms-actions">
          <Input ref={search} className="lobby-search" contentBefore={<SearchRegular />} aria-label="搜索 Linkle 房间" value={query} onChange={(_, data) => setQuery(data.value)} placeholder="搜索房间" />
          <Button icon={<ArrowClockwiseRegular />} onClick={() => void refresh()} disabled={loading}>{loading ? "正在刷新" : "刷新"}</Button>
          <Button appearance="primary" icon={<AddRegular />} onClick={() => open("create", null)} disabled={disabled || !facade.canCreateRoom} title={createBlockedReason ?? undefined}>创建房间</Button>
        </div>
      </div>
      {createBlockedReason ? <p className="lobby-hint">{createBlockedReason}</p> : null}
      <div ref={list} className="lobby-rows" aria-busy={loading} onScroll={event => browsing.set(origin, { query, filter, selected, scroll: event.currentTarget.scrollTop })}>
        <div className="lobby-row head" aria-hidden="true"><span>房间</span><span>访问</span><span className="c3">人数</span><span /></div>
        {visible.map((item, index) => (
          <div className={item.roomId === selected ? "lobby-row on" : "lobby-row"} key={`${item.origin}:${item.roomId}`}>
            <button
              id={`linkle-room-${item.roomId}`} className="lobby-room" aria-pressed={item.roomId === selected}
              onClick={() => setSelected(item.roomId)}
              onKeyDown={event => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]
                  setSelected(next.roomId); document.getElementById(`linkle-room-${next.roomId}`)?.focus()
                } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open("join", item) }
              }}
              aria-label={`${item.name}，${item.visibility === "private" ? "私密" : "公开"}，${item.memberCount ?? "人数未知"}${item.requiresPassword ? "，需要密码" : ""}${inside(item) ? "，当前活动会话" : ""}`}
            >
              {item.visibility === "private" ? <KeyRegular className="lobby-room-icon" /> : <MusicNote2Regular className="lobby-room-icon" />}
              <span className="lobby-room-name">{item.name}</span>
              {inside(item) ? <span className="lobby-tag">当前活动会话</span> : null}
              {facade.canManageRoom(item) ? <span className="lobby-tag muted">我创建的</span> : null}
            </button>
            <span className="lobby-vis">{item.visibility === "private" ? "私密" : "公开"}</span>
            <span className="lobby-count c3">{item.memberCount ?? "未知"}</span>
            <span className="lobby-row-actions">
              {facade.canManageRoom(item) ? <>
                <Button appearance="subtle" icon={<EditRegular />} aria-label={`重命名 ${item.name}`} onClick={() => openManage("rename", item)} />
                <Button appearance="subtle" icon={<DeleteRegular />} aria-label={`删除 ${item.name}`} disabled={inside(item)} title={inside(item) ? "请先离开该房间再删除" : "删除会清除队列、聊天与成员关系"} onClick={() => openManage("delete", item)} />
              </> : null}
              {inside(item)
                ? <Button disabled>已在此房间</Button>
                : <Button disabled={disabled} onClick={() => open("join", item)}>{item.requiresPassword ? "输入密码" : "进入"}</Button>}
            </span>
          </div>
        ))}
        {!visible.length && !loading ? (
          <div className="lobby-empty">
            <strong>{query || filter !== "all" ? "没有匹配的房间" : "当前没有可浏览的音乐房间"}</strong>
            {query || filter !== "all"
              ? <Button onClick={() => { setQuery(""); setFilter("all") }}>清除筛选</Button>
              : <Button appearance="primary" disabled={disabled || !facade.canCreateRoom} title={createBlockedReason ?? undefined} onClick={() => open("create", null)}>创建第一个房间</Button>}
          </div>
        ) : null}
        {loading ? <p className="lobby-empty" role="status">正在获取 Linkle 房间…</p> : null}
      </div>
    </div>
    <p className="sr-only" role="status" aria-live="polite">{room ? `已选择 ${room.name}` : "未选择房间"}</p>
    <dialog ref={dialog} className="lobby-dialog" aria-labelledby="linkle-dialog-title" onCancel={event => { event.preventDefault(); if (discard) setDiscard(false); else requestClose() }} onClick={event => { if (event.target === event.currentTarget && !dirty) requestClose() }} onClose={() => { setForm(null); setPassword(""); setName(""); setPrivateRoom(false); setDiscard(false); trigger.current?.focus() }}>
      {discard ? <div><h2 id="linkle-dialog-title">放弃填写的内容？</h2><p>房间名称与密码不会保存。</p><footer><Button autoFocus onClick={() => setDiscard(false)}>继续编辑</Button><Button appearance="primary" onClick={() => dialog.current?.close()}>放弃</Button></footer></div> : <form onSubmit={event => { event.preventDefault(); void submit() }} aria-busy={pending}>
        <h2 id="linkle-dialog-title">{form === "create" ? "创建 Linkle 房间" : form === "rename" ? `重命名 ${room?.name ?? "房间"}` : form === "delete" ? `删除「${room?.name ?? ""}」？` : `加入 ${room?.name ?? "房间"}`}</h2>
        {form === "create" ? <><Field label="房间名称" required><Input autoFocus required value={name} disabled={pending} onChange={(_, data) => setName(data.value)} /></Field><Checkbox label="私密房间" checked={privateRoom} disabled={pending} onChange={(_, data) => setPrivateRoom(Boolean(data.checked))} /></>
          : form === "rename" ? <Field label="房间名称" required><Input autoFocus required value={name} disabled={pending} onChange={(_, data) => setName(data.value)} /></Field>
          : form === "delete" ? <p>删除会一并清除该房间的队列、历史、聊天与成员关系，且不可撤销。房间列表会立即刷新。</p>
          : <p>{activeRoom ? "确认后将切换活动会话，连接失败时尝试恢复原房间。" : "加入后同步房间的播放与队列。"}</p>}
        {(form === "join" && room?.requiresPassword) || (form === "create" && privateRoom) ? <Field label="房间密码" required><Input type="password" autoComplete="off" required value={password} disabled={pending} onChange={(_, data) => setPassword(data.value)} /></Field> : null}
        {formError ? <MessageBar intent="error"><MessageBarBody>{formError}</MessageBarBody></MessageBar> : null}
        <footer><Button type="button" disabled={pending} onClick={requestClose}>取消</Button><Button type="submit" appearance={form === "delete" ? "outline" : "primary"} disabled={disabled || ((form === "create" || form === "rename") && !name.trim())}>{pending ? (form === "create" ? "正在创建" : form === "rename" ? "正在改名" : form === "delete" ? "正在删除" : "正在加入") : form === "create" ? "创建房间" : form === "rename" ? "保存名称" : form === "delete" ? "确认删除房间" : "加入房间"}</Button></footer>
      </form>}
    </dialog>
  </section>
}
