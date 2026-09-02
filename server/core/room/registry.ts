import { Room } from "./Room.ts";

export type RoomRegistryOptions = {
  now?: () => number;
  idleTtlMs?: number;
};

const DEFAULT_IDLE_TTL_MS = 8 * 60 * 60 * 1000;

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
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

  create(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }
    const room = new Room(roomId, { now: this.now });
    this.rooms.set(roomId, room);
    return room;
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
      unloaded.push(key);
    }
    return unloaded;
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) {
      room.destroy();
    }
    this.rooms.clear();
  }
}
