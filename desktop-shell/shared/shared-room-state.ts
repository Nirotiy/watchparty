import type { ClockSample, MediaItem, SharedRoomState } from "./domain"
import type { MusicMetadata, PlayerProgressPayload, PlayerStatePayload, SyncPongPayload } from "./musicparty-contract"
export type { ClockSample, SharedRoomState } from "./domain"

const MAX_SAMPLES = 8
const MAX_USABLE_RTT_MS = 1500
const CLOCK_MAX_AGE_MS = 15000
const STATE_MAX_AGE_MS = 3000

export function emptySharedRoomState(roomId: string): SharedRoomState {
  return {
    roomId,
    item: null,
    durationMs: 0,
    paused: true,
    shuffle: false,
    loading: false,
    pauseLocked: false,
    skipLocked: false,
    shuffleLocked: false,
    enqueuedById: null,
    enqueuedByName: null,
    likedUserIds: [],
    positionUpdatedAt: null,
    stateVersion: 0,
    queueVersion: 0,
    historyCursor: null,
    playEpoch: 0,
    positionAnchorMs: 0,
    anchorServerMs: 0,
    anchorLocalMs: 0,
    clockSamples: [],
  }
}

/** `player.state` is the authoritative frame, so an older stateVersion may not overwrite a newer one. */
export function applyPlayerState(state: SharedRoomState, payload: PlayerStatePayload, localNowMs: number): SharedRoomState | null {
  if (payload.stateVersion < state.stateVersion || payload.queueVersion < state.queueVersion || payload.playEpoch < state.playEpoch) return null
  if (payload.nowPlaying?.playEpoch !== undefined && payload.nowPlaying.playEpoch !== payload.playEpoch) return null
  if (payload.stateVersion === state.stateVersion && payload.playEpoch === state.playEpoch && payload.serverTimestamp < state.anchorServerMs) return null
  const nowPlaying = payload.nowPlaying ?? null
  return {
    ...state,
    item: nowPlaying ? normalizeMusic(nowPlaying.music) : null,
    durationMs: nowPlaying?.music.duration ?? 0,
    paused: payload.isPaused,
    shuffle: payload.isShuffle,
    loading: payload.isLoading,
    pauseLocked: payload.isPauseLocked,
    skipLocked: payload.isSkipLocked,
    shuffleLocked: payload.isShuffleLocked,
    enqueuedById: nowPlaying?.enqueuedById ?? null,
    enqueuedByName: nowPlaying?.enqueuedByName ?? null,
    likedUserIds: [...(nowPlaying?.likedUserIds ?? [])],
    positionUpdatedAt: nowPlaying?.positionUpdatedAt ?? null,
    stateVersion: payload.stateVersion,
    queueVersion: payload.queueVersion,
    historyCursor: payload.historyCursor ?? null,
    playEpoch: payload.playEpoch,
    positionAnchorMs: nowPlaying?.currentPosition ?? 0,
    anchorServerMs: payload.serverTimestamp,
    anchorLocalMs: localNowMs,
  }
}

/** Progress frames only move the position; they never carry locks or queue content. */
export function applyProgress(state: SharedRoomState, payload: PlayerProgressPayload, localNowMs: number): SharedRoomState | null {
  if (payload.playEpoch !== state.playEpoch || payload.stateVersion !== state.stateVersion) return null
  if (payload.serverTimestamp <= state.anchorServerMs) return null
  return { ...state, positionAnchorMs: payload.currentPosition, anchorServerMs: payload.serverTimestamp, anchorLocalMs: localNowMs }
}

/**
 * Samples with the lowest round trip represent the real path delay; an upward spike is congestion.
 * The median of the best half resists one-off jitter without tracking a moving average.
 */
export function clockOffsetMs(samples: ClockSample[]): number | null {
  if (!samples.length) return null
  const ordered = [...samples].sort((left, right) => left.rttMs - right.rttMs)
  const best = ordered.slice(0, Math.max(1, Math.ceil(ordered.length / 2)))
  const offsets = best.map(sample => sample.offsetMs).sort((left, right) => left - right)
  const middle = Math.floor((offsets.length - 1) / 2)
  return offsets.length % 2 ? offsets[middle] : (offsets[middle] + offsets[middle + 1]) / 2
}

export function addClockSample(state: SharedRoomState, pong: SyncPongPayload, nowLocalMs: number): SharedRoomState {
  if (![nowLocalMs, pong.clientSendTime, pong.serverReceiveTime, pong.serverSendTime].every(Number.isFinite)) return state
  const processingMs = pong.serverSendTime - pong.serverReceiveTime
  if (processingMs < 0 || nowLocalMs < pong.clientSendTime) return state
  const rttMs = nowLocalMs - pong.clientSendTime - processingMs
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_USABLE_RTT_MS) return state
  const sample: ClockSample = { rttMs, offsetMs: pong.serverSendTime + rttMs / 2 - nowLocalMs, takenAtLocalMs: nowLocalMs }
  return { ...state, clockSamples: [...state.clockSamples, sample].slice(-MAX_SAMPLES) }
}

export function clockTrusted(state: SharedRoomState, nowLocalMs: number): boolean {
  const newest = state.clockSamples.at(-1)
  return Boolean(newest && nowLocalMs >= newest.takenAtLocalMs && nowLocalMs - newest.takenAtLocalMs < CLOCK_MAX_AGE_MS)
}

/** Extrapolation stops when either the clock or the last position frame is stale. */
export function sharedPositionMs(state: SharedRoomState, nowLocalMs: number): number {
  if (!state.item) return 0
  if (state.paused || !clockTrusted(state, nowLocalMs) || nowLocalMs < state.anchorLocalMs || nowLocalMs - state.anchorLocalMs >= STATE_MAX_AGE_MS) return Math.max(0, state.positionAnchorMs)
  const offset = clockOffsetMs(state.clockSamples)
  if (offset === null) return Math.max(0, state.positionAnchorMs)
  const elapsed = nowLocalMs + offset - state.anchorServerMs
  const position = state.positionAnchorMs + Math.max(0, elapsed)
  return state.durationMs > 0 ? Math.min(position, state.durationMs) : position
}

function normalizeMusic(music: MusicMetadata): MediaItem {
  return { id: music.id, title: music.name, artist: music.artists.join(", "), artworkUrl: music.coverUrl, durationSeconds: music.duration / 1000, kind: "audio", source: music.platform }
}
