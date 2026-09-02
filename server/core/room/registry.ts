import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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

type TokenRecord = { clientId: string; nickname: string };
type RoomAccess = {
  pinSalt?: Buffer;
  pinHash?: Buffer;
  accessTokens: Map<string, TokenRecord>;
  ownerTokenHash: string;
  ownerClientId: string;
};
type PinFailures = { count: number; expiresAt: number };

const DEFAULT_IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const PIN_PATTERN = /^\d{4}$/;
const PIN_WINDOW_MS = 5 * 60 * 1000;

export type CreatedRoom = { room: Room; accessToken: string; ownerToken: string };
export type AccessResult =
  | { ok: true; accessToken: string }
  | { ok: false; code: "INVALID_PIN" | "RATE_LIMITED" };
export type AuthenticatedAccess = { clientId: string; nickname: string };

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly accessByRoom = new Map<string, RoomAccess>();
  private readonly pinFailures = new Map<string, PinFailures>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;

  constructor(options: RoomRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  get size(): number { return this.rooms.size; }
  get(key: string): Room | undefined { return this.rooms.get(key); }
  values(): IterableIterator<Room> { return this.rooms.values(); }

  create(options: CreateRoomOptions): CreatedRoom {
    if (!isValidUUID(options.clientId)) {
      throw new Error("Invalid clientId");
    }
    if (!validateNickname(options.nickname)) throw new Error("Invalid nickname");
    if (options.pin !== undefined && !PIN_PATTERN.test(options.pin)) throw new Error("PIN must be four digits");

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
      accessTokens: new Map([[hashToken(accessToken), { clientId: options.clientId, nickname: options.nickname.trim() }]]),
      ownerTokenHash: hashToken(ownerToken),
      ownerClientId: options.clientId,
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

  issueAccess(roomId: string, clientId: string, nickname: string, pin: string | undefined, ip: string): AccessResult {
    const room = this.rooms.get(roomId);
    const access = this.accessByRoom.get(roomId);
    if (!room || !access || !isValidUUID(clientId) || !validateNickname(nickname)) return { ok: false, code: "INVALID_PIN" };
    if (access.pinHash && !this.checkPin(roomId, access, pin ?? "", ip)) {
      const failure = this.pinFailures.get(`${ip}:${roomId}`);
      return { ok: false, code: failure && failure.count >= 5 ? "RATE_LIMITED" : "INVALID_PIN" };
    }
    const token = randomToken();
    access.accessTokens.set(hashToken(token), { clientId, nickname: nickname.trim() });
    return { ok: true, accessToken: token };
  }

  authenticateToken(roomId: string, token: unknown): AuthenticatedAccess | undefined {
    if (typeof token !== "string") return undefined;
    return this.accessByRoom.get(roomId)?.accessTokens.get(hashToken(token));
  }

  updateNickname(roomId: string, accessToken: string, nickname: string): void {
    const record = this.accessByRoom.get(roomId)?.accessTokens.get(hashToken(accessToken));
    if (record) record.nickname = nickname.trim();
  }

  authenticate(roomId: string, clientId: string, token: unknown): AuthenticatedAccess | undefined {
    if (!isValidUUID(clientId) || typeof token !== "string") return undefined;
    const access = this.accessByRoom.get(roomId);
    const record = access?.accessTokens.get(hashToken(token));
    return record?.clientId === clientId ? record : undefined;
  }

  isOwner(roomId: string, clientId: string, ownerToken: unknown): boolean {
    const access = this.accessByRoom.get(roomId);
    return Boolean(
      access && access.ownerClientId === clientId && typeof ownerToken === "string" &&
      timingSafeStringEqual(access.ownerTokenHash, hashToken(ownerToken)),
    );
  }

  transferOwner(roomId: string, actorClientId: string, ownerToken: unknown, targetClientId: string):
    | { ok: true; ownerToken: string }
    | { ok: false; code: "OWNER_TOKEN_INVALID" | "OWNER_TARGET_OFFLINE" } {
    const room = this.rooms.get(roomId);
    const access = this.accessByRoom.get(roomId);
    if (!room || !access || !this.isOwner(roomId, actorClientId, ownerToken)) {
      return { ok: false, code: "OWNER_TOKEN_INVALID" };
    }
    if (!room.isOnline(targetClientId)) return { ok: false, code: "OWNER_TARGET_OFFLINE" };
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
      if (room.onlineCount > 0 || Number(room.lastUpdateTime) >= cutoff) continue;
      room.destroy();
      this.rooms.delete(roomId);
      this.accessByRoom.delete(roomId);
      for (const key of this.pinFailures.keys()) if (key.endsWith(`:${roomId}`)) this.pinFailures.delete(key);
      unloaded.push(roomId);
    }
    return unloaded;
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.accessByRoom.clear();
    this.pinFailures.clear();
  }

  private checkPin(roomId: string, access: RoomAccess, pin: string, ip: string): boolean {
    const key = `${ip}:${roomId}`;
    const existing = this.pinFailures.get(key);
    if (existing && existing.expiresAt > this.now() && existing.count >= 5) return false;
    if (!access.pinSalt || !access.pinHash || !PIN_PATTERN.test(pin)) return this.recordPinFailure(key);
    const candidate = scryptSync(pin, access.pinSalt, access.pinHash.length);
    if (timingSafeEqual(candidate, access.pinHash)) {
      this.pinFailures.delete(key);
      return true;
    }
    return this.recordPinFailure(key);
  }

  private recordPinFailure(key: string): false {
    const current = this.pinFailures.get(key);
    const next = current && current.expiresAt > this.now()
      ? { count: current.count + 1, expiresAt: current.expiresAt }
      : { count: 1, expiresAt: this.now() + PIN_WINDOW_MS };
    this.pinFailures.set(key, next);
    return false;
  }
}

function randomToken(): string { return randomBytes(32).toString("base64url"); }
function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
function randomRoomId(): string { return `room-${randomBytes(8).toString("hex")}`; }

export { ERROR_MESSAGES, errorResult };
