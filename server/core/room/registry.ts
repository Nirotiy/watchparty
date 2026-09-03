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
import type { MediaSource } from "../protocol.ts";

export type RoomRegistryOptions = { now?: () => number; idleTtlMs?: number };
export type CreateRoomOptions = {
  clientId: string;
  nickname: string;
  pin?: string;
  initialMedia?: MediaSource;
};

export type ClientType = "browser" | "mpv";
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
};
type HandoffTicket = {
  roomId: string;
  issuedByClientId: string;
  expiresAt: number;
};
type PinFailures = { count: number; expiresAt: number };

const DEFAULT_IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const HANDOFF_TICKET_TTL_MS = 120 * 1000;
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

    const access: RoomAccess = {
      accessTokens: new Map([
        [
          hashToken(accessToken),
          {
            clientId: options.clientId,
            nickname: options.nickname.trim(),
            clientType: "browser",
          },
        ],
      ]),
      ownerTokenHash: hashToken(ownerToken),
      ownerClientId: options.clientId,
      mpvLastSeen: new Map(),
    };
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
      clientType: "browser",
    });
    return { ok: true, accessToken: token };
  }

  /**
   * Issue a one-time handoff ticket for launching an MPV client into the room.
   * Only browser tokens may issue tickets. The ticket is stored hashed with a
   * short TTL; redemption is a single atomic map delete.
   */
  issueHandoffTicket(
    roomId: string,
    accessToken: string,
  ): { ticket: string; expiresAt: number } | undefined {
    const access = this.accessByRoom.get(roomId);
    const record = access?.accessTokens.get(hashToken(accessToken));
    if (!record || record.clientType !== "browser") return undefined;
    const ticket = randomToken();
    const expiresAt = this.now() + HANDOFF_TICKET_TTL_MS;
    this.handoffTickets.set(hashToken(ticket), {
      roomId,
      issuedByClientId: record.clientId,
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  /**
   * Redeem a handoff ticket: consume it once and mint an independent MPV
   * identity (fresh clientId + clientType=mpv token). Returns undefined when
   * the ticket is unknown, expired or already used.
   */
  redeemHandoffTicket(
    ticket: string,
  ):
    | {
        roomId: string;
        accessToken: string;
        clientId: string;
        nickname: string;
      }
    | undefined {
    if (typeof ticket !== "string" || !ticket) return undefined;
    const key = hashToken(ticket);
    const record = this.handoffTickets.get(key);
    this.handoffTickets.delete(key);
    if (!record || record.expiresAt <= this.now()) return undefined;
    const access = this.accessByRoom.get(record.roomId);
    if (!access) return undefined;
    const clientId = randomUUID();
    const token = randomToken();
    const nickname = "MPV";
    access.accessTokens.set(hashToken(token), {
      clientId,
      nickname,
      clientType: "mpv",
    });
    return { roomId: record.roomId, accessToken: token, clientId, nickname };
  }

  /** Token lookup that only accepts MPV tokens; used by the /api/mpv/* endpoints. */
  authenticateMpvToken(
    roomId: string,
    token: unknown,
  ): AuthenticatedAccess | undefined {
    if (typeof token !== "string") return undefined;
    const record = this.accessByRoom
      .get(roomId)
      ?.accessTokens.get(hashToken(token));
    return record?.clientType === "mpv" ? record : undefined;
  }

  /** Record a heartbeat from an MPV client so stale members can be pruned. */
  touchMpvClient(roomId: string, clientId: string): void {
    this.accessByRoom.get(roomId)?.mpvLastSeen.set(clientId, this.now());
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
    if (!room.isOnline(targetClientId))
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
