import type { MediaSource, MediaLibraryItem } from "../contracts";

export function isMkvSource(source: MediaSource | null) {
  if (source?.kind === "openlist") return source.container.toLowerCase() === "mkv";
  if (source?.kind !== "http") return false;
  try { return new URL(source.url).pathname.toLowerCase().endsWith(".mkv"); }
  catch { return false; }
}

/** MKV is only a candidate; the current browser must probe both video and audio. */
export function canAttemptBrowserPlayback(item: Pick<MediaLibraryItem, "extension" | "compatibility">) {
  return item.compatibility.browser === "supported"
    || (item.extension?.toLowerCase() === "mkv" && item.compatibility.browser === "maybe");
}
