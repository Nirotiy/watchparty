import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { rankHits, type MetadataHit } from "../media/catalog-metadata.ts";
import { scoreTitles, tokenizeTitle } from "../media/catalog-names.ts";

/**
 * Threshold regression set for catalog matching, recorded from live Bangumi
 * responses against the real E:/multimedia layout (recorder:
 * dev/record-catalog-fixtures.mjs). It exists because scoring was retuned twice
 * while adding CJK bigrams and infobox aliases: the first pass silently turned a
 * confirmed 攻壳 case into a candidate, which only real data caught.
 *
 * Auto-confirm means score >= 0.86 (AUTO_SCORE); candidate means >= 0.5.
 */

type RecordedHit = {
  externalId: string;
  name: string;
  name_cn: string;
  eps: number | null;
  total_episodes: number | null;
  aired_date: string | null;
  infobox_cn_name: string | null;
  infobox_alias: string | null;
  infobox_episodes: string | null;
};

type RecordedGroup = { query: string; itemKey: string; fileCount: number; hits: RecordedHit[] };

const recorded = JSON.parse(
  fs.readFileSync(new URL("./fixtures/bangumi-live-hits.json", import.meta.url), "utf8"),
) as RecordedGroup[];

function toHit(row: RecordedHit): MetadataHit {
  const title = row.name_cn || row.name;
  const aliases = [row.infobox_cn_name, row.infobox_alias]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => value.split("/"))
    .map((value) => value.trim())
    .filter((value) => value && value !== title && value !== row.name);
  const infoboxEpisodes = Number((row.infobox_episodes ?? "").replace(/\D/g, ""));
  const episodes = row.eps ?? row.total_episodes ?? (Number.isFinite(infoboxEpisodes) ? infoboxEpisodes : null);
  return {
    externalDb: "bangumi",
    externalId: row.externalId,
    title,
    originalTitle: row.name && row.name !== title ? row.name : null,
    year: row.aired_date ? Number(row.aired_date.slice(0, 4)) : null,
    overview: null,
    imageUrl: null,
    episodes: typeof episodes === "number" && episodes > 0 ? episodes : null,
    aliases,
  };
}

function group(query: string): RecordedGroup {
  const found = recorded.find((entry) => entry.query === query);
  assert.ok(found, `fixture is missing the "${query}" group`);
  return found;
}

function best(query: string, options: { aliases: boolean }): { title: string; score: number } | undefined {
  const entry = group(query);
  const hits = entry.hits.map(toHit).map((hit) => (options.aliases ? hit : { ...hit, aliases: undefined }));
  return rankHits(entry.query, hits, null, entry.fileCount)[0];
}

const ALIASES_ON = { aliases: true };
const ALIASES_OFF = { aliases: false };

test("a romaji folder whose only home is the Bangumi alias list becomes confirmed", () => {
  // The release folder says "Kimi ga Shinu made Koi wo Shitai"; the subject is
  // 「きみが死ぬまで恋をしたい」 with 中文名 与你相恋到生命尽头. Without the
  // 别名 field neither name scores above zero, so this row used to be a
  // 0.62 floor candidate for a human to resolve by hand.
  const before = best("Kimi ga Shinu made Koi wo Shitai", ALIASES_OFF);
  const after = best("Kimi ga Shinu made Koi wo Shitai", ALIASES_ON);
  assert.ok(before && before.score < 0.86, `expected a pre-fix miss, got ${before?.score}`);
  assert.equal(after?.title, "与你相恋到生命尽头");
  assert.equal(after?.score, 1);
});

test("the exact alias match wins over the substring floor it had to hide behind", () => {
  const before = best("Medalist", ALIASES_OFF);
  assert.ok(before && before.score < 0.86, `expected a pre-fix miss, got ${before?.score}`);
  const after = best("Medalist", ALIASES_ON);
  assert.equal(after?.title, "金牌得主");
  assert.ok(after && after.score >= 0.86, `expected auto-confirm, got ${after?.score}`);
});

test("a single-file movie resolves through its alias instead of staying a candidate", () => {
  const query = "Fuuto Tantei Movie Kamen Rider Skull no Shouzou";
  assert.ok(best(query, ALIASES_OFF)!.score < 0.86);
  const after = best(query, ALIASES_ON);
  assert.ok(after && after.score >= 0.86, `expected auto-confirm, got ${after?.score}`);
  assert.match(after!.title, /风都侦探/);
});

test("a title that is not in any alias stays a candidate instead of being auto-confirmed", () => {
  // Guard against the opposite failure: bigrams+aliases must not confirm
  // everything. This romaji folder only half-matches its CN title.
  const after = best("Tai-Ari deshita Ojou-sama wa Kakutou Game nante Shinai", ALIASES_ON);
  assert.ok(after, "expected at least one candidate");
  assert.ok(after!.score < 0.86, `expected a human-review candidate, got ${after!.score}`);
  assert.ok(after!.score > 0.62, "bigrams should beat the old floor-only score");
});

test("latin containment survives the token rewrite", () => {
  // `The Ghost in the Shell` sits inside `攻殻機動隊 THE GHOST IN THE SHELL`; the
  // first bigram pass dropped this from 0.9 to 0.67 and turned a confirmed
  // match into a candidate, which is how containment became an explicit signal.
  const after = best("The Ghost in the Shell", ALIASES_ON);
  assert.equal(after?.title, "攻壳机动队 THE GHOST IN THE SHELL");
  assert.ok(after!.score >= 0.86, `expected auto-confirm, got ${after!.score}`);
});

test("chinese titles score on characters instead of collapsing to one token", () => {
  // Old scoring: the whole CJK run is a single token, so a shared two-character
  // prefix bought nothing at all.
  assert.equal(scoreTitles("侍战队真剑者全集", "侍战队真剑者"), 0.9); // containment, not bigrams
  assert.equal(tokenizeTitle("攻壳机动队").length, 4); // 4 bigrams over 5 characters
  const shared = scoreTitles("攻壳机动队 2026", "攻壳机动队 THE GHOST IN THE SHELL");
  assert.ok(shared > 0, "CJK overlap must score above zero");
  assert.ok(scoreTitles("攻壳机动队", "棒球英豪") < 0.2, "unrelated CJK titles must not converge");
});

test("episode count still breaks a same-franchise tie", () => {
  // Medalist season 1 has 13 episodes and the folder holds 13 files; season 2
  // (9 episodes) carries the alias "Medalist Season 2", so only the 话数 hint
  // keeps them apart once aliases enter the scoring.
  const entry = group("Medalist");
  const ranked = rankHits(entry.query, entry.hits.map(toHit), null, entry.fileCount);
  assert.equal(ranked[0]?.title, "金牌得主");
  assert.ok(ranked.length > 1, "expected the sequel to remain visible as a candidate");
});
