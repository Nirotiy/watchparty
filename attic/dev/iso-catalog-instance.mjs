// 隔离副本的媒体库后端：把真库拷一份到别处跑，REVIEW=1 的写路径就不碰真库。
// 跑法（在 watchparty/ 根下）：
//   node dev/iso-catalog-instance.mjs [--port=8099] [--root=<dir>] [--refresh]
//     --refresh  重新拷库（VACUUM INTO，拿到一致快照）并重写海报路径；默认复用已有副本
// 起好之后：
//   WATCHPARTY_MEDIA_CHECK_ORIGIN=http://127.0.0.1:8099 [WATCHPARTY_MEDIA_CHECK_REVIEW=1] \
//     node desktop-shell/electron/launch.mjs --media-check
// 前置：OpenList 得在跑（.env 的 OPENLIST_URL）。
//
// 四个都踩过的坑：
//   ① cwd 必须是 watchparty 根：`server/utils/moniker.ts` 按 cwd 读 `words/*.txt`（会 ENOENT 崩），
//      而且 `server/config.ts` 的 `loadEnvFile()` 也是按 cwd 找 `.env`。脚本自己 chdir。
//   ② `poster_files.cache_path` 存的是**绝对路径**（指向真库的 data/poster-cache）⇒ 拷完必须把前缀改到副本，
//      否则海报全 404、无海报回退渲染被点亮，harness 的 `titles-wall` 会红在"图上写了名字却又写了标题"。
//   ③ 副本实例照样会打**真 OpenList**（只读列目录）：scan/classify/浏览都要它在线；
//      别在别人正刮削/正扫库的时候跑，也别拿它去碰真库的写路径。
//   ④ 副本比真栈慢（同机再跑一个 Node + Electron），harness 里那些"等某个 DOM 出现"的超时按宽松的算。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const args = process.argv.slice(2);
const portFlag = args.find((arg) => arg.startsWith("--port="));
const rootFlag = args.find((arg) => arg.startsWith("--root="));
const port = portFlag ? Number(portFlag.split("=")[1]) : 8099;
const root = rootFlag ? path.resolve(rootFlag.split("=")[1]) : path.join(os.tmpdir(), "watchparty-iso");
const refresh = args.includes("--refresh");

const liveData = path.join(repoRoot, "data");
const liveCatalog = path.join(liveData, "watchparty-catalog.sqlite");
const liveLibrary = path.join(liveData, "watchparty-library.sqlite");
const livePosters = path.join(liveData, "poster-cache");

function snapshot(source, destination) {
  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  // 真库可能正被活实例打开：外部 cp 一个活着的 sqlite 可能拍到**事务中途**的状态（本机 journal_mode=delete，
  // 边上的回滚日志多半不会被一起拷走 ⇒ 副本可能自相矛盾）。事务保护的是 SQLite 自己，不是旁边那个 cp。
  // VACUUM INTO 出的是一致快照，跟 journal 模式无关（后端 bfa145f0 同因改用）。
  const db = new DatabaseSync(source);
  db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  db.close();
}

function prepare() {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const catalogCopy = path.join(root, "data", "watchparty-catalog.sqlite");
  const libraryCopy = path.join(root, "data", "watchparty-library.sqlite");
  const postersCopy = path.join(root, "data", "poster-cache");
  snapshot(liveCatalog, catalogCopy);
  snapshot(liveLibrary, libraryCopy);
  fs.rmSync(postersCopy, { recursive: true, force: true });
  fs.cpSync(livePosters, postersCopy, { recursive: true });

  const db = new DatabaseSync(catalogCopy);
  const oldPrefix = livePosters;
  const newPrefix = postersCopy;
  const rows = db.prepare("SELECT COUNT(*) n FROM poster_files WHERE cache_path LIKE ?").get(oldPrefix + "%").n;
  db.prepare("UPDATE poster_files SET cache_path = replace(cache_path, ?, ?) WHERE cache_path LIKE ?").run(oldPrefix, newPrefix, oldPrefix + "%");
  db.close();
  console.log(`ISO_PREPARED root=${root} posters-rewritten=${rows}`);
}

const catalogPath = path.join(root, "data", "watchparty-catalog.sqlite");
if (refresh || !fs.existsSync(catalogPath)) prepare();
else console.log(`ISO_REUSED root=${root}（--refresh 重新拷）`);

const { createBackend } = await import(new URL("../server/app.ts", import.meta.url).href);
const backend = createBackend({
  host: "127.0.0.1",
  port,
  libraryDbPath: path.join(root, "data", "watchparty-library.sqlite"),
  catalogDbPath: catalogPath,
  posterDir: path.join(root, "data", "poster-cache"),
  catalogSidecarDir: path.join(root, "data", "catalog-sidecars"),
});
await backend.start();
console.log(`ISO_LISTENING http://127.0.0.1:${port}  （harness: WATCHPARTY_MEDIA_CHECK_ORIGIN=http://127.0.0.1:${port}）`);
const stop = () => void backend.close().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
