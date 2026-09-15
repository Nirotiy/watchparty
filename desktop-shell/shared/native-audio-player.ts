import type { MediaItem, PlaybackSnapshot } from "./domain"
import type { PlayerAdapter } from "./player"

export class NativeAudioPlayer implements PlayerAdapter {
  readonly kind = "native-audio" as const
  private readonly audio = new Audio()

  async load(_item: MediaItem, mediaUrl: string): Promise<void> {
    this.audio.src = mediaUrl
    this.audio.load()
  }

  async applySnapshot(snapshot: PlaybackSnapshot): Promise<void> {
    if (Math.abs(this.audio.currentTime - snapshot.positionSeconds) > 0.75) this.audio.currentTime = Math.max(0, snapshot.positionSeconds)
    if (snapshot.playing) await this.audio.play()
    else this.audio.pause()
  }

  async pause(): Promise<void> { this.audio.pause() }
  async resume(): Promise<void> { await this.audio.play() }
  async stop(): Promise<void> { this.audio.pause(); this.audio.currentTime = 0 }
  async setAudioFocus(active: boolean): Promise<void> { if (!active) await this.pause() }
  async dispose(): Promise<void> { await this.stop(); this.audio.removeAttribute("src"); this.audio.load() }
}
