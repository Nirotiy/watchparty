import { groupScanFiles, type ScanFile } from "./catalog-names.ts";
import { MetadataUnavailable, type MetadataSearcher } from "./catalog-metadata.ts";
import { judgeSubject } from "./catalog-judge.ts";
import type { CatalogStore, PendingItem, ScrapeJob } from "./catalog-store.ts";
import type { StoredLibrary } from "./library-store.ts";

export type JudgeReport = { judged: number; confirmed: number; pending: number; items: string[] };

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
  /** 只判定草稿：查条目、打分、把结论写回 catalog_draft，正式表与 scrape_jobs 都不动。 */
  judgeDrafts(libraryId: string, maxLookups?: number): Promise<JudgeReport | undefined>;
  resumeIncomplete(): void;
  cachePoster(itemId: string, imageUrl: string): Promise<void>;
} {
  const inflight = new Map<string, Promise<unknown>>();

  /** One task at a time per library: a scrape, a resume and a draft judge never interleave. */
  function enqueue<T>(libraryId: string, task: () => Promise<T>): Promise<T> {
    const previous = inflight.get(libraryId) ?? Promise.resolve();
    const next = previous.then(task, task);
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
        // The enumeration is the expensive, rate-limited part. Keeping it means a
        // grouping change can be reviewed offline against the real tree instead of
        // re-scraping the network and rewriting people's answers.
        options.catalog.writeScan(libraryId, files);
        const groups = groupScanFiles(files, options.catalog.protectedKeys(libraryId)).filter((group) => group.query);
        // Classification lands in the draft table first: it is the one place where a
        // grouping change can be reviewed as data, and writing it costs nothing.
        options.catalog.writeDraft(libraryId, groups);
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
      // Second pass over the answers: cards the scrape confirmed onto the *same*
      // subject are one work, whatever folders it arrived in. Human decisions are
      // skipped inside this call, so a re-scan can never swallow someone's pick.
      options.catalog.reclusterBySubject(libraryId);
      options.catalog.finishJob(libraryId);
    } catch (error) {
      options.catalog.failJob(libraryId, error instanceof MetadataUnavailable ? "CATALOG_UNAVAILABLE" : "OPENLIST_UNAVAILABLE");
    }
  }

  async function lookup(item: PendingItem): Promise<void> {
    if (item.kind === "other") {
      options.catalog.applyMatch(item, "unmatched", null, []);
      options.catalog.bumpJob(item.libraryId, false);
      return;
    }
    // Candidates are rebuilt from the file names rather than read from the row, so a
    // parse fix takes effect without a re-scan.
    const judgment = await judgeSubject(
      {
        itemKey: item.itemKey,
        query: item.query,
        rawName: item.rawName,
        fileNames: item.fileNames,
        fileCount: item.fileCount,
        kind: item.kind,
        rejected: options.catalog.rejectionKeys(item.libraryId, item.itemKey),
      },
      { bangumi: options.bangumi, tmdb: options.tmdb, delayMs: options.delayMs },
    );
    if (judgment.status === "confirmed" && judgment.chosen) {
      options.catalog.applyMatch(item, "confirmed", judgment.chosen, judgment.candidates);
      if (judgment.posterUrl) await cachePoster(item.id, judgment.posterUrl);
      options.catalog.bumpJob(item.libraryId, true);
      return;
    }
    options.catalog.applyMatch(item, judgment.status, null, judgment.candidates);
    options.catalog.bumpJob(item.libraryId, false);
  }

  async function cachePoster(itemId: string, imageUrl: string): Promise<void> {
    const poster = await options.fetchPoster(imageUrl);
    if (!poster) return;
    options.catalog.writePoster(itemId, poster.contentType, poster.bytes);
  }

  return {
    async start(libraryId) {
      if (!options.getLibrary(libraryId)) return undefined;
      const done = enqueue(libraryId, () => run(libraryId, true));
      if (options.inline) await done;
      return options.catalog.getJob(libraryId);
    },
    async continue(libraryId) {
      if (!options.getLibrary(libraryId)) return undefined;
      const done = enqueue(libraryId, () => run(libraryId, false));
      if (options.inline) await done;
      return options.catalog.getJob(libraryId);
    },
    async judgeDrafts(libraryId, maxLookups) {
      if (!options.getLibrary(libraryId)) return undefined;
      const kind = options.getLibrary(libraryId)?.kind ?? "anime";
      return enqueue(libraryId, async () => {
        const subjects = options.catalog.listPendingDrafts(libraryId);
        const batch = maxLookups === undefined ? subjects : subjects.slice(0, maxLookups);
        let judged = 0;
        let confirmed = 0;
        const items: string[] = [];
        for (const subject of batch) {
          const judgment = await judgeSubject(
            { ...subject, kind, rejected: options.catalog.rejectionKeys(libraryId, subject.itemKey) },
            { bangumi: options.bangumi, tmdb: options.tmdb, delayMs: options.delayMs },
          );
          options.catalog.writeDraftJudgment(libraryId, subject.itemKey, judgment);
          judged += 1;
          items.push(subject.itemKey);
          if (judgment.status === "confirmed") confirmed += 1;
          // Anonymous Bangumi allows roughly 60 requests a minute, and one subject can
          // spend three of them, so the wait between subjects is what keeps us literate.
          if (options.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        return { judged, confirmed, items, pending: options.catalog.listPendingDrafts(libraryId).length };
      });
    },
    resumeIncomplete() {
      for (const job of options.catalog.listRunningJobs()) void enqueue(job.libraryId, () => run(job.libraryId, false));
    },
    cachePoster,
  };
}
