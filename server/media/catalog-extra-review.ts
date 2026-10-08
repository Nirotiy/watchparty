import path from "node:path";
import { createHash } from "node:crypto";
import { parseEpisode } from "./catalog-names.ts";

export type ExtraReviewFile = {
  relativePath: string;
  name: string;
  size: number | null;
  season: number | null;
  episode: number | null;
  durationSeconds?: number | null;
  keepByHuman?: boolean;
};

export type ExtraReviewInput = {
  libraryId: string;
  itemKey: string;
  files: ExtraReviewFile[];
  /** Per-season counts from verified metadata, not guessed from the file count. */
  expected?: Array<{ season: number | null; episodes: number }>;
};

export type ExtraReason = "bd-label" | "small-size" | "short-duration" | "numbered-episode" | "human-kept";
export type ExtraFileReview = {
  relativePath: string;
  size: number | null;
  durationSeconds: number | null;
  reasons: ExtraReason[];
  action: "propose-exclusion" | "inspect" | "keep";
  confidence: "high" | "medium" | "low" | null;
};

export type ExtraReview = {
  libraryId: string;
  itemKey: string;
  fingerprint: string;
  reference: { numberedFiles: number; medianSize: number | null; medianDurationSeconds: number | null };
  count: { files: number; expectedEpisodes: number | null; proposedExclusions: number; remaining: number; completeSequence: boolean | null };
  warnings: Array<"expected-count-unknown" | "missing-or-duplicate-episodes" | "unresolved-surplus" | "duration-incomplete" | "insufficient-reference">;
  files: ExtraFileReview[];
};

/** Match release tags and attachment directories, never words inside a work title. */
function hasBdLabel(file: ExtraReviewFile): boolean {
  const tags = [...file.name.matchAll(/\[([^\]]+)\]/g)].map(match => match[1] ?? "");
  const directories = path.posix.dirname(file.relativePath).split("/").slice(2);
  const extra = /^(?:nc(?:op|ed)(?:\d+|[_ .-](?:broadcast.*|terrestrial.*|temp))?|menu(?:\d+|[_ .-]disc\d+)?|cm\d*|pv(?:\d+|[_ .-]spot[_ .-]collection)?|iv\d+|box\d+[_ -]sp|cast[_ -]interview\d*|(?:op|ed)[_ -](?:broadcast|terrestrial|prototype).*|promotiona?l?[_ -]video|tokuten|teaser[_ -]trailer|english[_ -]trailer|特典映像|映像特典)$/i;
  return tags.some(tag => extra.test(tag.trim())) || directories.some(dir => /^(?:ncop(?:[&＋+ ]nced)?|nced|pv|menu|extras?|特典映像|映像特典)$/i.test(dir));
}

function median(values: number[]): number | null {
  if (values.length < 3) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const validPositive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Pure proposal generation. Nothing here writes exclusions, changes episode numbers, or fits files to a quota. */
export function reviewBdExtras(input: ExtraReviewInput): ExtraReview {
  const expected = input.expected ?? [];
  if (expected.some(row => !Number.isSafeInteger(row.episodes) || row.episodes < 1 || row.episodes > 1000 ||
    row.season !== null && (!Number.isSafeInteger(row.season) || row.season < 0 || row.season > 99)) ||
    new Set(expected.map(row => row.season)).size !== expected.length) throw new Error("EXTRA_REVIEW_EXPECTED_INVALID");
  const ordered = input.files.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
  if (new Set(ordered.map(file => file.relativePath)).size !== ordered.length || ordered.some(file => !file.relativePath.startsWith("/"))) throw new Error("EXTRA_REVIEW_PATH_INVALID");
  const numbered = (file: ExtraReviewFile) => {
    const parsed = parseEpisode(file.name);
    const episode = parsed.episode ?? file.episode;
    return Number.isSafeInteger(episode) && episode! > 0 ? { season: parsed.season ?? file.season, episode: episode! } : null;
  };
  const reference = ordered.filter(file => !hasBdLabel(file) && numbered(file));
  const medianSize = median(reference.map(file => file.size).filter(validPositive));
  const medianDurationSeconds = median(reference.map(file => file.durationSeconds).filter(validPositive));
  const files: ExtraFileReview[] = ordered.map(file => {
    const reasons: ExtraReason[] = [];
    const label = hasBdLabel(file);
    const number = numbered(file);
    if (label) reasons.push("bd-label");
    if (medianSize !== null && validPositive(file.size) && file.size < medianSize * 0.25) reasons.push("small-size");
    if (medianDurationSeconds !== null && validPositive(file.durationSeconds) &&
      file.durationSeconds < medianDurationSeconds * 0.35) reasons.push("short-duration");
    if (number && !label) reasons.push("numbered-episode");
    if (file.keepByHuman) reasons.push("human-kept");
    const statistical = reasons.filter(reason => reason === "small-size" || reason === "short-duration").length;
    const action = file.keepByHuman ? "keep" : label ? "propose-exclusion" :
      statistical && number ? "inspect" : statistical > 0 ? "propose-exclusion" : "keep";
    return { relativePath: file.relativePath, size: file.size,
      durationSeconds: validPositive(file.durationSeconds) ? file.durationSeconds : null, reasons, action,
      confidence: action === "keep" ? null : label ? "high" : statistical === 2 && !number ? "medium" : "low" };
  });
  const candidates = new Set(files.filter(file => file.action === "propose-exclusion").map(file => file.relativePath));
  const retained = ordered.filter(file => !candidates.has(file.relativePath));
  let completeSequence: boolean | null = null;
  if (expected.length) {
    const counts = new Map<string, number>();
    let unknown = false;
    for (const file of retained) {
      const number = numbered(file);
      if (!number) { unknown = true; continue; }
      const season = number.season ?? (expected.length === 1 ? expected[0]!.season : null);
      const key = `${season}:${number.episode}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const wanted = expected.flatMap(row => Array.from({ length: row.episodes }, (_, i) => `${row.season}:${i + 1}`));
    completeSequence = !unknown && counts.size === wanted.length && wanted.every(key => counts.get(key) === 1);
  }
  const expectedEpisodes = expected.length ? expected.reduce((total, row) => total + row.episodes, 0) : null;
  const warnings: ExtraReview["warnings"] = [];
  if (!expected.length) warnings.push("expected-count-unknown");
  if (completeSequence === false) warnings.push("missing-or-duplicate-episodes");
  if (expectedEpisodes !== null && retained.length > expectedEpisodes) warnings.push("unresolved-surplus");
  if (ordered.some(file => !validPositive(file.durationSeconds))) warnings.push("duration-incomplete");
  if (medianSize === null && medianDurationSeconds === null) warnings.push("insufficient-reference");
  const fingerprint = createHash("sha256").update(JSON.stringify({ libraryId: input.libraryId, itemKey: input.itemKey,
    expected: expected.toSorted((a, b) => (a.season ?? -1) - (b.season ?? -1)),
    files: ordered.map(file => [file.relativePath, file.name, file.size, file.season, file.episode, file.durationSeconds ?? null, Boolean(file.keepByHuman)]) })).digest("hex");
  return { libraryId: input.libraryId, itemKey: input.itemKey, fingerprint,
    reference: { numberedFiles: reference.length, medianSize, medianDurationSeconds },
    count: { files: ordered.length, expectedEpisodes, proposedExclusions: candidates.size, remaining: retained.length, completeSequence }, warnings, files };
}

/** A batch approval refers to the exact evidence the human saw, including sizes and duration results. */
export function approvedExtraPaths(input: ExtraReviewInput, fingerprint: string): string[] {
  const current = reviewBdExtras(input);
  if (current.fingerprint !== fingerprint) throw new Error("EXTRA_REVIEW_STALE");
  return current.files.filter(file => file.action === "propose-exclusion").map(file => file.relativePath);
}
