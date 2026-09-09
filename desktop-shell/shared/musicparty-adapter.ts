import type { DomainEvent, ProductId } from "./domain"
import type { ProductAdapter } from "./adapter"
import { DEFAULT_RETRY_POLICY, retryDelay } from "./retry"

export interface MusicPartyAdapterOptions {
  origin: string
  cookie?: string
  roomId?: string
  fetchImpl?: typeof fetch
  webSocketFactory?: (url: string) => WebSocket
}

/** Transport boundary for MusicParty. UI never sees raw HTTP or socket envelopes. */
export class MusicPartyAdapter implements ProductAdapter {
  readonly product: ProductId = "musicparty"
  private readonly listeners = new Set<(event: DomainEvent) => void>()
  private readonly fetchImpl: typeof fetch
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0

  constructor(private readonly options: MusicPartyAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async connect(): Promise<void> {
    this.stopped = false
    this.attempt = 0
    this.emit({ type: "connection", status: "connecting" })
    await this.openSocket()
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    this.socket?.close()
    this.socket = null
    this.emit({ type: "connection", status: "idle" })
  }

  async redeemInvite(code: string): Promise<void> {
    const response = await this.request("/api/invites/redeem", { method: "POST", body: JSON.stringify({ code }) })
    if (!response.ok) throw new Error(`invite_rejected:${response.status}`)
  }

  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("Accept", "application/json")
    if (init.body) headers.set("Content-Type", "application/json")
    if (this.options.cookie) headers.set("Cookie", this.options.cookie)
    return this.fetchImpl(new URL(path, this.options.origin), { ...init, headers, credentials: "include" })
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url))
    const url = new URL("/ws", this.options.origin.replace(/^http/, "ws"))
    if (this.options.roomId) url.searchParams.set("roomId", this.options.roomId)
    const socket = factory(url.toString())
    this.socket = socket
    socket.onopen = () => { this.attempt = 0; this.emit({ type: "connection", status: "ready" }) }
    socket.onmessage = (event) => this.decode(event.data)
    socket.onerror = () => this.emit({ type: "connection", status: "reconnecting", message: "网络连接异常" })
    socket.onclose = () => {
      if (this.stopped) return
      if (++this.attempt > DEFAULT_RETRY_POLICY.maxAttempts) { this.emit({ type: "connection", status: "failed", message: "无法连接 MusicParty 服务" }); return }
      this.emit({ type: "connection", status: "reconnecting" })
      setTimeout(() => void this.openSocket(), retryDelay(this.attempt))
    }
  }

  private decode(raw: unknown): void {
    try {
      const value = JSON.parse(String(raw)) as { type?: string; snapshot?: unknown; message?: string }
      if (value.type === "playback" && value.snapshot) this.emit({ type: "playback", snapshot: value.snapshot as never })
      else if (value.type === "error") this.emit({ type: "error", code: "server_error", message: value.message ?? "MusicParty 服务错误" })
    } catch { this.emit({ type: "error", code: "invalid_event", message: "收到无法识别的服务事件" }) }
  }

  private emit(event: DomainEvent): void { for (const listener of this.listeners) listener(event) }
}

