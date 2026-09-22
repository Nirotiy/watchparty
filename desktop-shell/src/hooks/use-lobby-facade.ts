import { useCallback, useMemo } from "react"
import type { MusicPartyAdapter, CreateMusicPartyRoomInput } from "../../shared/musicparty-adapter"
import type { MusicPartyConnection } from "../../shared/musicparty-connection"
import type { RoomSummaryRecord, RoomIdentity, SwitchTarget } from "../../shared/lobby-contract"

/** Small typed boundary for the lobby. It does not own the player or connection lifecycle. */
export interface LobbyFacadeSource {
  origin: string
  connection: MusicPartyConnection
  createAdapter: () => MusicPartyAdapter
  switchTo: (target: SwitchTarget) => Promise<void>
}

export interface LobbyFacade {
  listRooms(): Promise<RoomSummaryRecord[]>
  createRoom(input: CreateMusicPartyRoomInput): Promise<RoomSummaryRecord>
  joinRoom(identity: RoomIdentity, password?: string): Promise<void>
  switchTo(target: SwitchTarget): Promise<void>
  readonly canCreateRoom: boolean
}

/** Adapter calls stay origin-scoped and are safe to pass to a React lobby. */
export function useLobbyFacade(source: LobbyFacadeSource | null): LobbyFacade | null {
  const listRooms = useCallback(async () => {
    if (!source) throw new Error("lobby_unavailable")
    const adapter = source.createAdapter()
    if (adapter.origin !== new URL(source.origin).origin) throw new Error("lobby_origin_mismatch")
    return adapter.listRooms()
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
    if (identity.service !== "musicparty" || new URL(identity.origin).origin !== new URL(source.origin).origin) throw new Error("lobby_origin_mismatch")
    await source.switchTo({ identity, password })
  }, [source])
  const switchTo = useCallback(async (target: SwitchTarget) => {
    if (!source?.switchTo) throw new Error("lobby_switch_unavailable")
    await source.switchTo(target)
  }, [source])
  return useMemo(() => source ? {
    listRooms,
    createRoom,
    joinRoom,
    switchTo,
    canCreateRoom: source.connection.current?.origin === new URL(source.origin).origin,
  } : null, [source, listRooms, createRoom, joinRoom, switchTo])
}
