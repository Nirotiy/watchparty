import type { Express, Request, Response } from "express";
import { OpenlistServiceError } from "../../media/openlist.ts";
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
    res.status(error.status).json({ code: error.code, error: error.code, message: error.code });
    return;
  }
  if (error instanceof OpenlistServiceError) {
    sendError(res, 502, "OPENLIST_UNAVAILABLE", error.message);
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
