export type RangeMetrics = {
  requests: number;
  bytes: number;
  coveredBytes: number;
  size: number;
  fullBodyRejected: boolean;
};

export type RangeRequest = { pos: number; length: number };

type ProbeResult = { ok: true; status: number; size: number; reason: string } | { ok: false; status: number; size: number; reason: string };

/** Fetches exact byte ranges for the Matroska parser without retaining a file URL. */
export class RangeFile {
  readonly metrics: RangeMetrics = { requests: 0, bytes: 0, coveredBytes: 0, size: 0, fullBodyRejected: false };
  private url: string;
  private readonly report: (metrics: RangeMetrics) => void;
  private etag: string | null = null;
  private readonly ranges: Array<[number, number]> = [];
  readonly requests: RangeRequest[] = [];
  private refreshSignedUrl?: () => Promise<string>;

  constructor(url: string, report: (metrics: RangeMetrics) => void, refreshSignedUrl?: () => Promise<string>) {
    this.url = url;
    this.report = report;
    this.refreshSignedUrl = refreshSignedUrl;
  }

  setRefreshSignedUrl(refresh: () => Promise<string>) {
    this.refreshSignedUrl = refresh;
  }

  refreshUrl(url: string) {
    this.url = url;
  }

  get size() {
    return this.metrics.size;
  }

  async probe(): Promise<ProbeResult> {
    let response: Response | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetch(this.url, { headers: { Range: "bytes=0-65535" }, cache: "no-store", referrerPolicy: "no-referrer" });
        this.metrics.requests += 1;
        if (response.status === 403 && attempt === 0 && this.refreshSignedUrl) {
          await response.body?.cancel();
          this.url = await this.refreshSignedUrl();
          continue;
        }
        break;
      }
    } catch (error) {
      return { ok: false, status: 0, size: 0, reason: error instanceof Error ? `CORS / 網路錯誤：${error.message}` : "CORS / 網路錯誤" };
    }
    if (!response) return { ok: false, status: 0, size: 0, reason: "Range probe did not return a response" };
    this.etag = response.headers.get("ETag");
    const size = parseSize(response.headers.get("Content-Range"));
    this.metrics.size = size;
    if (response.status !== 206) {
      this.metrics.fullBodyRejected = response.status === 200;
      await response.body?.cancel();
      this.report(this.metrics);
      return { ok: false, status: response.status, size, reason: response.status === 200 ? "伺服器忽略 Range 並回 200；已取消回應本文，拒絕完整下載" : `Range 回應狀態 ${response.status}，需要 206` };
    }
    const contentRange = response.headers.get("Content-Range");
    if (!contentRange || !/^bytes\s+0-\d+\/\d+$/i.test(contentRange)) {
      await response.body?.cancel();
      return { ok: false, status: response.status, size, reason: "Content-Range 缺失或格式不可讀；請檢查 CORS expose headers" };
    }
    if (!response.headers.get("Accept-Ranges")?.toLowerCase().includes("bytes")) {
      eventNote("Accept-Ranges 未暴露；206 成功但標頭證據不足。", "warn");
    }
    const exposedRange = response.headers.get("Access-Control-Expose-Headers");
    const exposed = exposedRange?.toLowerCase() ?? "";
    if (exposed && !exposed.includes("content-range") && exposed !== "*") {
      await response.body?.cancel();
      return { ok: false, status: response.status, size, reason: "Content-Range 未列入 Access-Control-Expose-Headers" };
    }
    const bytes = await response.arrayBuffer();
    this.metrics.bytes += bytes.byteLength;
    this.addCoverage(0, bytes.byteLength);
    this.report(this.metrics);
    return { ok: true, status: response.status, size, reason: "206 Range" };
  }

  slice(start: number, end: number) {
    return { arrayBuffer: () => this.read(start, end) };
  }

  async read(start: number, end: number) {
    const from = Math.max(0, Math.floor(start));
    const to = Math.max(from, Math.floor(end) - 1);
    this.requests.push({ pos: from, length: to - from + 1 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = new Headers({ Range: `bytes=${from}-${to}` });
      if (this.etag) headers.set("If-Range", this.etag);
      const response = await fetch(this.url, { headers, cache: "no-store", referrerPolicy: "no-referrer" });
      this.metrics.requests += 1;
      if (response.status === 403 && attempt === 0 && this.refreshSignedUrl) {
        await response.body?.cancel();
        this.url = await this.refreshSignedUrl();
        continue;
      }
      if (response.status !== 206) {
        this.metrics.fullBodyRejected = response.status === 200;
        await response.body?.cancel();
        this.report(this.metrics);
        throw new Error(response.status === 200 ? "seek 時源站忽略 Range，完整回應已取消" : `seek Range 回應 ${response.status}`);
      }
      const contentRange = response.headers.get("Content-Range");
      if (!contentRange || !rangeMatches(contentRange, from, to)) {
        await response.body?.cancel();
        throw new Error(`seek Content-Range 不匹配 bytes=${from}-${to}`);
      }
      const body = await response.arrayBuffer();
      this.metrics.bytes += body.byteLength;
      this.addCoverage(from, from + body.byteLength);
      this.report(this.metrics);
      return body;
    }
    throw new Error("签名 URL 刷新后 Range 请求仍失败");
  }

  private addCoverage(start: number, end: number) {
    this.ranges.push([start, end]);
    this.ranges.sort((left, right) => left[0] - right[0]);
    let covered = 0;
    let currentStart = -1;
    let currentEnd = -1;
    for (const [rangeStart, rangeEnd] of this.ranges) {
      if (rangeStart > currentEnd) {
        if (currentStart >= 0) covered += currentEnd - currentStart;
        currentStart = rangeStart;
        currentEnd = rangeEnd;
      } else {
        currentEnd = Math.max(currentEnd, rangeEnd);
      }
    }
    if (currentStart >= 0) covered += currentEnd - currentStart;
    this.metrics.coveredBytes = covered;
    this.report(this.metrics);
  }
}

function parseSize(value: string | null) {
  const match = value?.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function rangeMatches(value: string, start: number, end: number) {
  const match = value.match(/^bytes\s+(\d+)-(\d+)\//i);
  return Boolean(match && Number(match[1]) === start && Number(match[2]) === end);
}

function eventNote(message: string, tone: "warn") {
  document.dispatchEvent(new CustomEvent("poc-event", { detail: { message, tone } }));
}
