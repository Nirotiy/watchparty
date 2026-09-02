import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { Room } from "./Room.ts";

export type RoomRegistryOptions = {
  now?: () => number;
  idleTtlMs?: number;
};

export type CreateRoomOptions = {
  password?: string;
};

type RoomAccess = {
  salt: Buffer;
  passwordHash: Buffer;
  tokens: Map<string, number>;
};

const DEFAULT_IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const PIN_PATTERN = /^\d{4}$/;

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly accessByRoom = new Map<string, RoomAccess>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;

  constructor(options: RoomRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  get size(): number {
    return this.rooms.size;
  }

  has(key: string): boolean {
    return this.rooms.has(key);
  }

  get(key: string): Room | undefined {
    return this.rooms.get(key);
  }

  values(): IterableIterator<Room> {
    return this.rooms.values();
  }

  create(roomId: string, options: CreateRoomOptions = {}): Room {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }
    const room = new Room(roomId, { now: this.now });
    this.rooms.set(roomId, room);
    if (options.password) {
      if (!PIN_PATTERN.test(options.password)) {
        room.destroy();
        this.rooms.delete(roomId);
        throw new Error("Room password must be a 4 digit PIN");
      }
      const salt = randomBytes(16);
      this.accessByRoom.set(roomId, {
        salt,
        passwordHash: scryptSync(options.password, salt, 32),
        tokens: new Map(),
      });
    }
    return room;
  }

  isProtected(roomId: string): boolean {
    return this.accessByRoom.has(roomId);
  }

  verifyPin(roomId: string, pin: string): string | undefined {
    const access = this.accessByRoom.get(roomId);
    if (!access || !PIN_PATTERN.test(pin)) {
      return undefined;
    }
    const candidate = scryptSync(pin, access.salt, access.passwordHash.length);
    if (!timingSafeEqual(candidate, access.passwordHash)) {
      return undefined;
    }
    const token = randomBytes(32).toString("base64url");
    access.tokens.set(token, this.now() + TOKEN_TTL_MS);
    return token;
  }

  canJoin(roomId: string, token: unknown): boolean {
    const access = this.accessByRoom.get(roomId);
    if (!access) {
      return true;
    }
    if (typeof token !== "string") {
      return false;
    }
    const expiresAt = access.tokens.get(token);
    if (!expiresAt || expiresAt <= this.now()) {
      access.tokens.delete(token);
      return false;
    }
    return true;
  }

  /** Drop empty rooms whose last activity is older than idleTtlMs. */
  pruneIdle(): string[] {
    const unloaded: string[] = [];
    const cutoff = this.now() - this.idleTtlMs;
    for (const [key, room] of this.rooms) {
      if (room.roster.length > 0) {
        continue;
      }
      if (Number(room.lastUpdateTime) >= cutoff) {
        continue;
      }
      console.log("unloading empty room %s", key);
      room.destroy();
      this.rooms.delete(key);
      this.accessByRoom.delete(key);
      unloaded.push(key);
    }
    return unloaded;
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) {
      room.destroy();
    }
    this.rooms.clear();
    this.accessByRoom.clear();
  }
}
