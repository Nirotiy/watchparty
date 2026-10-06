import type { MusicPartyAdapter } from "./musicparty-adapter"
import type { DomainEvent } from "./domain"
import type { PlayerAdapter } from "./player"

/** Owns the subscription and player binding together, including manual reconnection. */
export class MusicPartyConnection {
  private adapter: MusicPartyAdapter | null = null
  private origin = ""
  private unbind: (() => void) | undefined
  private unsubscribe: (() => void) | undefined
  private player: PlayerAdapter | undefined
  private onLoaded: (() => Promise<unknown>) | undefined
  private pending: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly rooms = new Map<string, string>()

  constructor(private readonly create: (origin: string, roomId?: string) => MusicPartyAdapter, private readonly onEvent: (event: DomainEvent) => void) {}

  get current(): MusicPartyAdapter | null { return this.adapter }
  /** Local output device for room-independent actions (sleep timer pauses it). */
  get audioPlayer(): PlayerAdapter | null { return this.player ?? null }

  /** Serialize auth actions with switching; never apply an old UI action to a new service. */
  withCurrent<T>(origin: string, action: (adapter: MusicPartyAdapter | null) => Promise<T>): Promise<T> {
    const expected = this.adapter
    const normalized = new URL(origin).origin
    const task = this.pending.then(() => {
      if (this.disposed || this.adapter !== expected || (this.adapter && this.origin !== normalized)) throw new Error("service_changed")
      return action(this.adapter)
    })
    this.pending = task.catch(() => {})
    return task
  }

  run<T>(origin: string, action: (adapter: MusicPartyAdapter) => Promise<T>): Promise<T> {
    const normalized = new URL(origin.trim()).origin
    const task = this.pending.then(async () => {
      if (this.disposed) throw new Error("connection_disposed")
      if (!this.adapter || normalized !== this.origin) {
        if (this.adapter?.roomId) this.rooms.set(this.origin, this.adapter.roomId)
        this.unbind?.(); this.unbind = undefined
        this.unsubscribe?.(); this.unsubscribe = undefined
        await this.adapter?.disconnect()
        if (this.disposed) throw new Error("connection_disposed")
        this.adapter = this.create(normalized, this.rooms.get(normalized))
        this.origin = normalized
        this.unsubscribe = this.adapter.subscribe(this.onEvent)
        if (this.player) this.unbind = this.adapter.bindPlayer(this.player, this.onLoaded)
      }
      return action(this.adapter)
    })
    this.pending = task.catch(() => {})
    return task
  }

  bindPlayer(player: PlayerAdapter, onLoaded: () => Promise<unknown>): void {
    if (this.disposed) return
    this.unbind?.()
    this.player = player; this.onLoaded = onLoaded
    this.unbind = this.adapter?.bindPlayer(player, onLoaded)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unbind?.(); this.unbind = undefined
    this.unsubscribe?.(); this.unsubscribe = undefined
    await this.adapter?.disconnect()
    await this.pending
    await this.adapter?.disconnect()
  }
}
