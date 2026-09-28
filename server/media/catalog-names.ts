import path from "node:path";

export type ScanFile = {
  relativePath: string;
  name: string;
  mediaId: string;
};

export type CatalogGroupFile = {
  mediaId: string;
  name: string;
  season: number | null;
  episode: number | null;
  /**
   * Library-relative path. Identity has to be the path rather than `mediaId`:
   * `mediaId` is an HMAC under `WATCHPARTY_MEDIA_ID_KEY`, which is unset on this
   * machine (`readiness.config.mediaIdKey.mode = "ephemeral"`), so every process
   * mints different ids for the same file and any cross-process comparison fails.
   */
  relativePath?: string;
  /**
   * True when the file was pulled up out of a specials/OVA/disc folder into the
   * work card. It is playable from that card, but it is not an episode, so the
   * 「N 集」 count skips it - otherwise a 12-episode series with 67 CM clips in
   * `SPs/` would announce itself as 79 集.
   */
  bonus?: boolean;
};

export type CatalogGroup = {
  itemKey: string;
  query: string;
  /**
   * Ordered title guesses, best first (max 3). One path segment is not enough
   * to know the title - release groups put it in the file name, or in a bracket
   * after the subtitle group - so the lookup stage tries these in order and
   * stops at the first confirmed match instead of guessing once.
   */
  queries: string[];
  rawName: string;
  files: CatalogGroupFile[];
};

// `strm` is included because a pointer file stands in for the media it names: the
// library tree (folder layout + file name) is what carries the title and season, so
// grouping them with videos is what makes an strm library scrapable at all.
const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "webm", "m4v", "mov", "avi", "ts", "m2ts", "flv", "wmv", "strm"]);
const TECHNICAL = /1080|720|2160|4k|bdrip|web-?dl|bluray|hevc|x26[45]|aac|flac|\bmkv\b|avc|10bit|8bit|全集|特典|特别篇|导演/i;

export function isVideoFileName(name: string): boolean {
  const index = name.lastIndexOf(".");
  if (index <= 0) return false;
  return VIDEO_EXTENSIONS.has(name.slice(index + 1).toLowerCase());
}

export function cleanTitle(name: string): string {
  const withoutExt = name.replace(/\.[a-z0-9]{2,5}$/i, "");
  const chunks: string[] = [];
  const remainder = withoutExt
    .replace(/\[([^\]]*)\]/g, (_all, inner: string) => {
      chunks.push(inner);
      return " ";
    })
    .replace(/\(([^)]*)\)/g, (_all, inner: string) => {
      chunks.push(inner);
      return " ";
    });
  const title = stripReleaseTags(remainder);
  if (title) return title;
  const picked = chunks.find((chunk) => !junkChunk(chunk));
  return picked ? stripReleaseTags(picked) : "";
}

export function yearFrom(name: string): number | null {
  const match = name.match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

export function parseEpisode(name: string): { season: number | null; episode: number | null } {
  const stem = name.replace(/\.[a-z0-9]{2,5}$/i, "");
  const seasonEpisode = /S(\d{1,2})E(\d{1,3})/i.exec(stem);
  if (seasonEpisode?.[1] && seasonEpisode[2]) return { season: Number(seasonEpisode[1]), episode: Number(seasonEpisode[2]) };
  const explicit = /(?:\bEP(?:ISODE)?[\s._-]*(\d{1,3})\b|第\s*(\d{1,3})\s*[话話集])/i.exec(stem);
  if (explicit) return { season: null, episode: Number(explicit[1] ?? explicit[2]) };
  // Release groups place an episode after the title, before codec/language tags.
  const bracketed = /(?:^|[\s\]\)])\[(\d{1,3})\](?=\[|\s|$)/.exec(stem);
  if (bracketed?.[1]) return { season: null, episode: Number(bracketed[1]) };
  const trailing = /(?:^|\s)[-–]\s*(\d{1,3})(?=\s*(?:\[|$))/.exec(stem);
  return { season: null, episode: trailing?.[1] ? Number(trailing[1]) : null };
}

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** `12`、`三`、`十二`、`二十` → number; anything else null. Shared with the installment guardrail. */
export function cnNumber(value: string): number | null {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.startsWith("十")) return 10 + (CN_DIGIT[value[1]] ?? 0);
  if (value.endsWith("十")) return (CN_DIGIT[value[0]] ?? 0) * 10;
  return CN_DIGIT[value] ?? null;
}

/**
 * Season a folder name announces. Latin form is exact (`Season 01`, `S2`); the
 * Chinese one only has to *start* with `第N季`/`第N期`, because these folders are
 * written with a trailing note (`第三季 包含字幕和弹幕文件`, `第四季 全集 …`) and
 * the whole season otherwise collapses into one card per folder.
 * `第N话` is deliberately not a season - it is one episode in its own folder.
 */
export function seasonFromName(name: string): number | null {
  const trimmed = name.trim();
  const latin = /^(?:season\s*|s)(\d{1,2})$/i.exec(trimmed);
  if (latin?.[1]) return Number(latin[1]);
  const chinese = /^第\s*([0-9一二三四五六七八九十]{1,3})\s*[季期]/.exec(trimmed);
  return chinese?.[1] ? cnNumber(chinese[1]) : null;
}

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

/**
 * Splits a title into comparison tokens. Latin/digit runs become words; CJK
 * runs become overlapping bigrams, because a Chinese or Japanese title has no
 * spaces and treating it as one token collapses similarity scoring to a
 * whole-string containment test (that is what forced manual review).
 */
export function tokenizeTitle(value: string): string[] {
  const normalized = normalizeTitle(value);
  if (!normalized) return [];
  const tokens: string[] = [];
  for (const part of normalized.split(" ")) {
    if (!part) continue;
    if (!CJK.test(part)) {
      tokens.push(part);
      continue;
    }
    const chars = [...part].filter((char) => CJK.test(char));
    if (chars.length === 1) tokens.push(chars[0]);
    for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(chars[index] + chars[index + 1]);
  }
  return tokens;
}

export function scoreTitles(query: string, title: string): number {
  const left = normalizeTitle(query);
  const right = normalizeTitle(title);
  if (!left || !right) return 0;
  if (left === right) return 1;
  // Containment is its own signal (release names pad the official title with
  // year or group tags) and must survive the token comparison below: taking
  // only the bigram Dice would drop `[LoliHouse] The Ghost in the Shell` vs
  // `攻殻機動隊 THE GHOST IN THE SHELL` from 0.9 to 0.67, i.e. confirmed → candidate.
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  const contained =
    (left.includes(right) || right.includes(left)) && shorter >= 4 && shorter / longer >= 0.45 ? 0.9 : 0;
  return Math.max(contained, dice(tokenizeTitle(query), tokenizeTitle(title)));
}

function dice(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of leftSet) if (rightSet.has(token)) shared += 1;
  return (2 * shared) / (leftSet.size + rightSet.size);
}

/**
 * `keepFolders` = directory keys a person has decided on (confirmed by hand). A
 * folder in that set is never folded into its parent: the alternative is either
 * deleting someone's card or showing the same file on two cards.
 */
export function groupScanFiles(files: ScanFile[], keepFolders?: Set<string>): CatalogGroup[] {
  const byDir = new Map<string, ScanFile[]>();
  for (const file of files) {
    const dir = parentOf(file.relativePath);
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const rolled = new Map<string, CatalogGroupFile[]>();
  for (const [dir, list] of byDir) {
    const base = dir === "/" ? "" : path.posix.basename(dir);
    if (base && isExtraDirectory(base)) continue;
    const seasonFolder = base ? seasonFromName(base) : null;
    const key = workKeyOf(dir, seasonFolder !== null);
    const bucket = rolled.get(key) ?? [];
    for (const file of list) {
      const parsed = parseEpisode(file.name);
      bucket.push({
        mediaId: file.mediaId,
        name: file.name,
        season: parsed.season ?? seasonFolder,
        episode: parsed.episode,
        relativePath: file.relativePath,
      });
    }
    rolled.set(key, bucket);
  }
  const groups: CatalogGroup[] = [];
  // A subfolder whose own files name the parent's work is a segment of that release,
  // not a second work: `[DBD-Raws][泽塔奥特曼][…]` holds `/人物访谈`(8) and
  // `/遥辉的奥特导航`(22) whose file names repeat 泽塔奥特曼. The folder *name*
  // cannot be used for this comparison (`人物访谈` outranks everything else in that
  // bucket), so the candidate comes from the files only. That also keeps genuine
  // neighbours out: `/[VCB] SHIROBAKO …/[VCB] Daisan Hikou Shoujotai` names itself.
  const titlesOfFiles = (bucket: CatalogGroupFile[]) => titleCandidates(bucket.map((file) => file.name), "", 3);
  for (const key of [...rolled.keys()].sort((left, right) => right.split("/").length - left.split("/").length)) {
    const bucket = rolled.get(key);
    if (!bucket || key === "/") continue;
    const parent = parentOf(key);
    const parentBucket = rolled.get(parent);
    if (!parentBucket || keepFolders?.has(key)) continue;
    const above = titlesOfFiles(parentBucket)[0] ?? "";
    // Any candidate counts, not just the best one: in `[组][作品][遥辉的奥特导航][01]`
    // the segment name is longer than the work name and wins the tie-break, while
    // still proving the folder belongs to the parent release.
    if (!above || !titlesOfFiles(bucket).some((own) => scoreTitles(own, above) >= 0.95)) continue;
    parentBucket.push(...bucket);
    rolled.delete(key);
  }
  for (const [key, bucket] of rolled) {
    const filesInOrder = [...bucket].sort(compareFiles);
    if (key === "/") {
      for (const file of filesInOrder) {
        const queries = titleCandidates([file.name], path.posix.basename(file.relativePath ?? file.name));
        groups.push({
          itemKey: file.relativePath ?? file.name,
          query: queries[0] ?? cleanTitle(file.name),
          queries: queries.length > 0 ? queries : [cleanTitle(file.name)],
          rawName: file.name,
          files: [{ mediaId: file.mediaId, name: file.name, season: file.season, episode: file.episode, relativePath: file.relativePath }],
        });
      }
      continue;
    }
    const rawName = path.posix.basename(key);
    const queries = titleCandidates(filesInOrder.map((file) => file.name), rawName);
    groups.push({
      itemKey: key,
      query: queries[0] ?? cleanTitle(rawName),
      queries: queries.length > 0 ? queries : [cleanTitle(rawName)],
      rawName,
      files: filesInOrder,
    });
  }
  return groups.sort((left, right) => left.itemKey.localeCompare(right.itemKey));
}

/**
 * zh-CN display string, served verbatim: clients are forbidden by the frozen
 * contract from parsing this text, so the wording belongs to the backend.
 * Shape is load-bearing (optional `S<n> · ` prefix, then a count) — the card
 * sub-line truncates near 20 characters.
 *
 * Counts episodes, not files (frontend decision B, 2026-09-27): bonus folders roll
 * into the work card so their files stay playable from it, but `12 集 + 67 SP` must
 * not read as `79 集`. A work with fewer than two episodes of its own - a film plus
 * its commentary discs - returns null so the sub-line disappears entirely, which
 * both clients render as "no count" rather than a wrong one.
 */
/**
 * Is this file an episode of the card, or something filed alongside it?
 *
 * With the card's own folder known, the rule is structural rather than a vocabulary:
 * a file sitting in that folder is an episode, and a deeper folder counts only when it
 * names a season (`第二季 包含字幕和弹幕文件`, `Season 01`, `第03话`). Everything below
 * that - `人物访谈`, `遥辉的奥特导航`, `SPs`, `爆炸` - is a segment, still playable
 * from this card but not counted as an episode. Without `workDir` there is no
 * structure to read, so it falls back to the folder-name shapes alone.
 */
function isEpisodeFile(file: CatalogGroupFile, workDir?: string): boolean {
  if (!file.relativePath) return true;
  const folder = file.relativePath.replace(/\/[^/]*$/, "");
  const name = folder.split("/").pop() ?? "";
  if (!workDir) return !isBonusDirectory(name);
  // Files in the folder of the card itself are its episodes by definition, even if
  // somebody named that folder `SPs` and later confirmed the card.
  if (folder === workDir) return true;
  return seasonFromName(name) !== null || /^第.{1,4}[话話期季]/.test(name);
}

export function episodeSubtitle(files: CatalogGroupFile[], workDir?: string): string | null {
  const episodes = files.filter((file) => isEpisodeFile(file, workDir));
  if (episodes.length <= 1) return null;
  const seasons = new Set(episodes.map((file) => file.season).filter((season): season is number => season !== null));
  const prefix = seasons.size === 1 ? `S${[...seasons][0]} · ` : "";
  return `${prefix}${episodes.length} 集`;
}

function parentOf(relativePath: string): string {
  const normalized = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "/" : parent;
}

function compareFiles(left: CatalogGroupFile, right: CatalogGroupFile): number {
  const season = (left.season ?? 0) - (right.season ?? 0);
  if (season !== 0) return season;
  const episode = (left.episode ?? 0) - (right.episode ?? 0);
  if (episode !== 0) return episode;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function stripReleaseTags(value: string): string {
  return value
    .replace(/\bS\d{1,2}E\d{1,3}\b/gi, " ")
    .replace(/\b(?:S\d{1,2}|Season\s*\d+|Full)\b/gi, " ")
    .replace(/\b(?:1080p|720p|2160p|4k|bdrip|web-?dl|bluray|hevc|x264|x265|aac|flac|avc|10bit)\b/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Technical/promotional tags. Matched per token because real chunks are composites:
 * `Ma10p_1080p` survived a whole-chunk test and ended up ranked above the actual
 * title, wasting a lookup and leaving `[VCB-Studio] SHIROBAKO .../SPs` unresolved.
 */
const TECHNICAL_STEMS = [
  "1080p", "1080", "1080i", "720p", "480p", "2160p", "2160", "1920", "4k", "8k", "uhd", "bdrip", "bd-rip", "webrip",
  "web-dl", "webdl", "hdtv", "x264", "x265", "hevc", "h264", "h265", "avc", "10bit", "8bit", "hi10p", "ma10p",
  "flac", "aac", "m4a", "opus", "ac3", "eac3", "dts", "dts-hd", "truehd", "atmos", "ddp", "dd", "hdr", "hdr10",
  "sdr", "dv", "dolby", "vision", "mkv", "mp4", "ts", "ass", "srt", "vtt", "pcm", "dvd", "sacd", "cd", "dl",
  "bluray", "blu-ray", "bdmux", "dvdrip", "av1", "avc1", "hybrid", "dovi", "remux", "uncensored", "complete", "full", "audio", "chs", "cht", "jpn", "eng", "chn", "kor", "yue", "gb", "big5",
  "chs-jpn", "jpn-chs", "chs-cht", "chscht", "dayuan",
];
/**
 * Subtitle-config and promotional chunks. `招募翻译`/`压制` are release-notice
 * filler, `简体双语`/`日英双语`/`简繁外挂` are subtitle tracks - both appear in
 * every file of a group, so a missing entry here outranks the real title.
 */
const TECHNICAL_PHRASES =
  /^(?:[简繁]体?(?:双语|内嵌|外挂|中字)?|[简繁]繁(?:双语|内嵌|外挂)?|(?:日英|中英|中日|国日|粤日)双语?|双语字幕|单语字幕|内嵌字幕|外挂字幕|全集|合集|特典|特别篇|导演剪辑版?|招募翻译|翻译|压制|校对|时间轴|轴|扫雷|发布|timeshift|nced|ncop|op|ed|pv|menu|cast commentary|making|trailer|cm\d*)$/;

/** Technical tags are matched loosely: `ASSx2`, `flacx2`, `1080P` all mean the same thing. */
function isTechnicalToken(token: string): boolean {
  const normalized = token.toLowerCase().replace(/[._]/g, "-").replace(/-$/, "");
  if (!normalized) return true;
  if (/^\d+[pP]?$/.test(normalized)) return true;
  const stripped = normalized.replace(/(?:x\d+)+$/, "");
  if (TECHNICAL_STEMS.includes(normalized) || TECHNICAL_STEMS.includes(stripped)) return true;
  // `DDP5.1` is one tag with a channel count bolted on, so the alphabetic prefix
  // decides (`ddp` is a stem, `ddp5` on its own was leaking into the query).
  const alpha = normalized.replace(/\d+$/, "");
  if (alpha.length >= 2 && TECHNICAL_STEMS.includes(alpha)) return true;
  if (TECHNICAL_PHRASES.test(normalized) || TECHNICAL_PHRASES.test(stripped)) return true;
  // Hyphenated composites (`HEVC-10bit`) are two tags glued together, but the
  // same shape also carries season qualifiers (`2-Choume`), so the token only
  // counts as technical when every part does.
  if (normalized.includes("-")) {
    const parts = normalized.split("-").filter(Boolean);
    if (parts.length > 1 && parts.every((part) => isTechnicalToken(part))) return true;
  }
  if (/(?:bdrip|bluray|webrip|hevc|x26[45]|flac|aac|1080|2160)/.test(normalized) && normalized.length <= 12) return true;
  // Pixel-format tags (`yuv420p10`) never appear alone, only inside a composite
  // like `HEVC-yuv420p10`, which the part-wise check above then resolves.
  if (/yuv\d*/.test(normalized)) return true;
  return false;
}

/**
 * Group handles mention a studio/subbing/encoding identity anywhere in the chunk,
 * so `Studio GreenTea&LoliHouse` reads as a group even though neither `&` part is
 * a single token. Anchored forms (`raws?`, `subs?`) stay anchored so titles that
 * merely contain those letters survive.
 */
const GROUP_WORD = /(?:studio|committee|ous?group|字幕组|字幕社|汉化|压制组|工作组|raws?$|fansubs?$|subs?$)/i;

/**
 * Release-group shapes. Deliberately only shapes, never names: the group list is
 * open-ended, so blacklisting `Airota` today just means `TxxZ&POPGO&MGRT` tomorrow.
 * `&` means a group collab only when the joined parts look like handles - every
 * part single-token, or one part carrying a group word - because
 * `Panty & Stocking with Garterbelt` is the work title and all 48 of its files
 * say so. A lone `-` only counts inside a single token, otherwise real titles
 * written `作品 - Romaji` would be discarded.
 */
function isGroupChunk(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (!trimmed) return false;
  if (GROUP_WORD.test(trimmed)) return true;
  if (/[&＆]/.test(trimmed)) {
    const parts = trimmed.split(/[&＆]/).map((part) => part.trim()).filter(Boolean);
    if (parts.every((part) => !/\s/.test(part))) return true;
    // The named-prefix shape already in the list applies to each collab part, so
    // `[Nekomoe kissaten&LoliHouse]` is a group without the rule learning a name.
    if (parts.some((part) => /^(?:lolihouse|dynamis)\b/i.test(part))) return true;
  }
  if (!/\s/.test(trimmed) && /-/.test(trimmed)) return !isSceneName(trimmed);
  return /^(?:lolihouse|dynamis)\b/i.test(trimmed);
}

/** Translator/promotion credits glued to a CJK run: `加刘景长压制`, `某某校轴`. */
function isPromoToken(token: string): boolean {
  return /^[\u4e00-\u9fff]{2,12}(?:压制|翻译|校对|校轴|时间轴|轴|扫雷|发布)$/.test(token);
}

/**
 * Scene release names: `Wicked.2024.Hybrid.2160p.WEB-DL.DV.HDR.DDP5.1.H265-AOC`.
 * They contain no spaces, so the "single token with a hyphen" group shape used to
 * classify the entire string as a subtitle group and drop it - which is why the
 * Films wall stayed empty (the frontend's title-cleaning ask).
 */
function isSceneName(chunk: string): boolean {
  return !/\s/.test(chunk) && (chunk.match(/\./g) ?? []).length >= 2;
}

function junkChunk(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (!trimmed) return true;
  if (/^[0-9A-F]{6,}$/i.test(trimmed)) return true;
  if (/^(?:19|20)\d{2}$/.test(trimmed)) return true;
  if (isGroupChunk(trimmed)) return true;
  return normalizeChunk(trimmed).length === 0;
}

/**
 * A chunk with its release bookkeeping removed: `01 昭和元禄落语心中 第一季.EP01.1080p.…`
 * becomes `昭和元禄落语心中 第一季`. Dot-separated names carry no brackets at all, so
 * without this per-token filter each of the 25 files contributes a unique string,
 * and the one observation that is shared by none wins over the one shared by all.
 */
function normalizeChunk(chunk: string): string {
  let head = chunk.replace(/\.[a-z0-9]{2,5}$/i, "");
  // Scene convention: everything after the last hyphen is the release group.
  if (isSceneName(head)) head = head.replace(/-[^-.]*$/, "");
  const tokens = head.split(/[\s_./·]+/).filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens) {
    if (/^\d{1,3}$/.test(token)) continue;
    if (/^\d{1,3}v\d+[a-z]?$/i.test(token)) continue;
    if (/^(?:19|20)\d{2}$/.test(token)) continue;
    if (/^(?:ep|episode|#)\d{1,3}$/i.test(token)) continue;
    if (/^s\d{1,2}e\d{1,3}$/i.test(token)) continue;
    if (/^(?:ova|sp)\d{1,3}$/i.test(token)) continue;
    if (/^v\d+$/i.test(token)) continue;
    if (/^(?:short|drama|anime|theatrical)$/i.test(token)) continue;
    if (isPromoToken(token)) continue;
    if (isTechnicalToken(token)) continue;
    kept.push(token);
  }
  return kept.join(" ").trim();
}

/** Bracket chunks plus the text outside them; full-width brackets included. */
export function chunkList(value: string): string[] {
  const withoutExt = value.replace(/\.[a-z0-9]{2,5}$/i, "");
  const halfWidth = withoutExt
    .replace(/[［【「『]/g, "[")
    .replace(/[］」』】]/g, "]")
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")");
  const chunks: string[] = [];
  const remainder = halfWidth
    .replace(/\[([^\]]*)\]/g, (_all, inner: string) => {
      chunks.push(inner.trim());
      return " ";
    })
    .replace(/\(([^)]*)\)/g, (_all, inner: string) => {
      chunks.push(inner.trim());
      return " ";
    });
  const outside = remainder.replace(/\s+/g, " ").trim();
  if (outside) chunks.push(outside);
  return chunks.filter(Boolean);
}

/**
 * Title candidates for one path segment or file name, best first. The work title
 * is the chunk shared by most files of the group - the directory may hold nothing
 * but an episode name (`.../爆炸/` whose files all read
 * `[DBD-Raws][Panty & Stocking with Garterbelt][Explosion][01]...`), and the first
 * bracket is the subtitle group, not the title.
 */
export type TitleCandidate = { query: string; authoritative: boolean };

/**
 * Same guesses as `titleCandidates`, but keeping whether a guess is a title or a
 * lone file's episode name. `authoritative` means the string is either what most
 * files of the group agree on, or spelled in the directory; a guess only one file
 * carries (`荒原` from `S03E01 荒原.mp4`) is an episode title, and an episode title
 * must never auto-confirm a card - that is how 克拉克森的农场's season folder got
 * bound to a different show called 荒原.
 */
export function titleCandidateDetails(names: string[], segmentName = "", limit = 3): TitleCandidate[] {
  const observations = names.map((name) => chunkList(name)).filter((chunks) => chunks.length > 0);
  const dirChunks = chunkList(segmentName);
  if (dirChunks.length > 0) observations.push(dirChunks); // the directory is one more sample
  if (observations.length === 0) return [];
  const total = observations.length;
  const frequency = new Map<string, { query: string; count: number; firstIndex: number }>();
  for (const chunks of observations) {
    const seenInFile = new Set<string>();
    chunks.forEach((chunk, chunkIndex) => {
      if (junkChunk(chunk)) return;
      const query = normalizeChunk(chunk);
      if (query.length < 2 || seenInFile.has(query)) return;
      seenInFile.add(query);
      const entry = frequency.get(query) ?? { query, count: 0, firstIndex: chunkIndex };
      entry.count += 1;
      entry.firstIndex = Math.min(entry.firstIndex, chunkIndex);
      frequency.set(query, entry);
    });
  }
  const dirTitles = new Set(dirChunks.map((chunk) => normalizeChunk(chunk)));
  // The title is what the files agree on. Chunks only one file carries
  // (`FLCL 03 Marquis de Carabas`, `Cast Commentary 01`) are episode names, and
  // they used to outrank the shared work title for lack of any threshold. A
  // trailing ` - 01` is not an episode name though - it is the work title with a
  // part marker, and normalizeChunk has already removed the marker.
  const shared = [...frequency.values()].filter((entry) => entry.count / total >= 0.5);
  const pool = shared.length > 0 ? shared : [...frequency.values()];
  const ranked = pool
    .map((entry) => {
      let rank = entry.count / total;
      if (dirTitles.has(entry.query)) rank += 0.25; // also spelled in the directory
      if (entry.firstIndex === 0) rank -= 0.35; // leading chunk is usually the group
      if (/[㐀-䶿一-鿿぀-ヿ]/.test(entry.query)) rank += 0.05;
      // Single-file groups have no frequency to separate a title from a bracketed
      // subtitle (`（⁕不是不可能？）`) sitting inside it; the longer observation is
      // the one that names the work.
      rank += Math.min(entry.query.length, 24) / 100;
      return {
        query: entry.query,
        authoritative: entry.count / total >= 0.5 || dirTitles.has(entry.query),
        firstIndex: entry.firstIndex,
        rank,
      };
    })
    .sort((left, right) => right.rank - left.rank || left.firstIndex - right.firstIndex)
    .slice(0, limit);
  return ranked.map(({ query, authoritative }) => ({ query, authoritative }));
}

export function titleCandidates(names: string[], segmentName = "", limit = 3): string[] {
  return titleCandidateDetails(names, segmentName, limit).map((candidate) => candidate.query);
}

function isExtraDirectory(name: string): boolean {
  return /^(?:pv|pvs|ncop(?:\s*[&＆+]\s*nced)?|nced|menu|menus|extras?|bonus(?:es)?|scans|booklet|特典映像|特典|特别篇|特別篇|映像特典)$/i.test(name.trim());
}

/**
 * Directories that hold regular episodes but are not named after the work:
 * `SPs` (plural escaped the old `^sp$`), `OVA01`, `第2季`-style and episode-name
 * folders. Their files roll up into the nearest work-level ancestor instead of
 * being dropped - dropping them would remove real episodes from the poster wall.
 */
/**
 * Bonus folders rather than episodes: `SPs` (plural escaped the old `^sp$`),
 * `OVA01`, `CD1`, `DISC2`. Their files roll into the work card and are skipped by
 * the 「N 集」 count, because `CM01`/`Audio Drama 01.3`/`Akeome Mini Movie` clips
 * are not episodes.
 */
function isBonusDirectory(name: string): boolean {
  return /^(?:sps?|specials?|ovas?(?:\s*\d+)?|sp\s*\d+|cd\d+|dis[ck]\d*)$/i.test(name.trim());
}

/**
 * Folders whose files belong to the work card above them. `第N话`-style folders
 * roll up too, but their files stay counted as episodes.
 */
function isRollupDirectory(name: string): boolean {
  return isBonusDirectory(name) || /^第.{1,4}[话話期季]$/.test(name.trim());
}

/**
 * The directory a group of files belongs to as one work. Season folders and
 * special/OVA subfolders roll into their parent so a show is one catalog item
 * with its specials included, rather than a second item nobody confirms.
 */
function workKeyOf(dir: string, seasonFolder: boolean): string {
  let key = dir;
  if (key === "/") return key;
  if (seasonFolder) key = parentOf(key);
  let guard = 0;
  while (key !== "/" && guard < 4 && isRollupDirectory(path.posix.basename(key))) {
    key = parentOf(key);
    guard += 1;
  }
  return key;
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, " ")
    .replace(/\b(?:the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
