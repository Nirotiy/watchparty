import type { DomainEvent, MediaItem, ProductId, PlaybackSnapshot, SharedCommandKind, SharedRoomState } from "./domain"
import type { MediaResolveResponse, MusicMetadata, PlayerStatePayload, QueuePatchPayload } from "./musicparty-contract"
import type { ProductAdapter } from "./adapter"
import type { RoomSummaryRecord } from "./lobby-contract"
import type { PlayerAdapter } from "./player"
import { DEFAULT_RETRY_POLICY, retryDelay } from "./retry"
import { MUSICPARTY_DESKTOP_API_VERSION, MUSICPARTY_MIN_CLIENT_VERSION } from "./musicparty-contract"
import { addClockSample, applyPlayerState, applyProgress, emptySharedRoomState } from "./shared-room-state"

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
export interface CreateMusicPartyRoomInput { name: string; isPrivate: boolean; password?: string }
export type RoomCreateErrorCode = "not-connected" | "in-progress" | "invalid-input" | "rejected" | "disconnected" | "timeout" | "invalid-response"
export class MusicPartyRoomCreateError extends Error {
  constructor(readonly code: RoomCreateErrorCode) { super(`room_create_${code}`); this.name = "MusicPartyRoomCreateError" }
}

export type ControlOutcome = "applied" | "noop" | "rejected" | "unknown"
export type ControlErrorCode = "not-connected" | "in-progress" | "invalid-input" | "not-ready" | "unsupported"
export class MusicPartyControlError extends Error {
  constructor(readonly code: ControlErrorCode) { super(`control_${code}`); this.name = "MusicPartyControlError" }
}

export type PlaylistScope = "user" | "room"
export interface PlaylistSummary { id: string; name: string; systemKey: string | null; trackCount: number; createdAt: number; updatedAt: number }
export interface PlaylistTrack { id: string; playlistId: string; music: MusicMetadata; sortOrder: number; createdAt: number }
export class MusicPartyPlaylistError extends Error {
  constructor(readonly code: string) { super(`playlist_${code}`); this.name = "MusicPartyPlaylistError" }
}

/** Transport boundary for MusicParty. UI never sees raw HTTP or socket envelopes. */
export class MusicPartyAdapter implements ProductAdapter {
  readonly product: ProductId = "musicparty"
  private readonly listeners = new Set<(event: DomainEvent) => void>()
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private snapshot: PlaybackSnapshot | null = null
  private sharedState: SharedRoomState | null = null
  private queue: MediaItem[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private helloTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setTimeout> | undefined
  private readonly outstandingPings = new Map<string, number>()
  private welcomed = false
  private nativeActive = false
  private nativeGeneration = 0
  private readonly mutationWaiters = new Map<string, { resolve: (value: boolean) => void; reject: (error: Error) => void }>()
  private readonly playlistWaiters = new Map<string, (result: { ok: true; payload: unknown } | { ok: false; error: Error }) => void>()
  private loadingItemId: string | null = null
  private roomCreate: { resolve: (room: RoomSummaryRecord) => void; reject: (error: MusicPartyRoomCreateError) => void } | undefined
  private roomCreateUncertain = false
  private controlPending: { requestId: string; roomId: string; generation: number; kind: SharedCommandKind; ack?: { outcome: "applied" | "noop"; stateVersion: number; queueVersion: number; playEpoch: number }; finish: (outcome: ControlOutcome) => void } | null = null
  private controlIdempotency = false
  private controlPreconditions = false
  private controlScope: { id: string; ttlMs: number } | null = null
  private lastResyncAtMs = 0

  constructor(private readonly options: MusicPartyAdapterOptions) {
  }

  async connect(): Promise<void> {
    await this.disconnect()
    this.stopped = false
    this.attempt = 0
    this.controlIdempotency = false
    this.controlPreconditions = false
    this.emit({ type: "connection", status: "connecting" })
    const health = await this.request("/api/desktop/v1/health").catch(() => null)
    if (!health || !health.ok) {
      this.emit({ type: "connection", status: "failed", message: "MusicParty 服务不可用" })
      return
    }
    const capabilities = await this.request("/api/desktop/v1/capabilities").catch(() => null)
    if (!capabilities?.ok) { this.emit({ type: "connection", status: "failed" }); return }
    if (capabilities.ok) {
      const data = await capabilities.json() as { apiVersion?: string; minimumClientVersion?: string; features?: { controlIdempotency?: boolean; controlPreconditions?: boolean } }
      if (data.apiVersion !== MUSICPARTY_DESKTOP_API_VERSION || (data.minimumClientVersion && compareVersions(this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION, data.minimumClientVersion) < 0)) {
        this.emit({ type: "connection", status: "failed", message: "MusicParty 服务版本不兼容，请升级客户端或服务" })
        return
      }
      this.controlIdempotency = data.features?.controlIdempotency === true
      this.controlPreconditions = data.features?.controlPreconditions === true
    }
    await this.openSocket()
  }

  get roomId(): string | undefined { return this.options.roomId }
  get origin(): string { return new URL(this.options.origin).origin }

  async listRooms(): Promise<RoomSummaryRecord[]> {
    const response = await this.request("/api/rooms")
    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) throw new Error("invalid_room_list")
    return payload.map(room => this.roomSummary(room))
  }

  private roomSummary(value: unknown): RoomSummaryRecord {
    if (!value || typeof value !== "object") throw new Error("invalid_room_summary")
    const room = value as Record<string, unknown>
    if (typeof room.roomId !== "string" || !room.roomId || typeof room.name !== "string" || typeof room.privateRoom !== "boolean") throw new Error("invalid_room_summary")
    return { service: "musicparty", origin: this.origin, roomId: room.roomId, name: room.name,
      visibility: room.privateRoom ? "private" : "public",
      memberCount: typeof room.onlineCount === "number" && Number.isInteger(room.onlineCount) && room.onlineCount >= 0 ? room.onlineCount : null,
      requiresPassword: room.privateRoom && room.accessGranted !== true }
  }

  /** The protocol has no request ID, so only one create may be outstanding per connection. */
  async createRoom(input: CreateMusicPartyRoomInput, timeoutMs = 10000): Promise<RoomSummaryRecord> {
    if (this.roomCreate || this.roomCreateUncertain) throw new MusicPartyRoomCreateError("in-progress")
    if (!input.name.trim() || (input.isPrivate && !input.password?.trim())) throw new MusicPartyRoomCreateError("invalid-input")
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.roomCreate = undefined }
      const timer = setTimeout(() => { this.roomCreateUncertain = true; this.roomCreate?.reject(new MusicPartyRoomCreateError("timeout")) }, timeoutMs)
      this.roomCreate = { resolve: room => { finish(); resolve(room) }, reject: error => { finish(); reject(error) } }
      if (!this.sendCommand({ type: "rooms.create", payload: { name: input.name.trim(), isPrivate: input.isPrivate, password: input.password ?? "" } })) this.roomCreate.reject(new MusicPartyRoomCreateError("not-connected"))
    })
  }

  async verifyRoomAccess(roomId: string, password: string): Promise<void> {
    await this.request(`/api/rooms/${encodeURIComponent(roomId)}/verify`, { method: "POST", body: JSON.stringify({ password }) })
  }

  async disconnect(): Promise<void> {
    const generation = ++this.nativeGeneration
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.helloTimer)
    this.stopClockSync()
    this.socket?.close()
    this.socket = null
    if (this.options.nativeInvoke && this.nativeActive) { this.nativeActive = false; await this.options.nativeInvoke<void>("musicPartyWsDisconnect", {}).catch(() => undefined) }
    this.controlPending?.finish("unknown")
    this.emit({ type: "connection", status: "idle" })
  }

  async redeemInvite(code: string): Promise<InviteRedeemResult> {
    const response = await this.request("/api/desktop/v1/invites/redeem", { method: "POST", body: JSON.stringify({ code, displayName: "桌面用户" }) })
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
    await player.load(normalizeMusic(resolved.music), new URL(resolved.url, this.options.origin).href)
  }

  bindPlayer(player: PlayerAdapter, onLoaded?: () => Promise<unknown>): () => void {
    let active = true
    let latest = this.snapshot
    let target = ""
    let loaded = ""
    let failedTarget = ""
    let generation = 0
    let pending = Promise.resolve()
    const fail = () => this.emit({ type: "error", code: "playback-failed", message: "媒体解析或播放失败" })
    const stopAfterFailure = (key: string) => {
      if (!active) return
      failedTarget = key
      target = loaded = ""
      ++generation
      pending = pending.then(async () => { if (active) await player.stop() }).catch(() => {})
      fail()
    }
    const run = (work: () => Promise<void>, failureKey = "") => {
      pending = pending.then(work).catch(() => { if (active) stopAfterFailure(failureKey || target) })
    }
    const update = (snapshot: PlaybackSnapshot) => {
      latest = snapshot
      const item = snapshot.item
      const key = item ? JSON.stringify([item.source, item.id, snapshot.playEpoch]) : ""
      if (key && key === failedTarget) return
      if (key === target) {
        if (loaded === key) run(async () => { if (active && latest === snapshot) await player.applySnapshot(snapshot) })
        return
      }
      target = key
      loaded = ""
      failedTarget = ""
      const token = ++generation
      run(async () => { if (active && token === generation) await player.stop() }, key)
      if (!item) return
      void this.resolveMedia(item.source ?? "", item.id).then(resolved => {
        run(async () => {
          if (!active || token !== generation) return
          await player.load(item, new URL(resolved.url, this.options.origin).href)
          if (!active || token !== generation) return
          loaded = key
          if (latest) await player.applySnapshot(latest)
          if (!active || token !== generation) return
          await onLoaded?.()
          if (!active || token !== generation) return
          // Focus may await native work. Reapply the authoritative state after it settles.
          if (latest) await player.applySnapshot(latest)
        }, key)
      }).catch(() => { if (active && token === generation) stopAfterFailure(key) })
    }
    const unsubscribe = this.subscribe(event => {
      if (event.type === "playback") update(event.snapshot)
      if (event.type === "error" && event.code === "media-failed") stopAfterFailure(target)
      if (event.type === "connection" && event.status !== "ready") {
        ++generation; target = loaded = ""; failedTarget = ""; latest = null
        run(async () => { if (active) await player.stop() })
      }
    })
    if (latest) update(latest)
    return () => { active = false; ++generation; unsubscribe(); void player.stop().catch(() => {}) }
  }


  async enqueue(platform: string, musicId: string): Promise<boolean> {
    const mutationId = crypto.randomUUID()
    return new Promise<boolean>(resolve => {
      const finish = (accepted: boolean) => { clearTimeout(timer); this.mutationWaiters.delete(mutationId); resolve(accepted) }
      const timer = setTimeout(() => finish(false), 10000)
      this.mutationWaiters.set(mutationId, { resolve: finish, reject: () => finish(false) })
      if (!this.sendCommand({ type: "enqueue", roomId: this.options.roomId, payload: { platform, musicId, mutationId } })) finish(false)
    })
  }

  /**
   * Shared playback control per the contract: control.* with a correlated requestId.
   * One command in flight at a time; a timed-out command is never resent — the
   * projection plus a throttled resync reconcile the room instead.
   */
  sendControl(kind: SharedCommandKind, payload: { positionMs?: number } = {}, timeoutMs = 2000): Promise<ControlOutcome> {
    if (this.controlPending) return Promise.reject(new MusicPartyControlError("in-progress"))
    if (this.stopped || !this.welcomed) return Promise.reject(new MusicPartyControlError("not-connected"))
    if (this.controlIdempotency && !this.controlScope) return Promise.reject(new MusicPartyControlError("not-ready"))
    if (kind === "seek" || kind === "like" || kind === "previous") {
      if (!this.controlPreconditions) return Promise.reject(new MusicPartyControlError("unsupported"))
      if (!this.sharedState?.item) return Promise.reject(new MusicPartyControlError("invalid-input"))
    }
    let wirePayload: Record<string, unknown> = {}
    if (kind === "seek") {
      if (typeof payload.positionMs !== "number" || !Number.isFinite(payload.positionMs)) return Promise.reject(new MusicPartyControlError("invalid-input"))
      const durationMs = this.sharedState?.durationMs ?? 0
      const upper = durationMs > 0 ? durationMs : Number.MAX_SAFE_INTEGER
      wirePayload = { positionMs: Math.min(Math.max(Math.round(payload.positionMs), 0), upper) }
    } else if (kind === "like" && !this.sharedState?.item) {
      return Promise.reject(new MusicPartyControlError("invalid-input"))
    }
    const type = kind === "play" || kind === "pause" ? "control.toggle-pause" : kind === "shuffle" ? "control.toggle-shuffle" : `control.${kind}`
    if ((kind === "seek" || kind === "like" || kind === "previous") && this.sharedState) wirePayload.expectedPlayEpoch = this.sharedState.playEpoch
    const requestId = crypto.randomUUID()
    const roomId = this.options.roomId ?? ""
    return new Promise((resolve, reject) => {
      if (this.controlIdempotency && this.controlScope) wirePayload = { ...wirePayload, mutationId: crypto.randomUUID(), idempotencyScopeId: this.controlScope.id }
      const finish = (outcome: ControlOutcome) => {
        if (this.controlPending?.requestId !== requestId) return
        clearTimeout(timer)
        this.controlPending = null
        this.emit({ type: "command-pending", roomId, requestId, kind, pending: false })
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        if (this.controlPending?.requestId !== requestId) return
        finish("unknown")
        this.requestResync()
      }, timeoutMs)
      this.controlPending = { requestId, roomId, generation: this.nativeGeneration, kind, finish }
      this.emit({ type: "command-pending", roomId: this.options.roomId ?? "", requestId, kind, pending: true })
      if (!this.sendCommand({ type, requestId, roomId: this.options.roomId, payload: wirePayload })) {
        clearTimeout(timer)
        this.controlPending = null
        this.emit({ type: "command-pending", roomId: this.options.roomId ?? "", requestId, kind, pending: false })
        reject(new MusicPartyControlError("not-connected"))
      }
    })
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

  /** Clears the whole shared queue; resolves false when the mutation is not confirmed in time. */
  clearQueue(timeoutMs = 10000): Promise<boolean> {
    const mutationId = crypto.randomUUID()
    return new Promise<boolean>(resolve => {
      const finish = (accepted: boolean) => { clearTimeout(timer); this.mutationWaiters.delete(mutationId); resolve(accepted) }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.mutationWaiters.set(mutationId, { resolve: () => finish(true), reject: () => finish(false) })
      if (!this.sendCommand({ type: "queue.clear", roomId: this.options.roomId, payload: { mutationId } })) finish(false)
    })
  }

  private settlePlaylist(requestId: string | undefined, result: { ok: true; payload: unknown } | { ok: false; error: Error }): void {
    const settle = this.playlistWaiters.get(requestId ?? "")
    if (settle) { this.playlistWaiters.delete(requestId ?? ""); settle(result) }
  }

  /** Playlist commands are request-ID correlated; the server answers exactly once per command. */
  private playlistRequest<T>(type: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
    if (this.stopped || !this.welcomed) return Promise.reject(new MusicPartyPlaylistError("NOT_CONNECTED"))
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.playlistWaiters.delete(requestId); reject(new MusicPartyPlaylistError("TIMEOUT")) }, timeoutMs)
      this.playlistWaiters.set(requestId, result => {
        clearTimeout(timer)
        if (result.ok) resolve(result.payload as T); else reject(result.error)
      })
      if (!this.sendCommand({ type, requestId, roomId: this.options.roomId, payload })) {
        clearTimeout(timer)
        this.playlistWaiters.delete(requestId)
        reject(new MusicPartyPlaylistError("NOT_CONNECTED"))
      }
    })
  }

  async listPlaylists(scope: PlaylistScope): Promise<PlaylistSummary[]> {
    const payload = await this.playlistRequest<{ playlists?: unknown }>("playlist.list", { scope })
    if (!Array.isArray(payload.playlists)) throw new MusicPartyPlaylistError("INVALID_RESPONSE")
    return payload.playlists.map(toPlaylistSummary)
  }

  async getPlaylistTracks(scope: PlaylistScope, playlistId: string, range: { offset?: number; limit?: number } = {}): Promise<PlaylistTrack[]> {
    const payload = await this.playlistRequest<{ tracks?: unknown }>("playlist.get", { scope, playlistId, ...range })
    if (!Array.isArray(payload.tracks)) throw new MusicPartyPlaylistError("INVALID_RESPONSE")
    return payload.tracks.map(toPlaylistTrack)
  }

  async createPlaylist(scope: PlaylistScope, name: string): Promise<PlaylistSummary> {
    const payload = await this.playlistRequest<{ playlist?: unknown }>("playlist.create", { scope, name, mutationId: crypto.randomUUID() })
    return toPlaylistSummary(payload.playlist)
  }

  async renamePlaylist(scope: PlaylistScope, playlistId: string, name: string): Promise<PlaylistSummary> {
    const payload = await this.playlistRequest<{ playlist?: unknown }>("playlist.rename", { scope, playlistId, name, mutationId: crypto.randomUUID() })
    return toPlaylistSummary(payload.playlist)
  }

  async deletePlaylist(scope: PlaylistScope, playlistId: string): Promise<void> {
    await this.playlistRequest("playlist.delete", { scope, playlistId, mutationId: crypto.randomUUID() })
  }

  async addPlaylistItems(scope: PlaylistScope, playlistId: string, items: MusicMetadata[]): Promise<{ addedCount: number; skippedCount: number }> {
    if (items.length === 0 || items.length > 200) throw new MusicPartyPlaylistError("PAYLOAD_INVALID")
    const payload = await this.playlistRequest<{ addedCount?: unknown; skippedCount?: unknown }>("playlist.add-items", { scope, playlistId, items, mutationId: crypto.randomUUID() })
    return { addedCount: typeof payload.addedCount === "number" ? payload.addedCount : 0, skippedCount: typeof payload.skippedCount === "number" ? payload.skippedCount : 0 }
  }

  async removePlaylistTracks(scope: PlaylistScope, playlistId: string, trackIds: string[]): Promise<number> {
    if (trackIds.length === 0 || trackIds.length > 200) throw new MusicPartyPlaylistError("PAYLOAD_INVALID")
    const payload = await this.playlistRequest<{ removedCount?: unknown }>("playlist.remove-items", { scope, playlistId, trackIds, mutationId: crypto.randomUUID() })
    return typeof payload.removedCount === "number" ? payload.removedCount : 0
  }

  async enqueuePlaylist(scope: PlaylistScope, playlistId: string): Promise<number> {
    const payload = await this.playlistRequest<{ count?: unknown }>("playlist.enqueue", { scope, playlistId, mutationId: crypto.randomUUID() })
    return typeof payload.count === "number" ? payload.count : 0
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
      const invoke = this.options.nativeInvoke ?? (await import("./desktop-runtime")).invoke
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
    const invoke = this.options.nativeInvoke ?? (await import("./desktop-runtime")).invoke
    await invoke<void>("clearMusicPartySession", { origin: this.options.origin })
    this.snapshot = null
    this.queue = []
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return
    if (!this.options.webSocketFactory) { if (!this.options.nativeInvoke) (this.options as MusicPartyAdapterOptions).nativeInvoke = (await import("./desktop-runtime")).invoke as MusicPartyInvoke; await this.openNative(); return }
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url))
    const url = new URL("/api/desktop/v1/ws", this.options.origin.replace(/^http/, "ws"))
    if (this.options.roomId) url.searchParams.set("roomId", this.options.roomId)
    const socket = factory(url.toString())
    const generation = ++this.nativeGeneration
    this.snapshot = null
    this.queue = []
    this.socket = socket
    this.welcomed = false
    clearTimeout(this.helloTimer)
    this.helloTimer = setTimeout(() => { if (this.socket === socket && !this.welcomed) socket.close() }, 5000)
    socket.onopen = () => { this.attempt = 0; socket.send(JSON.stringify({ type: "client.hello", payload: { apiVersion: MUSICPARTY_DESKTOP_API_VERSION, clientVersion: this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION } })) }
    socket.onmessage = (event) => { if (!this.stopped && this.socket === socket && generation === this.nativeGeneration) this.decode(event.data) }
    socket.onerror = () => this.emit({ type: "connection", status: "reconnecting", message: "网络连接异常" })
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return
      ++this.nativeGeneration
      this.welcomed = false
      if (++this.attempt > DEFAULT_RETRY_POLICY.maxAttempts) { this.emit({ type: "connection", status: "failed", message: "无法连接 MusicParty 服务" }); return }
      this.emit({ type: "connection", status: "reconnecting" })
      this.reconnectTimer = setTimeout(() => void this.openSocket(), retryDelay(this.attempt))
    }
  }

  private decode(raw: unknown): void {
    try {
      const value = JSON.parse(String(raw)) as { type?: string; requestId?: string; roomId?: string; snapshot?: unknown; message?: string; payload?: unknown }
      if (value.roomId != null && value.roomId !== this.options.roomId) return
      if (value.type === "rooms.created") {
        try { this.roomCreate?.resolve(this.roomSummary(value.payload)) }
        catch { this.roomCreate?.reject(new MusicPartyRoomCreateError("invalid-response")) }
      }
      else if (value.type === "player.state") {
        const state = value.payload as PlayerStatePayload
        const scope = typeof state?.idempotencyScopeId === "string" && state.idempotencyScopeId.length > 0 && state.idempotencyScopeId.length <= 128
          && typeof state.idempotencyTtlMs === "number" && Number.isSafeInteger(state.idempotencyTtlMs) && state.idempotencyTtlMs > 0
          ? { id: state.idempotencyScopeId, ttlMs: state.idempotencyTtlMs } : null
        if (!state || ![state.stateVersion, state.queueVersion, state.playEpoch, state.serverTimestamp].every(Number.isFinite) || !Array.isArray(state.queue)) {
          this.controlScope = null
          throw new Error("invalid snapshot")
        }
        const decoded = decodeSharedPlayerState(value.payload)
        if (decoded) {
          if (this.controlIdempotency && this.controlScope?.id !== scope?.id) {
            this.controlPending?.finish("unknown")
            this.sharedState = null
            this.outstandingPings.clear()
          }
          this.controlScope = scope
          const projected = applyPlayerState(this.sharedState ?? emptySharedRoomState(this.options.roomId ?? ""), decoded, Date.now())
          if (projected) { this.controlScope = scope; this.sharedState = projected; this.emit({ type: "shared-room-state", state: projected }) }
        } else {
          this.controlScope = null
        }
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
        if (this.sharedState && progress.currentPosition >= 0 && Number.isSafeInteger(progress.stateVersion) && Number.isSafeInteger(progress.playEpoch)) {
          const projected = applyProgress(this.sharedState, progress, Date.now())
          if (projected) { this.sharedState = projected; this.emit({ type: "shared-room-state", state: projected }) }
        }
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
        if (notice.code === "ROOM_CREATE_FAILED") this.roomCreate?.reject(new MusicPartyRoomCreateError("rejected"))
        this.emit({ type: "player-notice", code: notice.code, severity: notice.severity, message: notice.message })
        if (notice.code === "MEDIA_FAILED" || notice.code === "ERROR_LOAD") this.emit({ type: "error", code: "media-failed", message: notice.message })
      }
      else if (value.type === "server.hello") {
        const hello = value.payload as { apiVersion: string; minimumClientVersion?: string }
        if (hello.apiVersion !== MUSICPARTY_DESKTOP_API_VERSION || (hello.minimumClientVersion && compareVersions(this.options.clientVersion ?? MUSICPARTY_MIN_CLIENT_VERSION, hello.minimumClientVersion) < 0)) { clearTimeout(this.helloTimer); this.failVersion() }
        else { this.welcomed = true; clearTimeout(this.helloTimer); this.emit({ type: "server-ready", apiVersion: hello.apiVersion, minimumClientVersion: hello.minimumClientVersion }); this.emit({ type: "connection", status: "ready" }); this.startClockSync() }
      }
      else if (value.type === "sync.pong") {
        const pong = value.payload as { pingId: string; clientSendTime: number; serverReceiveTime: number; serverSendTime: number }
        if (![pong.clientSendTime, pong.serverReceiveTime, pong.serverSendTime].every(Number.isFinite)) throw new Error("invalid pong")
        if (this.outstandingPings.delete(pong.pingId) && this.sharedState) {
          this.sharedState = addClockSample(this.sharedState, pong, Date.now())
          this.emit({ type: "shared-room-state", state: this.sharedState })
        }
        this.emit({ type: "clock-sync", pingId: pong.pingId, clientSendTime: pong.clientSendTime, serverReceiveTime: pong.serverReceiveTime, serverSendTime: pong.serverSendTime, receivedAt: Date.now() })
      }
      else if (value.type === "control.ack" && value.payload && typeof value.payload === "object") {
        const payload = value.payload as { outcome?: ControlOutcome; code?: unknown; committed?: { stateVersion?: unknown; queueVersion?: unknown; playEpoch?: unknown } }
        const pending = this.controlPending
        if (!pending || value.requestId !== pending.requestId || value.roomId !== pending.roomId || pending.generation !== this.nativeGeneration) return
        if (payload.outcome === "rejected") {
          const code = typeof payload.code === "string" && payload.code ? payload.code : "COMMAND_REJECTED"
          this.emit({ type: "denied", roomId: pending.roomId, requestId: pending.requestId, code, message: code })
          pending.finish("rejected")
        } else if ((payload.outcome === "applied" || payload.outcome === "noop") && payload.committed) {
          const { stateVersion, queueVersion, playEpoch } = payload.committed
          if (![stateVersion, queueVersion, playEpoch].every(version => typeof version === "number" && Number.isSafeInteger(version) && version >= 0)) return
          pending.ack = { outcome: payload.outcome, stateVersion: stateVersion as number, queueVersion: queueVersion as number, playEpoch: playEpoch as number }
          this.settleControl()
        }
      }
      else if (["enqueue.ack", "queue.mutation.ack", "queue.reorder.ack"].includes(value.type ?? "") && value.payload && typeof value.payload === "object") { const payload = value.payload as { mutationId?: string }; this.mutationWaiters.get(payload.mutationId ?? "")?.resolve(true); this.mutationWaiters.delete(payload.mutationId ?? ""); this.emit({ type: "queue", status: "accepted", mutationId: payload.mutationId ?? "" }) }
      else if (["enqueue.nack", "queue.mutation.nack", "queue.reorder.nack"].includes(value.type ?? "") && value.payload && typeof value.payload === "object") { const payload = value.payload as { mutationId?: string; reason?: string }; this.mutationWaiters.get(payload.mutationId ?? "")?.reject(new Error(payload.reason ?? "queue_rejected")); this.mutationWaiters.delete(payload.mutationId ?? ""); this.emit({ type: "queue", status: "rejected", mutationId: payload.mutationId ?? "", message: payload.reason }) }
      else if (value.type === "chat.message" && value.payload && typeof value.payload === "object") { const payload = value.payload as { id?: string; content?: string; author?: { name?: string } }; this.emit({ type: "chat", id: payload.id ?? crypto.randomUUID(), content: payload.content ?? "", author: payload.author?.name ?? "成员" }) }
      else if (value.type === "chat.history" && Array.isArray(value.payload)) for (const message of value.payload as Array<{ id?: string; content?: string; author?: { name?: string }; createdAt?: string }>) this.emit({ type: "chat", id: message.id ?? crypto.randomUUID(), content: message.content ?? "", author: message.author?.name ?? "成员", createdAt: message.createdAt })
      else if ((value.type === "members.state" || value.type === "room.members") && Array.isArray(value.payload)) { this.emit({ type: "members", members: value.payload.map((member: { id?: string; publicId?: string; name?: string; online?: boolean }) => ({ id: member.id ?? member.publicId ?? "", name: member.name ?? "成员", online: member.online !== false })) }) }
      else if (value.type === "playlist.data" || value.type === "playlist.ack") this.settlePlaylist(value.requestId, { ok: true, payload: value.payload })
      else if (value.type === "playlist.nack") {
        const reason = typeof (value.payload as { reason?: unknown } | null)?.reason === "string" ? (value.payload as { reason: string }).reason : "REJECTED"
        this.settlePlaylist(value.requestId, { ok: false, error: new MusicPartyPlaylistError(reason) })
      }
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
    this.stopClockSync()
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
      this.requestResync()
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
    if (this.sharedState && patch.queueVersion > this.sharedState.queueVersion) {
      this.sharedState = { ...this.sharedState, queueVersion: patch.queueVersion }
      this.emit({ type: "shared-room-state", state: this.sharedState })
    }
    this.emitQueue()
  }

  private emit(event: DomainEvent): void {
    if (event.type === "shared-room-state") this.settleControl()
    if (event.type === "server-ready") this.roomCreateUncertain = false
    if (event.type === "connection" && event.status !== "ready") {
      this.controlPending?.finish("unknown")
      this.roomCreate?.reject(new MusicPartyRoomCreateError("disconnected"))
      this.snapshot = null
      this.sharedState = null
      this.controlScope = null
      this.stopClockSync()
      for (const waiter of this.mutationWaiters.values()) waiter.reject(new Error("disconnected"))
      for (const settle of this.playlistWaiters.values()) settle({ ok: false, error: new MusicPartyPlaylistError("DISCONNECTED") })
      this.playlistWaiters.clear()
    }
    for (const listener of this.listeners) listener(event)
  }

  /** An ACK identifies our result; only an accepted projection proves convergence. */
  private settleControl(): void {
    const pending = this.controlPending, state = this.sharedState
    if (!pending?.ack || !state || pending.generation !== this.nativeGeneration || state.roomId !== pending.roomId) return
    if (state.stateVersion >= pending.ack.stateVersion && state.queueVersion >= pending.ack.queueVersion && state.playEpoch >= pending.ack.playEpoch) pending.finish(pending.ack.outcome)
  }

  /** D4 time base: ping every 5s while ready; three unanswered pings or a clock jump void the samples. */
  private startClockSync(): void {
    this.stopClockSync()
    this.schedulePing(5000)
  }

  private schedulePing(delayMs: number): void {
    clearTimeout(this.pingTimer)
    if (this.stopped || !this.welcomed) return
    const dueAtMs = Date.now() + delayMs
    this.pingTimer = setTimeout(() => this.sendClockPing(dueAtMs), delayMs)
  }

  private sendClockPing(dueAtMs: number): void {
    if (this.stopped || !this.welcomed) return
    if (Date.now() - dueAtMs > 5000 || this.outstandingPings.size >= 3) {
      this.outstandingPings.clear()
      if (this.sharedState?.clockSamples.length) {
        this.sharedState = { ...this.sharedState, clockSamples: [] }
        this.emit({ type: "shared-room-state", state: this.sharedState })
      }
    }
    const pingId = crypto.randomUUID()
    this.outstandingPings.set(pingId, Date.now())
    this.sendCommand({ type: "sync.ping", payload: { pingId, clientSendTime: Date.now() } })
    this.schedulePing(5000)
  }

  private stopClockSync(): void {
    clearTimeout(this.pingTimer)
    this.pingTimer = undefined
    this.outstandingPings.clear()
  }

  private requestResync(): void {
    const now = Date.now()
    if (now - this.lastResyncAtMs < 750) return
    this.lastResyncAtMs = now
    this.sendCommand({ type: "player.resync", roomId: this.options.roomId, payload: {} })
  }
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
  return { ...normalizeMusic(entry.music), id: entry.queueId, musicId: entry.music.id, status: entry.status }
}

function toPlaylistSummary(value: unknown): PlaylistSummary {
  const raw = value as Record<string, unknown> | null
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string"
    || typeof raw.trackCount !== "number" || !Number.isSafeInteger(raw.trackCount) || raw.trackCount < 0
    || (raw.systemKey !== null && typeof raw.systemKey !== "string")) throw new MusicPartyPlaylistError("INVALID_RESPONSE")
  return { id: raw.id, name: raw.name, systemKey: raw.systemKey as string | null, trackCount: raw.trackCount,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0, updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 }
}

function toPlaylistTrack(value: unknown): PlaylistTrack {
  const raw = value as Record<string, unknown> | null
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || typeof raw.playlistId !== "string") throw new MusicPartyPlaylistError("INVALID_RESPONSE")
  const music = raw.music as Partial<MusicMetadata> | null
  if (!music || typeof music.id !== "string" || typeof music.name !== "string" || !Array.isArray(music.artists)
    || typeof music.duration !== "number" || !Number.isFinite(music.duration) || typeof music.platform !== "string"
    || typeof music.coverUrl !== "string") throw new MusicPartyPlaylistError("INVALID_RESPONSE")
  return { id: raw.id, playlistId: raw.playlistId, music: music as MusicMetadata,
    sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : 0, createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0 }
}

/** Decode the additive room projection without changing the native playback path. */
function decodeSharedPlayerState(value: unknown): PlayerStatePayload | null {
  if (!value || typeof value !== "object") return null
  const state = value as Record<string, unknown>
  if (![state.stateVersion, state.queueVersion, state.playEpoch].every(version => typeof version === "number" && Number.isSafeInteger(version) && version >= 0)
    || typeof state.serverTimestamp !== "number" || !Number.isFinite(state.serverTimestamp)
    || typeof state.isPaused !== "boolean" || !Array.isArray(state.queue)) return null
  const flags = ["isShuffle", "isPauseLocked", "isSkipLocked", "isShuffleLocked", "isLoading"] as const
  if (flags.some(key => typeof state[key] !== "boolean")) return null
  const raw = state.nowPlaying
  let nowPlaying: PlayerStatePayload["nowPlaying"] = null
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object") return null
    const current = raw as Record<string, unknown>
    const music = current.music as Partial<MusicMetadata> | null
    if (!music || typeof music !== "object" || typeof music.id !== "string" || typeof music.name !== "string"
      || !Array.isArray(music.artists) || !music.artists.every(artist => typeof artist === "string")
      || typeof music.duration !== "number" || !Number.isFinite(music.duration) || music.duration < 0
      || !["netease", "youtube", "bilibili"].includes(music.platform ?? "") || typeof music.coverUrl !== "string"
      || typeof current.currentPosition !== "number" || !Number.isFinite(current.currentPosition) || current.currentPosition < 0) return null
    if (["enqueuedById", "enqueuedByName"].some(key => current[key] !== null && typeof current[key] !== "string")
      || !Array.isArray(current.likedUserIds) || !current.likedUserIds.every(id => typeof id === "string")
      || typeof current.positionUpdatedAt !== "number" || !Number.isFinite(current.positionUpdatedAt)
      || (current.playEpoch !== undefined && current.playEpoch !== state.playEpoch)) return null
    nowPlaying = { music: music as MusicMetadata, currentPosition: current.currentPosition,
      enqueuedById: current.enqueuedById as string | null | undefined, enqueuedByName: current.enqueuedByName as string | null | undefined,
      likedUserIds: current.likedUserIds as string[] | undefined, positionUpdatedAt: current.positionUpdatedAt as number | undefined }
  }
  return { nowPlaying, queue: [], isPaused: state.isPaused, isShuffle: state.isShuffle === true,
    isPauseLocked: state.isPauseLocked === true, isSkipLocked: state.isSkipLocked === true,
    isShuffleLocked: state.isShuffleLocked === true, isLoading: state.isLoading === true,
    stateVersion: state.stateVersion as number, queueVersion: state.queueVersion as number,
    historyCursor: typeof state.historyCursor === "number" && Number.isSafeInteger(state.historyCursor) && state.historyCursor >= 0 ? state.historyCursor : undefined,
    playEpoch: state.playEpoch as number, serverTimestamp: state.serverTimestamp }
}
