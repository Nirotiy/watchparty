import { useCallback, useMemo } from "react"
import type { MusicPartyAdapter, CreateMusicPartyRoomInput, MusicPartyProbe } from "../../shared/musicparty-adapter"
import type { MusicPartyConnection } from "../../shared/musicparty-connection"
import type { RoomSummaryRecord, RoomIdentity, SwitchTarget } from "../../shared/lobby-contract"

/** Small typed boundary for the lobby. It does not own the player or connection lifecycle. */
export interface LobbyFacadeSource {
  origin: string
  connection: MusicPartyConnection
  /** Kept for the existing call sites; browsing now runs over the connection itself. */
  createAdapter?: () => MusicPartyAdapter
  switchTo: (target: SwitchTarget) => Promise<void>
}

export interface LobbyFacade {
  listRooms(): Promise<RoomSummaryRecord[]>
  createRoom(input: CreateMusicPartyRoomInput): Promise<RoomSummaryRecord>
  joinRoom(identity: RoomIdentity, password?: string): Promise<void>
  switchTo(target: SwitchTarget): Promise<void>
  /** True only for a connected origin whose server advertises desktop room creation. */
  readonly canCreateRoom: boolean
  /** Why the create entry is closed: the lobby says which part is missing instead of guessing. */
  readonly createReadiness: { connected: boolean; hasAccount: boolean; isGuest: boolean; serverSupportsCreate: boolean }
  /** The connection's cached probe, read live so the lobby can show server state without re-asking. */
  readonly probe: MusicPartyProbe | null
  /** Management belongs to whoever created the room, and only when the server offers it at all. */
  canManageRoom(room: RoomSummaryRecord | null): boolean
  renameRoom(room: RoomSummaryRecord, name: string): Promise<RoomSummaryRecord>
  deleteRoom(room: RoomSummaryRecord): Promise<void>
}

/** An unconfigured server is a normal state, so it must read as "unavailable" rather than throw. */
const originOf = (value: string) => { try { return new URL(value).origin } catch { return "" } }

/** Adapter calls stay origin-scoped and are safe to pass to a React lobby. */
export function useLobbyFacade(source: LobbyFacadeSource | null): LobbyFacade | null {
  const listRooms = useCallback(async () => {
    if (!source || !originOf(source.origin)) throw new Error("lobby_unavailable")
    // A throwaway adapter used to serve the list, which left `current` without the probe this
    // facade gates on — the create entry stayed disabled however the server advertised. Going
    // through the connection keeps the listing and the capability bits on one instance; the
    // lobby always lists the origin it is connected to, so nothing else is torn down.
    return source.connection.run(source.origin, async adapter => {
      await adapter.ensureProbe(true)
      return adapter.listRooms()
    })
  }, [source])
  const createRoom = useCallback(async (input: CreateMusicPartyRoomInput) => {
    if (!source) throw new Error("lobby_unavailable")
    return source.connection.withCurrent(source.origin, adapter => {
      if (!adapter) throw new Error("lobby_not_connected")
      return adapter.createRoom(input)
    })
  }, [source])
  const joinRoom = useCallback(async (identity: RoomIdentity, password?: string) => {
    if (!source) throw new Error("lobby_unavailable")
    if (identity.service !== "musicparty" || new URL(identity.origin).origin !== originOf(source.origin)) throw new Error("lobby_origin_mismatch")
    await source.switchTo({ identity, password })
  }, [source])
  const switchTo = useCallback(async (target: SwitchTarget) => {
    if (!source?.switchTo) throw new Error("lobby_switch_unavailable")
    await source.switchTo(target)
  }, [source])
  // Read live, not from a memo: the probe belongs to the connection and changes without the
  // App re-rendering, so a captured value would keep offering 创建房间 with a stale account.
  const adapterFor = () => {
    const adapter = source?.connection.current ?? null
    return adapter && source && adapter.origin === originOf(source.origin) ? adapter : null
  }
  const readiness = () => {
    const probe = adapterFor()?.desktopProbe ?? null
    const account = probe?.account ?? null
    // A guest session can listen but not create; the lobby says so instead of offering a 403.
    return { connected: Boolean(probe), hasAccount: Boolean(account), isGuest: account?.isGuest === true, serverSupportsCreate: probe?.features.roomCreate === true }
  }
  const manageReadiness = (room: RoomSummaryRecord | null): boolean => {
    if (!source || !room) return false
    const adapter = source.connection.current
    const origin = originOf(source.origin)
    // A probe from one server must never unlock management of another server's room.
    if (!adapter || !origin || adapter.origin !== origin || originOf(room.origin) !== adapter.origin) return false
    const probe = adapter.desktopProbe
    const account = probe?.account ?? null
    if (!probe?.features.roomManage || !account) return false
    // Mirrors the server's CanEdit: platform admins may manage any room, members only their own.
    // (Member, owner and invite administration keep requiring CanManage, which is admin-only.)
    return account.isAdmin || room.creatorPublicId === account.publicId
  }
  const manage = useCallback(async <T>(room: RoomSummaryRecord, action: (adapter: MusicPartyAdapter) => Promise<T>): Promise<T> => {
    if (!source) throw new Error("lobby_unavailable")
    if (!manageReadiness(room)) throw new Error("lobby_not_manageable")
    return source.connection.withCurrent(source.origin, adapter => {
      if (!adapter) throw new Error("lobby_not_connected")
      return action(adapter)
    })
  }, [source])
  return useMemo(() => source ? {
    listRooms,
    createRoom,
    joinRoom,
    switchTo,
    canManageRoom: room => manageReadiness(room),
    renameRoom: (room, name) => manage(room, adapter => adapter.renameRoom(room.roomId, name, room.visibility === "private")),
    deleteRoom: room => manage(room, adapter => adapter.deleteRoom(room.roomId)),
    get probe() { return adapterFor()?.desktopProbe ?? null },
    get createReadiness() { return readiness() },
    // `roomCreate` says the server accepts the endpoint; the account says this machine has a
    // session to send with it. Without one every attempt answers 401, so offering the entry only
    // produces an unexplained failure.
    get canCreateRoom() { const value = readiness(); return value.connected && value.hasAccount && !value.isGuest && value.serverSupportsCreate },
  } : null, [source, listRooms, createRoom, joinRoom, switchTo, manage])
}
