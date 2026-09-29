/**
 * 疑似同作的判定（handoff §9）：**只标记，不合并**。
 *
 * 为什么默认不动手：OVA/季度/SP 与正片的目录写法几乎一样，而一次错误的合并会把人确认过的
 * 绑定和标题吃掉。这里的产物是给审阅页看的"建议"，落地仍然是人工合并那一条路。
 *
 * 证据分成两类强弱：同一外部条目是强证据（两个名字完全不同也可能是同作的两部分），
 * 名字规范化后相同是中等证据（同名不同作确实存在，所以两边都不能有互相冲突的绑定）。
 */

export type DuplicateEvidence = {
  id: string;
  itemKey: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  externalDb: string | null;
  externalId: string | null;
  confirmedBy: string | null;
  files: number;
  episodes: number;
  folders: string[];
  poster: string | null;
};

export type DuplicateGroup = {
  reason: "same-subject" | "same-title";
  confidence: "high" | "medium";
  subject: { externalDb: string; externalId: string } | null;
  cards: DuplicateEvidence[];
  files: number;
  evidence: { titles: string[]; folders: string[]; years: Array<number | null>; bindings: string[] };
  suggestion: {
    action: "merge";
    keepId: string;
    dropIds: string[];
    /** 人会看到的那一句：合并走的是既有的人工合并接口，不是新的自动流程。 */
    via: string;
  };
  /** 合并之后剩下什么：绑定 / 集数 / 海报各自的去向，这是人点头前最想知道的三样。 */
  preserves: {
    binding: { kept: string | null; from: string | null };
    episodes: { kept: number; merged: number };
    poster: { kept: string | null; from: string | null };
  };
  /** 组里有任何一张是人确认过的 ⇒ 合并会撤掉那份人工决定，必须由人来裁。 */
  needsHumanDecision: boolean;
};

const HUMAN = new Set(["manual", "rebind", "unknown"]);

/** 只留字母、数字与各文字（空白与半角/全角标点一律去掉）；剩下的太短就不当证据。 */
export function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const MIN_TITLE_EVIDENCE = 4;

function binding(card: DuplicateEvidence): string | null {
  return card.externalDb && card.externalId ? `${card.externalDb}:${card.externalId}` : null;
}

function sorted(cards: DuplicateEvidence[]): DuplicateEvidence[] {
  // 保住"文件最多的那张"当 keepKey：它最可能是人正在看的那一部；同数时按绑定有无、再按键位。
  return [...cards].sort(
    (left, right) =>
      right.files - left.files ||
      Number(Boolean(binding(right))) - Number(Boolean(binding(left))) ||
      left.itemKey.localeCompare(right.itemKey),
  );
}

function group(reason: DuplicateGroup["reason"], cards: DuplicateEvidence[]): DuplicateGroup {
  const ordered = sorted(cards);
  const keep = ordered[0]!;
  const drops = ordered.slice(1);
  const subject = binding(keep);
  const bindingGiver = drops.find((card) => !binding(keep) && binding(card));
  const posterGiver = drops.find((card) => !keep.poster && card.poster);
  const titles = [...new Set(cards.map((card) => card.title).filter(Boolean))];
  return {
    reason,
    confidence: reason === "same-subject" ? "high" : "medium",
    subject:
      reason === "same-subject" && keep.externalDb && keep.externalId
        ? { externalDb: keep.externalDb, externalId: keep.externalId }
        : null,
    cards: ordered,
    files: cards.reduce((total, card) => total + card.files, 0),
    evidence: {
      titles,
      folders: [...new Set(cards.flatMap((card) => card.folders))].sort(),
      years: [...new Set(cards.map((card) => card.year))].sort((left, right) => (left ?? 0) - (right ?? 0)),
      bindings: [...new Set(cards.map(binding).filter((value): value is string => Boolean(value)))],
    },
    suggestion: {
      action: "merge",
      keepId: keep.id,
      dropIds: drops.map((card) => card.id),
      via: "POST /api/media/catalog/merge { keepId, dropIds }",
    },
    preserves: {
      binding: { kept: subject ?? (bindingGiver ? binding(bindingGiver) : null), from: !subject && bindingGiver ? bindingGiver.itemKey : null },
      episodes: { kept: keep.episodes, merged: cards.reduce((total, card) => total + card.episodes, 0) },
      poster: { kept: keep.poster ?? (posterGiver?.poster ?? null), from: !keep.poster && posterGiver ? posterGiver.itemKey : null },
    },
    needsHumanDecision: cards.some((card) => card.confirmedBy !== null && HUMAN.has(card.confirmedBy)),
  };
}

/**
 * 正式卡里的疑似同作。同一外部条目优先成组（强证据），成过的卡不再参与名字分组，
 * 避免同一堆卡被报两遍。只有一张卡的组不算重复，直接不出现。
 */
export function findDuplicateGroups(cards: DuplicateEvidence[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const claimed = new Set<string>();

  const bySubject = new Map<string, DuplicateEvidence[]>();
  for (const card of cards) {
    const key = binding(card);
    if (!key) continue;
    bySubject.set(key, [...(bySubject.get(key) ?? []), card]);
  }
  for (const [, same] of bySubject) {
    if (same.length < 2) continue;
    for (const card of same) claimed.add(card.id);
    groups.push(group("same-subject", same));
  }

  const byTitle = new Map<string, DuplicateEvidence[]>();
  for (const card of cards) {
    if (claimed.has(card.id)) continue;
    for (const value of [normalizeTitle(card.title), card.originalTitle ? normalizeTitle(card.originalTitle) : null]) {
      if (!value || value.length < MIN_TITLE_EVIDENCE) continue;
      const bucket = byTitle.get(value) ?? [];
      if (!bucket.some((entry) => entry.id === card.id)) bucket.push(card);
      byTitle.set(value, bucket);
    }
  }
  for (const [, same] of byTitle) {
    const usable = same.filter((card) => !claimed.has(card.id));
    if (usable.length < 2) continue;
    // 两边各自绑到不同条目 = 已经有人判定它们是两部作品，不许再报同作。
    const bindings = new Set(usable.map(binding).filter(Boolean));
    if (bindings.size > 1) continue;
    for (const card of usable) claimed.add(card.id);
    groups.push(group("same-title", usable));
  }

  return groups.sort((left, right) => Number(right.needsHumanDecision) - Number(left.needsHumanDecision) || right.files - left.files || left.reason.localeCompare(right.reason));
}
