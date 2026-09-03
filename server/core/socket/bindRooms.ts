import type { Socket } from "socket.io";
import type {
  ClientToServerEvents,
  CommandAck,
  CoreServer,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "../protocol.ts";
import {
  ERROR_MESSAGES,
  PROTOCOL_VERSION,
  errorResult,
  isValidUUID,
} from "../protocol.ts";
import { validateMediaSource, validateRevision } from "../media.ts";
import type { Room, RoomEvent } from "../room/Room.ts";
import type { RoomRegistry } from "../room/registry.ts";

type RoomSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** Bind the root Socket.io namespace and authenticate every room connection. */
export function bindRooms(io: CoreServer, registry: RoomRegistry): void {
  const socketIdsByRoom = new Map<string, Map<string, string>>();
  const bridgedRooms = new WeakSet<Room>();

  io.use((socket, next) => {
    const auth = socket.handshake.auth as Partial<SocketData> | undefined;
    // Spec 9.1: protocol version is hard-checked on handshake; no downgrade.
    if (auth?.clientProtocol !== PROTOCOL_VERSION) {
      next(socketError("PROTOCOL_VERSION_MISMATCH"));
      return;
    }
    const roomId = auth?.roomId;
    const clientId = auth?.clientId;
    const access = registry.authenticate(
      roomId ?? "",
      clientId ?? "",
      auth?.accessToken,
    );
    if (!roomId || !access) {
      next(socketError("ACCESS_TOKEN_INVALID"));
      return;
    }
    socket.data.roomId = roomId;
    socket.data.clientId = clientId ?? "";
    socket.data.accessToken = auth?.accessToken ?? "";
    socket.data.ownerToken =
      typeof auth?.ownerToken === "string" ? auth.ownerToken : undefined;
    socket.data.nickname = access.nickname;
    next();
  });

  io.on("connection", (socket) => {
    const room = registry.get(socket.data.roomId);
    if (!room) {
      socket.disconnect(true);
      return;
    }
    const clientId = socket.data.clientId;
    const socketIds = getSocketIds(socketIdsByRoom, room.id);
    const previousSocketId = socketIds.get(clientId);
    if (previousSocketId)
      io.sockets.sockets.get(previousSocketId)?.disconnect(true);
    socketIds.set(clientId, socket.id);
    socket.join(room.id);
    room.join(clientId, socket.data.nickname);
    bridgeRoomEvents(io, room, bridgedRooms);

    socket.emit("REC:snapshot", room.snapshot());
    socket.emit("REC:members", membersForRoom(room));
    if (
      socket.data.ownerToken &&
      !registry.isOwner(room.id, clientId, socket.data.ownerToken)
    ) {
      socket.emit("REC:error", {
        code: "OWNER_TOKEN_INVALID",
        message: ERROR_MESSAGES.OWNER_TOKEN_INVALID,
      });
    }

    bindCommands(socket, room, registry, io);
    socket.on("disconnect", () => {
      if (socketIds.get(clientId) !== socket.id) return;
      socketIds.delete(clientId);
      room.leave(clientId);
      if (socketIds.size === 0) socketIdsByRoom.delete(room.id);
    });
  });
}

function bindCommands(
  socket: RoomSocket,
  room: Room,
  registry: RoomRegistry,
  io: CoreServer,
): void {
  const owner = () =>
    registry.isOwner(room.id, socket.data.clientId, socket.data.ownerToken);
  const run = (
    payload: unknown,
    command: Parameters<Room["execute"]>[1],
    ack: (result: CommandAck) => void,
  ) => {
    const expectedRevision = isRecord(payload)
      ? payload.expectedRevision
      : undefined;
    if (!validateRevision(expectedRevision)) {
      ack(errorResult("INVALID_REQUEST"));
      return;
    }
    ack(room.execute(socket.data.clientId, command, expectedRevision, owner()));
  };

  socket.on("CMD:name", (payload, ack) => {
    const result = room.rename(socket.data.clientId, payload?.name);
    if (result.ok)
      registry.updateNickname(
        room.id,
        socket.data.accessToken,
        payload?.name ?? "",
      );
    ack(result);
  });
  socket.on("CMD:clockSync", (payload, ack) => {
    if (
      !isRecord(payload) ||
      typeof payload.clientSentAtMs !== "number" ||
      !Number.isFinite(payload.clientSentAtMs)
    ) {
      ack(errorResult("INVALID_REQUEST"));
      return;
    }
    ack({
      ok: true,
      revision: room.snapshot().revision,
      data: { serverTimeMs: room.snapshot().serverTimeMs },
    });
  });
  socket.on("CMD:play", (payload, ack) => run(payload, { type: "play" }, ack));
  socket.on("CMD:pause", (payload, ack) =>
    run(payload, { type: "pause" }, ack),
  );
  socket.on("CMD:seek", (payload, ack) => {
    if (!isRecord(payload) || typeof payload.positionSeconds !== "number")
      return ack(errorResult("INVALID_REQUEST"));
    run(
      payload,
      { type: "seek", positionSeconds: payload.positionSeconds },
      ack,
    );
  });
  socket.on("CMD:rate", (payload, ack) => {
    if (!isRecord(payload) || typeof payload.rate !== "number")
      return ack(errorResult("INVALID_REQUEST"));
    run(payload, { type: "rate", rate: payload.rate }, ack);
  });
  socket.on("CMD:loop", (payload, ack) => {
    if (!isRecord(payload) || typeof payload.loop !== "boolean")
      return ack(errorResult("INVALID_REQUEST"));
    run(payload, { type: "loop", loop: payload.loop }, ack);
  });
  socket.on("CMD:lock", (payload, ack) => {
    if (!isRecord(payload) || typeof payload.locked !== "boolean")
      return ack(errorResult("INVALID_REQUEST"));
    run(payload, { type: "lock", locked: payload.locked }, ack);
  });
  socket.on("CMD:mediaSet", (payload, ack) => {
    if (!isRecord(payload) || !validateMediaSource(payload.media))
      return ack(errorResult("INVALID_REQUEST"));
    run(payload, { type: "mediaSet", media: payload.media }, ack);
  });
  socket.on("CMD:playlistAdd", (payload, ack) => {
    if (!isRecord(payload) || !validateMediaSource(payload.media))
      return ack(errorResult("INVALID_REQUEST"));
    run(payload, { type: "playlistAdd", media: payload.media }, ack);
  });
  socket.on("CMD:playlistRemove", (payload, ack) => {
    if (!isRecord(payload) || typeof payload.itemId !== "string")
      return ack(errorResult("INVALID_REQUEST"));
    run(payload, { type: "playlistRemove", itemId: payload.itemId }, ack);
  });
  socket.on("CMD:playlistMove", (payload, ack) => {
    if (
      !isRecord(payload) ||
      typeof payload.itemId !== "string" ||
      typeof payload.targetIndex !== "number"
    )
      return ack(errorResult("INVALID_REQUEST"));
    run(
      payload,
      {
        type: "playlistMove",
        itemId: payload.itemId,
        targetIndex: payload.targetIndex,
      },
      ack,
    );
  });
  socket.on("CMD:playlistPlay", (payload, ack) => {
    if (!isRecord(payload) || typeof payload.itemId !== "string")
      return ack(errorResult("INVALID_REQUEST"));
    run(payload, { type: "playlistPlay", itemId: payload.itemId }, ack);
  });
  socket.on("CMD:playlistNext", (payload, ack) =>
    run(payload, { type: "playlistNext" }, ack),
  );
  socket.on("CMD:transferOwner", (payload, ack) => {
    if (!isRecord(payload) || typeof payload.targetClientId !== "string")
      return ack(errorResult("INVALID_REQUEST"));
    const expectedRevision = payload.expectedRevision;
    if (!validateRevision(expectedRevision))
      return ack(errorResult("INVALID_REQUEST"));
    if (expectedRevision !== room.snapshot().revision)
      return ack(errorResult("REVISION_CONFLICT"));
    if (!owner()) return ack(errorResult("OWNER_TOKEN_INVALID"));
    const result = registry.transferOwner(
      room.id,
      socket.data.clientId,
      socket.data.ownerToken,
      payload.targetClientId,
    );
    if (!result.ok) return ack(errorResult(result.code));
    const targetSocketId = findSocketId(io, room.id, payload.targetClientId);
    if (targetSocketId)
      io.to(targetSocketId).emit("REC:ownerToken", result.ownerToken);
    socket.data.ownerToken = undefined;
    ack({ ok: true, revision: room.snapshot().revision });
  });
}

function bridgeRoomEvents(
  io: CoreServer,
  room: Room,
  bridgedRooms: WeakSet<Room>,
): void {
  if (bridgedRooms.has(room)) return;
  bridgedRooms.add(room);
  room.onEvent((event) => {
    if (event.event === "snapshot")
      io.to(room.id).emit("REC:snapshot", event.payload);
    else io.to(room.id).emit("REC:members", event.payload);
  });
}

function membersForRoom(
  room: Room,
): Parameters<ServerToClientEvents["REC:members"]>[0] {
  return room.snapshotMembers();
}

function findSocketId(
  io: CoreServer,
  roomId: string,
  clientId: string,
): string | undefined {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.roomId === roomId && socket.data.clientId === clientId)
      return socket.id;
  }
  return undefined;
}

function getSocketIds(
  map: Map<string, Map<string, string>>,
  roomId: string,
): Map<string, string> {
  const current = map.get(roomId);
  if (current) return current;
  const created = new Map<string, string>();
  map.set(roomId, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function socketError(
  code: "ACCESS_TOKEN_INVALID" | "PROTOCOL_VERSION_MISMATCH",
): Error & { data: { code: string; message: string } } {
  const error = new Error(ERROR_MESSAGES[code]) as Error & {
    data: { code: string; message: string };
  };
  error.data = { code, message: ERROR_MESSAGES[code] };
  return error;
}
