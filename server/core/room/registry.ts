import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { Room, type RoomOptions } from "./Room.ts";
import { ERROR_MESSAGES, errorResult, type CommandAck } from "../protocol.ts";
import { validateNickname, isValidUUID } from "../media.ts";
import type { ClientType, MediaSource } from "../protocol.ts";

export type RoomRegistryOptions = { now?: () => number; idleTtlMs?: number };
export type CreateRoomOptions = {
  clientId: string;
  nickname: string;
  pin?: string;
  initialMedia?: MediaSource;
  clientType?: ClientType;
};

type TokenRecord = {
  clientId: string;
  nickname: string;
  clientType: ClientType;
};
type RoomAccess = {
  pinSalt?: Buffer;
  pinHash?: Buffer;
  accessTokens: Map<string, TokenRecord>;
  ownerTokenHash: string;
  ownerClientId: string;
  /** Last snapshot poll per MPV clientId, used to drop abandoned MPV members. */
  mpvLastSeen: Map<string, number>;
  /** Current generation and heartbeat for each desktop clientId. */
  desktopSessions: Map<string, DesktopSession>;
  /** Monotonic generation counters survive heartbeat pruning for each desktop token. */
  desktopGenerationCounters: Map<string, number>;
};
type DesktopSession = { generation: number; lastSeen: number };
type HandoffTicket = {
  roomId: string;
  issuedByClientId: string;
  target: "mpv" | "desktop";
  expiresAt: number;
};
type PinFailures = { count: number; expiresAt: number };

const DEFAULT_IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const HANDOFF_TICKET_TTL_MS = 5 * 60 * 1000;
/**
 * MPV polls snapshots every 2s (backoff up to 16s); anything that has not
 * polled for this long is considered gone and removed from the member list.
 */
const MPV_STALE_MS = 120 * 1000;
const PIN_PATTERN = /^\d{4}$/;
const PIN_WINDOW_MS = 5 * 60 * 1000;

export type CreatedRoom = {
  room: Room;
  accessToken: string;
  ownerToken: string;
};
export type AccessResult =
  | { ok: true; accessToken: string }
  | { ok: false; code: "INVALID_PIN" | "RATE_LIMITED" };
export type AuthenticatedAccess = {
  clientId: string;
  nickname: string;
  clientType: ClientType;
};

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly accessByRoom = new Map<string, RoomAccess>();
  private readonly handoffTickets = new Map<string, HandoffTicket>();
  private readonly pinFailures = new Map<string, PinFailures>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;

  constructor(options: RoomRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  get size(): number {
    return this.rooms.size;
  }
  get(key: string): Room | undefined {
    return this.rooms.get(key);
  }
  values(): IterableIterator<Room> {
    return this.rooms.values();
  }

  create(options: CreateRoomOptions): CreatedRoom {
    if (!isValidUUID(options.clientId)) {
      throw new Error("Invalid clientId");
    }
    if (!validateNickname(options.nickname))
      throw new Error("Invalid nickname");
    if (options.pin !== undefined && !PIN_PATTERN.test(options.pin))
      throw new Error("PIN must be four digits");

    let roomId = randomRoomId();
    while (this.rooms.has(roomId)) roomId = randomRoomId();
    const accessToken = randomToken();
    const ownerToken = randomToken();
    const room = new Room(roomId, options.clientId, {
      now: this.now,
      initialMedia: options.initialMedia,
    } satisfies RoomOptions);
    this.rooms.set(roomId, room);

    const clientType = options.clientType ?? "browser";
    const generation = clientType === "desktop" ? 1 : undefined;
    const access: RoomAccess = {
      accessTokens: new Map([
        [
          hashToken(accessToken),
          {
            clientId: options.clientId,
            nickname: options.nickname.trim(),
            clientType,
          },
        ],
      ]),
      ownerTokenHash: hashToken(ownerToken),
      ownerClientId: options.clientId,
      mpvLastSeen: new Map(),
      desktopSessions: new Map(),
      desktopGenerationCounters: new Map(),
    };
    if (generation !== undefined) {
      access.desktopGenerationCounters.set(options.clientId, generation);
      access.desktopSessions.set(options.clientId, {
        generation,
        lastSeen: this.now(),
      });
      room.join(options.clientId, options.nickname.trim(), "desktop");
    }
    if (options.pin) {
      const salt = randomBytes(16);
      access.pinSalt = salt;
      access.pinHash = scryptSync(options.pin, salt, 32);
    }
    this.accessByRoom.set(roomId, access);
    return { room, accessToken, ownerToken };
  }

  isProtected(roomId: string): boolean {
    return Boolean(this.accessByRoom.get(roomId)?.pinHash);
  }

  issueAccess(
    roomId: string,
    clientId: string,
    nickname: string,
    pin: string | undefined,
    ip: string,
    clientType: ClientType = "browser",
  ): AccessResult {
    const room = this.rooms.get(roomId);
    const access = this.accessByRoom.get(roomId);
    if (
      !room ||
      !access ||
      !isValidUUID(clientId) ||
      !validateNickname(nickname)
    )
      return { ok: false, code: "INVALID_PIN" };
    if (access.pinHash && !this.checkPin(roomId, access, pin ?? "", ip)) {
      const failure = this.pinFailures.get(`${ip}:${roomId}`);
      return {
        ok: false,
        code: failure && failure.count >= 5 ? "RATE_LIMITED" : "INVALID_PIN",
      };
    }
    const token = randomToken();
    access.accessTokens.set(hashToken(token), {
      clientId,
      nickname: nickname.trim(),
      clientType,
    });
    return { ok: true, accessToken: token };
  }

  /**
   * Issue a one-time handoff ticket for launching a native client into the room.
   * Only browser tokens may issue tickets. The target is bound into the ticket
   * so an MPV ticket cannot be redeemed through the desktop endpoint.
   */
  issueHandoffTicket(
    roomId: string,
    accessToken: string,
    target: "mpv" | "desktop" = "mpv",
  ): { ticket: string; expiresAt: number } | undefined {
    const access = this.accessByRoom.get(roomId);
    const record = access?.accessTokens.get(hashToken(accessToken));
    if (!record || record.clientType !== "browser") return undefined;
    const ticket = randomToken();
    const expiresAt = this.now() + HANDOFF_TICKET_TTL_MS;
    this.handoffTickets.set(hashToken(ticket), {
      roomId,
      issuedByClientId: record.clientId,
      target,
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  /**
   * Redeem a handoff ticket: consume it once and mint an independent native
   * identity. Desktop redemptions also start generation 1 for stale-session
   * protection. Returns undefined when the ticket is invalid for this target.
   */
  redeemHandoffTicket(
    ticket: string,
    target: "mpv" | "desktop" = "mpv",
  ):
    | {
        roomId: string;
        accessToken: string;
        clientId: string;
        nickname: string;
        clientType: "mpv" | "desktop";
        sessionGeneration?: number;
      }
    | undefined {
    if (typeof ticket !== "string" || !ticket) return undefined;
    const key = hashToken(ticket);
    const record = this.handoffTickets.get(key);
    if (!record || record.target !== target || record.expiresAt <= this.now()) {
      return undefined;
    }
    this.handoffTickets.delete(key);
    const access = this.accessByRoom.get(record.roomId);
    if (!access) return undefined;
    const clientId = randomUUID();
    const token = randomToken();
    const nickname = target === "desktop" ? "Desktop" : "MPV";
    const sessionGeneration = target === "desktop" ? 1 : undefined;
    access.accessTokens.set(hashToken(token), {
      clientId,
      nickname,
      clientType: target,
    });
    if (sessionGeneration !== undefined) {
      access.desktopGenerationCounters.set(clientId, sessionGeneration);
      access.desktopSessions.set(clientId, {
        generation: sessionGeneration,
        lastSeen: this.now(),
      });
    }
    return {
      roomId: record.roomId,
      accessToken: token,
      clientId,
      nickname,
      clientType: target,
      ...(sessionGeneration !== undefined ? { sessionGeneration } : {}),
    };
  }

  /** Token lookup restricted to the requested native client type. */
  authenticateNativeToken(
    roomId: string,
    token: unknown,
    clientType: "mpv" | "desktop",
  ): AuthenticatedAccess | undefined {
    if (typeof token !== "string") return undefined;
    const record = this.accessByRoom
      .get(roomId)
      ?.accessTokens.get(hashToken(token));
    return record?.clientType === clientType ? record : undefined;
  }

  /** Backward-compatible MPV-only token lookup for existing callers. */
  authenticateMpvToken(
    roomId: string,
    token: unknown,
  ): AuthenticatedAccess | undefined {
    return this.authenticateNativeToken(roomId, token, "mpv");
  }

  /** Record a heartbeat from an MPV client so stale members can be pruned. */
  touchMpvClient(roomId: string, clientId: string): boolean {
    const access = this.accessByRoom.get(roomId);
    if (!access) return false;
    const record = [...access.accessTokens.values()].find(
      (candidate) =>
        candidate.clientId === clientId && candidate.clientType === "mpv",
    );
    if (!record) return false;
    access.mpvLastSeen.set(clientId, this.now());
    return true;
  }

  /** Return the active desktop session generation for a client. */
  desktopSessionGeneration(
    roomId: string,
    clientId: string,
  ): number | undefined {
    return this.accessByRoom.get(roomId)?.desktopSessions.get(clientId)
      ?.generation;
  }

  /** Claim a new generation so delayed requests from an older desktop session become stale. */
  claimDesktopSession(
    roomId: string,
    accessToken: string,
  ): { clientId: string; nickname: string; generation: number } | undefined {
    const access = this.accessByRoom.get(roomId);
    const record = access?.accessTokens.get(hashToken(accessToken));
    if (!access || !record || record.clientType !== "desktop") return undefined;
    const generation =
      (access.desktopGenerationCounters.get(record.clientId) ?? 0) + 1;
    access.desktopGenerationCounters.set(record.clientId, generation);
    access.desktopSessions.set(record.clientId, {
      generation,
      lastSeen: this.now(),
    });
    this.rooms.get(roomId)?.join(record.clientId, record.nickname, "desktop");
    return { clientId: record.clientId, nickname: record.nickname, generation };
  }

  /** Touch a desktop session only when its generation is still current. */
  touchDesktopClient(
    roomId: string,
    clientId: string,
    generation: number,
  ): boolean {
    const session = this.accessByRoom
      .get(roomId)
      ?.desktopSessions.get(clientId);
    if (!session || session.generation !== generation) return false;
    session.lastSeen = this.now();
    return true;
  }

  /** Remove a desktop member only if the caller owns the current generation. */
  leaveDesktopClient(
    roomId: string,
    clientId: string,
    generation: number,
  ): boolean {
    const access = this.accessByRoom.get(roomId);
    const session = access?.desktopSessions.get(clientId);
    if (!access || !session || session.generation !== generation) return false;
    access.desktopSessions.delete(clientId);
    this.rooms.get(roomId)?.leave(clientId);
    return true;
  }

  authenticateToken(
    roomId: string,
    token: unknown,
  ): AuthenticatedAccess | undefined {
    if (typeof token !== "string") return undefined;
    return this.accessByRoom.get(roomId)?.accessTokens.get(hashToken(token));
  }

  updateNickname(roomId: string, accessToken: string, nickname: string): void {
    const record = this.accessByRoom
      .get(roomId)
      ?.accessTokens.get(hashToken(accessToken));
    if (record) record.nickname = nickname.trim();
  }

  authenticate(
    roomId: string,
    clientId: string,
    token: unknown,
  ): AuthenticatedAccess | undefined {
    if (!isValidUUID(clientId) || typeof token !== "string") return undefined;
    const access = this.accessByRoom.get(roomId);
    const record = access?.accessTokens.get(hashToken(token));
    return record?.clientId === clientId ? record : undefined;
  }

  isOwner(roomId: string, clientId: string, ownerToken: unknown): boolean {
    const access = this.accessByRoom.get(roomId);
    return Boolean(
      access &&
      access.ownerClientId === clientId &&
      typeof ownerToken === "string" &&
      timingSafeStringEqual(access.ownerTokenHash, hashToken(ownerToken)),
    );
  }

  transferOwner(
    roomId: string,
    actorClientId: string,
    ownerToken: unknown,
    targetClientId: string,
  ):
    | { ok: true; ownerToken: string }
    | { ok: false; code: "OWNER_TOKEN_INVALID" | "OWNER_TARGET_OFFLINE" } {
    const room = this.rooms.get(roomId);
    const access = this.accessByRoom.get(roomId);
    if (!room || !access || !this.isOwner(roomId, actorClientId, ownerToken)) {
      return { ok: false, code: "OWNER_TOKEN_INVALID" };
    }
    if (
      !room.isOnline(targetClientId) ||
      room.memberClientType(targetClientId) !== "browser"
    )
      return { ok: false, code: "OWNER_TARGET_OFFLINE" };
    const newOwnerToken = randomToken();
    access.ownerTokenHash = hashToken(newOwnerToken);
    access.ownerClientId = targetClientId;
    room.setOwner(targetClientId);
    return { ok: true, ownerToken: newOwnerToken };
  }

  pruneIdle(): string[] {
    const unloaded: string[] = [];
    const cutoff = this.now() - this.idleTtlMs;
    for (const [roomId, room] of this.rooms) {
      this.pruneStaleMpvMembers(room);
      if (room.onlineCount > 0 || Number(room.lastUpdateTime) >= cutoff)
        continue;
      room.destroy();
      this.rooms.delete(roomId);
      this.accessByRoom.delete(roomId);
      for (const key of this.pinFailures.keys())
        if (key.endsWith(`:${roomId}`)) this.pinFailures.delete(key);
      unloaded.push(roomId);
    }
    for (const key of this.handoffTickets.keys()) {
      if ((this.handoffTickets.get(key)?.expiresAt ?? 0) <= this.now())
        this.handoffTickets.delete(key);
    }
    return unloaded;
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.accessByRoom.clear();
    this.handoffTickets.clear();
    this.pinFailures.clear();
  }

  private pruneStaleMpvMembers(room: Room): void {
    const access = this.accessByRoom.get(room.id);
    if (!access) return;
    const cutoff = this.now() - MPV_STALE_MS;
    for (const [clientId, lastSeen] of access.mpvLastSeen) {
      if (lastSeen > cutoff) continue;
      access.mpvLastSeen.delete(clientId);
      room.leave(clientId);
    }
    for (const [clientId, session] of access.desktopSessions) {
      if (session.lastSeen > cutoff) continue;
      access.desktopSessions.delete(clientId);
      room.leave(clientId);
    }
  }

  private checkPin(
    roomId: string,
    access: RoomAccess,
    pin: string,
    ip: string,
  ): boolean {
    const key = `${ip}:${roomId}`;
    const existing = this.pinFailures.get(key);
    if (existing && existing.expiresAt > this.now() && existing.count >= 5)
      return false;
    if (!access.pinSalt || !access.pinHash || !PIN_PATTERN.test(pin))
      return this.recordPinFailure(key);
    const candidate = scryptSync(pin, access.pinSalt, access.pinHash.length);
    if (timingSafeEqual(candidate, access.pinHash)) {
      this.pinFailures.delete(key);
      return true;
    }
    return this.recordPinFailure(key);
  }

  private recordPinFailure(key: string): false {
    const current = this.pinFailures.get(key);
    const next =
      current && current.expiresAt > this.now()
        ? { count: current.count + 1, expiresAt: current.expiresAt }
        : { count: 1, expiresAt: this.now() + PIN_WINDOW_MS };
    this.pinFailures.set(key, next);
    return false;
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
function randomRoomId(): string {
  return `room-${randomBytes(8).toString("hex")}`;
}

export { ERROR_MESSAGES, errorResult };
