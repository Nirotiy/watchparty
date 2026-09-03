import { randomUUID } from "node:crypto";
import type {
  ApiError,
  CommandAck,
  MediaSource,
  PlaylistItem,
  RoomMember,
  RoomSnapshot,
  ClientType,
} from "../protocol.ts";
import { errorResult, ERROR_MESSAGES, okResult } from "../protocol.ts";
import { validateMediaSource, validateNickname } from "../media.ts";

const MAX_PLAYLIST_ITEMS = 200;
const MAX_RATE = 2;
const MIN_RATE = 0.25;
const MAX_POSITION = 1_000_000_000;

export type SharedCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; positionSeconds: number }
  | { type: "rate"; rate: number }
  | { type: "loop"; loop: boolean }
  | { type: "lock"; locked: boolean }
  | { type: "mediaSet"; media: MediaSource }
  | { type: "playlistAdd"; media: MediaSource }
  | { type: "playlistRemove"; itemId: string }
  | { type: "playlistMove"; itemId: string; targetIndex: number }
  | { type: "playlistPlay"; itemId: string }
  | { type: "playlistNext"; expectedCurrentPlaylistItemId?: string };

export type RoomEvent =
  | { event: "snapshot"; payload: RoomSnapshot }
  | { event: "members"; payload: RoomMember[] };

export type RoomOptions = { now?: () => number; initialMedia?: MediaSource };
export type RoomEventHandler = (event: RoomEvent) => void;

export class Room {
  readonly id: string;
  lastUpdateTime: Date;

  private readonly now: () => number;
  private readonly handlers: RoomEventHandler[] = [];
  private readonly members = new Map<string, RoomMember>();
  private ownerClientId: string;
  private source: MediaSource | null;
  private currentPlaylistItemId: string | undefined;
  private positionSeconds = 0;
  private stateChangedAtMs: number;
  private paused = true;
  private playbackRate = 1;
  private loop = false;
  private locked = true;
  private playlist: PlaylistItem[] = [];
  private revision = 0;
  private snapshotInterval: NodeJS.Timeout | undefined;

  constructor(id: string, ownerClientId: string, options: RoomOptions = {}) {
    this.id = id;
    this.ownerClientId = ownerClientId;
    this.now = options.now ?? Date.now;
    this.stateChangedAtMs = this.now();
    this.lastUpdateTime = new Date(this.stateChangedAtMs);
    this.source = options.initialMedia ?? null;
    this.snapshotInterval = setInterval(() => {
      if (this.source && !this.paused) this.emitSnapshot();
    }, 2_000);
    this.snapshotInterval.unref();
  }

  get roomId(): string {
    return this.id;
  }

  get ownerId(): string {
    return this.ownerClientId;
  }

  get onlineCount(): number {
    return this.members.size;
  }

  isOnline(clientId: string): boolean {
    return this.members.has(clientId);
  }

  memberClientType(clientId: string): ClientType | undefined {
    return this.members.get(clientId)?.clientType;
  }

  onEvent(handler: RoomEventHandler): void {
    this.handlers.push(handler);
  }

  join(
    clientId: string,
    name: string,
    clientType: ClientType = "browser",
  ): void {
    const member: RoomMember = {
      clientId,
      name: validateNickname(name) ? name.trim() : "观众",
      isOwner: clientId === this.ownerClientId,
      clientType,
    };
    this.members.set(clientId, member);
    this.emitMembers();
  }

  leave(clientId: string): void {
    if (!this.members.delete(clientId)) return;
    this.emitMembers();
  }

  rename(clientId: string, name: string): CommandAck {
    if (!validateNickname(name)) return this.invalidRequest();
    const member = this.members.get(clientId);
    if (!member) return this.invalidRequest();
    member.name = name.trim();
    this.touch();
    this.emitMembers();
    return okResult(this.revision);
  }

  execute(
    clientId: string,
    command: SharedCommand,
    expectedRevision: number,
    isOwner: boolean,
  ): CommandAck {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return this.invalidRequest();
    }
    if (expectedRevision !== this.revision)
      return errorResult("REVISION_CONFLICT");
    if (command.type === "lock" && !isOwner) return errorResult("FORBIDDEN");
    if (this.locked && !isOwner) return errorResult("FORBIDDEN");

    switch (command.type) {
      case "play":
        this.setPaused(false);
        break;
      case "pause":
        this.setPaused(true);
        break;
      case "seek":
        if (!isValidPosition(command.positionSeconds))
          return this.invalidRequest();
        this.setPosition(command.positionSeconds);
        break;
      case "rate":
        if (
          !Number.isFinite(command.rate) ||
          command.rate < MIN_RATE ||
          command.rate > MAX_RATE
        )
          return this.invalidRequest();
        this.setPosition(this.currentPosition());
        this.playbackRate = command.rate;
        break;
      case "loop":
        if (typeof command.loop !== "boolean") return this.invalidRequest();
        this.loop = command.loop;
        break;
      case "lock":
        if (typeof command.locked !== "boolean") return this.invalidRequest();
        this.locked = command.locked;
        break;
      case "mediaSet":
        if (!validateMediaSource(command.media)) return this.invalidRequest();
        this.source = command.media;
        this.currentPlaylistItemId = undefined;
        this.positionSeconds = 0;
        this.paused = true;
        this.playbackRate = 1;
        this.loop = false;
        this.stateChangedAtMs = this.now();
        break;
      case "playlistAdd":
        if (!validateMediaSource(command.media)) return this.invalidRequest();
        if (this.playlist.length >= MAX_PLAYLIST_ITEMS)
          return errorResult("PLAYLIST_FULL");
        this.playlist.push({
          id: randomUUID(),
          media: command.media,
          addedByClientId: clientId,
          addedAtMs: this.now(),
        });
        break;
      case "playlistRemove": {
        const index = this.playlist.findIndex(
          (item) => item.id === command.itemId,
        );
        if (index < 0) return errorResult("MEDIA_NOT_FOUND");
        this.playlist.splice(index, 1);
        break;
      }
      case "playlistMove": {
        if (
          !Number.isInteger(command.targetIndex) ||
          command.targetIndex < 0 ||
          command.targetIndex >= this.playlist.length
        )
          return this.invalidRequest();
        const index = this.playlist.findIndex(
          (item) => item.id === command.itemId,
        );
        if (index < 0) return errorResult("MEDIA_NOT_FOUND");
        const [item] = this.playlist.splice(index, 1);
        if (!item) return this.invalidRequest();
        this.playlist.splice(command.targetIndex, 0, item);
        break;
      }
      case "playlistPlay": {
        const item = this.playlist.find(
          (candidate) => candidate.id === command.itemId,
        );
        if (!item) return errorResult("MEDIA_NOT_FOUND");
        this.source = item.media;
        this.currentPlaylistItemId = item.id;
        this.positionSeconds = 0;
        this.paused = true;
        this.playbackRate = 1;
        this.stateChangedAtMs = this.now();
        break;
      }
      case "playlistNext": {
        // Old clients (e.g. an MPV that just finished a superseded media) must
        // not advance a playlist entry they no longer correspond to.
        if (
          command.expectedCurrentPlaylistItemId !== undefined &&
          command.expectedCurrentPlaylistItemId !== this.currentPlaylistItemId
        ) {
          return errorResult("REVISION_CONFLICT");
        }
        const next = this.nextPlaylistItem();
        if (!next) return okResult(this.revision);
        this.source = next.media;
        this.currentPlaylistItemId = next.id;
        this.positionSeconds = 0;
        this.paused = true;
        this.playbackRate = 1;
        this.stateChangedAtMs = this.now();
        break;
      }
    }

    this.revision += 1;
    this.touch();
    this.emitSnapshot();
    return okResult(this.revision);
  }

  setOwner(clientId: string): void {
    this.ownerClientId = clientId;
    for (const member of this.members.values())
      member.isOwner = member.clientId === clientId;
    this.revision += 1;
    this.touch();
    this.emitSnapshot();
    this.emitMembers();
  }

  snapshotMembers(): RoomMember[] {
    return [...this.members.values()].map((member) => ({ ...member }));
  }

  snapshot(): RoomSnapshot {
    return {
      revision: this.revision,
      source: this.source,
      ...(this.currentPlaylistItemId
        ? { currentPlaylistItemId: this.currentPlaylistItemId }
        : {}),
      positionSeconds: this.currentPosition(),
      serverTimeMs: this.now(),
      paused: this.paused,
      playbackRate: this.playbackRate,
      loop: this.loop,
      locked: this.locked,
      ownerClientId: this.ownerClientId,
      playlist: this.playlist.map((item) => ({
        ...item,
        media: { ...item.media },
      })),
    };
  }

  destroy(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = undefined;
    }
    this.handlers.length = 0;
    this.members.clear();
  }

  /**
   * Next playlist entry. With loop=false the list ends at the last item (no
   * wrap); loop=true wraps back to the first. A current source that is not a
   * playlist entry always starts from the first item.
   */
  private nextPlaylistItem(): PlaylistItem | undefined {
    if (!this.playlist.length) return undefined;
    const currentIndex = this.currentPlaylistItemId
      ? this.playlist.findIndex(
          (item) => item.id === this.currentPlaylistItemId,
        )
      : -1;
    const next = this.playlist[currentIndex + 1];
    if (next) return next;
    if (currentIndex >= 0 && !this.loop) return undefined;
    return this.playlist[0];
  }

  private setPaused(paused: boolean): void {
    this.setPosition(this.currentPosition());
    this.paused = paused;
  }

  private setPosition(position: number): void {
    this.positionSeconds = position;
    this.stateChangedAtMs = this.now();
  }

  private currentPosition(): number {
    if (this.paused) return this.positionSeconds;
    return (
      this.positionSeconds +
      ((this.now() - this.stateChangedAtMs) / 1000) * this.playbackRate
    );
  }

  private invalidRequest(): { ok: false; error: ApiError } {
    return {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: ERROR_MESSAGES.INVALID_REQUEST,
      },
    };
  }

  private touch(): void {
    this.lastUpdateTime = new Date(this.now());
  }

  private emitSnapshot(): void {
    this.emit({ event: "snapshot", payload: this.snapshot() });
  }

  private emitMembers(): void {
    this.emit({
      event: "members",
      payload: [...this.members.values()].map((member) => ({ ...member })),
    });
  }

  private emit(event: RoomEvent): void {
    this.lastUpdateTime = new Date(this.now());
    for (const handler of this.handlers) handler(event);
  }
}

function isValidPosition(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_POSITION;
}
