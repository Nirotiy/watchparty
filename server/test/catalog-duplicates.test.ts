import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateGroups, normalizeTitle, type DuplicateEvidence } from "../media/catalog-duplicates.ts";

/**
 * 疑似同作的判定表（handoff §9）。这里只钉两件事：什么样的证据够格报，
 * 以及报出来时必须把"合并后会留下什么"讲清楚 —— 人点头靠的是那三行。
 */
function card(value: Partial<DuplicateEvidence> & { id: string }): DuplicateEvidence {
  return {
    itemKey: `/${value.id}`,
    title: value.title ?? `作品 ${value.id}`,
    originalTitle: null,
    year: null,
    externalDb: null,
    externalId: null,
    confirmedBy: null,
    files: 1,
    episodes: 1,
    folders: [`/${value.id}`],
    poster: null,
    ...value,
  };
}

test("normalizeTitle：半角全角标点、括号、空白一起去掉，只留文字与数字", () => {
  assert.equal(normalizeTitle("我们不可能成为恋人！绝对不行。 (※似乎可行？) 〜再次闪耀！〜"), "我们不可能成为恋人绝对不行似乎可行再次闪耀");
  assert.equal(normalizeTitle("[VCB-Studio] SHIROBAKO [01]"), "vcbstudioshirobako01");
  assert.equal(normalizeTitle("Yuru Camp△"), "yurucamp"); // △ 是记号不是文字，一样去掉
  assert.equal(normalizeTitle("  a b  "), "ab");
});

test("同一个外部条目 = 强证据，标题完全不同也报", () => {
  const groups = findDuplicateGroups([
    card({ id: "a", title: "OVA 主篇", externalDb: "bangumi", externalId: "587454", files: 5, episodes: 5 }),
    card({ id: "b", title: "完全不像的名字", externalDb: "bangumi", externalId: "587454", files: 2, episodes: 2 }),
    card({ id: "c", title: "别的作品", externalDb: "bangumi", externalId: "111111" }),
  ]);
  assert.equal(groups.length, 1);
  const group = groups[0]!;
  assert.equal(group.reason, "same-subject");
  assert.equal(group.confidence, "high");
  assert.deepEqual(group.cards.map((entry) => entry.id), ["a", "b"], "文件多的那张当保留卡");
  assert.equal(group.files, 7);
  assert.deepEqual(group.suggestion.dropIds, ["b"]);
  assert.equal(group.needsHumanDecision, false);
  assert.equal(group.preserves.episodes.kept, 5);
  assert.equal(group.preserves.episodes.merged, 7);
});

test("名字撞上但各自绑到不同条目：人已判定是两部作品，不许再报同作", () => {
  const groups = findDuplicateGroups([
    card({ id: "a", title: "摇曳露营", externalDb: "bangumi", externalId: "1" }),
    card({ id: "b", title: "摇曳露营", externalDb: "tmdb", externalId: "2" }),
  ]);
  assert.deepEqual(groups, []);
});

test("没有绑定的同名卡：中等证据，仍然报，并把目录与年份摊出来", () => {
  const groups = findDuplicateGroups([
    card({ id: "a", title: "蓝色监狱 第二季", year: 2022, folders: ["/蓝色监狱 S2"], files: 11, episodes: 11 }),
    card({ id: "b", title: "蓝色监狱（第二季）", year: 2024, folders: ["/蓝色监狱 S2/SPs"], files: 3, episodes: 0 }),
  ]);
  assert.equal(groups.length, 1);
  const group = groups[0]!;
  assert.equal(group.reason, "same-title");
  assert.equal(group.confidence, "medium");
  assert.equal(group.subject, null);
  assert.deepEqual(group.evidence.years, [2022, 2024]);
  assert.deepEqual(group.evidence.folders, ["/蓝色监狱 S2", "/蓝色监狱 S2/SPs"]);
  assert.deepEqual(group.cards.map((entry) => entry.id), ["a", "b"], "11 集的那张当保留卡");
});

test("名字太短不当证据，也不会把两张单卡凑成一组", () => {
  assert.deepEqual(findDuplicateGroups([card({ id: "a", title: "OVA" }), card({ id: "b", title: "ova " })]), []);
  assert.deepEqual(findDuplicateGroups([card({ id: "a", title: "只有这一部作品" })]), []);
});

test("海报与绑定的去向要说清从哪张卡接手，人确认过的一张就要标出来", () => {
  const groups = findDuplicateGroups([
    card({ id: "a", title: "同作两部", confirmedBy: "manual" }),
    card({ id: "b", title: "同作两部", externalDb: "bangumi", externalId: "42", poster: "/api/media/catalog/b/poster", files: 4 }),
  ]);
  assert.equal(groups.length, 1);
  const group = groups[0]!;
  assert.equal(group.needsHumanDecision, true, "组里有人确认过的卡 ⇒ 合并会撤掉那份决定，必须人裁");
  // 保留卡按文件数选，所以是 b；它的绑定与海报原地保留，a 那边没有可接手的东西。
  assert.equal(group.suggestion.keepId, "b");
  assert.equal(group.preserves.binding.kept, "bangumi:42");
  assert.equal(group.preserves.binding.from, null);
  assert.equal(group.preserves.poster.kept, "/api/media/catalog/b/poster");
});

test("同一批卡只报一遍：已经按条目成组的卡不再按名字成组", () => {
  const groups = findDuplicateGroups([
    card({ id: "a", title: "同作两部", externalDb: "bangumi", externalId: "7" }),
    card({ id: "b", title: "同作两部", externalDb: "bangumi", externalId: "7" }),
    card({ id: "c", title: "同作两部" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.reason, "same-subject");
  assert.deepEqual(groups[0]!.cards.map((entry) => entry.id), ["a", "b"]);
});
