import type { Express, Request, Response } from "express";
import { OpenlistServiceError } from "../../media/openlist.ts";
import { MetadataUnavailable } from "../../media/catalog-metadata.ts";
import { LibraryRequestError, type LibraryService } from "../../media/library-service.ts";
import { sendError, requestIp, requireRoomAccess, requireMediaRead, GUEST_SESSION_PATH } from "./shared.ts";
import type { RoomRegistry } from "../room/registry.ts";
import type { GuestAccessStore } from "../guest-access.ts";

/**
 * Media-library routes. Registered before the legacy core routes so
 * `libraryId` is claimed here. `root=Anime|Film|TV Shows` is left for the
 * existing v1 browser so the shipped web picker keeps its response shape.
 * Readiness is not registered here and must keep using the original media object.
 */
export function registerLibraryHttp(
  app: Express,
  library: LibraryService,
  registry: RoomRegistry,
  guests: GuestAccessStore,
): void {
  const requireRoom = (req: Request, res: Response): boolean => {
    return requireRoomAccess(req, res, registry);
  };
  // 只读浏览：房内房间凭据或有效游客凭据都可以；写路由与播放路由仍只认房间。
  const requireRead = (req: Request, res: Response): boolean => {
    return requireMediaRead(req, res, registry, guests);
  };
  app.use(["/api/admin/media-sources", "/api/admin/media-libraries", "/api/admin/media-catalog"], (req, res, next) => {
    if (requireAdmin(library, req, res)) next();
  });
  app.use("/api/media/catalog", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || requireAdmin(library, req, res)) next();
  });
  app.get("/api/media/capabilities", (req, res) => {
    res.json(library.capabilities(library.allowsAdmin(requestIp(req), headerValue(req, "x-watchparty-admin"))));
  });

  // 游客凭据签发：一次性短时效、只读、不绑定房间。无 body（客户端契约如此）。
  // 限速按 IP，避免这里变成匿名枚举媒体库的固定入口。
  app.post(GUEST_SESSION_PATH, (req, res) => {
    const issued = guests.issue(requestIp(req));
    if (!issued) {
      sendError(res, 429, "GUEST_RATE_LIMITED");
      return;
    }
    res.json(issued);
  });

  app.get("/api/media/artwork/:mediaId", async (req, res) => {
    if (!requireRead(req, res)) return;
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

  app.get("/api/media/libraries", async (req, res) => {
    if (!requireRead(req, res)) return;
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
    if (!requireRead(req, res)) return;
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
    if (!requireRead(req, res)) return;
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
    res.json({ sources: library.adminList() });
  });

  app.post("/api/admin/media-sources", async (req, res) => {
    try {
      res.status(201).json(await library.adminCreate(req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.patch("/api/admin/media-sources/:id", async (req, res) => {
    try {
      res.json(await library.adminUpdate(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.delete("/api/admin/media-sources/:id", (req, res) => {
    if (!library.adminDelete(paramId(req))) {
      sendError(res, 404, "MEDIA_NOT_FOUND");
      return;
    }
    res.status(204).end();
  });

  app.get(["/api/media/catalog", "/api/admin/media-catalog"], (req, res) => {
    if (!req.path.startsWith("/api/admin/") && !requireRead(req, res)) return;
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

  app.get(["/api/media/catalog/:id", "/api/admin/media-catalog/:id"], async (req, res) => {
    if (!req.path.startsWith("/api/admin/") && !requireRead(req, res)) return;
    try {
      res.json(await library.catalogDetail(paramId(req), req.query.episodeTitles !== "0"));
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
    if (!requireRoom(req, res)) return;
    try {
      res.json({ items: await library.vendorSearch({ q: req.query.q }) });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/media/posters/:id", (req, res) => {
    if (!requireRead(req, res)) return;
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
    try {
      res.json(await library.adminScrape(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/admin/media-libraries/:id/scrape", (req, res) => {
    try {
      res.json(library.adminScrapeStatus(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 枚举/分类是"冷态 30–46 秒"的管理动作：8 秒宽限期内跑完就照旧 200 + 完整结果，
  // 没跑完就 202 {status:"accepted", running:true}，调用方去轮询对应的 GET（都在白名单里，
  // 不新增路由 ⇒ 桌面侧零管道成本）。绝不对这两条做 POST 重试 —— 那只会多走一遍网盘。
  app.post("/api/admin/media-libraries/:id/scan", async (req, res) => {
    try {
      const outcome = await library.catalogRefreshScan(paramId(req));
      res.status(outcome.status === "done" ? 200 : 202).json(outcome);
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.get("/api/admin/media-libraries/:id/scan", (req, res) => {
    try {
      res.json({ libraryId: paramId(req), ...library.catalogScan(paramId(req)) });
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // Classification is deliberately separate from the scrape: it lands in the draft
  // table and reports what applying it would change, without touching a single card.
  app.post("/api/admin/media-libraries/:id/classify", async (req, res) => {
    try {
      const outcome = await library.catalogClassify(paramId(req));
      res.status(outcome.status === "done" ? 200 : 202).json(outcome);
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 列表投影（不含 children）；?item=<草稿 itemKey> 时只回那一张的文件列表。
  app.get("/api/admin/media-libraries/:id/classify", (req, res) => {
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
    const force = /^(1|true|yes)$/i.test(queryString(req.query.force) ?? "");
    try {
      res.json(await library.catalogApply(paramId(req), force));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 人工批准当前草稿的结构变更：签发一次性明文凭证（48h），数据库只留哈希。
  app.post("/api/admin/media-libraries/:id/approval", (req, res) => {
    try {
      res.json(library.catalogApprove(paramId(req), req.body, headerValue(req, "x-watchparty-approval")));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.post("/api/admin/media-libraries/:id/approval/revoke", (req, res) => {
    try {
      res.json(library.catalogRevoke(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 带凭证的那条应用路径：`/apply` 只会做元数据，结构变更到这里才放行。
  app.post("/api/admin/media-libraries/:id/apply-approved", async (req, res) => {
    try {
      res.json(await library.catalogApplyApproved(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 回滚台账（只读）：Agent 与界面都从这里知道"哪一次应用还能撤"。不含 token 也不含哈希。
  app.get("/api/admin/media-libraries/:id/approvals", (req, res) => {
    try {
      res.json(library.catalogApprovals(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 疑似同作（OVA/季度/SP）：只报证据与建议，服务端一行都不改，也不自动合并。
  app.get("/api/admin/media-libraries/:id/duplicates", (req, res) => {
    try {
      res.json(library.catalogDuplicates(paramId(req)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 回滚 = 带并发检查的反向 patch：先由人批准这一次撤回（/approval {rollbackOf}），
  // 再带凭证执行。当前值与当时写入的不一致就整批不动，只报冲突 keys。
  app.post("/api/admin/media-libraries/:id/rollback", async (req, res) => {
    try {
      res.json(await library.catalogRollback(paramId(req), req.body));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  // 草稿编辑动作同一种形状（只写草稿、返回新摘要），所以表驱动注册。
  const draftEdits: Array<{ action: string; run: (id: string, body: unknown) => unknown }> = [
    { action: "exclude", run: (id, body) => library.draftExclude(id, body) },
    { action: "unexclude", run: (id, body) => library.draftUnexclude(id, body) },
    { action: "edit", run: (id, body) => library.draftEdit(id, body) },
    { action: "confirm", run: (id, body) => library.draftConfirm(id, body) },
    { action: "unconfirm", run: (id, body) => library.draftUnconfirm(id, body) },
    { action: "merge", run: (id, body) => library.draftMerge(id, body) },
    { action: "split", run: (id, body) => library.draftSplit(id, body) },
    { action: "keep-binding", run: (id, body) => library.draftKeepBinding(id, body) },
  ];
  app.get("/api/admin/media-libraries/:id/exclusions", (req, res) => {
    try { res.json(library.catalogExclusions(paramId(req))); }
    catch (error) { sendFailure(res, error); }
  });
  for (const { action, run } of draftEdits) {
    app.post(`/api/admin/media-libraries/:id/draft/${action}`, (req, res) => {
      try {
        res.json(run(paramId(req), req.body));
      } catch (error) {
        sendFailure(res, error);
      }
    });
  }

  // sidecar 导入：草稿是唯一真相源，所以这里只有"写草稿"的口子。export 把当前草稿落成
  // `.watchparty.collection.json`（服务端本地根目录，绝不回写网盘）；preview 读回来按文件
  // 集合对账；structure 把结构提案也落进草稿。正式卡仍然只有 apply 能动。
  const imports: Array<{ action: string; run: (id: string, body: unknown) => unknown }> = [
    { action: "offline-export", run: (id, body) => library.offlineExport(id, body) },
    { action: "offline-check", run: (id, body) => library.offlineCheck(id, body) },
    { action: "offline-stage", run: (id, body) => library.offlineStage(id, body) },
    { action: "export", run: (id) => library.importExport(id) },
    { action: "preview", run: (id) => library.importPreview(id) },
    { action: "structure", run: (id, body) => library.importStructure(id, body) },
  ];
  for (const { action, run } of imports) {
    app.post(`/api/admin/media-libraries/:id/import/${action}`, (req, res) => {
      try {
        res.json(run(paramId(req), req.body));
      } catch (error) {
        sendFailure(res, error);
      }
    });
  }

  // One call for the whole local loop: classify what is missing, judge what is not
  // yet judged, and stop at the draft. `?max=` caps this run's lookups.
  app.post("/api/admin/media-libraries/:id/prepare", async (req, res) => {
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
  if (error instanceof Error && /^OFFLINE_[A-Z_]+$/.test(error.message)) {
    res.status(409).json({ code: error.message });
    return;
  }
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
