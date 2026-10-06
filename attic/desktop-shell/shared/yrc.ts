export interface YrcSegment {
  start: number
  end: number
  text: string
}

export interface YrcLine {
  start: number
  end: number
  text: string
  segments: YrcSegment[]
}

const LINE_HEADER = /^\[(\d+),(\d+)\]/
// NetEase frequently serves ytlrc/yromalrc as plain colon-timestamp LRC rows
// (e.g. "[00:03.580]译文") instead of segment YRC; accept them as whole-line
// entries so time-window pairing still works.
const LRC_HEADER = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/
const SEGMENT_MARKER = /\((\d+),(\d+),(\d+)\)/g

/**
 * YRC (`/lyric/new`) interleaves one `[lineStart,lineDuration]` header per row with
 * per-word `(start,duration,0)` markers. A duration of 0 marks punctuation and
 * spacing: the text is kept so words never glue together, and the renderer treats
 * it as part of the preceding word's window.
 */
export function parseYrc(raw?: string | null): YrcLine[] {
  if (!raw) return []
  const lines: YrcLine[] = []
  for (const row of raw.split(/\r?\n/)) {
    const trimmed = row.trim()
    // The word route rewrites credit metadata as JSON rows; they carry no timing.
    if (!trimmed || trimmed.startsWith("{")) continue
    const lineHeader = LINE_HEADER.exec(trimmed)
    let start = Number.NaN
    let end = Number.NaN
    let bodyStart = 0
    if (lineHeader) {
      start = Number(lineHeader[1])
      end = start + Number(lineHeader[2])
      bodyStart = lineHeader[0].length
    } else {
      const lrcHeader = LRC_HEADER.exec(trimmed)
      if (!lrcHeader) continue
      start = Number(lrcHeader[1]) * 60000 + Number(lrcHeader[2]) * 1000 + Number((lrcHeader[3] ?? "0").padEnd(3, "0"))
      end = start
      bodyStart = lrcHeader[0].length
    }
    const rest = trimmed.slice(bodyStart)
    const markers: Array<{ index: number; length: number; start: number; duration: number }> = []
    SEGMENT_MARKER.lastIndex = 0
    let hit: RegExpExecArray | null
    while ((hit = SEGMENT_MARKER.exec(rest)) !== null) {
      markers.push({ index: hit.index, length: hit[0].length, start: Number(hit[1]), duration: Number(hit[2]) })
    }
    const segments: YrcSegment[] = []
    if (markers.length) {
      for (let i = 0; i < markers.length; i += 1) {
        const marker = markers[i]
        const next = markers[i + 1]
        const text = rest.slice(marker.index + marker.length, next ? next.index : rest.length)
        if (!text) continue
        segments.push({ start: marker.start, end: marker.start + marker.duration, text })
      }
    } else if (rest) {
      segments.push({ start, end, text: rest })
    }
    const text = segments.map(segment => segment.text).join("").trim()
    if (!text || !Number.isFinite(start)) continue
    lines.push({ start, end, text, segments })
  }
  return lines.sort((left, right) => left.start - right.start)
}

function ownerIndex(lines: YrcLine[], start: number, end: number): number {
  const middle = (start + end) / 2
  let fallback = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const ownerEnd = Math.max(line.end, line.start + 1)
    if (start >= line.start && start < ownerEnd) return i
    if (line.start <= middle) fallback = i
  }
  return fallback >= 0 ? fallback : lines.length ? 0 : -1
}

/**
 * Measured live 2026-09-22: the word translation/romanization tracks do not align
 * with the word track by line count (Cruel Summer 65 vs 60), so the extra track is
 * paired by time window, never by index.
 */
export function pairByTime(main: YrcLine[], extra: YrcLine[]): string[] {
  const buckets: string[][] = main.map(() => [])
  for (const line of extra) {
    const index = ownerIndex(main, line.start, line.end)
    if (index >= 0) buckets[index].push(line.text)
  }
  return buckets.map(bucket => bucket.join(" "))
}
