import type { MediaItem, PlaybackSnapshot } from "./domain"

export interface PlayerAdapter {
  readonly kind: "libmpv" | "native-audio"
  load(item: MediaItem, mediaUrl: string): Promise<void>
  applySnapshot(snapshot: PlaybackSnapshot): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  setAudioFocus(active: boolean): Promise<void>
  dispose(): Promise<void>
}

export class AudioFocusOwner {
  private owner: string | null = null
  private readonly players = new Map<string, PlayerAdapter>()

  register(id: string, player: PlayerAdapter): void { this.players.set(id, player) }
  unregister(id: string): void { this.players.delete(id); if (this.owner === id) this.owner = null }
  async request(id: string): Promise<boolean> {
    const player = this.players.get(id)
    if (!player) return false
    if (this.owner && this.owner !== id) await this.players.get(this.owner)?.setAudioFocus(false)
    this.owner = id
    await player.setAudioFocus(true)
    return true
  }
  async release(id: string): Promise<void> {
    if (this.owner !== id) return
    await this.players.get(id)?.setAudioFocus(false)
    this.owner = null
  }
  get currentOwner(): string | null { return this.owner }
}

