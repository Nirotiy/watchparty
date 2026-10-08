import type { CommandAck, MediaSource, RoomSnapshot } from "./contracts";

export type OperationResult =
  | { status: "succeeded"; acknowledgement: Extract<CommandAck, { ok: true }> }
  | { status: "failed" | "uncertain"; error: { code: string; message: string } };

// A missing/invalid response does not establish whether the server committed the command.
const UNCERTAIN_CODES = new Set(["TIMEOUT", "INVALID_ACK", "COMMAND_EXCEPTION", "QUEUE_ADD_UNCERTAIN"]);
export function operationResult(acknowledgement: CommandAck): OperationResult {
  if (acknowledgement.ok) return { status: "succeeded", acknowledgement };
  return { status: UNCERTAIN_CODES.has(acknowledgement.error.code) ? "uncertain" : "failed", error: acknowledgement.error };
}

export type BatchOperationResult<T> = {
  status: OperationResult["status"];
  addedCount: number;
  succeeded: Array<{ index: number; item: T; acknowledgement: Extract<CommandAck, { ok: true }> }>;
  stopped: { index: number; item: T; result: Exclude<OperationResult, { status: "succeeded" }> } | null;
  remaining: Array<{ index: number; item: T }>;
};

/** Uses the caller's existing room command queue and stops at the first non-success. */
export async function runBatchOperation<T>(items: readonly T[], execute: (item: T) => Promise<CommandAck>): Promise<BatchOperationResult<T>> {
  const input = [...items];
  const succeeded: BatchOperationResult<T>["succeeded"] = [];
  for (const [index, item] of input.entries()) {
    let result: OperationResult;
    try { result = operationResult(await execute(item)); }
    catch { result = { status: "uncertain", error: { code: "COMMAND_EXCEPTION", message: "Command outcome is unknown" } }; }
    if (result.status !== "succeeded") {
      return { status: result.status, addedCount: succeeded.length, succeeded, stopped: { index, item, result },
        remaining: input.slice(index + 1).map((remainingItem, offset) => ({ index: index + 1 + offset, item: remainingItem })) };
    }
    succeeded.push({ index, item, acknowledgement: result.acknowledgement });
  }
  return { status: "succeeded", addedCount: succeeded.length, succeeded, stopped: null, remaining: [] };
}

/** Unknown outcomes require snapshot reconciliation before retrying the stopped item. */
export function getBatchRetryItems<T>(result: BatchOperationResult<T>): T[] | null {
  if (result.status === "uncertain") return null;
  return [...(result.stopped ? [result.stopped.item] : []), ...result.remaining.map(({ item }) => item)];
}

export type PlaylistAddAttempt = { before: RoomSnapshot; media: MediaSource; clientId: string };

/** A single new revision and own item can confirm the add; existing copies and absence cannot. */
export function reconcilePlaylistAdd(attempt: PlaylistAddAttempt, after: RoomSnapshot): Extract<CommandAck, { ok: true }> | null {
  if (after.revision !== attempt.before.revision + 1) return null;
  const oldIds = new Set(attempt.before.playlist.map((item) => item.id));
  const candidates = after.playlist.filter((item) => !oldIds.has(item.id) && item.addedByClientId === attempt.clientId
    && sameMedia(item.media, attempt.media));
  return candidates.length === 1 ? { ok: true, revision: after.revision } : null;
}

function sameMedia(left: MediaSource, right: MediaSource): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "openlist": return right.kind === "openlist" && left.mediaId === right.mediaId;
    case "youtube": return right.kind === "youtube" && left.videoId === right.videoId;
    default: return (right.kind === "http" || right.kind === "hls") && left.url === right.url;
  }
}

export function confirmStoppedBatchItem<T>(result: BatchOperationResult<T>, acknowledgement: Extract<CommandAck, { ok: true }>): BatchOperationResult<T> {
  if (!result.stopped || result.status !== "uncertain") return result;
  const { index, item } = result.stopped;
  return { ...result, status: result.remaining.length ? "failed" : "succeeded", addedCount: result.addedCount + 1,
    succeeded: [...result.succeeded, { index, item, acknowledgement }], stopped: null };
}
