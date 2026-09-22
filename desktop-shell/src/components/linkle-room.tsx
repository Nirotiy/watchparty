import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownRegular, ArrowExitRegular, ArrowShuffleRegular, ArrowUpRegular, ChatMultipleRegular, DismissRegular,
  FullScreenMaximizeRegular, HeartRegular, LibraryRegular, MoreHorizontalRegular, MusicNote2PlayRegular,
  MusicNote2Regular, NextRegular, PauseRegular, PlayRegular, PreviousRegular, SearchRegular,
  SpeakerMuteRegular, TextBulletListLtrRegular, TimerRegular,
} from "@fluentui/react-icons"
import type { DomainEvent, MediaItem, SharedCommandKind, SharedRoomState } from "../../shared/domain"
import { sharedPositionMs } from "../../shared/shared-room-state"
import { MusicPartyPlaylistError } from "../../shared/musicparty-adapter"
import type { MusicPartyAdapter, MusicSearchResult, PlaylistScope, PlaylistSummary, PlaylistTrack } from "../../shared/musicparty-adapter"
import type { MusicMetadata } from "../../shared/musicparty-contract"
import type { MusicPartyConnection } from "../../shared/musicparty-connection"
import type { RoomIdentity } from "../../shared/lobby-contract"

type RoomPanel = "listen" | "queue" | "search" | "playlists" | "chat"
type LyricState = { status: "none" | "loading" | "ready" | "error"; lines: Array<{ atMs: number; text: string }> }

function formatTime(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

const CONNECTION_LABEL: Record<string, string> = {
  idle: "未连接", connecting: "正在连接", ready: "已连接", reconnecting: "正在重新连接", expired: "会话已过期", failed: "连接失败",
}

function parseLrc(text: string): Array<{ atMs: number; text: string }> {
  const lines: Array<{ atMs: number; text: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const body = raw.replace(/\[[^\]]*\]/g, "").trim()
    if (!body) continue
    for (const stamp of stamps) {
      const atMs = (Number(stamp[1]) * 60 + Number(stamp[2])) * 1000 + Number((stamp[3] ?? "0").padEnd(3, "0"))
      lines.push({ atMs, text: body })
    }
  }
  return lines.sort((left, right) => left.atMs - right.atMs)
}

/**
 * Linkle one-screen room workspace, P1: listen view + the floating player bar.
 * Shared commands ride the adapter's requestId channel (single in flight,
 * 2000ms timeout → unknown → throttled resync); local-only affordances never
 * send commands. Lyrics use the simplified renderer; the word-level spec is a
 * later phase.
 */
export function LinkleRoom({ room, connection, subscribeRoom, onLeave }: {
  room: RoomIdentity
  connection: MusicPartyConnection
  subscribeRoom: (listener: (event: DomainEvent) => void) => () => void
  onLeave: () => void
}) {
  const sharedRef = useRef<SharedRoomState | null>(null)
  const [, tick] = useState(0)
  const [queue, setQueue] = useState<MediaItem[]>([])
  const [members, setMembers] = useState<Array<{ id: string; name: string; online: boolean }>>([])
  const [chatUnread, setChatUnread] = useState(0)
  const [connLabel, setConnLabel] = useState("连接中")
  const [pendingKind, setPendingKind] = useState<string | null>(null)
  const [note, setNote] = useState("共享命令已接通 · requestId 单在途 · 2000ms 超时 → resync")
  const [panel, setPanel] = useState<RoomPanel>("listen")
  const panelRef = useRef<RoomPanel>("listen")
  panelRef.current = panel
  const [lyrics, setLyrics] = useState<LyricState>({ status: "none", lines: [] })
  const [timerOn, setTimerOn] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [menuOpen, setMenuOpen] = useState<"room" | "bar" | null>(null)
  const [seekOverride, setSeekOverride] = useState<number | null>(null)
  const [volume, setVolumeState] = useState(100)
  const lastVolume = useRef(100)
  const fadeRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  useEffect(() => subscribeRoom(event => {
    if (event.type === "shared-room-state") sharedRef.current = event.state
    else if (event.type === "command-pending") {
      setPendingKind(event.pending ? event.kind : null)
      if (event.pending) setNote(`→ ${event.kind} {requestId: ${event.requestId.slice(0, 8)}…} · 等待 control.ack（2000ms 超时）`)
    } else if (event.type === "denied") setNote(`control.ack rejected {code: ${event.code}} · 不自动重发`)
    else if (event.type === "queue-state") setQueue(event.items)
    else if (event.type === "members") setMembers(event.members)
    else if (event.type === "chat") { if (panelRef.current !== "chat") setChatUnread(value => value + 1) }
    else if (event.type === "connection") setConnLabel(CONNECTION_LABEL[event.status] ?? event.status)
  }), [subscribeRoom])

  useEffect(() => { if (panel === "chat") setChatUnread(0) }, [panel])

  // D4/D5 interpolation clock: the shared projection advances between frames.
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); if (fadeRef.current) clearInterval(fadeRef.current) }, [])

  const shared = sharedRef.current
  const item = shared?.item ?? null
  const positionMs = shared ? sharedPositionMs(shared, Date.now()) : 0
  const durationMs = shared?.durationMs ?? 0
  const paused = shared?.paused ?? true
  const hasTrack = Boolean(item)
  const locked = Boolean(shared && (shared.pauseLocked || shared.skipLocked || shared.shuffleLocked))

  // Lyrics follow the current track; simplified renderer, no word-level animation yet.
  const lyricKey = item ? `${item.source}:${item.id}` : ""
  useEffect(() => {
    if (!lyricKey) { setLyrics({ status: "none", lines: [] }); return }
    const [platform, songId] = lyricKey.split(":")
    let token = true
    setLyrics({ status: "loading", lines: [] })
    void adapterOf(connection)?.lyrics(platform, songId).then(text => {
      if (!token) return
      const lines = parseLrc(text)
      setLyrics(lines.length ? { status: "ready", lines } : { status: "none", lines: [] })
    }).catch(() => { if (token) setLyrics({ status: "error", lines: [] }) })
    return () => { token = false }
  }, [lyricKey, connection])

  const currentLyric = useMemo(() => {
    if (lyrics.status !== "ready") return -1
    let index = -1
    for (let i = 0; i < lyrics.lines.length; i += 1) if (lyrics.lines[i].atMs <= positionMs) index = i
    return index
  }, [lyrics, positionMs])

  const send = useCallback(async (kind: SharedCommandKind, payload: { positionMs?: number } = {}) => {
    const adapter = adapterOf(connection)
    if (!adapter) { setNote("未连接 Linkle 服务"); return }
    try {
      const outcome = await adapter.sendControl(kind, payload)
      if (outcome === "applied") setNote(`${kind} → control.ack applied · 已按 committed 水位对齐`)
      else if (outcome === "noop") setNote(`${kind} → control.ack noop · 无变化`)
      else if (outcome === "rejected") setNote(`${kind} → control.ack rejected · 服务已回执拒绝码`)
      else setNote(`${kind} → 超时 unknown · 已自动 player.resync（750ms 节流），不自动重发`)
    } catch (error) {
      setNote(`${kind} 未发送：${error instanceof Error ? error.message : "unknown"}（单在途通道未被占用）`)
    }
  }, [connection])

  function applyVolume(value: number, remember = true) {
    setVolumeState(value)
    if (value > 0 && remember) lastVolume.current = value
    const player = connection.audioPlayer
    if (player) void player.setVolume(value).catch(() => setNote("本机音量未生效（播放器未就绪）"))
  }

  // Sidecar is the volume owner: read its effective value back after (re)connects and track changes.
  const playEpoch = shared?.playEpoch ?? 0
  const volumeSyncKey = `${connLabel}:${playEpoch}`
  useEffect(() => {
    let token = true
    void connection.audioPlayer?.getVolume().then(value => {
      if (token && Number.isFinite(value)) { setVolumeState(value); if (value > 0) lastVolume.current = value }
    }).catch(() => undefined)
    return () => { token = false }
  }, [connection, volumeSyncKey])

  function toggleTimer() {
    if (timerRef.current || fadeRef.current) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      if (fadeRef.current) { clearInterval(fadeRef.current); fadeRef.current = null; applyVolume(lastVolume.current) }
      setTimerOn(false); setNote("睡眠定时已关闭 · 本机恢复跟随房间"); return
    }
    setTimerOn(true)
    setNote("睡眠定时已启动（30 分钟）· 到点只暂停本机输出，不停止房间播放、不发命令")
    const from = volume
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setTimerOn(false)
      // 渐弱按交接规格由前端分步发 Volume 递减实现。
      let current = from
      fadeRef.current = setInterval(() => {
        current = Math.max(0, current - 10)
        applyVolume(current, false)
        if (current <= 0) {
          clearInterval(fadeRef.current ?? undefined)
          fadeRef.current = null
          void connection.audioPlayer?.pause().catch(() => undefined)
          setNote("睡眠定时到点 · 已渐弱并暂停本机输出，房间不受影响；点扬声器按钮恢复音量")
        }
      }, 150)
    }, 30 * 60 * 1000)
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => setNote("全屏请求被拒绝"))
  }

  function leave() {
    if (!window.confirm("退出当前活动会话？")) return
    if (timerRef.current) clearTimeout(timerRef.current)
    void adapterOf(connection)?.disconnect()
    onLeave()
  }

  // Splitter: drag or arrow keys adjust the lyrics column; double-click resets.
  function setLyricsWidth(px: number) {
    const grid = gridRef.current
    if (!grid) return
    const width = grid.clientWidth
    const clamped = Math.min(Math.max(px, 240), Math.max(Math.min(Math.round(width * 0.65), width - 420), 240))
    grid.style.setProperty("--lyrics-w", `${clamped}px`)
  }
  function splitterKey(event: React.KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const grid = gridRef.current
    if (!grid) return
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ")
    const current = Math.round(parseFloat(columns[columns.length - 1])) || 0
    setLyricsWidth(event.key === "ArrowRight" ? current + 16 : current - 16)
  }

  const seekDisabled = !hasTrack
  const historyCursor = shared?.historyCursor ?? null
  // 「已知禁用不发送」：游标为 0（或服务端未上报）时上一首置灰且点击不发命令。
  const prevDisabled = !hasTrack || historyCursor === null || historyCursor <= 0
  const flags: Array<{ text: string; local?: boolean }> = []
  if (locked) flags.push({ text: `房间锁：${[shared?.pauseLocked && "暂停", shared?.skipLocked && "切歌", shared?.shuffleLocked && "随机"].filter(Boolean).join("/")}` })
  if (connLabel === "正在重新连接") flags.push({ text: "重连中 · 等待快照" })
  if (timerOn) flags.push({ text: "睡眠定时 · 仅本机", local: true })

  return (
    <div className="linkle-room" data-panel={panel}>
      <header className="roomhead">
        <div className="identity">
          <h2>{room.roomId}</h2>
          <p className="connection">{connLabel} · {members.length || "…"} 人</p>
        </div>
        <nav className="room-actions" aria-label="房间功能">
          <RoomTab icon={<MusicNote2Regular />} label="收听 · 当前曲目与接下来" active={panel === "listen"} onClick={() => setPanel("listen")} />
          <RoomTab icon={<SearchRegular />} label="点歌 · 搜索并加入队列" active={panel === "search"} onClick={() => setPanel("search")} />
          <RoomTab icon={<TextBulletListLtrRegular />} label="队列 · 批量管理与排序" active={panel === "queue"} onClick={() => setPanel("queue")} />
          <RoomTab icon={<LibraryRegular />} label="歌单 · 房间与个人歌单" active={panel === "playlists"} onClick={() => setPanel("playlists")} />
          <RoomTab icon={<ChatMultipleRegular />} label={`聊天与成员${chatUnread ? `，${chatUnread} 条未读` : ""}`} badge={chatUnread} active={panel === "chat"} onClick={() => setPanel("chat")} />
          <span className="tip end">
            <button type="button" className="i32" aria-label="更多房间功能" onClick={() => setMenuOpen(menuOpen === "room" ? null : "room")}><MoreHorizontalRegular /></button>
            <span className="tooltip" role="tooltip">更多房间功能</span>
          </span>
          <span className="tip end">
            <button type="button" className="i32" aria-label="离房 · 确认后退出活动会话" onClick={leave}><ArrowExitRegular /></button>
            <span className="tooltip" role="tooltip">离房 · 确认后退出活动会话</span>
          </span>
        </nav>
        {menuOpen === "room" ? (
          <>
            <button type="button" className="menu-backdrop" aria-label="关闭菜单" onClick={() => setMenuOpen(null)} />
            <div className="menu topmenu" role="menu">
              <h3>房间功能</h3>
              <button type="button" role="menuitem" onClick={() => { setPanel("chat"); setMenuOpen(null) }}>聊天与成员</button>
              <button type="button" role="menuitem" onClick={() => { setPanel("playlists"); setMenuOpen(null) }}>歌单与导出</button>
              <button type="button" role="menuitem" aria-disabled="true">房间设置（下一阶段）</button>
              <button type="button" role="menuitem" aria-disabled="true">来源与媒体管理（下一阶段）</button>
            </div>
          </>
        ) : null}
      </header>

      <div className="bodygrid" ref={gridRef}>
        <section className="task" aria-label="当前任务">
          {panel === "listen" ? (
            <div className="listen-view">
              {connLabel === "正在重新连接" ? <p className="notice warning">连接中断，正在重连。当前曲目与队列保留，等待最新房间状态。</p> : null}
              {locked ? <p className="notice warning">房间锁已启用：被锁命令将收到 rejected{"{code}"}，本机音量不受影响。</p> : null}
              <div className="album" aria-hidden="true"><MusicNote2Regular /><small>封面占位{item ? ` · ${item.source}` : ""}</small></div>
              {item ? (
                <>
                  <h3 className="current-track">{item.title}</h3>
                  <p className="trackmeta">{item.artist ?? "未知艺术家"}<br />{shared?.enqueuedByName ? `点歌者 ${shared.enqueuedByName} · ` : ""}仅点歌者或管理员可 seek（服务端裁决）</p>
                </>
              ) : (
                <div className="empty">
                  <h3>队列里还没有歌曲</h3>
                  <p>此刻点「暂停」将收到 rejected{"{NO_CURRENT_TRACK}"}。</p>
                </div>
              )}
              <section className="upnext" aria-label="接下来">
                <div className="sectionhead"><h3>接下来</h3><p>{Math.max(0, queue.length - (hasTrack ? 1 : 0))} 首 · 自动接续</p></div>
                <div className="upnext-list" tabIndex={0} aria-label="接下来的曲目，区域内滚动">
                  {(hasTrack ? queue.slice(1) : queue).map(entry => (
                    <div className="song" key={entry.id}>
                      <span className="upcover" aria-hidden="true"><MusicNote2Regular /></span>
                      <div><strong>{entry.title}</strong><small>{entry.artist ?? "未知艺术家"}{entry.durationSeconds ? ` · ${formatTime(entry.durationSeconds * 1000)}` : ""}</small></div>
                      <button type="button" className="i32" aria-label={`${entry.title} 的操作（下一阶段）`} aria-disabled="true"><MoreHorizontalRegular /></button>
                    </div>
                  ))}
                  {!queue.length ? <p className="lobby-empty">队列空 · 从点歌或歌单加入曲目</p> : null}
                </div>
              </section>
            </div>
          ) : panel === "queue" ? (
            <QueuePanel queue={queue} connection={connection} />
          ) : panel === "search" ? (
            <SearchPanel connection={connection} roomId={room.roomId} />
          ) : panel === "playlists" ? (
            <PlaylistsPanel connection={connection} queue={queue} />
          ) : (
            <ChatPanel connection={connection} subscribeRoom={subscribeRoom} members={members} enqueuerName={shared?.enqueuedByName ?? null} />
          )}
        </section>
        <div
          className="splitter" role="separator" aria-orientation="vertical"
          aria-label="调整歌词栏宽度（拖动或左右方向键，双击复位）" aria-valuemin={240} tabIndex={0}
          onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
          onPointerMove={event => { if (dragging.current) setLyricsWidth(event.currentTarget.getBoundingClientRect().right - event.clientX - 5) }}
          onPointerUp={() => { dragging.current = false }}
          onPointerCancel={() => { dragging.current = false }}
          onDoubleClick={() => { gridRef.current?.style.removeProperty("--lyrics-w") }}
          onKeyDown={splitterKey}
        />
        <aside className="lyrics" aria-label="歌词">
          <div className="lyric-content">
            {panel === "listen" ? null : <p className="muted">歌词仅在收听视图展示。</p>}
            {lyrics.status === "ready" ? (
              <div className="lyrictext">
                {lyrics.lines.map((line, index) => (
                  <p
                    key={`${line.atMs}-${index}`}
                    className={index === currentLyric ? "current" : undefined}
                    role="button" tabIndex={0}
                    aria-label={`跳转到 ${formatTime(line.atMs)}（发送 seek）`}
                    data-jump={formatTime(line.atMs)}
                    onClick={() => { if (!seekDisabled) void send("seek", { positionMs: line.atMs }) }}
                    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!seekDisabled) void send("seek", { positionMs: line.atMs }) } }}
                  >{line.text}</p>
                ))}
              </div>
            ) : (
              <div className="empty">
                <h3>{{ none: "暂无歌词", loading: "正在获取歌词", error: "歌词获取失败" }[lyrics.status]}</h3>
                <p>{{ none: "继续收听，歌词可用时显示在这里。", loading: "此处保留空间，播放控件不移动。", error: "播放不受影响，可稍后重试。" }[lyrics.status]}</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <div className="bar-holder">
        <p className="control-note" role="status" aria-live="polite">{pendingKind ? `在途命令（${pendingKind}）· 单在途通道 · 后续点击被忽略` : note}</p>
        <footer className="player" aria-label="唯一播放控制区">
          <div className="art" aria-hidden="true"><MusicNote2Regular /><small>{hasTrack ? "封面" : "无曲目"}</small></div>
          <div className="stack">
            <div className="info">
              <div className="copy">
                <strong>{item ? item.title : "暂无曲目"}</strong>
                <small>{item ? `${item.artist ?? "未知艺术家"} · ${shared?.enqueuedByName ? `点歌者 ${shared.enqueuedByName}` : room.roomId}` : "等待点歌"}</small>
              </div>
              <div className="flags">
                {flags.map(flag => <span key={flag.text} className={flag.local ? "flag local" : "flag"}>{flag.text}</span>)}
              </div>
            </div>
            <div className="progress">
              <input
                className="seek" type="range" min={0} max={Math.max(1, Math.round(durationMs / 1000))}
                value={seekOverride ?? Math.round(positionMs / 1000)} step={1}
                style={{ "--fill": `${(() => { const total = Math.max(1, Math.round(durationMs / 1000)); return ((seekOverride ?? Math.round(positionMs / 1000)) / total) * 100 })()}%` } as React.CSSProperties}
                aria-label={`房间播放进度（拖动即 control.seek，仅点歌者或管理员）${seekDisabled ? " · 当前无曲目" : ""}`}
                aria-disabled={seekDisabled}
                onInput={event => setSeekOverride(Number(event.currentTarget.value))}
                onBlur={() => setSeekOverride(null)}
                onKeyDown={event => { if (event.key === "Escape") setSeekOverride(null) }}
                onChange={event => {
                  const seconds = Number(event.currentTarget.value)
                  setSeekOverride(null)
                  if (!seekDisabled) void send("seek", { positionMs: seconds * 1000 })
                }}
              />
            </div>
            <div className="controls">
              <div className="grp">
                <span className="tip">
                  <button type="button" className="i32 big" aria-label={paused ? "继续整个房间" : "暂停整个房间"} disabled={!hasTrack || Boolean(pendingKind)}
                    onClick={() => void send(paused ? "play" : "pause")}>
                    {paused ? <PlayRegular /> : <PauseRegular />}
                  </button>
                  <span className="tooltip" role="tooltip">暂停 / 继续 · 共享 <code>control.toggle-pause</code> · 受暂停锁约束</span>
                </span>
                <span className="tip">
                  <button type="button" className="i32 big" aria-label="上一首（房间）" disabled={prevDisabled || Boolean(pendingKind)}
                    onClick={() => void send("previous")}>
                    <PreviousRegular />
                  </button>
                  <span className="tooltip" role="tooltip">上一首 · 共享 <code>control.previous{"{expectedPlayEpoch}"}</code> · 历史游标 {historyCursor ?? "—"}，为 0 时禁用不发送 · 受切歌锁约束</span>
                </span>
                <span className="tip">
                  <button type="button" className="i32 big" aria-label="房间下一首" disabled={!hasTrack || Boolean(pendingKind)}
                    onClick={() => void send("next")}>
                    <NextRegular />
                  </button>
                  <span className="tooltip" role="tooltip">下一首 · 共享 <code>control.next</code> · 受切歌锁约束</span>
                </span>
                <span className="time">{formatTime(positionMs)} / {formatTime(durationMs)}</span>
              </div>
              <div className="grp volume">
                <span className="tip">
                  <button type="button" className="i32" aria-label={volume <= 0 ? "恢复本机音量" : "本机静音"} aria-pressed={volume <= 0}
                    onClick={() => applyVolume(volume <= 0 ? (lastVolume.current || 65) : 0)}>
                    <SpeakerMuteRegular />
                  </button>
                  <span className="tooltip" role="tooltip">静音 · 本机（D5 <code>musicPartyAudio</code> volume 0/恢复），不影响房间</span>
                </span>
                <input className="slider" type="range" min={0} max={100} value={Math.round(volume)} step={1}
                  aria-label={`本机音量 ${Math.round(volume)}，仅本机，不发送房间命令`}
                  onChange={event => applyVolume(Number(event.currentTarget.value))} />
              </div>
              <div className="grp extras">
                <span className="tip ov-c">
                  <button type="button" className="i32" aria-label="喜欢" disabled={!hasTrack || Boolean(pendingKind)} onClick={() => void send("like")}><HeartRegular /></button>
                  <span className="tooltip" role="tooltip">喜欢 · 共享 <code>control.like{"{expectedPlayEpoch}"}</code> · 幂等，重复点赞为 noop</span>
                </span>
                <span className="tip">
                  <button type="button" className="i32" aria-label="房间随机" aria-pressed={shared?.shuffle === true} disabled={Boolean(pendingKind)} onClick={() => void send("shuffle")}><ArrowShuffleRegular /></button>
                  <span className="tooltip" role="tooltip">随机 · 共享 <code>control.toggle-shuffle</code> · 受独立随机锁约束</span>
                </span>
                <span className="tip ov-b">
                  <button type="button" className="i32" aria-label="歌词当前行" onClick={() => {
                    const current = currentLyric
                    if (current >= 0) document.querySelector(".linkle-room .lyrictext")?.children[current]?.scrollIntoView({ block: "center", behavior: "smooth" })
                  }}><MusicNote2PlayRegular /></button>
                  <span className="tooltip" role="tooltip">歌词 · 本机视图，跳到当前行，不改变房间进度</span>
                </span>
                <span className="tip ov-a">
                  <button type="button" className="i32" aria-label="队列视图" onClick={() => setPanel("queue")}><TextBulletListLtrRegular /></button>
                  <span className="tooltip" role="tooltip">队列 · 本机视图切换（内容变更走 <code>queue.*</code>，P2 植入）</span>
                </span>
                <span className="tip ov-a">
                  <button type="button" className="i32" aria-label="睡眠定时（仅本机，30 分钟）" aria-pressed={timerOn} onClick={toggleTimer}><TimerRegular /></button>
                  <span className="tooltip" role="tooltip">睡眠定时 · <strong>只影响本机</strong>，到点暂停本机输出，不停止房间播放、不发命令</span>
                </span>
                <span className="tip ov-a">
                  <button type="button" className="i32" aria-label="全屏" onClick={toggleFullscreen}><FullScreenMaximizeRegular /></button>
                  <span className="tooltip" role="tooltip">全屏 · 本机窗口形态，不发命令</span>
                </span>
                <span className="tip">
                  <button type="button" className="i32" aria-label="更多播放选项" onClick={() => setMenuOpen(menuOpen === "bar" ? null : "bar")}><MoreHorizontalRegular /></button>
                </span>
              </div>
            </div>
          </div>
        </footer>
        {menuOpen === "bar" ? (
          <>
            <button type="button" className="menu-backdrop" aria-label="关闭菜单" onClick={() => setMenuOpen(null)} />
            <div className="menu barmenu" role="menu">
              <h3>更多播放选项</h3>
              <button type="button" role="menuitem" aria-disabled="true">播放设置（不加重复 / 迷你 / 速度 / 设备）</button>
              <button type="button" role="menuitem" onClick={() => { setPanel("chat"); setMenuOpen(null) }}>聊天与成员</button>
              <button type="button" role="menuitem" aria-disabled="true">键盘快捷键（后续边界对齐）</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

function adapterOf(connection: MusicPartyConnection): MusicPartyAdapter | null {
  return connection.current
}

function errCode(error: unknown): string {
  if (error instanceof MusicPartyPlaylistError) return error.code
  return error instanceof Error ? error.message : "unknown"
}

function toMusicMetadata(entry: MediaItem): MusicMetadata | null {
  const id = entry.musicId ?? entry.id
  if (!id || !entry.title || !entry.source) return null
  const duration = entry.durationSeconds != null && Number.isFinite(entry.durationSeconds) ? Math.max(0, Math.round(entry.durationSeconds * 1000)) : 0
  return { id, name: entry.title, artists: entry.artist ? entry.artist.split(", ") : [], duration, platform: entry.source as MusicMetadata["platform"], coverUrl: entry.artworkUrl ?? "" }
}

/** Queue view: multi-select removal plus per-row top / move, all riding S2 mutationIds. */
function QueuePanel({ queue, connection }: { queue: MediaItem[]; connection: MusicPartyConnection }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = useState("")
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveTargets, setSaveTargets] = useState<PlaylistSummary[]>([])
  const [saveBusy, setSaveBusy] = useState(false)
  const adapter = () => adapterOf(connection)
  function toggle(id: string) {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function removeSelected() {
    const target = adapter()
    if (!target) { setMessage("未连接 Linkle 服务"); return }
    let sent = 0
    for (const id of selected) if (target.sendQueueMutation("queue.remove", id)) sent += 1
    setSelected(new Set())
    setMessage(`已发送 ${sent} 项移除命令（mutationId 幂等）· 以服务端队列更新为准`)
  }
  function move(id: string, direction: "up" | "down") {
    const target = adapter()
    if (!target) return
    const index = queue.findIndex(entry => entry.id === id)
    const neighbor = queue[direction === "up" ? index - 1 : index + 1]
    if (!neighbor) return
    target.reorderQueue(id, neighbor.id, direction === "up" ? "before" : "after")
    setMessage("已发送排序命令 · 以服务端队列更新为准")
  }
  async function clearAll() {
    const target = adapter()
    if (!target) { setMessage("未连接 Linkle 服务"); return }
    if (!queue.length) { setMessage("队列已经是空的"); return }
    if (!window.confirm(`清空房间队列（${queue.length} 首）？此操作对全房间生效，其他成员会同步收到清空。`)) return
    setMessage("已发送 queue.clear · 等待服务端回执…")
    const ok = await target.clearQueue()
    setMessage(ok ? "已发送清空并获回执 · queue.patch(clear) 同步到全员" : "清空未获确认：超时或被服务端拒绝")
  }
  async function openSave() {
    const target = adapter()
    if (!target) { setMessage("未连接 Linkle 服务"); return }
    setSaveBusy(true)
    try {
      setSaveTargets(await target.listPlaylists("user"))
      setSaveOpen(true)
      setMessage("")
    } catch (error) { setMessage(`加载歌单失败：${errCode(error)}`) }
    finally { setSaveBusy(false) }
  }
  async function saveTo(playlistId: string | null) {
    const target = adapter()
    if (!target || !selected.size) return
    const items = queue.filter(entry => selected.has(entry.id)).map(entry => toMusicMetadata(entry))
    const music = items.filter((entry): entry is MusicMetadata => entry !== null)
    if (!music.length) { setMessage("选中项缺少可保存的曲目信息"); return }
    setSaveBusy(true)
    try {
      let id = playlistId
      if (!id) {
        const name = window.prompt("新建歌单名称", "我的歌单")?.trim()
        if (!name) { setSaveBusy(false); return }
        id = (await target.createPlaylist("user", name)).id
      }
      const result = await target.addPlaylistItems("user", id, music)
      setMessage(`已保存：新增 ${result.addedCount} 首，跳过重复 ${result.skippedCount} 首`)
      setSaveOpen(false)
      setSelected(new Set())
    } catch (error) { setMessage(`保存失败：${errCode(error)}`) }
    finally { setSaveBusy(false) }
  }
  return (
    <>
      <div className="sectionhead"><div><h3>播放队列</h3><p>{queue.length} 首 · 变更命令携带 S2 mutationId，ack/nack 关联回包</p></div></div>
      <div className="row inline-actions">
        <button type="button" disabled={selected.size === 0} onClick={removeSelected}>移出选中（{selected.size}）</button>
        <button type="button" disabled={selected.size === 0 || saveBusy} onClick={() => void openSave()}>保存至歌单</button>
        <button type="button" disabled={!queue.length || saveBusy} onClick={() => void clearAll()}>清空</button>
      </div>
      {saveOpen ? (
        <div className="notice" role="group" aria-label="选择目标歌单">
          <strong>保存选中到…</strong>
          <div className="row inline-actions">
            {saveTargets.filter(entry => !entry.systemKey).map(entry => (
              <button key={entry.id} type="button" disabled={saveBusy} onClick={() => void saveTo(entry.id)}>{entry.name}（{entry.trackCount}）</button>
            ))}
            <button type="button" disabled={saveBusy} onClick={() => void saveTo(null)}>新建歌单…</button>
            <button type="button" onClick={() => setSaveOpen(false)}>取消</button>
          </div>
        </div>
      ) : null}
      {queue.map((entry, index) => (
        <div className="song select" key={entry.id}>
          <input type="checkbox" aria-label={`选择 ${entry.title}`} checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} />
          <div><strong>{entry.title}</strong><small>{entry.artist ?? "未知艺术家"}{entry.durationSeconds ? ` · ${formatTime(entry.durationSeconds * 1000)}` : ""} · {entry.source}</small></div>
          <span className="actions">
            <button type="button" className="i32" aria-label={`上移 ${entry.title}`} disabled={index === 0} onClick={() => move(entry.id, "up")}><ArrowUpRegular /></button>
            <button type="button" className="i32" aria-label={`下移 ${entry.title}`} disabled={index === queue.length - 1} onClick={() => move(entry.id, "down")}><ArrowDownRegular /></button>
            <button type="button" className="i32" aria-label={`移出 ${entry.title}`} onClick={() => { if (adapter()?.sendQueueMutation("queue.remove", entry.id)) setMessage("已发送移除命令 · 以服务端队列更新为准") }}><DismissRegular /></button>
          </span>
        </div>
      ))}
      {!queue.length ? <div className="empty"><h3>队列是空的</h3><p>去点歌或从歌单加入曲目。</p></div> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
    </>
  )
}

/** Search-to-queue view backed by the desktop search and enqueue endpoints. */
function SearchPanel({ connection, roomId }: { connection: MusicPartyConnection; roomId: string }) {
  const [platforms, setPlatforms] = useState<Array<{ id: string; name: string }>>([{ id: "netease", name: "网易云" }, { id: "youtube", name: "YouTube" }, { id: "bilibili", name: "Bilibili" }])
  const [platform, setPlatform] = useState("netease")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<MusicSearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  useEffect(() => {
    const adapter = adapterOf(connection)
    if (!adapter) return
    let token = true
    void adapter.listPlatforms().then(list => { if (token && list.length) setPlatforms(list) }).catch(() => undefined)
    return () => { token = false }
  }, [connection])
  async function run(event: React.FormEvent) {
    event.preventDefault()
    const adapter = adapterOf(connection)
    if (!adapter || !query.trim()) return
    setBusy(true); setMessage("")
    try {
      const found = await adapter.search(platform, query.trim(), roomId)
      setResults(found)
      if (!found.length) setMessage("没有匹配的曲目")
    } catch { setMessage("搜索失败，请检查服务连接") }
    finally { setBusy(false) }
  }
  async function enqueue(result: MusicSearchResult) {
    const adapter = adapterOf(connection)
    if (!adapter) { setMessage("未连接 Linkle 服务"); return }
    const ok = await adapter.enqueue(result.platform, result.sourceId)
    setMessage(ok ? `已加入队列：${result.title}` : `入队未获服务端确认：${result.title}`)
  }
  return (
    <>
      <div className="sectionhead"><div><h3>点歌</h3><p>搜索并加入房间队列 · 入队走 S2 mutationId 确认</p></div></div>
      <form className="searchbar" onSubmit={event => void run(event)}>
        <select value={platform} onChange={event => setPlatform(event.currentTarget.value)} aria-label="音乐平台">
          {platforms.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="搜索歌曲、艺术家或粘贴链接" aria-label="搜索曲目" />
        <button type="submit" className="primary" disabled={busy || !query.trim()}>搜索</button>
      </form>
      {results.map(result => (
        <div className="song" key={result.id}>
          <span className="num" aria-hidden="true"><MusicNote2Regular /></span>
          <div><strong>{result.title}</strong><small>{result.artist ?? "未知艺术家"} · {result.platform}{result.durationSeconds ? ` · ${formatTime(result.durationSeconds * 1000)}` : ""}</small></div>
          <span className="actions"><button type="button" onClick={() => void enqueue(result)}>加入队列</button></span>
        </div>
      ))}
      {busy ? <p className="notice">正在搜索…</p> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
    </>
  )
}

function exportQueueText(queue: MediaItem[], format: "TXT" | "CSV" | "JSON"): string {
  if (format === "JSON") return JSON.stringify(queue.map(entry => ({ title: entry.title, artist: entry.artist ?? null, durationSeconds: entry.durationSeconds ?? null, platform: entry.source })), null, 2)
  if (format === "CSV") return ["title,artist,duration_seconds,platform", ...queue.map(entry => [entry.title, entry.artist ?? "", entry.durationSeconds ?? "", entry.source].map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))].join("\r\n")
  return queue.map((entry, index) => `${index + 1}. ${entry.title} — ${entry.artist ?? "未知艺术家"}`).join("\n")
}

/** Playlists ride the WS playlist.* surface (requestId correlated); export still copies the live queue. */
function PlaylistsPanel({ connection, queue }: { connection: MusicPartyConnection; queue: MediaItem[] }) {
  const [scope, setScope] = useState<PlaylistScope>("room")
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [tracks, setTracks] = useState<PlaylistTrack[]>([])
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [exportMessage, setExportMessage] = useState("")

  useEffect(() => {
    const target = adapterOf(connection)
    if (!target) { setMessage("未连接 Linkle 服务"); return }
    let token = true
    setBusy(true)
    void target.listPlaylists(scope).then(list => {
      if (!token) return
      setPlaylists(list)
      const first = list.length ? list[0].id : null
      setOpenId(first)
      return first ? target.getPlaylistTracks(scope, first) : []
    }).then(items => { if (token && items) { setTracks(items); setMessage("") } })
      .catch(error => { if (token) setMessage(`加载歌单失败：${errCode(error)}`) })
      .finally(() => { if (token) setBusy(false) })
    return () => { token = false }
  }, [connection, scope])

  async function run(work: (target: MusicPartyAdapter) => Promise<string>) {
    const target = adapterOf(connection)
    if (!target) { setMessage("未连接 Linkle 服务"); return }
    setBusy(true)
    try { setMessage(await work(target)) }
    catch (error) { setMessage(`操作失败：${errCode(error)}`) }
    finally { setBusy(false) }
  }

  function select(playlistId: string) {
    const target = adapterOf(connection)
    if (!target) return
    setOpenId(playlistId)
    setBusy(true)
    void target.getPlaylistTracks(scope, playlistId).then(items => { setTracks(items); setBusy(false) })
      .catch(error => { setMessage(`加载歌单失败：${errCode(error)}`); setBusy(false) })
  }

  function create() {
    const name = window.prompt("新歌单名称", scope === "room" ? "房间歌单" : "我的歌单")?.trim()
    if (!name) return
    void run(async target => { const created = await target.createPlaylist(scope, name); setOpenId(created.id); return `已创建歌单「${created.name}」` })
  }
  function rename(entry: PlaylistSummary) {
    const name = window.prompt("重命名歌单", entry.name)?.trim()
    if (!name || name === entry.name) return
    void run(async target => { await target.renamePlaylist(scope, entry.id, name); return "歌单已重命名" })
  }
  function remove(entry: PlaylistSummary) {
    if (!window.confirm(`删除歌单「${entry.name}」（${entry.trackCount} 首）？`)) return
    void run(async target => { await target.deletePlaylist(scope, entry.id); setOpenId(null); setTracks([]); return "歌单已删除" })
  }
  function enqueueAll(entry: PlaylistSummary) {
    void run(async target => `${await target.enqueuePlaylist(scope, entry.id)} 首已加入队列（mutationId 幂等）`)
  }
  function removeTrack(track: PlaylistTrack) {
    if (!openId) return
    void run(async target => `${await target.removePlaylistTracks(scope, openId, [track.id])} 首已从歌单移除`)
  }

  const opened = playlists.find(entry => entry.id === openId) ?? null
  async function copyExport(format: "TXT" | "CSV" | "JSON") {
    const text = exportQueueText(queue, format)
    try {
      await navigator.clipboard.writeText(text)
      setExportMessage(`已复制 ${format} 到剪贴板（${queue.length} 首）· 受控原生保存待接入`)
    } catch {
      const area = document.createElement("textarea")
      area.value = text
      document.body.append(area)
      area.select()
      const ok = document.execCommand("copy")
      area.remove()
      setExportMessage(ok ? `已复制 ${format} 到剪贴板（${queue.length} 首）· 受控原生保存待接入` : "复制失败：剪贴板权限被拒绝")
    }
  }
  return (
    <>
      <div className="sectionhead"><div><h3>歌单</h3><p>房间与个人歌单 · 走 WS <code>playlist.*</code>（requestId 关联、写命令带 mutationId）</p></div></div>
      <div className="row inline-actions">
        <button type="button" className={scope === "room" ? "primary" : undefined} aria-pressed={scope === "room"} onClick={() => setScope("room")}>房间歌单</button>
        <button type="button" className={scope === "user" ? "primary" : undefined} aria-pressed={scope === "user"} onClick={() => setScope("user")}>我的歌单</button>
        <button type="button" disabled={busy} onClick={create}>新建歌单</button>
        <button type="button" disabled={busy || !opened} onClick={() => opened && void enqueueAll(opened)}>全部加入队列</button>
      </div>
      {playlists.length ? (
        <div className="song-list" role="listbox" aria-label="歌单列表">
          {playlists.map(entry => (
            <div className={`song select${entry.id === openId ? " current" : ""}`} key={entry.id}>
              <button type="button" onClick={() => select(entry.id)}>{entry.name}<small>{entry.trackCount} 首{entry.systemKey ? " · 系统歌单（只读）" : ""}</small></button>
              <span className="actions">
                <button type="button" disabled={busy || Boolean(entry.systemKey)} onClick={() => rename(entry)}>重命名</button>
                <button type="button" disabled={busy || Boolean(entry.systemKey)} onClick={() => remove(entry)}>删除</button>
                <button type="button" disabled={busy} onClick={() => enqueueAll(entry)}>加入队列</button>
              </span>
            </div>
          ))}
        </div>
      ) : <p className="muted">{busy ? "正在加载歌单…" : "这个范围还没有歌单"}</p>}
      {opened ? (
        <section aria-label={`歌单条目：${opened.name}`}>
          <div className="sectionhead"><div><h3>{opened.name}</h3><p>{tracks.length} 条{busy ? " · 加载中" : ""}</p></div></div>
          {tracks.map(track => (
            <div className="song" key={track.id}>
              <span className="num" aria-hidden="true"><MusicNote2Regular /></span>
              <div><strong>{track.music.name}</strong><small>{track.music.artists.join(", ") || "未知艺术家"} · {track.music.platform}{track.music.duration ? ` · ${formatTime(track.music.duration)}` : ""}</small></div>
              <span className="actions"><button type="button" className="i32" aria-label={`从 ${opened.name} 移除 ${track.music.name}`} disabled={busy || Boolean(opened.systemKey)} onClick={() => removeTrack(track)}><DismissRegular /></button></span>
            </div>
          ))}
          {!tracks.length && !busy ? <p className="muted">歌单还没有条目 · 可在队列视图选中曲目后「保存至歌单」</p> : null}
        </section>
      ) : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      <div className="notice" aria-live="polite">
        <strong>导出当前队列（{queue.length} 首）</strong>
        <p>受控原生保存窗口待接入，先以剪贴板交付。</p>
        <div className="row inline-actions">
          <button type="button" onClick={() => void copyExport("TXT")}>TXT 文本</button>
          <button type="button" onClick={() => void copyExport("CSV")}>CSV 表格</button>
          <button type="button" onClick={() => void copyExport("JSON")}>JSON 数据</button>
        </div>
        {exportMessage ? <p role="status">{exportMessage}</p> : null}
      </div>
    </>
  )
}

function RoomTab({ icon, label, active, onClick, badge }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <span className="tip">
      <button type="button" className={active ? "i32 selected" : "i32"} aria-label={label} aria-pressed={active} onClick={onClick}>
        {icon}
        {badge ? <span className="badge" aria-hidden="true">{badge > 99 ? "99+" : badge}</span> : null}
      </button>
      <span className="tooltip" role="tooltip">{label}</span>
    </span>
  )
}

/** Chat & members: real chat.* / members events; history pages prepend on demand. */
function ChatPanel({ connection, subscribeRoom, members, enqueuerName }: {
  connection: MusicPartyConnection
  subscribeRoom: (listener: (event: DomainEvent) => void) => () => void
  members: Array<{ id: string; name: string; online: boolean }>
  enqueuerName: string | null
}) {
  const [messages, setMessages] = useState<Array<{ id: string; author: string; content: string }>>([])
  const [input, setInput] = useState("")
  const [status, setStatus] = useState("")
  const [historyDone, setHistoryDone] = useState(false)
  const expectingHistory = useRef(false)
  const historyCount = useRef(0)
  const seen = useRef(new Set<string>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  useEffect(() => subscribeRoom(event => {
    if (event.type !== "chat") return
    if (seen.current.has(event.id)) return
    seen.current.add(event.id)
    setMessages(current => {
      const entry = { id: event.id, author: event.author, content: event.content }
      return expectingHistory.current ? [entry, ...current] : [...current, entry]
    })
    if (expectingHistory.current) historyCount.current += 1
  }), [subscribeRoom])

  useEffect(() => {
    const list = scrollRef.current
    if (list && pinnedToBottom.current) list.scrollTop = list.scrollHeight
  }, [messages])

  function fetchHistory() {
    const adapter = adapterOf(connection)
    if (!adapter) { setStatus("未连接 Linkle 服务"); return }
    const before = historyCount.current
    expectingHistory.current = true
    adapter.sendChatHistoryFetch(50, before)
    setTimeout(() => {
      expectingHistory.current = false
      if (historyCount.current === before) setHistoryDone(true)
    }, 1500)
  }
  function send(event: React.FormEvent) {
    event.preventDefault()
    const text = input.trim()
    if (!text) return
    const adapter = adapterOf(connection)
    if (!adapter) { setStatus("未连接 Linkle 服务 · 草稿已保留"); return }
    if (adapter.sendChat(text)) { setInput(""); setStatus("") }
    else setStatus("发送失败：连接不可用 · 草稿已保留")
  }
  const online = members.filter(entry => entry.online)
  return (
    <>
      <div className="sectionhead"><div><h3>聊天与成员</h3><p>单房间频道 · 消息按服务端回执展示</p></div></div>
      <div className="chat-scroll" ref={scrollRef} onScroll={event => {
        const list = event.currentTarget
        pinnedToBottom.current = list.scrollTop + list.clientHeight >= list.scrollHeight - 24
      }}>
        {messages.map(entry => (
          <div className="chatline" key={entry.id}>
            <small>{entry.author}</small>
            <p>{entry.content}</p>
          </div>
        ))}
        {!messages.length ? <p className="muted">还没有消息 · 说点什么吧</p> : null}
      </div>
      <div className="row inline-actions">
        <button type="button" disabled={historyDone} onClick={fetchHistory}>更早消息</button>
      </div>
      <form className="searchbar" onSubmit={send}>
        <input type="text" value={input} onChange={event => setInput(event.currentTarget.value)} placeholder="发送到当前频道" aria-label="聊天消息" />
        <button type="submit" className="primary" disabled={!input.trim()}>发送</button>
      </form>
      {status ? <p className="notice" role="status">{status}</p> : null}
      <section className="members" aria-label="在线成员">
        <h3>在线成员 · {online.length}</h3>
        {online.map(entry => (
          <p key={entry.id}>
            {entry.name}
            {entry.name && entry.name === enqueuerName ? <span className="member-tag">当前点歌者</span> : null}
          </p>
        ))}
        {!online.length ? <p className="muted">成员列表等待服务端在线状态…</p> : null}
      </section>
    </>
  )
}
