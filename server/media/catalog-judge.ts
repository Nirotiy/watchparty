import { titleCandidateDetails, yearFrom, type TitleCandidate } from "./catalog-names.ts";
import { chooseMatch, rankHits, type MetadataSearcher, type RankedHit } from "./catalog-metadata.ts";
import type { DraftJudgment } from "./catalog-store.ts";
import type { LibraryKind } from "./library-store.ts";

/**
 * 一条"要判定的东西"：草稿行或正式卡都长这样。判定与写库分开，是因为同一套查询、
 * 打分、选条目的逻辑既要在扫描时跑（写正式表），也要能在本地对着草稿反复跑
 * （只写草稿），而这两者的写入语义完全相反。
 */
export type JudgeSubject = {
  itemKey: string;
  query: string;
  rawName: string;
  fileNames: string[];
  fileCount: number;
  kind: LibraryKind;
  /** 人已拒绝过的条目（`db:id`），不再当候选。 */
  rejected: Set<string>;
};

/** Ordered, de-duplicated title guesses for one subject (max 3 requests). */
export function candidateQueries(subject: JudgeSubject): TitleCandidate[] {
  const segment = subject.itemKey.split("/").filter(Boolean).pop() ?? subject.rawName;
  const guesses = titleCandidateDetails(subject.fileNames, segment).slice(0, 3);
  if (guesses.length === 0 && subject.query) guesses.push({ query: subject.query, authoritative: true });
  const seen = new Set<string>();
  return guesses.filter((guess) => {
    const query = guess.query.trim();
    if (!query || seen.has(query)) return false;
    seen.add(query);
    return true;
  });
}

/**
 * 查条目、打分、决定确认还是留候选。只读网络、只返回结论，一行库都不写。
 */
export async function judgeSubject(
  subject: JudgeSubject,
  options: { bangumi: MetadataSearcher; tmdb: MetadataSearcher; delayMs: number },
): Promise<DraftJudgment> {
  const queries = candidateQueries(subject);
  if (queries.length === 0) return { status: "unmatched", candidates: [] };
  const searchKind = subject.kind === "tv" ? "tv" : subject.kind === "movie" ? "movie" : "anime";
  const searcher = subject.kind === "anime" ? options.bangumi : options.tmdb;
  let best: DraftJudgment = { status: "unmatched", candidates: [] };
  let bestScore = -1;
  for (const [index, guess] of queries.entries()) {
    if (index > 0 && options.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const hits = await searcher.search(guess.query, searchKind);
    const ranked = rankHits(guess.query, hits, yearFrom(subject.rawName), subject.fileCount || null).filter(
      (hit) => !subject.rejected.has(`${hit.externalDb}:${hit.externalId}`),
    );
    // Early stop: a confirmed match costs no further request, and a strong
    // candidate list means the query was understood even if nobody chose it.
    const choice = chooseMatch(ranked);
    // An episode title that happens to be another show's name must not bind the
    // card: `S03E01 荒原.mp4` confirmed 克拉克森的农场's folder as 荒原 (2015).
    // It still goes to the human as a candidate, which is the useful outcome.
    const confirmed = choice.status === "confirmed" && guess.authoritative;
    if (confirmed && choice.chosen) {
      return { status: "confirmed", candidates: choice.candidates, chosen: choice.chosen, posterUrl: choice.chosen.imageUrl ?? null };
    }
    const topScore = ranked[0]?.score ?? -1;
    if (ranked.length > 0 && topScore > bestScore) {
      best = { status: "candidate", candidates: choice.status === "confirmed" ? choice.candidates : ranked };
      bestScore = topScore;
    }
    if (topScore >= 0.75) break;
  }
  return best;
}

/** 判定结论里人要看的那一条：确认项或最高分候选。 */
export function chosenOrTop(judgment: DraftJudgment): RankedHit | null {
  return judgment.chosen ?? judgment.candidates[0] ?? null;
}
