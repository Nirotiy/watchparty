import { YOUTUBE_VIDEO_ID_REGEX } from "../../utils/regex.ts";
import type {
  CoreHostState,
  RoomCommand,
  RoomEvent,
  RoomEventHandler,
  ReactionCommand,
  RoomSnapshot,
} from "../protocol.ts";
import { CORE_REC } from "../protocol.ts";

const MAX_HOST_URL = 50000;
const MAX_PLAYLIST_URL = 20000;
const MAX_CHAT = 10000;
const MAX_NAME = 50;
const MAX_PICTURE = 10000;
const MAX_NUMBER_STRING = 100;
const MAX_CHAT_HISTORY = 100;
const MAX_REACTION = 8;
const TS_IGNORE_MS = 1000;

export type RoomOptions = {
  now?: () => number;
};

export class Room {
  readonly id: string;
  lastUpdateTime: Date = new Date();
  roster: User[] = [];

  private video = "";
  private videoTS = 0;
  private subtitle = "";
  private playbackRate = 1;
  private paused = false;
  private loop = false;
  private controller: string | undefined;
  private isLocked = false;
  private chat: ChatMessage[] = [];
  private nameMap: StringDict = {};
  private pictureMap: StringDict = {};
  private playlist: PlaylistVideo[] = [];
  private tsMap: NumberDict = {};
  private lastTsMap = 0;
  private ignoreTsUntil = 0;
  private readonly now: () => number;
  private readonly handlers: RoomEventHandler[] = [];
  private tsInterval: NodeJS.Timeout | undefined;

  constructor(id: string, options: RoomOptions = {}) {
    this.id = id;
    this.now = options.now ?? Date.now;
    this.lastTsMap = this.now();
    this.tsInterval = setInterval(() => {
      const memberIds = this.roster.map((p) => p.id);
      for (const key of Object.keys(this.tsMap)) {
        if (!memberIds.includes(key)) {
          delete this.tsMap[key];
        }
      }
      if (this.video) {
        this.lastTsMap = this.now();
        this.emit({ event: CORE_REC.tsMap, payload: this.tsMap });
      }
    }, 1000);
    this.tsInterval.unref();
  }

  get roomId(): string {
    return this.id;
  }

  onEvent(handler: RoomEventHandler): void {
    this.handlers.push(handler);
  }

  apply(clientId: string, cmd: RoomCommand): void {
    if (
      this.isLocked &&
      cmd.type !== "lock" &&
      isLockedControl(cmd) &&
      clientId !== this.controller
    ) {
      return;
    }
    switch (cmd.type) {
      case "host":
        this.host(clientId, cmd.url);
        return;
      case "play":
        this.play(clientId);
        return;
      case "pause":
        this.pause(clientId);
        return;
      case "seek":
        this.seek(clientId, cmd.t);
        return;
      case "playbackRate":
        this.setPlaybackRate(clientId, cmd.rate);
        return;
      case "loop":
        this.setLoop(cmd.on);
        return;
      case "lock":
        this.setLock(clientId, cmd.locked);
        return;
      case "ts":
        this.setTimestamp(clientId, cmd.t);
        return;
      case "name":
        this.setName(clientId, cmd.name);
        return;
      case "chat":
        this.chatFrom(clientId, cmd.msg, cmd.replyToId, cmd.replyToTimestamp);
        return;
      case "playlistAdd":
        this.playlistAdd(clientId, cmd.url);
        return;
      case "playlistMove":
        this.playlistMove(cmd.index, cmd.toIndex);
        return;
      case "playlistDelete":
        this.playlistDelete(cmd.index);
        return;
      case "playlistNext":
        this.advancePlaylist(cmd.url);
        return;
    }
  }

  snapshot(): RoomSnapshot {
    return {
      ...this.hostState(),
      chat: this.chat,
      playlist: this.playlist,
      roster: this.roster,
      nameMap: this.nameMap,
      pictureMap: this.pictureMap,
      tsMap: this.tsMap,
    };
  }

  destroy(): void {
    if (this.tsInterval) {
      clearInterval(this.tsInterval);
      this.tsInterval = undefined;
    }
  }

  join(clientId: string): void {
    if (!this.roster.some((user) => user.id === clientId)) {
      this.roster.push({ id: clientId });
      this.controller ??= clientId;
    }
  }

  leave(clientId: string): void {
    this.roster = this.roster.filter((user) => user.id !== clientId);
    delete this.tsMap[clientId];
    if (this.controller === clientId) {
      this.controller = this.roster[0]?.id;
      this.emit({ event: CORE_REC.host, payload: this.hostState() });
    }
    this.emit({ event: CORE_REC.roster, payload: this.roster });
  }

  setPicture(clientId: string, url: string): void {
    if (url && url.length > MAX_PICTURE) {
      return;
    }
    this.pictureMap[clientId] = url;
    this.emit({ event: CORE_REC.pictureMap, payload: this.pictureMap });
  }

  addReaction(clientId: string, data: ReactionCommand): void {
    const users = this.reactionUsers(data, true);
    if (!users) {
      return;
    }
    if (!users.includes(clientId)) {
      users.push(clientId);
      this.emit({
        event: CORE_REC.addReaction,
        payload: { user: clientId, ...data },
      });
    }
  }

  removeReaction(clientId: string, data: ReactionCommand): void {
    const users = this.reactionUsers(data, false);
    if (!users) {
      return;
    }
    const index = users.indexOf(clientId);
    if (index === -1) {
      return;
    }
    users.splice(index, 1);
    this.emit({
      event: CORE_REC.removeReaction,
      payload: { user: clientId, ...data },
    });
  }

  private host(clientId: string, url: string): void {
    if (url && url.length > MAX_HOST_URL) {
      return;
    }
    this.setHost(url, clientId);
    if (url === "") {
      this.advancePlaylist();
    }
  }

  private setHost(url: string, clientId?: string): void {
    this.video = url;
    this.videoTS = 0;
    this.paused = false;
    this.subtitle = "";
    this.loop = false;
    this.playbackRate = 1;
    this.tsMap = {};
    this.ignoreTsUntil = this.now() + TS_IGNORE_MS;
    this.emit({ event: CORE_REC.tsMap, payload: this.tsMap });
    this.emit({ event: CORE_REC.host, payload: this.hostState() });
    if (clientId && url) {
      this.pushChat(clientId, { id: clientId, cmd: "host", msg: url });
    }
    this.emit({ event: CORE_REC.roster, payload: this.roster });
  }

  private play(clientId: string): void {
    this.paused = false;
    this.emit({
      event: CORE_REC.play,
      payload: this.video,
      target: { except: clientId },
    });
    this.pushChat(clientId, {
      id: clientId,
      cmd: "play",
      msg: this.tsMap[clientId]?.toString(),
    });
  }

  private pause(clientId: string): void {
    this.paused = true;
    this.emit({
      event: CORE_REC.pause,
      payload: undefined,
      target: { except: clientId },
    });
    this.pushChat(clientId, {
      id: clientId,
      cmd: "pause",
      msg: this.tsMap[clientId]?.toString(),
    });
  }

  private seek(clientId: string, t: number): void {
    if (!this.isShortNumber(t)) {
      return;
    }
    this.videoTS = t;
    this.emit({
      event: CORE_REC.seek,
      payload: t,
      target: { except: clientId },
    });
    this.pushChat(clientId, { id: clientId, cmd: "seek", msg: t?.toString() });
  }

  private setPlaybackRate(clientId: string, rate: number): void {
    if (!this.isShortNumber(rate)) {
      return;
    }
    this.playbackRate = Number(rate);
    this.emit({ event: CORE_REC.playbackRate, payload: Number(rate) });
    this.pushChat(clientId, {
      id: clientId,
      cmd: "playbackRate",
      msg: rate?.toString(),
    });
  }

  private setLoop(on: boolean): void {
    if (String(on).length > MAX_NUMBER_STRING) {
      return;
    }
    this.loop = on;
    this.emit({ event: CORE_REC.loop, payload: on });
  }

  private setLock(clientId: string, locked: boolean): void {
    if (clientId !== this.controller || typeof locked !== "boolean") {
      return;
    }
    this.isLocked = locked;
    this.emit({ event: CORE_REC.lock, payload: locked });
  }

  private setTimestamp(clientId: string, t: number): void {
    if (!this.isShortNumber(t)) {
      return;
    }
    if (this.now() < this.ignoreTsUntil) {
      return;
    }
    // Negative is live-stream offset; otherwise timestamps only move forward.
    if (t < 0 || t > this.videoTS) {
      this.videoTS = t;
    }
    const timeSinceTsMap = this.now() - this.lastTsMap;
    this.tsMap[clientId] = t - timeSinceTsMap / 1000 + 1;
  }

  private setName(clientId: string, name: string): void {
    if (!name || name.length > MAX_NAME) {
      return;
    }
    this.nameMap[clientId] = name;
    this.emit({ event: CORE_REC.nameMap, payload: this.nameMap });
  }

  private chatFrom(
    clientId: string,
    msg: string,
    replyToId?: string,
    replyToTimestamp?: string,
  ): void {
    if (!msg || msg.length > MAX_CHAT) {
      return;
    }
    if (Boolean(replyToId) !== Boolean(replyToTimestamp)) {
      return;
    }
    const baseMsg: ChatMessageBase = { id: clientId, msg };
    if (!replyToId || !replyToTimestamp) {
      this.pushChat(clientId, baseMsg);
      return;
    }
    const target = this.chat.find(
      (m) => m.id === replyToId && m.timestamp === replyToTimestamp,
    );
    if (!target) {
      this.pushChat(clientId, baseMsg);
      return;
    }
    this.pushChat(clientId, {
      ...baseMsg,
      replyToId,
      replyToTimestamp,
      replyToUserId: replyToId,
      replyToMsg: target.msg || "",
    });
  }

  private playlistAdd(clientId: string, url: string): void {
    if (!url || url.length > MAX_PLAYLIST_URL) {
      return;
    }
    this.playlist.push({
      name: url,
      channel: "Video URL",
      duration: 0,
      url,
      type: url.startsWith("magnet:") ? "magnet" : "file",
    });
    this.emit({ event: CORE_REC.playlist, payload: this.playlist });
    if (clientId) {
      this.pushChat(clientId, { id: clientId, cmd: "playlistAdd", msg: url });
    }
    if (!this.video) {
      this.advancePlaylist();
    }
  }

  private playlistDelete(index: number): void {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.playlist.length
    ) {
      return;
    }
    this.playlist.splice(index, 1);
    this.emit({ event: CORE_REC.playlist, payload: this.playlist });
  }

  private playlistMove(index: number, toIndex: number): void {
    if (!Number.isInteger(index) || !Number.isInteger(toIndex)) {
      return;
    }
    if (
      index < 0 ||
      index >= this.playlist.length ||
      toIndex < 0 ||
      toIndex >= this.playlist.length
    ) {
      return;
    }
    const items = this.playlist.splice(index, 1);
    if (!items[0]) {
      return;
    }
    this.playlist.splice(toIndex, 0, items[0]);
    this.emit({ event: CORE_REC.playlist, payload: this.playlist });
  }

  private advancePlaylist(currentUrl?: string): void {
    if (
      currentUrl &&
      this.video &&
      currentUrl !== this.video &&
      youtubeVideoId(currentUrl) !== youtubeVideoId(this.video)
    ) {
      return;
    }
    const next = this.playlist.shift();
    this.emit({ event: CORE_REC.playlist, payload: this.playlist });
    if (next) {
      this.setHost(next.url);
    }
  }

  private pushChat(clientId: string, chatMsg: ChatMessageBase): void {
    const chatWithTime: ChatMessage = {
      ...chatMsg,
      timestamp: new Date(this.now()).toISOString(),
      videoTS: clientId ? this.tsMap[clientId] : undefined,
    };
    this.chat.push(chatWithTime);
    this.chat = this.chat.splice(-MAX_CHAT_HISTORY);
    this.emit({ event: CORE_REC.chat, payload: chatWithTime });
  }

  private hostState(): CoreHostState {
    return {
      video: this.video ?? "",
      videoTS: this.videoTS,
      subtitle: this.subtitle,
      playbackRate: this.playbackRate,
      paused: this.paused,
      loop: this.loop,
      controller: this.controller,
      isLocked: this.isLocked,
    };
  }

  private emit(event: RoomEvent): void {
    this.lastUpdateTime = new Date(this.now());
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private isShortNumber(value: number): boolean {
    return Number.isFinite(value) && String(value).length <= MAX_NUMBER_STRING;
  }

  private reactionUsers(
    data: ReactionCommand,
    create: boolean,
  ): string[] | undefined {
    if (
      !data.value ||
      data.value.length > MAX_REACTION ||
      !data.msgId ||
      !data.msgTimestamp
    ) {
      return undefined;
    }
    const message = this.chat.find(
      (candidate) =>
        candidate.id === data.msgId &&
        candidate.timestamp === data.msgTimestamp,
    );
    if (!message) {
      return undefined;
    }
    const reactions = (message.reactions ??= {});
    if (create) {
      return (reactions[data.value] ??= []);
    }
    return reactions[data.value];
  }
}

function isLockedControl(cmd: RoomCommand): boolean {
  return cmd.type === "play" || cmd.type === "pause" || cmd.type === "seek";
}

function youtubeVideoId(url: string): string | undefined {
  return YOUTUBE_VIDEO_ID_REGEX.exec(url)?.[1];
}
