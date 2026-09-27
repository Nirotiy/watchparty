import { cnNumber, scoreTitles } from "./catalog-names.ts";

export type MetadataDb = "bangumi" | "tmdb";

export type MetadataHit = {
  externalDb: MetadataDb;
  externalId: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  imageUrl: string | null;
  episodes: number | null;
  /**
   * Alternative names the release files may actually use (romaji, CN
   * simplified, group translations). Bangumi ships these in the search
   * response's infobox, so collecting them costs no extra request - and 75% of
   * live hits carry at least one, which is where the unmatched titles hide.
   */
  aliases?: string[];
};

export type RankedHit = MetadataHit & { score: number };

export type MetadataSearcher = {
  search(query: string, kind: "anime" | "movie" | "tv"): Promise<MetadataHit[]>;
};

export class MetadataUnavailable extends Error {
  readonly code = "CATALOG_UNAVAILABLE";

  constructor() {
    super("CATALOG_UNAVAILABLE");
    this.name = "MetadataUnavailable";
  }
}

const AUTO_SCORE = 0.86;
const AUTO_GAP = 0.08;
const CANDIDATE_SCORE = 0.5;
/** Below AUTO_SCORE on purpose: an installment mismatch must stay reviewable. */
const VARIANT_CAP = 0.84;
const POSTER_CAP_BYTES = 2 * 1024 * 1024;
const POSTER_HOSTS = new Set(["lain.bgm.tv", "image.tmdb.org"]);
/**
 * Which installment a name points at. `机动战士高达0079剧场版三部曲合集` scores
 * 0.900 against Bangumi's `机动战士高达` and used to confirm on its own - but the
 * folder is a trilogy collection and no such subject exists, so a person has to
 * choose. Token similarity cannot see that: the two titles differ only by the
 * qualifiers. So both sides are reduced to a set of installment keys and a
 * qualifier the folder claims but the record never mentions caps the pair.
 */
export function variantKeys(value: string): Set<string> {
  // Bangumi writes Japanese season numbers full-width (`街角魔族 ２丁目`).
  const text = value.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10));
  const keys = new Set<string>();
  if (/(?:剧场版|劇場版|映画|gekijouban|the movie|\bmovie\b)/i.test(text)) keys.add("movie");
  if (/\bova\b|ova\d/i.test(text)) keys.add("ova");
  if (/(?:特别篇|特別篇|\bsp\b|\bsps\b|special)/i.test(text)) keys.add("special");
  if (/(?:合集|全集|三部曲|套装|box|collection|complete|trilogy)/i.test(text)) keys.add("collection");
  const season = text.match(
    /(?:第\s*([0-9一二三四五六七八九十]{1,3})\s*(?:季|期|章|丁目)|(?:season|第)\s*(\d{1,2})(?:期|季|丁目)?|\bs(\d{1,2})\b|([0-9]{1,2})(?:st|nd|rd|th)|(\d{1,2})[\s-]*(?:期|季|丁目|choume|chome|ku|kou))/i,
  );
  const raw = season?.[1] ?? season?.[2] ?? season?.[3] ?? season?.[4] ?? season?.[5] ?? "";
  const number = raw ? cnNumber(raw) : null;
  if (number !== null && number > 0 && number <= 99) keys.add(`season:${number}`);
  return keys;
}

export function rankHits(query: string, hits: MetadataHit[], hintYear: number | null, hintFiles: number | null = null): RankedHit[] {
  const specific = query.trim().length >= 8;
  const wanted = variantKeys(query);
  return hits
    .map((hit, index) => {
      let score = Math.max(scoreTitles(query, hit.title), hit.originalTitle ? scoreTitles(query, hit.originalTitle) : 0);
      // An alias hit is as good as a title hit: release groups name folders after
      // whatever the community calls the show, which is often neither field.
      const offered = new Set<string>(variantKeys(hit.title));
      for (const alias of hit.aliases ?? []) {
        score = Math.max(score, scoreTitles(query, alias));
        for (const key of variantKeys(alias)) offered.add(key);
      }
      if (hit.originalTitle) for (const key of variantKeys(hit.originalTitle)) offered.add(key);
      if (hintYear !== null && hit.year !== null) {
        if (hit.year === hintYear) score += 0.05;
        else if (Math.abs(hit.year - hintYear) > 1) score -= 0.1;
      }
      if (hintFiles !== null && hintFiles >= 2 && hit.episodes !== null) {
        if (hit.episodes === 1) score -= 0.2;
        else if (hit.episodes === hintFiles) score += 0.08;
      }
      if (specific && score < CANDIDATE_SCORE) {
        const floor = index === 0 ? 0.62 : index < 3 ? 0.55 : 0;
        score = Math.max(score, floor);
      }
      // Only the folder's own claims are enforced: a subject record may list
      // several seasons in its aliases without that making it a wrong answer.
      for (const key of wanted) if (!offered.has(key)) score = Math.min(score, VARIANT_CAP);
      score = Math.max(0, Math.min(1, score));
      return { ...hit, score: Math.round(score * 1000) / 1000 };
    })
    .filter((hit) => hit.score >= CANDIDATE_SCORE)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
}

export function chooseMatch(ranked: RankedHit[]): { status: "confirmed" | "candidate" | "unmatched"; chosen: RankedHit | null; candidates: RankedHit[] } {
  const candidates = ranked.filter((hit) => hit.score >= CANDIDATE_SCORE).slice(0, 5);
  const top = candidates[0];
  const second = candidates[1];
  if (top && top.score >= AUTO_SCORE && (!second || top.score - second.score >= AUTO_GAP)) {
    return { status: "confirmed", chosen: top, candidates };
  }
  if (candidates.length > 0) return { status: "candidate", chosen: null, candidates };
  return { status: "unmatched", chosen: null, candidates: [] };
}

export function createBangumiClient(fetchImpl: typeof fetch = fetch): MetadataSearcher {
  return {
    async search(query) {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const anime = await bangumiSubjects(fetchImpl, trimmed, 2);
      let staged: MetadataHit[] = [];
      try {
        staged = await bangumiSubjects(fetchImpl, trimmed, 6);
      } catch {
        staged = [];
      }
      const seen = new Set(anime.map((hit) => hit.externalId));
      return [...anime, ...staged.filter((hit) => !seen.has(hit.externalId))];
    },
  };
}

export function createTmdbClient(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): MetadataSearcher {
  const key = (env.TMDB_API_KEY || env.TMDB_READ_TOKEN || "").trim();
  return {
    async search(query, kind) {
      const trimmed = query.trim();
      if (!trimmed) return [];
      if (!key) throw new MetadataUnavailable();
      const url = new URL(`https://api.themoviedb.org/3/${kind === "tv" ? "search/tv" : "search/movie"}`);
      url.searchParams.set("query", trimmed);
      url.searchParams.set("language", "zh-CN");
      const headers: Record<string, string> = { accept: "application/json" };
      if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
      else url.searchParams.set("api_key", key);
      let response: Response;
      try {
        response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
      } catch {
        throw new MetadataUnavailable();
      }
      if (!response.ok) throw new MetadataUnavailable();
      const body = (await response.json()) as { results?: unknown };
      if (!Array.isArray(body.results)) return [];
      const hits: MetadataHit[] = [];
      for (const entry of body.results) {
        const hit = tmdbHit(entry, kind === "tv");
        if (hit) hits.push(hit);
      }
      return hits;
    },
  };
}

export async function fetchPosterBytes(url: string, fetchImpl: typeof fetch = fetch): Promise<{ contentType: string; bytes: Buffer } | undefined> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== "https:" || !POSTER_HOSTS.has(target.hostname) || target.username || target.password) return undefined;
  let response: Response;
  try {
    response = await fetchImpl(target, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    return undefined;
  }
  if (response.status !== 200 || !response.body) return undefined;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > POSTER_CAP_BYTES) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > POSTER_CAP_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks);
  const contentType = sniffImage(bytes);
  if (!contentType) return undefined;
  return { contentType, bytes };
}


async function bangumiSubjects(fetchImpl: typeof fetch, keyword: string, type: number): Promise<MetadataHit[]> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.bgm.tv/v0/search/subjects", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "watchparty/0.1.0 (catalog scrape)",
      },
      body: JSON.stringify({ keyword, filter: { type: [type] }, limit: 8 }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new MetadataUnavailable();
  }
  if (!response.ok) throw new MetadataUnavailable();
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) return [];
  const hits: MetadataHit[] = [];
  for (const entry of body.data) {
    const hit = bangumiHit(entry);
    if (hit) hits.push(hit);
  }
  return hits;
}
/** Bangumi infobox entries that carry an alternative title, slash-separated. */
function bangumiAliases(infobox: unknown, known: Array<string | null>): string[] {
  if (!Array.isArray(infobox)) return [];
  const aliases: string[] = [];
  for (const entry of infobox) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.key !== "string" || !/别名|中文名|原名|日文名|英文名|简体中文|正體中文/.test(row.key)) continue;
    const values = Array.isArray(row.value)
      ? row.value.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).v : item))
      : [row.value];
    for (const value of values) {
      if (typeof value !== "string") continue;
      for (const part of value.split("/")) {
        const alias = part.trim();
        if (alias) aliases.push(alias);
      }
    }
  }
  return [...new Set(aliases)].filter((alias) => !known.includes(alias));
}

function infoboxNumber(infobox: unknown, key: string): number | null {
  if (!Array.isArray(infobox)) return null;
  for (const entry of infobox) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (row.key !== key) continue;
    const raw = Array.isArray(row.value) ? String(row.value[0] ?? "") : String(row.value ?? "");
    const digits = /(\d+)/.exec(raw);
    if (!digits) return null;
    const value = Number(digits[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

function bangumiHit(value: unknown): MetadataHit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "number" ? String(row.id) : "";
  const name = typeof row.name === "string" ? row.name : "";
  const nameCn = typeof row.name_cn === "string" ? row.name_cn : "";
  const title = nameCn || name;
  if (!id || !title) return undefined;
  const images = row.images && typeof row.images === "object" ? (row.images as Record<string, unknown>) : undefined;
  const image = typeof images?.common === "string" ? images.common : typeof images?.large === "string" ? images.large : null;
  const eps = typeof row.eps === "number" && row.eps > 0 ? row.eps : null;
  const total = typeof row.total_episodes === "number" && row.total_episodes > 0 ? row.total_episodes : null;
  return {
    externalDb: "bangumi",
    externalId: id,
    title,
    originalTitle: name && name !== title ? name : null,
    year: yearOf(typeof row.date === "string" ? row.date : ""),
    overview: typeof row.summary === "string" && row.summary.trim() ? row.summary.trim() : null,
    imageUrl: image,
    // eps is the aired-count the API reports for the season; total_episodes and
    // the infobox 话数 only exist for some entries, so they are fallbacks.
    episodes: eps ?? total ?? infoboxNumber(row.infobox, "话数"),
    aliases: bangumiAliases(row.infobox, [title, name, nameCn]),
  };
}

function tmdbHit(value: unknown, tv: boolean): MetadataHit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "number" ? String(row.id) : "";
  const title = typeof (tv ? row.name : row.title) === "string" ? String(tv ? row.name : row.title) : "";
  const original = typeof (tv ? row.original_name : row.original_title) === "string" ? String(tv ? row.original_name : row.original_title) : "";
  if (!id || !title) return undefined;
  const poster = typeof row.poster_path === "string" && row.poster_path ? `https://image.tmdb.org/t/p/w342${row.poster_path}` : null;
  const dated = typeof (tv ? row.first_air_date : row.release_date) === "string" ? String(tv ? row.first_air_date : row.release_date) : "";
  return {
    externalDb: "tmdb",
    externalId: id,
    title,
    originalTitle: original && original !== title ? original : null,
    year: yearOf(dated),
    overview: typeof row.overview === "string" && row.overview.trim() ? row.overview.trim() : null,
    imageUrl: poster,
    episodes: null,
  };
}

function yearOf(value: string): number | null {
  const match = /^(\d{4})/.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}

function sniffImage(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}
