import { ServiceSwitchTransaction, type DesktopServiceCheckpoint, type RoomIdentity, type ServiceSwitchDriver, type SwitchTarget } from "./lobby-contract"
import type { MusicPartyConnection } from "./musicparty-connection"
import type { MusicPartyAdapter } from "./musicparty-adapter"

/** WatchParty binds these methods to existing native IPC and its state subscription. */
export interface WatchPartySwitchPort {
  checkpointDesktopSession(): Promise<DesktopServiceCheckpoint | null>
  suspendDesktopSession(): Promise<void>
  rollbackDesktopSession(checkpointId: string): Promise<void>
  discardDesktopSessionCheckpoint(checkpointId: string): Promise<void>
  getDesktopSettings(): Promise<{ backendOrigin: string | null }>
  accessDesktopRoom(input: { roomId: string; nickname: string; pin?: string }): Promise<unknown>
  /** Subscribe before action; resolve only after this room's authoritative snapshot. */
  withAuthoritativeSnapshot(roomId: string, action: () => Promise<unknown>): Promise<void>
}

export interface LobbySwitchOptions {
  music: MusicPartyConnection
  watch: WatchPartySwitchPort
  current(): RoomIdentity | null
  nickname(): string
  /** Local native audio focus only, never a remote room pause. */
  focus(service: RoomIdentity["service"] | null): Promise<void>
  committed(identity: RoomIdentity | null): void
  snapshotTimeoutMs?: number
}

/** Callable glue for the existing entry points; credentials never enter its checkpoints. */
export function createLobbySwitchTransaction(options: LobbySwitchOptions): ServiceSwitchTransaction {
  let previous: RoomIdentity | null = null
  let target: RoomIdentity | null = null
  let checkpoint: DesktopServiceCheckpoint | null = null
  const musicJoin = (identity: RoomIdentity, password?: string) => options.music.run(identity.origin, async adapter => {
    if (password !== undefined) await adapter.verifyRoomAccess(identity.roomId, password)
    await musicSnapshot(adapter, () => adapter.joinRoom(identity.roomId), options.snapshotTimeoutMs)
  })
  const suspend = async () => {
    await options.focus(null)
    await options.music.current?.disconnect()
    if (previous?.service === "watchparty" || target?.service === "watchparty") await options.watch.suspendDesktopSession()
  }
  const driver: ServiceSwitchDriver = {
    async checkpointCurrent() {
      previous = options.current()
      target = null
      checkpoint = previous?.service === "watchparty" ? await options.watch.checkpointDesktopSession() : previous ? { id: crypto.randomUUID() } : null
      if (previous && !checkpoint) throw new Error("session_checkpoint_unavailable")
      return checkpoint
    },
    suspendCurrent: suspend,
    async join(next: SwitchTarget) {
      target = { ...next.identity, origin: new URL(next.identity.origin).origin }
      if (target.service === "musicparty") await musicJoin(target, next.password)
      else {
        const settings = await options.watch.getDesktopSettings()
        if (!settings.backendOrigin || new URL(settings.backendOrigin).origin !== target.origin) throw new Error("watchparty_origin_not_configured")
        await options.watch.withAuthoritativeSnapshot(target.roomId, () => options.watch.accessDesktopRoom({ roomId: target!.roomId, nickname: options.nickname(), pin: next.password }))
      }
    },
    // join has already awaited the snapshot with the listener installed before connecting.
    async waitForAuthoritativeSnapshot() {},
    async commit() {
      if (!target) throw new Error("switch_target_missing")
      await options.focus(target.service)
      if (previous?.service === "watchparty" && checkpoint) await options.watch.discardDesktopSessionCheckpoint(checkpoint.id)
      options.committed(target)
      checkpoint = null
    },
    async rollback(saved) {
      if (!previous || saved.id !== checkpoint?.id) throw new Error("switch_checkpoint_missing")
      await suspend()
      if (previous.service === "musicparty") await musicJoin(previous)
      else await options.watch.withAuthoritativeSnapshot(previous.roomId, () => options.watch.rollbackDesktopSession(saved.id))
      await options.focus(previous.service)
      options.committed(previous)
      checkpoint = null
    },
    async enterOffline() {
      try { await suspend() } finally {
        if (previous?.service === "watchparty" && checkpoint) await options.watch.discardDesktopSessionCheckpoint(checkpoint.id)
        options.committed(null)
        checkpoint = null
      }
    },
  }
  return new ServiceSwitchTransaction(driver)
}

function musicSnapshot(adapter: MusicPartyAdapter, action: () => Promise<void>, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); unsubscribe()
      if (error) reject(error); else resolve()
    }
    const timer = setTimeout(() => finish(new Error("room_snapshot_timeout")), timeoutMs)
    const unsubscribe = adapter.subscribe(event => {
      if (event.type === "room") finish()
      else if (event.type === "connection" && event.status === "failed") finish(new Error("room_connection_failed"))
    })
    void action().catch(error => finish(error instanceof Error ? error : new Error("room_join_failed")))
  })
}
