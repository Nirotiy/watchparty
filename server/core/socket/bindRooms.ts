import type { Namespace, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  CoreServer,
  InterServerEvents,
  RoomEvent,
  RoomEventTarget,
  ServerToClientEvents,
  SocketData,
} from "../protocol.ts";
import { CORE_CMD, CORE_REC, hostStateForClient } from "../protocol.ts";
import type { Room } from "../room/Room.ts";
import type { RoomRegistry } from "../room/registry.ts";

type RoomNamespace = Namespace<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
type RoomSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

const ROOM_NAMESPACE = /^\/[a-z][a-z0-9-]*$/i;

/** Bind the legacy per-room namespace contract through one dynamic namespace. */
export function bindRooms(io: CoreServer, registry: RoomRegistry): void {
  const rooms = io.of(ROOM_NAMESPACE);
  const socketIdsByRoom = new Map<string, Map<string, string>>();
  const bridgedRooms = new WeakSet<Room>();

  rooms.use((socket, next) => {
    const room = registry.get(socket.nsp.name);
    if (!room) {
      next(new Error("Invalid namespace"));
      return;
    }
    const clientId = socket.handshake.query?.clientId;
    if (typeof clientId !== "string") {
      next(new Error("Invalid clientId type"));
      return;
    }
    if (!isValidUUID(clientId)) {
      next(new Error("Invalid clientId format"));
      return;
    }

    const socketIds = getSocketIds(socketIdsByRoom, room.id);
    const previousSocketId = socketIds.get(clientId);
    if (previousSocketId) {
      socket.nsp.sockets.get(previousSocketId)?.disconnect();
    }
    socketIds.set(clientId, socket.id);
    socket.data.clientId = clientId;
    socket.data.uid = "";
    socket.data.isSub = false;
    room.join(clientId);
    next();
  });

  rooms.on("connection", (socket: RoomSocket) => {
    const room = registry.get(socket.nsp.name);
    if (!room) {
      socket.disconnect();
      return;
    }

    const clientId = socket.data.clientId;
    const socketIds = getSocketIds(socketIdsByRoom, room.id);
    bridgeRoomEvents(socket.nsp, room, socketIds, bridgedRooms);

    const snap = room.snapshot();
    socket.emit(CORE_REC.host, hostStateForClient(snap));
    socket.emit(CORE_REC.nameMap, snap.nameMap);
    socket.emit(CORE_REC.pictureMap, snap.pictureMap);
    socket.emit(CORE_REC.tsMap, snap.tsMap);
    socket.emit(CORE_REC.lock, "");
    socket.emit(CORE_REC.chatinit, snap.chat);
    socket.emit(CORE_REC.playlist, snap.playlist);
    socket.nsp.emit(CORE_REC.roster, snap.roster);

    bindCoreCommands(socket, room, clientId);

    socket.on("disconnect", () => {
      if (socket.id !== socketIds.get(clientId)) {
        return;
      }
      room.leave(clientId);
      socketIds.delete(clientId);
      if (socketIds.size === 0) {
        socketIdsByRoom.delete(room.id);
      }
    });
  });
}

function bindCoreCommands(
  socket: RoomSocket,
  room: Room,
  clientId: string,
): void {
  socket.on(CORE_CMD.name, (name) => {
    room.apply(clientId, { type: "name", name: String(name) });
  });
  socket.on(CORE_CMD.picture, (url) => {
    room.setPicture(clientId, String(url));
  });
  socket.on(CORE_CMD.host, (url) => {
    room.apply(clientId, { type: "host", url: String(url) });
  });
  socket.on(CORE_CMD.play, () => room.apply(clientId, { type: "play" }));
  socket.on(CORE_CMD.pause, () => room.apply(clientId, { type: "pause" }));
  socket.on(CORE_CMD.seek, (t) => {
    room.apply(clientId, { type: "seek", t: Number(t) });
  });
  socket.on(CORE_CMD.playbackRate, (rate) => {
    room.apply(clientId, { type: "playbackRate", rate: Number(rate) });
  });
  socket.on(CORE_CMD.loop, (on) => {
    room.apply(clientId, { type: "loop", on: Boolean(on) });
  });
  socket.on(CORE_CMD.ts, (t) => {
    room.apply(clientId, { type: "ts", t: Number(t) });
  });
  socket.on(CORE_CMD.chat, (msg) => {
    if (typeof msg === "string") {
      room.apply(clientId, { type: "chat", msg });
    }
  });
  socket.on(CORE_CMD.chatV2, (payload) => {
    if (!payload || typeof payload.msg !== "string") {
      return;
    }
    room.apply(clientId, {
      type: "chat",
      msg: payload.msg,
      replyToId:
        typeof payload.replyToId === "string" ? payload.replyToId : undefined,
      replyToTimestamp:
        typeof payload.replyToTimestamp === "string"
          ? payload.replyToTimestamp
          : undefined,
    });
  });
  socket.on(CORE_CMD.addReaction, (reaction) => {
    if (reaction?.value && reaction.msgId && reaction.msgTimestamp) {
      room.addReaction(clientId, reaction);
    }
  });
  socket.on(CORE_CMD.removeReaction, (reaction) => {
    if (reaction?.value && reaction.msgId && reaction.msgTimestamp) {
      room.removeReaction(clientId, reaction);
    }
  });
  socket.on(CORE_CMD.askHost, () => {
    socket.emit(CORE_REC.host, hostStateForClient(room.snapshot()));
  });
  socket.on(CORE_CMD.playlistNext, (url) => {
    room.apply(clientId, {
      type: "playlistNext",
      url: url != null && url !== "" ? String(url) : undefined,
    });
  });
  socket.on(CORE_CMD.playlistAdd, (url) => {
    room.apply(clientId, { type: "playlistAdd", url: String(url) });
  });
  socket.on(CORE_CMD.playlistMove, (move) => {
    if (
      move == null ||
      typeof move.index !== "number" ||
      typeof move.toIndex !== "number"
    ) {
      return;
    }
    room.apply(clientId, {
      type: "playlistMove",
      index: move.index,
      toIndex: move.toIndex,
    });
  });
  socket.on(CORE_CMD.playlistDelete, (index) => {
    room.apply(clientId, { type: "playlistDelete", index: Number(index) });
  });
}

function bridgeRoomEvents(
  namespace: RoomNamespace,
  room: Room,
  socketIds: Map<string, string>,
  bridgedRooms: WeakSet<Room>,
): void {
  if (bridgedRooms.has(room)) {
    return;
  }
  bridgedRooms.add(room);
  room.onEvent((event) => emitRoomEvent(namespace, socketIds, event));
}

function emitRoomEvent(
  namespace: RoomNamespace,
  socketIds: Map<string, string>,
  roomEvent: RoomEvent,
): void {
  switch (roomEvent.event) {
    case CORE_REC.host:
      emitToTarget(
        namespace,
        socketIds,
        roomEvent.target,
        roomEvent.event,
        hostStateForClient(roomEvent.payload),
      );
      return;
    case CORE_REC.pause:
      emitToTarget(namespace, socketIds, roomEvent.target, roomEvent.event);
      return;
    case CORE_REC.play:
    case CORE_REC.seek:
    case CORE_REC.playbackRate:
    case CORE_REC.loop:
    case CORE_REC.tsMap:
    case CORE_REC.chat:
    case CORE_REC.nameMap:
    case CORE_REC.pictureMap:
    case CORE_REC.addReaction:
    case CORE_REC.removeReaction:
    case CORE_REC.playlist:
    case CORE_REC.roster:
      emitToTarget(
        namespace,
        socketIds,
        roomEvent.target,
        roomEvent.event,
        roomEvent.payload,
      );
      return;
  }
}

function emitToTarget<Event extends keyof ServerToClientEvents>(
  namespace: RoomNamespace,
  socketIds: Map<string, string>,
  target: RoomEventTarget | undefined,
  event: Event,
  ...args: Parameters<ServerToClientEvents[Event]>
): void {
  const targetId = target?.to ? socketIds.get(target.to) : undefined;
  if (target?.to) {
    if (targetId) {
      namespace.to(targetId).emit(event, ...args);
    }
    return;
  }

  const exceptId = target?.except ? socketIds.get(target.except) : undefined;
  if (exceptId) {
    namespace.except(exceptId).emit(event, ...args);
    return;
  }
  namespace.emit(event, ...args);
}

function getSocketIds(
  socketIdsByRoom: Map<string, Map<string, string>>,
  roomId: string,
): Map<string, string> {
  const existing = socketIdsByRoom.get(roomId);
  if (existing) {
    return existing;
  }
  const created = new Map<string, string>();
  socketIdsByRoom.set(roomId, created);
  return created;
}

function isValidUUID(id: string): boolean {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[4][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(
    id,
  );
}
