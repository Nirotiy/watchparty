import { useEffect, useRef, useState } from "react"
import { Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Tab, TabList } from "@fluentui/react-components"
import { AddRegular, ArrowClockwiseRegular, DismissRegular, SearchRegular } from "@fluentui/react-icons"
import { useShellToast } from "@/components/shell-toast"
import type { LobbyFacade } from "@/hooks/use-lobby-facade"
import type { RoomIdentity, RoomSummaryRecord } from "../../shared/lobby-contract"

type Filter = "all" | "public" | "private"
// Browsing preferences live only for this app run, and are scoped to the service origin.
const browsing = new Map<string, { query: string; filter: Filter; selected: string | null; scroll: number }>()

export function LobbyView({ facade, origin, busy, activeRoom }: { facade: LobbyFacade; origin: string; busy: boolean; activeRoom: RoomIdentity | null }) {
  const cached = browsing.get(origin)
  const [rooms, setRooms] = useState<RoomSummaryRecord[]>([])
  const [selected, setSelected] = useState<string | null>(cached?.selected ?? null)
  const [query, setQuery] = useState(cached?.query ?? "")
  const [filter, setFilter] = useState<Filter>(cached?.filter ?? "all")
  const [message, setMessage] = useState("")
  const [formError, setFormError] = useState("")
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [form, setForm] = useState<"join" | "create" | null>(null)
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [privateRoom, setPrivateRoom] = useState(false)
  const [discard, setDiscard] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const request = useRef(0)
  const notify = useShellToast()
  const visible = rooms.filter(room => room.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (filter === "all" || room.visibility === filter))
  const room = rooms.find(item => item.roomId === selected) ?? null
  const disabled = busy || pending
  const dirty = Boolean(name || password || privateRoom)

  async function refresh() {
    const id = ++request.current
    setLoading(true); setMessage("")
    try { const result = await facade.listRooms(); if (id === request.current) setRooms(result) }
    catch { if (id === request.current) setMessage("无法读取 Linkle 房间列表。请在下方“服务与账号”检查服务器地址，确认服务运行后重试。") }
    finally { if (id === request.current) setLoading(false) }
  }
  useEffect(() => {
    const saved = browsing.get(origin)
    setQuery(saved?.query ?? ""); setFilter(saved?.filter ?? "all"); setSelected(saved?.selected ?? null)
    setRooms([]); setShowDetail(false); void refresh()
    return () => { request.current++ }
  }, [origin])
  useEffect(() => { browsing.set(origin, { query, filter, selected, scroll: browsing.get(origin)?.scroll ?? 0 }) }, [origin, query, filter, selected])
  useEffect(() => { if (!loading && list.current) list.current.scrollTop = browsing.get(origin)?.scroll ?? 0 }, [loading, origin])
  function closeDetail() { setShowDetail(false); document.getElementById(`linkle-room-${room?.roomId}`)?.focus() }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || dialog.current?.open) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const editing = Boolean(target?.matches("input,textarea,select") || target?.isContentEditable)
      if ((event.key === "/" && !editing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) { event.preventDefault(); search.current?.focus() }
      if (event.key === "Escape" && showDetail) { event.preventDefault(); closeDetail() }
    }
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key)
  }, [room?.roomId, showDetail])
  function open(next: NonNullable<typeof form>) { trigger.current = document.activeElement as HTMLElement; setName(""); setPassword(""); setPrivateRoom(false); setDiscard(false); setFormError(""); setForm(next); dialog.current?.showModal() }
  function requestClose() { if (pending) return; if (dirty) setDiscard(true); else dialog.current?.close() }
  async function submit() {
    if (disabled) return
    setPending(true); setFormError("")
    try {
      if (form === "create") { await facade.createRoom({ name: name.trim(), isPrivate: privateRoom, password: privateRoom ? password : undefined }); await refresh(); notify("房间已创建。选择它后确认加入。", "success") }
      else if (form === "join" && room) { await facade.joinRoom(room, password || undefined) }
      dialog.current?.close()
    } catch { const text = form === "create" ? "无法创建房间，请检查连接和创建权限。" : "无法加入房间，请检查密码和服务连接后重试。"; setFormError(text) }
    finally { setPending(false) }
  }
  return <section className="linkle-lobby" aria-label="Linkle 一起听">
    <header className="lobby-header"><div><h1>Linkle</h1><p>浏览音乐房间，加入后同步收听。</p></div><div className="lobby-actions"><Input ref={search} className="lobby-search" contentBefore={<SearchRegular />} aria-label="搜索 Linkle 房间" value={query} onChange={(_, data) => setQuery(data.value)} placeholder="搜索房间" /><Button icon={<ArrowClockwiseRegular />} onClick={() => void refresh()} disabled={loading}>{loading ? "正在刷新" : "刷新"}</Button><Button appearance="primary" icon={<AddRegular />} onClick={() => open("create")} disabled={disabled || !facade.canCreateRoom} title={facade.canCreateRoom ? undefined : "请先连接 Linkle 服务"}>创建房间</Button></div></header>
    {!facade.canCreateRoom ? <p className="lobby-hint">连接 Linkle 服务后可创建房间。</p> : null}
    {message ? <MessageBar intent="error" className="lobby-service-hint"><MessageBarBody>{message} <Button appearance="transparent" onClick={() => void refresh()}>重试</Button></MessageBarBody></MessageBar> : null}
    <TabList className="lobby-filters" selectedValue={filter} onTabSelect={(_, data) => { setFilter(data.value as Filter); setShowDetail(false) }} aria-label="房间访问类型"><Tab value="all">全部</Tab><Tab value="public">公开</Tab><Tab value="private">私密</Tab></TabList>
    <div className={showDetail && room ? "lobby-directory" : "lobby-directory no-detail"}>
      <div ref={list} className="lobby-list-scroll" aria-busy={loading} onScroll={event => browsing.set(origin, { query, filter, selected, scroll: event.currentTarget.scrollTop })}>
        {loading ? <p className="lobby-empty" role="status">正在获取 Linkle 房间…</p> : <><table className="lobby-table"><caption>上下键选择房间，Enter 查看详情。</caption><thead><tr><th>房间</th><th>访问</th><th>人数</th></tr></thead><tbody>{visible.map((item, index) => <tr key={`${item.origin}:${item.roomId}`} className={item.roomId === selected ? "selected" : undefined}><td><button id={`linkle-room-${item.roomId}`} className="room-button" aria-pressed={item.roomId === selected} onClick={() => { setSelected(item.roomId); setShowDetail(true) }} onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]; setSelected(next.roomId); document.getElementById(`linkle-room-${next.roomId}`)?.focus() }
          else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(item.roomId); setShowDetail(true) }
        }}>{item.name}{activeRoom?.service === "musicparty" && activeRoom.origin === item.origin && activeRoom.roomId === item.roomId ? <small>当前活动会话</small> : null}</button></td><td>{item.visibility === "private" ? "私密" : "公开"}</td><td>{item.memberCount ?? "未知"}</td></tr>)}</tbody></table>{!visible.length ? <div className="lobby-empty"><strong>{query || filter !== "all" ? "没有匹配的房间" : "当前没有可浏览的音乐房间"}</strong>{query || filter !== "all" ? <Button onClick={() => { setQuery(""); setFilter("all") }}>清除筛选</Button> : null}</div> : null}</>}
      </div>
      {showDetail && room ? <><button className="lobby-detail-backdrop" aria-label="关闭房间详情" onClick={closeDetail} /><aside className="lobby-inspector" aria-label="Linkle 房间摘要"><div><h2>{room.name}</h2><Button appearance="subtle" icon={<DismissRegular />} aria-label="关闭房间摘要" onClick={closeDetail} /></div><dl><dt>服务</dt><dd>Linkle</dd><dt>房间编号</dt><dd className="mono">{room.roomId}</dd><dt>访问</dt><dd>{room.visibility === "private" ? "需要密码" : "公开房间"}</dd><dt>人数</dt><dd>{room.memberCount ?? "暂不可用"}</dd></dl>{activeRoom?.service === "musicparty" && activeRoom.origin === room.origin && activeRoom.roomId === room.roomId ? <Button disabled>已在此房间</Button> : <Button appearance="primary" disabled={disabled} onClick={() => open("join")}>加入房间</Button>}<p>加入后查看播放、队列与成员。</p></aside></> : null}
    </div>
    <p className="sr-only" role="status" aria-live="polite">{room ? `已选择 ${room.name}` : "未选择房间"}</p>
    <dialog ref={dialog} className="lobby-dialog" aria-labelledby="linkle-dialog-title" onCancel={event => { event.preventDefault(); if (discard) setDiscard(false); else requestClose() }} onClick={event => { if (event.target === event.currentTarget && !dirty) requestClose() }} onClose={() => { setForm(null); setPassword(""); setName(""); setPrivateRoom(false); setDiscard(false); trigger.current?.focus() }}>
      {discard ? <div><h2 id="linkle-dialog-title">放弃填写的内容？</h2><p>房间名称与密码不会保存。</p><footer><Button autoFocus onClick={() => setDiscard(false)}>继续编辑</Button><Button appearance="primary" onClick={() => dialog.current?.close()}>放弃</Button></footer></div> : <form onSubmit={event => { event.preventDefault(); void submit() }} aria-busy={pending}>
        <h2 id="linkle-dialog-title">{form === "create" ? "创建 Linkle 房间" : `加入 ${room?.name ?? "房间"}`}</h2>
        {form === "create" ? <><Field label="房间名称" required><Input autoFocus required value={name} disabled={pending} onChange={(_, data) => setName(data.value)} /></Field><Checkbox label="私密房间" checked={privateRoom} disabled={pending} onChange={(_, data) => setPrivateRoom(Boolean(data.checked))} /></> : <p>{activeRoom ? "确认后将切换活动会话，连接失败时尝试恢复原房间。" : "加入后同步房间的播放与队列。"}</p>}
        {(form === "join" && room?.requiresPassword) || (form === "create" && privateRoom) ? <Field label="房间密码" required><Input type="password" autoComplete="off" required value={password} disabled={pending} onChange={(_, data) => setPassword(data.value)} /></Field> : null}
        {formError ? <MessageBar intent="error"><MessageBarBody>{formError}</MessageBarBody></MessageBar> : null}
        <footer><Button type="button" disabled={pending} onClick={requestClose}>取消</Button><Button type="submit" appearance="primary" disabled={disabled || (form === "create" && !name.trim())}>{pending ? (form === "create" ? "正在创建" : "正在加入") : form === "create" ? "创建房间" : "加入房间"}</Button></footer>
      </form>}
    </dialog>
  </section>
}
