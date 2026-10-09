import type { SubtitleTrack } from "./contracts";

function formatVttTime(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.floor((safeSeconds % 1) * 1000);

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${milliseconds
    .toString()
    .padStart(3, "0")}`;
}

function parseTimestamp(value: string): number | null {
  const match = value
    .trim()
    .match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?/);
  if (!match) return null;

  const [, hours, minutes, seconds, fraction = "0"] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction.padEnd(3, "0")) / 1000
  );
}

function offsetCueLine(line: string, offsetSeconds: number): string | null {
  const [rawStart, rawEnd] = line.split("-->");
  if (!rawStart || !rawEnd) return null;

  const start = parseTimestamp(rawStart);
  const end = parseTimestamp(rawEnd);
  if (start === null || end === null || end + offsetSeconds <= 0) return null;

  const endSettings = rawEnd.trim().replace(/^\S+/, "");
  return `${formatVttTime(start + offsetSeconds)} --> ${formatVttTime(
    end + offsetSeconds,
  )}${endSettings}`;
}

function srtToVttText(subtitleText: string, offsetSeconds: number): string {
  const blocks = subtitleText
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n/);
  const output: string[] = ["WEBVTT", ""];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const cueIndex = lines.findIndex((line) => line.includes("-->"));
    if (cueIndex < 0) continue;
    const cueLine = offsetCueLine(lines[cueIndex], offsetSeconds);
    if (!cueLine) continue;
    output.push(cueLine, ...lines.slice(cueIndex + 1), "");
  }

  return output.join("\n");
}

function offsetVttText(subtitleText: string, offsetSeconds: number): string {
  if (offsetSeconds === 0) return subtitleText;
  return subtitleText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("-->")) return line;
      return offsetCueLine(line, offsetSeconds) ?? "";
    })
    .join("\n");
}

/** Convert SRT or VTT text into a local WebVTT Blob URL. */
export function createVttBlobUrl(
  subtitleText: string,
  format: SubtitleTrack["format"],
  offsetSeconds = 0,
): string | null {
  if (format === "ass" || format === "ssa") return null;
  const normalized = subtitleText.replace(/\r\n?/g, "\n").trim();
  const vttText =
    format === "vtt" || normalized.startsWith("WEBVTT")
      ? offsetVttText(normalized, offsetSeconds)
      : srtToVttText(normalized, offsetSeconds);
  return URL.createObjectURL(new Blob([vttText], { type: "text/vtt;charset=utf-8" }));
}

export type SubtitleCue = { start: number; end: number; text: string };

const ENTITY_MAP: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "", rlm: "", quot: "\"", "#39": "'",
};

function cueText(rawLines: string[]): string {
  return rawLines.join("\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&([a-z#0-9]+);/gi, (match, name: string) => ENTITY_MAP[name.toLowerCase()] ?? match)
    .trim();
}

/** 解析 SRT/VTT 为纯文本 cue 列表（原生覆盖层用；ASS/SSA 返回空）。 */
export function parseSubtitleCues(subtitleText: string, format: SubtitleTrack["format"]): SubtitleCue[] {
  if (format === "ass" || format === "ssa") return [];
  const blocks = subtitleText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const cueIndex = lines.findIndex((line) => line.includes("-->"));
    if (cueIndex < 0) continue;
    const [rawStart, rawEnd] = lines[cueIndex].split("-->");
    const start = parseTimestamp(rawStart ?? "");
    const end = rawEnd === undefined ? null : parseTimestamp(rawEnd);
    if (start === null || end === null) continue;
    const text = cueText(lines.slice(cueIndex + 1));
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}
