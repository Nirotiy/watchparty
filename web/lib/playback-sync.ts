import type { RoomSnapshot } from "./contracts";
import type { PlayerAdapterHandle } from "../components/player-adapter";

/** Apply the server timeline; decoding and buffering remain local to the player. */
export function synchronizePlayback(player: PlayerAdapterHandle, snapshot: RoomSnapshot, serverNowMs: number) {
  if (snapshot.paused) player.pause();
  else void player.play().catch(() => {});
  player.setPlaybackRate(snapshot.playbackRate);
  const elapsed = snapshot.paused ? 0 : (serverNowMs - snapshot.serverTimeMs) / 1000 * snapshot.playbackRate;
  const expected = Math.max(0, snapshot.positionSeconds + elapsed);
  const delta = player.getCurrentTime() - expected;
  if (Math.abs(delta) > (snapshot.paused ? 0.01 : 1)) player.seek(expected);
  else if (Math.abs(delta) > 0.25 && !snapshot.paused) {
    player.setPlaybackRate(snapshot.playbackRate * (delta > 0 ? 0.95 : 1.05));
  }
}
