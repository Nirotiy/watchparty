"use client";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { type CatalogExclusions } from "../../desktop-shell/shared/catalog-exclusions";

import { exclusionText } from "@/lib/draft-view";

export interface ExclusionApi {
  read: (libraryId: string) => Promise<CatalogExclusions>;
  write: (
    libraryId: string,
    action: "exclude" | "unexclude",
    paths: string[],
  ) => Promise<CatalogExclusions>;
}

export function ExclusionList({
  libraryId,
  api,
  reload,
  classify,
  version,
}: {
  libraryId: string;
  api: ExclusionApi;
  reload: () => Promise<void>;
  classify: () => Promise<void>;
  version: unknown;
}) {
  const [data, setData] = useState<CatalogExclusions | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api
      .read(libraryId)
      .then((value) => {
        if (alive) {
          setData(value);
          setError("");
        }
      })
      .catch(() => {
        if (alive) setError(exclusionText.readFailed);
      });
    return () => {
      alive = false;
    };
  }, [libraryId, api, version]);
  async function restore(relativePath: string) {
    setBusy(true);
    try {
      setData(await api.write(libraryId, "unexclude", [relativePath]));
      await reload();
      setError("");
    } catch {
      setError(exclusionText.restoreFailed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label={exclusionText.title}
      style={{
        borderTop: "1px solid #444",
        borderBottom: "1px solid #444",
        padding: "10px 0",
        background: "#000",
        color: "#fff",
      }}
    >
      <Button
        size="sm"
        variant="outline"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{ color: "inherit", padding: "4px 0" }}
      >
        已排除 {data?.excluded ?? "—"} 个 · 失效 {data?.stale ?? "—"} 个{" "}
        {open ? <ChevronUp /> : <ChevronDown />}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void classify()}>重新分类</Button>
      {error ? <p role="alert">{error}</p> : null}
      {open ? (
        <>
          <p>
            {exclusionText.rollback} {exclusionText.restore}
          </p>
          {data?.items.length === 0 ? <p>没有排除标记</p> : null}
          <ul style={{ maxHeight: 320, overflowY: "auto" }}>
            {data?.items.map((item) => (
              <li
                key={item.relativePath}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  borderTop: "1px solid #333",
                  padding: "8px 0",
                }}
              >
                <span
                  style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
                >
                  {item.relativePath}
                  {item.stale ? (
                    <small style={{ display: "block" }}>
                      {exclusionText.stale}
                    </small>
                  ) : null}
                  {item.reason ? (
                    <small style={{ display: "block" }}>{item.reason}</small>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => void restore(item.relativePath)}
                >
                  {item.stale ? "清除" : "恢复"}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function ExcludeFiles({
  libraryId,
  files,
  api,
  reload,
}: {
  libraryId: string;
  files: Array<{ name: string; relativePath?: string }>;
  api: ExclusionApi;
  reload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function exclude() {
    setBusy(true);
    try {
      await api.write(libraryId, "exclude", paths);
      setPaths([]);
      setOpen(false);
      await reload();
      setError("");
    } catch {
      setError(exclusionText.markFailed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section style={{ margin: "10px 0", background: "#000", color: "#fff" }}>
      <Button
        size="sm"
        variant="outline"
        type="button"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        不入库文件…
      </Button>
      {open ? (
        <>
          <div className="flex flex-wrap items-center gap-2 py-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                setPaths(
                  files.flatMap((file) =>
                    file.relativePath ? [file.relativePath] : [],
                  ),
                )
              }
            >
              全选
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || paths.length === 0}
              onClick={() => setPaths([])}
            >
              清空
            </Button>
            <span>
              已选 {paths.length} / {files.length}
            </span>
          </div>
          <ul style={{ maxHeight: 320, overflowY: "auto" }}>
            {files.map((file) => (
              <li key={file.relativePath ?? file.name}>
                <label
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "5px 0",
                    overflowWrap: "anywhere",
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={busy || !file.relativePath}
                    checked={paths.includes(file.relativePath ?? "")}
                    onChange={() => {
                      const filePath = file.relativePath;
                      if (filePath)
                        setPaths((current) =>
                          current.includes(filePath)
                            ? current.filter((path) => path !== filePath)
                            : [...current, filePath],
                        );
                    }}
                  />
                  <span style={{ minWidth: 0 }}>{file.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <p>
            {paths.length === files.length && paths.length > 0
              ? exclusionText.empty
              : exclusionText.pending}
          </p>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={busy || paths.length === 0 || paths.length > 500}
            onClick={() => void exclude()}
          >
            {busy ? "正在标记…" : `标记不入库（${paths.length}）`}
          </Button>{" "}
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setPaths([]);
            }}
          >
            取消
          </Button>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
