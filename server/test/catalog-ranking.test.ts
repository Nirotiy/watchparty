import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chooseMatch, createBangumiClient, rankHits, variantKeys, type MetadataHit } from "../media/catalog-metadata.ts";
import { loadConfig } from "../config.ts";
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

test("an installment the folder claims but the record never mentions cannot auto-confirm", () => {
  // Found while tuning the bigram/alias scorer: the folder is a trilogy box set
  // and Bangumi has no such subject, yet `机动战士高达0079剧场版三部曲合集` scored
  // 0.900 against the plain `机动战士高达` and confirmed itself.
  const gundam: MetadataHit = {
    externalDb: "bangumi",
    externalId: "688",
    title: "机动战士高达",
    originalTitle: null,
    year: 1981,
    overview: null,
    imageUrl: null,
    episodes: 43,
    aliases: ["机动战士高达 剧场版Ⅰ"],
  };
  const ranked = rankHits("机动战士高达0079剧场版三部曲合集", [gundam], null, 3);
  assert.ok(ranked.length > 0, "the trilogy must still be listed for a human to pick");
  assert.ok(ranked[0].score < 0.86, `expected below AUTO_SCORE, got ${ranked[0].score}`);
  assert.equal(chooseMatch(ranked).status, "candidate");
});

test("a folder that names the same installment still confirms", () => {
  const movie: MetadataHit = {
    externalDb: "bangumi",
    externalId: "206754",
    title: "剧场版SHIROBAKO",
    originalTitle: null,
    year: 2020,
    overview: null,
    imageUrl: null,
    episodes: 1,
    aliases: ["Gekijouban SHIROBAKO"],
  };
  const ranked = rankHits("Gekijouban SHIROBAKO", [movie], null, null);
  assert.ok(ranked[0].score >= 0.86, `expected a confirm, got ${ranked[0].score}`);
  assert.equal(chooseMatch(ranked).status, "confirmed");
});

test("a season qualifier survives the parse and keeps the wrong season out", () => {
  // `Yuru Camp S2` must not land on 摇曳露营△ season 1 just because the alias
  // list of season 1 contains the bare romanized title.
  const season1: MetadataHit = {
    externalDb: "bangumi",
    externalId: "178709",
    title: "ゆるキャン△",
    originalTitle: null,
    year: 2018,
    overview: null,
    imageUrl: null,
    episodes: 13,
    aliases: ["摇曳露营", "Yuru Camp"],
  };
  assert.ok(!variantKeys("Yuru Camp S2").has("season:1"), "S2 must not read as season 1");
  assert.ok(variantKeys("摇曳露营△ 第三季").has("season:3"));
  const ranked = rankHits("Yuru Camp S2", [season1], null, 13);
  assert.ok(ranked.length === 0 || ranked[0].score < 0.86, `expected no confirm, got ${ranked[0]?.score}`);
});

test("a bare title carries no installment claim", () => {
  assert.equal(variantKeys("Cowboy Bebop").size, 0);
  assert.equal(variantKeys("The Ghost in the Shell").size, 0);
  assert.equal(variantKeys("24 Days no Anime").size, 0);
  assert.equal(variantKeys("Stand Alone Complex").size, 0);
  assert.ok(variantKeys("Mobile Suit Gundam The Movie III").has("movie"));
  assert.ok(variantKeys("魔法使俱乐部 OVA").has("ova"));
  assert.ok(variantKeys("Revue Starlight 剧场版 2幕").has("movie"));
});

test("a japanese season suffix reads as an installment claim", () => {
  // `街角魔族 2-Choume` confirmed onto the first season until the season pattern
  // only knew `第N季`/`Season N`/`S2`; the folder names ２丁目, the record does not.
  assert.ok(variantKeys("Machikado Mazoku 2-Choume").has("season:2"));
  assert.ok(variantKeys("街角魔族 ２丁目").has("season:2"), "full-width numbers must read as a season");
  assert.equal(variantKeys("Mobile Suit Gundam 00").size, 0, "a bare number in a title is not a season");
});

test("Bangumi 个人 token：带上就出 Authorization 头，不带就匿名，值永不出现在任何响应里", async () => {
  const seen: Array<Record<string, string>> = [];
  const fake = (async (_url: unknown, init?: RequestInit) => {
    seen.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const hits = await createBangumiClient(fake, "bgm-secret-token").search("摇曳露营");
  assert.deepEqual(hits, []);
  assert.equal(seen.length, 2, "两次检索都要带头");
  for (const headers of seen) {
    assert.equal(headers.authorization, "Bearer bgm-secret-token");
    assert.equal(headers["user-agent"], "watchparty/0.1.0 (catalog scrape)", "UA 不能被顶掉，Bangumi 按它限流");
  }
  const anonymous = [] as Array<Record<string, string>>;
  const anonFetch = (async (_url: unknown, init?: RequestInit) => {
    anonymous.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await createBangumiClient(anonFetch).search("摇曳露营");
  assert.equal(anonymous[0]?.authorization, undefined, "没配 token 就维持匿名请求");

  // 密钥只进不出：配置摘要里只出现 provisioning 事实
  const status = loadConfig({ NODE_ENV: "test", BANGUMI_TOKEN: "bgm-secret-token" }).configStatus;
  assert.equal(JSON.stringify(status).includes("bgm-secret-token"), false, "configStatus 里不得出现 token 值");
  assert.deepEqual(status.bangumi, { token: "explicit" });
  assert.equal(loadConfig({ NODE_ENV: "test" }).configStatus.bangumi.token, "missing");
});
