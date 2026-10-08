import type { CommandAck, MediaSource, RoomSnapshot, SubtitleTrack } from "../../lib/contracts";
import type { SocketClientOptions } from "../../lib/socket";
import type { MkvPlayerOptions } from "../../lib/mkv/player";
import type { EmbeddedTracks, PlayerCapabilities, PlayerLocalState } from "../../lib/player-local";
import { api as actualApi } from "../../lib/api";

const source = (id: string): MediaSource => ({ kind: "openlist", mediaId: id, title: `Media ${id}`, container: "mkv" });
export const rig = {
  snapshot: { revision: 1, source: source("a"), positionSeconds: 0, serverTimeMs: Date.now(), paused: true,
    playbackRate: 1, loop: false, locked: false, ownerClientId: "self", playlist: [] } as RoomSnapshot,
  sockets: new Set<WatchPartySocket>(), instances: [] as MkvPlayer[], states: [] as PlayerLocalState[], capabilities: [] as PlayerCapabilities[],
  commands: [] as string[], nextAdds: [] as Array<"success" | "failed" | "timeoutCommitted" | "timeoutUncommitted">,
  subtitleRequests: [] as string[], externalTracks: [] as SubtitleTrack[], transfers: [] as CommandAck[],
  refreshes: 0,
  publish() {
    this.snapshot.serverTimeMs = Date.now();
    for (const socket of this.sockets) socket.options.onSnapshot(structuredClone(this.snapshot));
  },
  setSource(media: MediaSource) { this.snapshot.source = media; this.snapshot.paused = true; this.snapshot.positionSeconds = 0; this.snapshot.revision++; this.publish(); },
  latest() { return this.instances.at(-1); },
};

export class WatchPartySocket {
  constructor(readonly options: SocketClientOptions) {}
  connect() { rig.sockets.add(this); queueMicrotask(() => { this.options.onConnect?.(); rig.publish(); this.members(); }); }
  disconnect() { rig.sockets.delete(this); }
  getClockOffset() { return 0; }
  members() { this.options.onMembers([{ clientId: "self", name: "Self", isOwner: rig.snapshot.ownerClientId === "self", clientType: "browser" },
    { clientId: "target", name: "Target", isOwner: rig.snapshot.ownerClientId === "target", clientType: "browser" }]); }
  async refreshSnapshot() { rig.refreshes++; rig.publish(); return structuredClone(rig.snapshot); }
  async playlistAdd(media: MediaSource): Promise<CommandAck> {
    rig.commands.push("playlistAdd");
    const outcome = rig.nextAdds.shift() ?? "success";
    if (outcome === "failed") return { ok: false, error: { code: "PLAYLIST_FULL", message: "清单已满" } };
    if (outcome !== "timeoutUncommitted") {
      rig.snapshot.playlist.push({ id: crypto.randomUUID(), media, addedByClientId: "self", addedAtMs: Date.now() });
      rig.snapshot.revision++; rig.publish();
    }
    return outcome.startsWith("timeout") ? { ok: false, error: { code: "TIMEOUT", message: "回执超时" } } : { ok: true, revision: rig.snapshot.revision };
  }
  async transferOwner(target: string): Promise<CommandAck> {
    const result = rig.transfers.shift() ?? { ok: true, revision: rig.snapshot.revision + 1 };
    if (result.ok) { rig.snapshot.ownerClientId = target; rig.snapshot.revision++; this.members(); rig.publish(); }
    return result;
  }
  async play() { rig.commands.push("play"); rig.snapshot.paused = false; rig.snapshot.revision++; rig.publish(); return { ok: true, revision: rig.snapshot.revision }; }
  async pause() { rig.snapshot.paused = true; rig.snapshot.revision++; rig.publish(); return { ok: true, revision: rig.snapshot.revision }; }
  async mediaSet(media: MediaSource) { rig.setSource(media); return { ok: true, revision: rig.snapshot.revision }; }
  async seek(position: number) { rig.snapshot.positionSeconds = position; rig.snapshot.revision++; rig.publish(); return { ok: true, revision: rig.snapshot.revision }; }
  async rate(rate: number) { rig.snapshot.playbackRate = rate; rig.snapshot.revision++; rig.publish(); return { ok: true, revision: rig.snapshot.revision }; }
  async loop(value: boolean) { rig.snapshot.loop = value; rig.snapshot.revision++; rig.publish(); return { ok: true, revision: rig.snapshot.revision }; }
}

export const api = {
  ...actualApi,
  resolveMedia: async (_room: string, id: string) => ({ url: `/${id}.mkv`, expiresAt: Date.now() + 60000, requiresCustomHeaders: false }),
  getSubtitleTracks: async () => rig.externalTracks,
  getSubtitleContent: async (_room: string, id: string) => { rig.subtitleRequests.push(id); return "1\n00:00:00,000 --> 00:00:10,000\nExternal cue\n"; },
  getMediaCapabilities: async () => ({ libraries: true, mediaAdmin: false }),
  getMediaLibraries: async () => [{ id: "lib", name: "Fixture library", kind: "anime", sourceName: "Fixture", health: "ok" }],
  getCatalog: async () => ({ items: [], hasMore: false }),
  getMediaList: async () => ({ items: ["a", "b", "c"].map((id) => ({ id, name: `Media ${id}`, type: "file", extension: "mkv",
    compatibility: { browser: "maybe", desktop: "supported" } })), hasMore: false, breadcrumbs: [{ name: "Fixture", path: "/" }] }),
};

/** Lifecycle fixture only. It does not decode media or create an audio output. */
export class MkvPlayer {
  currentTime = 0; duration = 12; volume = 85; muted = false; rate = 1; offset = 0; disposed = false; playing = false; unlocks = 0;
  embeddedTracks: EmbeddedTracks = { items: [], audioId: null, subtitleId: null };
  constructor(readonly options: MkvPlayerOptions) { rig.instances.push(this); }
  async load(url: string) {
    const base = url.includes("b.mkv") ? 100 : 0;
    this.embeddedTracks = { audioId: base + 1, subtitleId: base + 5, items: [
      { id: base + 1, kind: "audio", codec: "aac", label: "EN audio", language: "eng", supported: true },
      { id: base + 2, kind: "audio", codec: "opus", label: "JA audio", language: "jpn", supported: true },
      { id: base + 5, kind: "subtitle", codec: "subrip", label: "EN subtitle", language: "eng", supported: true },
      { id: base + 6, kind: "subtitle", codec: "subrip", label: "JA subtitle", language: "jpn", supported: true }] };
    this.options.onTracks?.(this.embeddedTracks); this.options.onReady(12); this.report();
  }
  report() { this.options.onLocalState?.({ phase: this.playing ? "playing" : "paused", audio: this.muted ? "muted" : "blocked", presentedTime: this.currentTime, bufferedAheadSeconds: 4 }); }
  async selectAudioTrack(id: number) { this.embeddedTracks.audioId = id; this.options.onTracks?.(this.embeddedTracks); }
  selectSubtitleTrack(id: number | null) { this.embeddedTracks.subtitleId = id; this.options.onTracks?.(this.embeddedTracks); }
  setExternalSubtitle() {}
  setSubtitleOffset(seconds: number) { this.offset = seconds; }
  async unlockAudio() { this.unlocks++; }
  seek(seconds: number) { this.currentTime = seconds; }
  setVolume(value: number) { this.volume = value; this.report(); }
  setMuted(value: boolean) { this.muted = value; this.report(); }
  setPlaybackRate(value: number) { this.rate = value; }
  async play() { this.playing = true; this.report(); }
  pause() { this.playing = false; this.report(); }
  dispose() { this.disposed = true; }
}
