import test from "node:test";
import assert from "node:assert/strict";
import { reviewBdExtras, approvedExtraPaths } from "../media/catalog-extra-review.ts";
import type { ExtraReviewFile, ExtraReviewInput } from "../media/catalog-extra-review.ts";

const main = (episode: number, patch: Partial<ExtraReviewFile> = {}): ExtraReviewFile => ({
  relativePath: `/BD/[Show][${String(episode).padStart(2, "0")}].mkv`, name: `[Show][${String(episode).padStart(2, "0")}].mkv`,
  size: 1_000_000_000, season: 1, episode, durationSeconds: 1440, ...patch,
});
const extra = (tag: string, patch: Partial<ExtraReviewFile> = {}): ExtraReviewFile => ({
  relativePath: `/BD/[Show][${tag}].mkv`, name: `[Show][${tag}].mkv`, size: 30_000_000,
  season: null, episode: null, durationSeconds: 90, ...patch,
});
const input = (files: ExtraReviewFile[]): ExtraReviewInput => ({ libraryId: "anime", itemKey: "/BD", files, expected: [{ season: 1, episodes: 24 }] });

test("BD labels, size and duration produce 29 proposals beside a complete 24-episode sequence without mutation", () => {
  const files = [...Array.from({ length: 24 }, (_, i) => main(i + 1)),
    ...Array.from({ length: 29 }, (_, i) => extra(`CM${i + 1}`))];
  const source = input(files), before = structuredClone(source), result = reviewBdExtras(source);
  assert.deepEqual(result.count, { files: 53, expectedEpisodes: 24, proposedExclusions: 29, remaining: 24, completeSequence: true });
  assert(result.files.filter(file => file.action === "propose-exclusion").every(file => file.confidence === "high" && file.reasons.includes("short-duration") && file.reasons.includes("small-size")));
  assert.deepEqual(source, before);
});

test("large and long interviews are still suggested by an explicit BD label", () => {
  const result = reviewBdExtras(input([main(1), main(2), main(3), extra("Cast_Interview1", { size: 2_000_000_000, durationSeconds: 3600 })]));
  assert.equal(result.files.find(file => file.relativePath.includes("Interview"))?.confidence, "high");
});

test("a small short numbered episode is inspect-only; human kept specials cannot become proposals", () => {
  const result = reviewBdExtras(input([main(1), main(2), main(3), main(4, { size: 10_000_000, durationSeconds: 60 }), extra("Tokuten", { keepByHuman: true })]));
  assert.equal(result.files.find(file => file.relativePath.includes("[04]"))?.action, "inspect");
  assert.equal(result.files.find(file => file.relativePath.includes("Tokuten"))?.action, "keep");
});

test("count surplus alone cannot select files, including an extra numbered episode", () => {
  const result = reviewBdExtras(input(Array.from({ length: 25 }, (_, i) => main(i + 1))));
  assert.equal(result.count.proposedExclusions, 0);
  assert(result.warnings.includes("unresolved-surplus"));
  assert(result.warnings.includes("missing-or-duplicate-episodes"));
});

test("short-form series use their own baseline and missing durations cannot mean zero", () => {
  const result = reviewBdExtras(input([main(1, { durationSeconds: 180 }), main(2, { durationSeconds: 190 }), main(3, { durationSeconds: 170 }), main(4, { durationSeconds: null })]));
  assert.equal(result.count.proposedExclusions, 0);
  assert(result.warnings.includes("duration-incomplete"));
});

test("mixed seasons, duplicate episodes and missing episodes do not pass a count-only check", () => {
  const source = input([main(1), main(1, { relativePath: "/BD/version2.mkv" }), main(1, { season: 2, relativePath: "/BD/S2/01.mkv" })]);
  source.expected = [{ season: 1, episodes: 2 }, { season: 2, episodes: 1 }];
  assert.equal(reviewBdExtras(source).count.completeSequence, false);
});

test("review fingerprints ignore order and refuse changed size, duration, human intent or expected count", () => {
  const source = input([main(1), main(2), main(3), extra("Menu01")]), result = reviewBdExtras(source);
  assert.equal(reviewBdExtras({ ...source, files: source.files.toReversed() }).fingerprint, result.fingerprint);
  assert.deepEqual(approvedExtraPaths(source, result.fingerprint), [extra("Menu01").relativePath]);
  for (const altered of [
    { ...source, expected: [{ season: 1, episodes: 3 }] },
    { ...source, files: source.files.map(file => ({ ...file, size: 2 })) },
    { ...source, files: source.files.map(file => ({ ...file, durationSeconds: 1 })) },
    { ...source, files: source.files.map(file => ({ ...file, keepByHuman: true })) },
  ]) assert.throws(() => approvedExtraPaths(altered, result.fingerprint), /EXTRA_REVIEW_STALE/);
});

test("work-title words and ambiguous OVA/SP tags are not BD exclusion labels", () => {
  const source = input([extra("OVA01", { name: "[Menu Shoujo][OVA01].mkv", size: null, durationSeconds: null }),
    extra("SP01", { name: "[PV Girl][SP01].mkv", size: null, durationSeconds: null })]);
  assert.equal(reviewBdExtras(source).count.proposedExclusions, 0);
  assert.throws(() => reviewBdExtras({ ...source, files: [source.files[0]!, source.files[0]!] }), /EXTRA_REVIEW_PATH_INVALID/);
});
