import type { Express, Request, Response } from "express";
import { OpenlistServiceError } from "../../media/openlist.ts";
import { MetadataUnavailable } from "../../media/catalog-metadata.ts";
import { LibraryRequestError, type LibraryService } from "../../media/library-service.ts";
import { sendError, requestIp } from "./shared.ts";

/**
 * Media-library routes. Registered before the legacy core routes so
 * `libraryId` is claimed here. `root=Anime|Film|TV Shows` is left for the
 * existing v1 browser so the shipped web picker keeps its response shape.
 * Readiness is not registered here and must keep using the original media object.
 */
export function registerLibraryHttp(app: Express, library: LibraryService): void {
  app.get("/api/media/capabilities", (req, res) => {
    res.json(library.capabilities(library.allowsAdmin(requestIp(req), headerValue(req, "x-watchparty-admin"))));
  });

  app.get("/api/media/artwork/:mediaId", async (req, res) => {
    try {
      const image = await library.loadArtwork(paramId(req));
      if (!image) {
        sendError(res, 404, "MEDIA_NOT_FOUND");
        return;
      }
      res.setHeader("content-type", image.contentType);
      res.setHeader("cache-control", "private, max-age=300");
      res.setHeader("x-content-type-options", "nosniff");
      res.status(200).end(image.bytes);
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/media/libraries", async (_req, res) => {
    try {
      res.json({ libraries: await library.libraries() });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/media/list", async (req, res, next) => {
    const libraryId = queryString(req.query.libraryId);
    if (!libraryId) {
      next();
      return;
    }
    try {
      res.json(await library.list(libraryId, queryString(req.query.path) ?? "/", queryString(req.query.cursor)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/media/search", async (req, res, next) => {
    const libraryId = queryString(req.query.libraryId);
    if (!libraryId) {
      next();
      return;
    }
    try {
      const query = queryString(req.query.q);
      if (!query) {
        sendError(res, 400, "INVALID_REQUEST");
        return;
      }
      res.json(await library.search(libraryId, query, queryString(req.query.cursor)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/admin/media-sources", (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    res.json({ sources: library.adminList() });
  });

  app.post("/api/admin/media-sources", async (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    try {
      res.status(201).json(await library.adminCreate(req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.patch("/api/admin/media-sources/:id", async (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    try {
      res.json(await library.adminUpdate(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.delete("/api/admin/media-sources/:id", (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    if (!library.adminDelete(paramId(req))) {
      sendError(res, 404, "MEDIA_NOT_FOUND");
      return;
    }
    res.status(204).end();
  });

  app.get("/api/media/catalog", (req, res) => {
    const libraryId = queryString(req.query.libraryId);
    if (!libraryId) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      res.json(library.catalogList(libraryId, queryString(req.query.cursor), queryString(req.query.q)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/media/catalog/:id", (req, res) => {
    try {
      res.json(library.catalogDetail(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.post("/api/media/catalog/:id/confirm", async (req, res) => {
    try {
      res.json(await library.catalogConfirm(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.post("/api/media/catalog/:id/reject", (req, res) => {
    try {
      res.json(library.catalogReject(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.post("/api/media/catalog/:id/unconfirm", (req, res) => {
    try {
      res.json(library.catalogUnconfirm(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.post("/api/media/catalog/:id/rebind", async (req, res) => {
    try {
      res.json(await library.catalogRebind(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.post("/api/media/catalog/merge", (req, res) => {
    try {
      res.json(library.catalogMerge(req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.post("/api/media/catalog/:id/split", (req, res) => {
    try {
      res.json(library.catalogSplit(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // Manual re-binding needs a way to look the subject up first; the scrape only
  // ever shows what it guessed. Read-only, one vendor round trip.
  app.get("/api/media/bangumi/search", async (req, res) => {
    try {
      res.json({ items: await library.vendorSearch({ q: req.query.q }) });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/media/posters/:id", (req, res) => {
    const image = library.catalogPoster(paramId(req));
    if (!image) {
      sendError(res, 404, "MEDIA_NOT_FOUND");
      return;
    }
    res.setHeader("content-type", image.contentType);
    res.setHeader("cache-control", "private, max-age=86400");
    res.setHeader("x-content-type-options", "nosniff");
    res.status(200).end(image.bytes);
  });

  app.post("/api/admin/media-libraries/:id/scrape", async (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    try {
      res.json(await library.adminScrape(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/admin/media-libraries/:id/scrape", (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    try {
      res.json(library.adminScrapeStatus(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.post("/api/admin/media-libraries/:id/scan", async (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    try {
      res.json({ libraryId: paramId(req), ...(await library.catalogRefreshScan(paramId(req))) });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/admin/media-libraries/:id/scan", (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    try {
      res.json({ libraryId: paramId(req), ...library.catalogScan(paramId(req)) });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // Classification is deliberately separate from the scrape: it lands in the draft
  // table and reports what applying it would change, without touching a single card.
  app.post("/api/admin/media-libraries/:id/classify", async (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    try {
      res.json(await library.catalogClassify(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 列表投影（不含 children）；?item=<草稿 itemKey> 时只回那一张的文件列表。
  app.get("/api/admin/media-libraries/:id/classify", (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    const id = paramId(req);
    const item = queryString(req.query.item);
    try {
      res.json(item === undefined ? library.catalogDraft(id) : library.catalogDraftCard(id, item));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // Judging is the network half of the local loop: it fills the draft's candidates
  // and bindings, and still writes no card. `?max=` caps the subjects because
  // Bangumi rate-limits anonymous callers.
  app.post("/api/admin/media-libraries/:id/judge", async (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    const max = parseMax(req);
    if (max === null) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      res.json(await library.catalogJudge(paramId(req), max));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // The only step that lets a locally prepared draft touch the wall.
  app.post("/api/admin/media-libraries/:id/apply", async (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    const force = /^(1|true|yes)$/i.test(queryString(req.query.force) ?? "");
    try {
      res.json(await library.catalogApply(paramId(req), force));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // One call for the whole local loop: classify what is missing, judge what is not
  // yet judged, and stop at the draft. `?max=` caps this run's lookups.
  app.post("/api/admin/media-libraries/:id/prepare", async (req, res) => {
    if (!requireAdmin(library, req, res)) return;
    const max = parseMax(req);
    if (max === null) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    try {
      res.json(await library.catalogPrepare(paramId(req), max));
    } catch (error) {
      sendFailure(res, error);
    }
  });
}

/** `?max=N`：判定是同步批量请求，一轮上限 20 张（条目站匿名限速下的合理批量）。 */
const JUDGE_MAX = 20;

function parseMax(req: Request): number | undefined | null {
  const raw = queryString(req.query.max);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > JUDGE_MAX) return null;
  return value;
}

function requireAdmin(library: LibraryService, req: Request, res: Response): boolean {
  if (library.allowsAdmin(requestIp(req), headerValue(req, "x-watchparty-admin"))) return true;
  res.status(403).json({ code: "ADMIN_FORBIDDEN", error: "ADMIN_FORBIDDEN", message: "ADMIN_FORBIDDEN" });
  return false;
}

function sendFailure(res: Response, error: unknown): void {
  if (error instanceof LibraryRequestError) {
    if (error.code === "MEDIA_NOT_FOUND" || error.code === "INVALID_REQUEST" || error.code === "OPENLIST_UNAVAILABLE") {
      sendError(res, error.status, error.code);
      return;
    }
    res.status(error.status).json({ code: error.code, error: error.code, message: error.code, ...(error.detail ?? {}) });
    return;
  }
  if (error instanceof OpenlistServiceError) {
    sendError(res, 502, "OPENLIST_UNAVAILABLE", error.message);
    return;
  }
  // 判定要打的条目站挂了/没代理：说清楚是它，而不是一个 500。
  if (error instanceof MetadataUnavailable) {
    res.status(503).json({ code: "CATALOG_UNAVAILABLE", error: "CATALOG_UNAVAILABLE", message: "条目检索暂不可用（检查网络或代理）" });
    return;
  }
  if (error instanceof Error && (error.message === "Invalid media path" || error.message === "Invalid cursor")) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  res.status(500).json({ code: "INTERNAL", error: "INTERNAL", message: "INTERNAL" });
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

function paramId(req: Request): string {
  const id = req.params.id ?? req.params.mediaId;
  return typeof id === "string" ? id : "";
}
