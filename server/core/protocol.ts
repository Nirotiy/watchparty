/**
 * Core watch-together socket and HTTP contract.
 * Event names stay `CMD:*` / `REC:*` so the Vite UI keeps working.
 */

export type RoomCommand =
  | { type: "host"; url: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; t: number }
  | { type: "playbackRate"; rate: number }
  | { type: "loop"; on: boolean }
  | { type: "ts"; t: number }
  | { type: "name"; name: string }
  | { type: "chat"; msg: string; replyToId?: string; replyToTimestamp?: string }
  | { type: "playlistAdd"; url: string }
  | { type: "playlistMove"; index: number; toIndex: number }
  | { type: "playlistDelete"; index: number }
  | { type: "playlistNext"; url?: string };

/** Who should receive a Room event on the wire. */
export type RoomEventTarget = {
  to?: string;
  except?: string;
};

export type CoreHostState = {
  video: string;
  videoTS: number;
  subtitle: string;
  paused: boolean;
  playbackRate: number;
  loop: boolean;
};

/** Payload the Vite UI reads from REC:host / askHost. */
export type WireHostState = CoreHostState & {
  isVBrowserLarge: boolean;
  controller?: string;
};

export type RoomSnapshot = CoreHostState & {
  chat: ChatMessage[];
  playlist: PlaylistVideo[];
  roster: User[];
  nameMap: StringDict;
  pictureMap: StringDict;
  tsMap: NumberDict;
};

export type ReactionCommand = {
  value: string;
  msgId: string;
  msgTimestamp: string;
};

export type ChatV2Payload = {
  msg: string;
  replyToId?: string;
  replyToTimestamp?: string;
};

export type PlaylistMovePayload = {
  index: number;
  toIndex: number;
};

export type SocketData = {
  clientId: string;
  uid: string;
  isSub: boolean;
};

export interface ClientToServerEvents {
  "CMD:name": (name: string) => void;
  "CMD:picture": (url: string) => void;
  "CMD:host": (url: string) => void;
  "CMD:play": () => void;
  "CMD:pause": () => void;
  "CMD:seek": (t: number) => void;
  "CMD:playbackRate": (rate: number) => void;
  "CMD:loop": (on: boolean) => void;
  "CMD:ts": (t: number) => void;
  "CMD:chat": (msg: string) => void;
  "CMD:chatV2": (payload: ChatV2Payload) => void;
  "CMD:addReaction": (payload: ReactionCommand) => void;
  "CMD:removeReaction": (payload: ReactionCommand) => void;
  "CMD:askHost": () => void;
  "CMD:playlistNext": (url?: string) => void;
  "CMD:playlistAdd": (url: string) => void;
  "CMD:playlistMove": (payload: PlaylistMovePayload) => void;
  "CMD:playlistDelete": (index: number) => void;
}

export interface ServerToClientEvents {
  "REC:host": (state: WireHostState) => void;
  "REC:play": (video: string) => void;
  "REC:pause": () => void;
  "REC:seek": (t: number) => void;
  "REC:playbackRate": (rate: number) => void;
  "REC:loop": (on: boolean) => void;
  "REC:tsMap": (tsMap: NumberDict) => void;
  "REC:chat": (msg: ChatMessage) => void;
  "REC:nameMap": (nameMap: StringDict) => void;
  "REC:pictureMap": (pictureMap: StringDict) => void;
  "REC:addReaction": (payload: Reaction & { user: string }) => void;
  "REC:removeReaction": (payload: Reaction & { user: string }) => void;
  "REC:lock": (lock: string) => void;
  chatinit: (chat: ChatMessage[]) => void;
  playlist: (playlist: PlaylistVideo[]) => void;
  roster: (roster: User[]) => void;
}

export type InterServerEvents = Record<string, never>;

export type CoreServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type RoomEventPayloads = {
  "REC:host": CoreHostState;
  "REC:play": string;
  "REC:pause": undefined;
  "REC:seek": number;
  "REC:playbackRate": number;
  "REC:loop": boolean;
  "REC:tsMap": NumberDict;
  "REC:chat": ChatMessage;
  "REC:nameMap": StringDict;
  "REC:pictureMap": StringDict;
  "REC:addReaction": Reaction;
  "REC:removeReaction": Reaction;
  playlist: PlaylistVideo[];
  roster: User[];
};

export type RoomEvent = {
  [Event in keyof RoomEventPayloads]: {
    event: Event;
    payload: RoomEventPayloads[Event];
    target?: RoomEventTarget;
  };
}[keyof RoomEventPayloads];

export type RoomEventHandler = (event: RoomEvent) => void;

export function hostStateForClient(state: CoreHostState): WireHostState {
  return {
    video: state.video,
    videoTS: state.videoTS,
    subtitle: state.subtitle,
    paused: state.paused,
    playbackRate: state.playbackRate,
    loop: state.loop,
    isVBrowserLarge: false,
    controller: undefined,
  };
}

export const CORE_CMD = {
  name: "CMD:name",
  picture: "CMD:picture",
  host: "CMD:host",
  play: "CMD:play",
  pause: "CMD:pause",
  seek: "CMD:seek",
  playbackRate: "CMD:playbackRate",
  loop: "CMD:loop",
  ts: "CMD:ts",
  chat: "CMD:chat",
  chatV2: "CMD:chatV2",
  addReaction: "CMD:addReaction",
  removeReaction: "CMD:removeReaction",
  askHost: "CMD:askHost",
  playlistNext: "CMD:playlistNext",
  playlistAdd: "CMD:playlistAdd",
  playlistMove: "CMD:playlistMove",
  playlistDelete: "CMD:playlistDelete",
} as const;

export const CORE_REC = {
  host: "REC:host",
  play: "REC:play",
  pause: "REC:pause",
  seek: "REC:seek",
  playbackRate: "REC:playbackRate",
  loop: "REC:loop",
  tsMap: "REC:tsMap",
  chat: "REC:chat",
  nameMap: "REC:nameMap",
  pictureMap: "REC:pictureMap",
  addReaction: "REC:addReaction",
  removeReaction: "REC:removeReaction",
  lock: "REC:lock",
  chatinit: "chatinit",
  playlist: "playlist",
  roster: "roster",
} as const;
import type { Server } from "socket.io";
