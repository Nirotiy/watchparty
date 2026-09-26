import type { ConnectionStatus, DomainEvent, MediaItem, PlaybackSnapshot, ProductId, RoomSummary } from "./domain"

/** Stable identity used by the lobby. Origin is normalized before comparison. */
export interface RoomIdentity {
  service: ProductId
  origin: string
  roomId: string
}

export interface RoomSummaryRecord extends RoomIdentity {
  name: string
  visibility: "public" | "private"
  memberCount: number | null
  requiresPassword: boolean
  /** The room's creator, when the server reports it: management belongs to that account. */
  creatorPublicId?: string
}

/** Details are derived from the list summary and the first authoritative WS snapshot. */
export interface RoomDetails extends RoomSummaryRecord {
  connection: ConnectionStatus
  playback: PlaybackSnapshot | null
  queue: MediaItem[]
  queueVersion?: number
  members: Array<{ id: string; name: string; online: boolean }>
  updatedAt: number
}

export type LobbyErrorCode =
  | "service-unavailable"
  | "room-not-found"
  | "private-room-password"
  | "permission-denied"
  | "version-incompatible"
  | "join-failed"
  | "switch-failed"
  | "rollback-failed"

export class LobbyError extends Error {
  constructor(readonly code: LobbyErrorCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = "LobbyError"
  }
}

export interface LobbySnapshot {
  rooms: RoomSummaryRecord[]
  details: Map<string, RoomDetails>
}

export interface RoomListSource {
  listRooms(): Promise<RoomSummaryRecord[]>
  getRoomDetails(summary: RoomSummaryRecord): Promise<RoomDetails>
}

export interface DesktopServiceCheckpoint {
  /** Native opaque handle. Renderer must never inspect credentials or session data. */
  readonly id: string
}

export interface SwitchTarget {
  identity: RoomIdentity
  password?: string
}

export interface ServiceSwitchDriver {
  checkpointCurrent(): Promise<DesktopServiceCheckpoint | null>
  suspendCurrent(): Promise<void>
  join(target: SwitchTarget): Promise<void>
  waitForAuthoritativeSnapshot(): Promise<void>
  commit(): Promise<void>
  rollback(checkpoint: DesktopServiceCheckpoint): Promise<void>
  enterOffline(): Promise<void>
}

/**
 * Serializes service switches. A target is committed only after its first
 * authoritative room snapshot; failed switches restore the native checkpoint.
 */
export class ServiceSwitchTransaction {
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly driver: ServiceSwitchDriver) {}

  switchTo(target: SwitchTarget): Promise<void> {
    const task = this.pending.then(async () => {
      const checkpoint = await this.driver.checkpointCurrent()
      try {
        await this.driver.suspendCurrent()
        await this.driver.join(target)
        await this.driver.waitForAuthoritativeSnapshot()
        await this.driver.commit()
      } catch (error) {
        if (!checkpoint) {
          await this.driver.enterOffline().catch(() => undefined)
          throw new LobbyError("switch-failed", "无法加入目标房间，当前没有可恢复的房间", error)
        }
        try {
          await this.driver.rollback(checkpoint)
        } catch (rollbackError) {
          await this.driver.enterOffline().catch(() => undefined)
          throw new LobbyError("rollback-failed", "切换失败且原房间恢复失败", rollbackError)
        }
        throw new LobbyError("switch-failed", "无法加入目标房间，已恢复原房间", error)
      }
    })
    this.pending = task.catch(() => undefined)
    return task
  }
}

export function roomKey(identity: RoomIdentity): string {
  return `${identity.service}:${new URL(identity.origin).origin}:${identity.roomId}`
}

/** Merge summary and transport events without allowing an old origin to update the room. */
export function applyRoomEvent(details: RoomDetails, identity: RoomIdentity, event: DomainEvent): RoomDetails {
  if (roomKey(details) !== roomKey(identity)) return details
  const now = Date.now()
  if (event.type === "playback") return { ...details, playback: event.snapshot, updatedAt: now }
  if (event.type === "queue-state") return { ...details, queue: event.items, queueVersion: event.queueVersion, updatedAt: now }
  if (event.type === "members") return { ...details, members: event.members, memberCount: event.members.length, updatedAt: now }
  if (event.type === "connection") return { ...details, connection: event.status, updatedAt: now }
  return details
}

export function detailsFromSummary(summary: RoomSummaryRecord, base: RoomSummary | null = null): RoomDetails {
  return {
    ...summary,
    connection: "idle",
    playback: base?.playback ?? null,
    queue: base?.queue ?? [],
    members: [],
    updatedAt: Date.now(),
  }
}
