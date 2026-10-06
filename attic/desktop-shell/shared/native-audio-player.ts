import type { MediaItem, PlaybackSnapshot } from "./domain"
import type { PlayerAdapter } from "./player"
import type { MusicPartyInvoke } from "./musicparty-adapter"

type AudioCommand =
  | { action: "load"; url: string; itemId: string }
  | { action: "snapshot"; itemId: string | null; position: number; playing: boolean }
  | { action: "pause" | "resume" | "stop" | "dispose" | "status" }
  | { action: "volume"; volume: number }
  | { action: "focus"; active: boolean }

interface AudioStatus { loaded: boolean; position: number; paused: boolean; volume: number }

/** Serializes native commands; Rust owns libmpv, CA lookup and the playback lifetime. */
export class NativeAudioPlayer implements PlayerAdapter {
  readonly kind = "libmpv" as const
  readonly id = crypto.randomUUID()
  private pending: Promise<unknown> = Promise.resolve()
  private disposed = false
  private loaded = false
  private generation = 0
  private pendingSnapshot: PlaybackSnapshot | null = null
  constructor(private readonly invoke: MusicPartyInvoke) {}

  private command(command: AudioCommand): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("player_disposed"))
    const result = this.pending.then(() => this.invoke("musicPartyAudio", { input: { playerId: this.id, command } })).then(() => {})
    this.pending = result.catch(() => {})
    return result
  }
  async load(item: MediaItem, mediaUrl: string): Promise<void> {
    const generation = ++this.generation
    this.loaded = false
    // Only snapshots received during this load may be replayed after it finishes.
    this.pendingSnapshot = null
    await this.command({ action: "load", url: mediaUrl, itemId: item.id })
    if (generation !== this.generation) return
    this.loaded = true
    if (this.pendingSnapshot) {
      const snapshot = this.pendingSnapshot
      this.pendingSnapshot = null
      await this.applySnapshot(snapshot)
    }
  }
  async applySnapshot(snapshot: PlaybackSnapshot): Promise<void> {
    if (!this.loaded) { this.pendingSnapshot = snapshot; return }
    await this.command({ action: "snapshot", itemId: snapshot.item?.id ?? null, position: snapshot.positionSeconds, playing: snapshot.playing })
  }
  async pause(): Promise<void> { await this.command({ action: "pause" }) }
  async resume(): Promise<void> { await this.command({ action: "resume" }) }
  async stop(): Promise<void> {
    ++this.generation
    this.loaded = false
    this.pendingSnapshot = null
    await this.command({ action: "stop" })
  }
  async setVolume(volume: number): Promise<void> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) return Promise.reject(new Error("invalid_volume"))
    return this.command({ action: "volume", volume })
  }
  /** Reads the sidecar's effective volume so the UI can sync after reconnects or track changes. */
  async getVolume(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error("player_disposed"))
    const result = this.pending.then(() => this.invoke<AudioStatus>("musicPartyAudio", { input: { playerId: this.id, command: { action: "status" as const } } }))
    this.pending = result.then(() => undefined).catch(() => undefined)
    return (await result).volume
  }
  async setAudioFocus(active: boolean): Promise<void> {
    // An empty room has no native player to focus. bindPlayer requests focus again after load.
    if (active && !this.loaded) return
    await this.command({ action: "focus", active })
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    ++this.generation
    this.loaded = false
    this.pendingSnapshot = null
    const result = this.command({ action: "dispose" })
    this.disposed = true
    await result
  }
}
