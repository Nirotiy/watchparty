import type { DomainEvent, MediaItem, ProductId, PlaybackSnapshot } from "./domain"
import type { MediaResolveResponse, MusicMetadata, PlayerStatePayload, QueuePatchPayload } from "./musicparty-contract"
import type { ProductAdapter } from "./adapter"
import type { PlayerAdapter } from "./player"
import { DEFAULT_RETRY_POLICY, retryDelay } from "./retry"
import { MUSICPARTY_DESKTOP_API_VERSION, MUSICPARTY_MIN_CLIENT_VERSION } from "./musicparty-contract"

export interface MusicPartyAdapterOptions {
  origin: string
  roomId?: string
  fetchImpl?: typeof fetch
  webSocketFactory?: (url: string) => WebSocket
  clientVersion?: string
  nativeInvoke?: MusicPartyInvoke
}

export type MusicPartyInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>

export interface MusicSearchResult extends MediaItem { platform: string; sourceId: string }
export interface InviteRedeemResult { roomId: string; roomName?: string }

/** Transport boundary for MusicParty. UI never sees raw HTTP or socket envelopes. */
export class MusicPartyAdapter implements ProductAdapter {
  readonly product: ProductId = "musicparty"
  private readonly listeners = new Set<(event: DomainEvent) => void>()
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private snapshot: PlaybackSnapshot | null = null
  private queue: MediaItem[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private helloTimer: ReturnType<typeof setTimeout> | undefined
  private welcomed = false
  private nativeActive = false
  private nativeGeneration = 0

  constructor(private readonly options: MusicPartyAdapterOptions) {
  }

  async connect(): Promise<void> {
    await this.disconnect()
    this.stopped = false
    this.attempt = 0
    this.emit({ type: "connection", status: "connecting" })
    const health = await this.request("/api/desktop/v1/health").catch(() => null)
    if (!health || !health.ok) {
      this.emit({ type: "connection", status: "failed", message: "MusicParty 服务不可用" })
      return
    }
    const capabilities = await this.request("/api/desktop/v1/capabilities").catch(() => null)
    if (!capabilities?.ok) { this.emit({ type: "connection", status: "failed" }); return }
    if (capabilities.ok) {
      const data = await capabilities.json() as { apiVersion?: string; minimumClientVersion?: string }
      if (data.apiVersion !== MUSICPARTY_DESKTOP_API_VERSION || (data.minimumClientVersion && compareVersions(this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION, data.minimumClientVersion) < 0)) {
        this.emit({ type: "connection", status: "failed", message: "MusicParty 服务版本不兼容，请升级客户端或服务" })
        return
      }
    }
    await this.openSocket()
  }

  async disconnect(): Promise<void> {
    const generation = ++this.nativeGeneration
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.helloTimer)
    this.socket?.close()
    this.socket = null
    if (this.options.nativeInvoke && this.nativeActive) { this.nativeActive = false; await this.options.nativeInvoke<void>("musicPartyWsDisconnect", {}).catch(() => undefined) }
    this.emit({ type: "connection", status: "idle" })
  }

  async redeemInvite(code: string): Promise<InviteRedeemResult> {
    const response = await this.request("/api/desktop/v1/invites/redeem", { method: "POST", body: JSON.stringify({ code }) })
    if (!response.ok) throw new Error(`invite_rejected:${response.status}`)
    const result = await response.json() as { roomId?: string; roomName?: string }
    if (!result.roomId) throw new Error("invite_room_missing")
    await this.joinRoom(result.roomId)
    return { roomId: result.roomId, roomName: result.roomName }
  }

  async joinRoom(roomId: string): Promise<void> {
    this.options.roomId = roomId
    await this.connect()
  }

  async listPlatforms(roomId?: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request("/api/desktop/v1/capabilities")
    if (!response.ok) throw new Error(`platforms_failed:${response.status}`)
    const payload = await response.json() as { providers?: Record<string, unknown> | string[] }
    const providers = Array.isArray(payload.providers) ? payload.providers : Object.keys(payload.providers ?? {})
    return providers.map((id) => ({ id, name: id }))
  }

  async search(platform: string, keyword: string, roomId?: string): Promise<MusicSearchResult[]> {
    const query = new URLSearchParams({ q: keyword, offset: "0", limit: "20" })
    if (roomId) query.set("roomId", roomId)
    const response = await this.request(`/api/desktop/v1/search/${encodeURIComponent(platform)}?${query}`)
    if (!response.ok) throw new Error(`search_failed:${response.status}`)
    const payload = await response.json() as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
    const results = Array.isArray(payload) ? payload : (payload.items ?? [])
    return results.map((item, index) => ({
      id: String(item.id ?? item.songId ?? `${platform}-${index}`),
      sourceId: String(item.id ?? item.songId ?? index),
      platform,
      title: String(item.name ?? item.title ?? "未命名歌曲"),
      artist: Array.isArray(item.artists) ? item.artists.filter((value): value is string => typeof value === "string").join(", ") : typeof item.artist === "string" ? item.artist : typeof item.artists === "string" ? item.artists : undefined,
      artworkUrl: typeof item.coverUrl === "string" ? item.coverUrl : typeof item.picUrl === "string" ? item.picUrl : typeof item.cover === "string" ? item.cover : undefined,
      durationSeconds: typeof item.duration === "number" ? item.duration / 1000 : undefined,
      kind: "audio" as const,
      source: platform,
    }))
  }

  async lyrics(platform: string, songId: string): Promise<string> {
    const response = await this.request(`/api/desktop/v1/music/${encodeURIComponent(platform)}/${encodeURIComponent(songId)}/lyrics`)
    if (!response.ok) throw new Error(`lyrics_failed:${response.status}`)
    return response.text()
  }

  async resolveMedia(platform: string, songId: string): Promise<MediaResolveResponse> {
    const response = await this.request(`/api/desktop/v1/media/${encodeURIComponent(platform)}/${encodeURIComponent(songId)}/resolve`)
    if (!response.ok) throw new Error(`media_resolve_failed:${response.status}`)
    const payload = await response.json() as MediaResolveResponse
    const url = payload.url
    if (typeof url !== "string" || !url) throw new Error("media_resolve_empty")
    return payload
  }

  async resolveMediaUrl(platform: string, songId: string): Promise<string> {
    return (await this.resolveMedia(platform, songId)).url
  }

  async loadForPlayer(player: PlayerAdapter, item: MusicSearchResult): Promise<void> {
    const resolved = await this.resolveMedia(item.platform, item.sourceId)
    await player.load(normalizeMusic(resolved.music), resolved.url)
  }

  bindPlayer(player: PlayerAdapter): () => void {
    return this.subscribe((event) => {
      if (event.type === "playback") void player.applySnapshot(event.snapshot)
    })
  }


  enqueue(platform: string, musicId: string): boolean {
    return this.sendCommand({ type: "enqueue", roomId: this.options.roomId, payload: { platform, musicId, mutationId: crypto.randomUUID() } })
  }

  sendPlaybackCommand(command: "play" | "pause" | "seek", positionSeconds?: number): boolean {
    return this.sendCommand({ type: `player.${command}`, roomId: this.options.roomId, payload: positionSeconds === undefined ? {} : { position: positionSeconds } })
  }

  sendChat(content: string): boolean {
    return !!content.trim() && this.sendCommand({ type: "chat.message", roomId: this.options.roomId, payload: { content: content.trim() } })
  }

  sendChatHistoryFetch(limit = 50, offset = 0): boolean {
    return this.sendCommand({ type: "chat.history.fetch", roomId: this.options.roomId, payload: { limit, offset } })
  }

  sendQueueMutation(kind: "queue.top" | "queue.remove", queueId: string): boolean {
    return !!queueId && this.sendCommand({ type: kind, roomId: this.options.roomId, payload: { queueId, mutationId: crypto.randomUUID() } })
  }

  reorderQueue(queueId: string, targetQueueId: string, position: "before" | "after" = "before"): boolean {
    return this.sendCommand({ type: "queue.reorder", roomId: this.options.roomId, payload: { queueId, targetQueueId, position, mutationId: crypto.randomUUID() } })
  }

  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("Accept", "application/json")
    headers.set("X-Desktop-API-Version", MUSICPARTY_DESKTOP_API_VERSION)
    headers.set("X-Desktop-Client-Version", this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION)
    if (init.body) headers.set("Content-Type", "application/json")
    let response: Response
    if (this.options.fetchImpl) {
      // Explicit transport injection supports browser fixtures; production uses native IPC.
      response = await this.options.fetchImpl(new URL(path, this.options.origin), { ...init, headers })
    } else {
      const invoke = this.options.nativeInvoke ?? (await import("@tauri-apps/api/core")).invoke
      const result = await invoke<{ status: number; body: string }>("musicPartyRequest", { input: {
        origin: this.options.origin, path, method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) as unknown : null,
        clientVersion: this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION,
      } })
      response = new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status })
    }
    if (!response.ok) {
      const code = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 502 ? "media-failed" : response.status === 426 ? "version-incompatible" : "http-error"
      this.emit({ type: "error", code, message: code })
      throw new MusicPartyHttpError(code, response.status)
    }
    return response
  }

  async clearSession(): Promise<void> {
    await this.disconnect()
    const invoke = this.options.nativeInvoke ?? (await import("@tauri-apps/api/core")).invoke
    await invoke<void>("clearMusicPartySession", { origin: this.options.origin })
    this.snapshot = null
    this.queue = []
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return
    if (!this.options.webSocketFactory) { if (!this.options.nativeInvoke) (this.options as MusicPartyAdapterOptions).nativeInvoke = (await import("@tauri-apps/api/core")).invoke as MusicPartyInvoke; await this.openNative(); return }
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url))
    const url = new URL("/api/desktop/v1/ws", this.options.origin.replace(/^http/, "ws"))
    if (this.options.roomId) url.searchParams.set("roomId", this.options.roomId)
    const socket = factory(url.toString())
    this.snapshot = null
    this.queue = []
    this.socket = socket
    this.welcomed = false
    clearTimeout(this.helloTimer)
    this.helloTimer = setTimeout(() => { if (this.socket === socket && !this.welcomed) socket.close() }, 5000)
    socket.onopen = () => { this.attempt = 0; socket.send(JSON.stringify({ type: "client.hello", payload: { apiVersion: MUSICPARTY_DESKTOP_API_VERSION, clientVersion: this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION } })) }
    socket.onmessage = (event) => { if (!this.stopped && this.socket === socket) this.decode(event.data) }
    socket.onerror = () => this.emit({ type: "connection", status: "reconnecting", message: "网络连接异常" })
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return
      if (++this.attempt > DEFAULT_RETRY_POLICY.maxAttempts) { this.emit({ type: "connection", status: "failed", message: "无法连接 MusicParty 服务" }); return }
      this.emit({ type: "connection", status: "reconnecting" })
      this.reconnectTimer = setTimeout(() => void this.openSocket(), retryDelay(this.attempt))
    }
  }

  private decode(raw: unknown): void {
    try {
      const value = JSON.parse(String(raw)) as { type?: string; snapshot?: unknown; message?: string; payload?: unknown }
      if (value.type === "player.state") {
        const state = value.payload as PlayerStatePayload
        if (![state.stateVersion, state.queueVersion, state.playEpoch, state.serverTimestamp].every(Number.isFinite) || !Array.isArray(state.queue)) throw new Error("invalid snapshot")
        this.snapshot = { item: state.nowPlaying ? normalizeMusic(state.nowPlaying.music) : null, positionSeconds: (state.nowPlaying?.currentPosition ?? 0) / 1000, playing: !state.isPaused, revision: state.stateVersion, stateVersion: state.stateVersion, queueVersion: state.queueVersion, playEpoch: state.playEpoch, serverTimeMs: state.serverTimestamp }
        this.queue = state.queue.map(normalizeQueueEntry)
        this.emit({ type: "playback", snapshot: this.snapshot })
        this.emit({ type: "room", room: { id: this.options.roomId ?? "", name: this.options.roomId ?? "", memberCount: 0, playback: this.snapshot, queue: [...this.queue] } })
        this.emitQueue()
      }
      else if (value.type === "queue.patch") this.applyQueuePatch(value.payload as QueuePatchPayload)
      else if (value.type === "player.progress") {
        const progress = value.payload as { currentPosition: number; stateVersion: number; playEpoch: number; serverTimestamp: number }
        if (![progress.currentPosition, progress.stateVersion, progress.playEpoch, progress.serverTimestamp].every(Number.isFinite)) throw new Error("invalid progress")
        if (!this.snapshot || progress.playEpoch !== this.snapshot.playEpoch || progress.stateVersion !== this.snapshot.stateVersion || progress.serverTimestamp < (this.snapshot.serverTimeMs ?? 0)) return
        this.snapshot = { ...this.snapshot, positionSeconds: progress.currentPosition / 1000, serverTimeMs: progress.serverTimestamp }
        this.emit({ type: "playback", snapshot: this.snapshot })
      }
      else if (value.type === "users.online") {
        const presence = value.payload as { users: Array<{ publicId: string; name: string }> }
        this.emit({ type: "members", members: presence.users.map(user => ({ id: user.publicId, name: user.name, online: true })) })
      }
      else if (value.type === "player.events") {
        const notice = value.payload as { code: string; severity: string; message: string }
        this.emit({ type: "player-notice", code: notice.code, severity: notice.severity, message: notice.message })
        if (notice.code === "MEDIA_FAILED" || notice.code === "ERROR_LOAD") this.emit({ type: "error", code: "media-failed", message: notice.message })
      }
      else if (value.type === "server.hello") {
        const hello = value.payload as { apiVersion: string; minimumClientVersion?: string }
        if (hello.apiVersion !== MUSICPARTY_DESKTOP_API_VERSION || (hello.minimumClientVersion && compareVersions(this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION, hello.minimumClientVersion) < 0)) { clearTimeout(this.helloTimer); this.failVersion() }
        else { this.welcomed = true; clearTimeout(this.helloTimer); this.emit({ type: "server-ready", apiVersion: hello.apiVersion, minimumClientVersion: hello.minimumClientVersion }); this.emit({ type: "connection", status: "ready" }) }
      }
      else if (value.type === "sync.pong") {
        const pong = value.payload as { pingId: string; clientSendTime: number; serverReceiveTime: number; serverSendTime: number }
        if (![pong.clientSendTime, pong.serverReceiveTime, pong.serverSendTime].every(Number.isFinite)) throw new Error("invalid pong")
        this.emit({ type: "clock-sync", pingId: pong.pingId, clientSendTime: pong.clientSendTime, serverReceiveTime: pong.serverReceiveTime, serverSendTime: pong.serverSendTime, receivedAt: Date.now() })
      }
      else if (["enqueue.ack", "queue.mutation.ack", "queue.reorder.ack"].includes(value.type ?? "") && value.payload && typeof value.payload === "object") { const payload = value.payload as { mutationId?: string }; this.emit({ type: "queue", status: "accepted", mutationId: payload.mutationId ?? "" }) }
      else if (["enqueue.nack", "queue.mutation.nack", "queue.reorder.nack"].includes(value.type ?? "") && value.payload && typeof value.payload === "object") { const payload = value.payload as { mutationId?: string; reason?: string }; this.emit({ type: "queue", status: "rejected", mutationId: payload.mutationId ?? "", message: payload.reason }) }
      else if (value.type === "chat.message" && value.payload && typeof value.payload === "object") { const payload = value.payload as { id?: string; content?: string; author?: { name?: string } }; this.emit({ type: "chat", id: payload.id ?? crypto.randomUUID(), content: payload.content ?? "", author: payload.author?.name ?? "成员" }) }
      else if (value.type === "chat.history" && Array.isArray(value.payload)) for (const message of value.payload as Array<{ id?: string; content?: string; author?: { name?: string }; createdAt?: string }>) this.emit({ type: "chat", id: message.id ?? crypto.randomUUID(), content: message.content ?? "", author: message.author?.name ?? "成员", createdAt: message.createdAt })
      else if ((value.type === "members.state" || value.type === "room.members") && Array.isArray(value.payload)) { this.emit({ type: "members", members: value.payload.map((member: { id?: string; publicId?: string; name?: string; online?: boolean }) => ({ id: member.id ?? member.publicId ?? "", name: member.name ?? "成员", online: member.online !== false })) }) }
      else if (value.type === "server.incompatible" || value.type === "version.incompatible") this.failVersion()
      else if (value.type === "error") this.emit({ type: "error", code: "server_error", message: value.message ?? "MusicParty 服务错误" })
    } catch { this.emit({ type: "error", code: "invalid_event", message: "收到无法识别的服务事件" }) }
  }

  private failVersion(): void {
    this.stopped = true
    this.nativeActive = false
    void this.options.nativeInvoke?.("musicPartyWsDisconnect", {}).catch(() => undefined)
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.helloTimer)
    this.socket?.close()
    this.emit({ type: "error", code: "version-incompatible", message: "MusicParty 服务版本不兼容" })
    this.emit({ type: "connection", status: "failed", message: "请升级客户端或服务" })
  }

  private async openNative(): Promise<void> {
    const generation = ++this.nativeGeneration
    this.welcomed = false
    this.nativeActive = true
    try {
      const hello = await this.options.nativeInvoke!("musicPartyWsConnect", { input: { origin: this.options.origin, roomId: this.options.roomId ?? "", clientVersion: this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION } }) as { event: string }
      if (generation !== this.nativeGeneration || this.stopped) return
      this.decode(hello.event)
      if (!this.welcomed) return
      this.nativeActive = true
      const receive = async (): Promise<void> => {
        while (generation === this.nativeGeneration && !this.stopped) {
          try { const event = await this.options.nativeInvoke!("musicPartyWsReceive", {}) as { event: string }; if (generation === this.nativeGeneration) this.decode(event.event) }
          catch (error) { this.nativeFailure(generation, error); return }
        }
      }
      void receive().catch(() => undefined)
    } catch (error) { this.nativeFailure(generation, error) }
  }

  private nativeFailure(generation: number, error: unknown): void {
    if (generation !== this.nativeGeneration || this.stopped) return
    if (String(error).includes("version-incompatible")) { this.failVersion(); return }
    ++this.nativeGeneration
    this.nativeActive = false
    this.welcomed = false
    const token = this.nativeGeneration
    void this.options.nativeInvoke?.("musicPartyWsDisconnect", {}).catch(() => undefined).then(() => {
      if (token !== this.nativeGeneration || this.stopped) return
      if (++this.attempt > DEFAULT_RETRY_POLICY.maxAttempts) { this.emit({ type: "connection", status: "failed" }); return }
      this.emit({ type: "connection", status: "reconnecting" })
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => { if (token === this.nativeGeneration && !this.stopped) void this.openNative() }, retryDelay(this.attempt))
    })
  }

  private sendCommand(value: unknown): boolean {
    if (this.stopped || !this.welcomed) return false
    if (this.options.nativeInvoke && this.nativeActive) { const generation = this.nativeGeneration; void this.options.nativeInvoke("musicPartyWsSend", { event: JSON.stringify(value) }).catch(error => this.nativeFailure(generation, error)); return true }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.welcomed) return false
    try { this.socket.send(JSON.stringify(value)); return true } catch { return false }
  }

  private emitQueue(): void {
    this.emit({ type: "queue-state", roomId: this.options.roomId ?? "", items: [...this.queue], queueVersion: this.snapshot?.queueVersion ?? 0 })
  }

  private applyQueuePatch(patch: QueuePatchPayload): void {
    if (!this.snapshot || patch.queueVersion <= (this.snapshot.queueVersion ?? 0)) return
    if (patch.queueVersion !== (this.snapshot.queueVersion ?? 0) + 1) {
      this.sendCommand({ type: "player.resync", roomId: this.options.roomId, payload: {} })
      return
    }
    switch (patch.operation) {
      case "append": this.queue = [...this.queue, ...(patch.items ?? []).map(normalizeQueueEntry)]; break
      case "snapshot": this.queue = (patch.queue ?? []).map(normalizeQueueEntry); break
      case "clear": this.queue = []; break
      case "remove": this.queue = this.queue.filter(item => !(patch.queueIds ?? [patch.queueId]).includes(item.id)); break
      case "status": this.queue = this.queue.map(item => item.id === (patch.queueId ?? patch.item?.queueId) ? { ...item, status: patch.status ?? patch.item?.status } : item); break
      case "move": {
        const item = this.queue.find(entry => entry.id === patch.queueId)
        const remaining = this.queue.filter(entry => entry.id !== patch.queueId)
        const index = remaining.findIndex(entry => entry.id === patch.targetQueueId)
        if (!item || index < 0) throw new Error("invalid queue move")
        remaining.splice(index + (patch.position === "after" ? 1 : 0), 0, item)
        this.queue = remaining
        break
      }
      default: throw new Error("unknown queue patch")
    }
    this.snapshot = { ...this.snapshot, queueVersion: patch.queueVersion }
    this.emitQueue()
  }

  private emit(event: DomainEvent): void { for (const listener of this.listeners) listener(event) }
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number), b = right.split(".").map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

function normalizeMusic(music: MusicMetadata): MediaItem {
  return { id: music.id, title: music.name, artist: music.artists.join(", "), artworkUrl: music.coverUrl, durationSeconds: music.duration / 1000, kind: "audio", source: music.platform }
}

export class MusicPartyHttpError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = "MusicPartyHttpError"
  }
}



function normalizeQueueEntry(entry: { queueId: string; music: MusicMetadata; status?: string }): MediaItem {
  return { ...normalizeMusic(entry.music), id: entry.queueId, status: entry.status }
}
