/** Validates exact 206 responses; signed URLs and room tokens never enter diagnostics. */
export class RangeFile {
  size = 0;
  bytesRead = 0;
  private etag: string | null = null;
  private refresh: Promise<string> | null = null;
  private urlVersion = 0;

  constructor(
    private url: string,
    private readonly signal: AbortSignal,
    private readonly refreshSignedUrl?: () => Promise<string>,
  ) {}

  async probe() {
    await this.request(0, 65536, true);
  }

  read(start: number, end: number) {
    return this.request(start, end, false);
  }

  private async request(start: number, end: number, probing: boolean): Promise<ArrayBuffer> {
    const from = Math.max(0, Math.floor(start));
    const to = Math.floor(end) - 1;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.signal.throwIfAborted();
      const version = this.urlVersion;
      const headers = new Headers({ Range: `bytes=${from}-${to}` });
      if (this.etag) headers.set("If-Range", this.etag);
      const response = await fetch(this.url, {
        headers, signal: this.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
      });
      if ((response.status === 403 || response.status === 410) && attempt === 0 && this.refreshSignedUrl) {
        await response.body?.cancel();
        // Concurrent prefetch failures share one renewal for the old URL.
        if (version === this.urlVersion) {
          this.refresh ??= this.refreshSignedUrl().then((url) => {
            this.url = url;
            this.urlVersion += 1;
            return url;
          }).finally(() => { this.refresh = null; });
          await this.refresh;
        }
        continue;
      }
      if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(response.status === 200
          ? "媒体服务器忽略 Range，已取消完整下载"
          : `媒体 Range 请求失败 (${response.status})`);
      }
      const match = response.headers.get("Content-Range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
      const total = match ? Number(match[3]) : 0;
      const expectedEnd = probing ? Math.min(to, total - 1) : to;
      const nextEtag = response.headers.get("ETag");
      if (!match || !Number.isSafeInteger(total) || total <= 0
        || Number(match[1]) !== from || Number(match[2]) !== expectedEnd
        || expectedEnd >= total || (this.size > 0 && total !== this.size)
        || (this.etag && nextEtag && this.etag !== nextEtag)) {
        await response.body?.cancel();
        throw new Error("媒体 Content-Range 不匹配或文件已变化，请检查 CORS 暴露头");
      }
      this.size = total;
      this.etag ??= nextEtag;
      const body = await response.arrayBuffer();
      if (body.byteLength !== expectedEnd - from + 1) throw new Error("媒体 Range 正文长度不匹配");
      this.bytesRead += body.byteLength;
      return body;
    }
    throw new Error("媒体签名续期后仍无法读取");
  }
}
