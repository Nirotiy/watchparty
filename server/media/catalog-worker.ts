import { groupScanFiles, yearFrom, type ScanFile } from "./catalog-names.ts";
import { chooseMatch, MetadataUnavailable, rankHits, type MetadataSearcher } from "./catalog-metadata.ts";
import type { CatalogStore, PendingItem, ScrapeJob } from "./catalog-store.ts";
import type { StoredLibrary } from "./library-store.ts";

export function createCatalogWorker(options: {
  catalog: CatalogStore;
  bangumi: MetadataSearcher;
  tmdb: MetadataSearcher;
  fetchPoster: (url: string) => Promise<{ contentType: string; bytes: Buffer } | undefined>;
  listFiles: (library: StoredLibrary) => Promise<ScanFile[]>;
  getLibrary: (id: string) => StoredLibrary | undefined;
  delayMs: number;
  maxLookupsPerRun?: number;
  inline: boolean;
}): {
  start(libraryId: string): Promise<ScrapeJob | undefined>;
  continue(libraryId: string): Promise<ScrapeJob | undefined>;
  resumeIncomplete(): void;
  cachePoster(itemId: string, imageUrl: string): Promise<void>;
} {
  const inflight = new Map<string, Promise<void>>();

  function enqueue(libraryId: string, reset: boolean): Promise<void> {
    const previous = inflight.get(libraryId) ?? Promise.resolve();
    const next = previous.then(
      () => run(libraryId, reset),
      () => run(libraryId, reset),
    );
    inflight.set(libraryId, next);
    return next;
  }

  async function run(libraryId: string, reset: boolean): Promise<void> {
    const library = options.getLibrary(libraryId);
    if (!library) {
      options.catalog.failJob(libraryId, "MEDIA_NOT_FOUND");
      return;
    }
    options.catalog.markRunning(libraryId, reset);
    try {
      const job = options.catalog.getJob(libraryId);
      if (reset || !job?.enumerated) {
        const files = library.kind === "other" ? [] : await options.listFiles(library);
        const groups = groupScanFiles(files).filter((group) => group.query);
        options.catalog.upsertScan(libraryId, library.kind, groups);
      }
      const pending = options.catalog.listPending(libraryId);
      let looked = 0;
      for (const item of pending) {
        if (options.maxLookupsPerRun !== undefined && looked >= options.maxLookupsPerRun) return;
        await lookup(item);
        looked += 1;
        if (options.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      options.catalog.finishJob(libraryId);
    } catch (error) {
      options.catalog.failJob(libraryId, error instanceof MetadataUnavailable ? "CATALOG_UNAVAILABLE" : "OPENLIST_UNAVAILABLE");
    }
  }

  async function lookup(item: PendingItem): Promise<void> {
    if (!item.query || item.kind === "other") {
      options.catalog.applyMatch(item, "unmatched", null, []);
      options.catalog.bumpJob(item.libraryId, false);
      return;
    }
    const searchKind = item.kind === "tv" ? "tv" : item.kind === "movie" ? "movie" : "anime";
    const searcher = item.kind === "anime" ? options.bangumi : options.tmdb;
    const hits = await searcher.search(item.query, searchKind);
    const rejected = options.catalog.rejectionKeys(item.libraryId, item.itemKey);
    const ranked = rankHits(item.query, hits, yearFrom(item.rawName), item.fileCount || null).filter(
      (hit) => !rejected.has(`${hit.externalDb}:${hit.externalId}`),
    );
    const choice = chooseMatch(ranked);
    options.catalog.applyMatch(item, choice.status, choice.chosen, choice.candidates);
    if (choice.status === "confirmed" && choice.chosen?.imageUrl) await cachePoster(item.id, choice.chosen.imageUrl);
    options.catalog.bumpJob(item.libraryId, choice.status === "confirmed");
  }

  async function cachePoster(itemId: string, imageUrl: string): Promise<void> {
    const poster = await options.fetchPoster(imageUrl);
    if (!poster) return;
    options.catalog.writePoster(itemId, poster.contentType, poster.bytes);
  }

  return {
    async start(libraryId) {
      if (!options.getLibrary(libraryId)) return undefined;
      const done = enqueue(libraryId, true);
      if (options.inline) await done;
      return options.catalog.getJob(libraryId);
    },
    async continue(libraryId) {
      if (!options.getLibrary(libraryId)) return undefined;
      const done = enqueue(libraryId, false);
      if (options.inline) await done;
      return options.catalog.getJob(libraryId);
    },
    resumeIncomplete() {
      for (const job of options.catalog.listRunningJobs()) void enqueue(job.libraryId, false);
    },
    cachePoster,
  };
}
