import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const filePath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass one local MKV path");

const file = await stat(filePath);
if (!file.isFile()) throw new Error("The selected path is not a file");

const origin = "http://localhost:5188";
const etag = `"${file.size}-${Math.trunc(file.mtimeMs)}"`;
const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Range, If-Range");
  response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, ETag");
  response.setHeader("Vary", "Origin");

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  if (request.url !== "/media" || !["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("ETag", etag);
  response.setHeader("Content-Type", "video/x-matroska");

  const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${file.size}` }).end();
    return;
  }
  const start = Number(match[1]);
  const end = Math.min(match[2] ? Number(match[2]) : file.size - 1, file.size - 1);
  if (!Number.isSafeInteger(start) || start > end || start >= file.size) {
    response.writeHead(416, { "Content-Range": `bytes */${file.size}` }).end();
    return;
  }

  const length = end - start + 1;
  response.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${file.size}`,
    "Content-Length": length,
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath, { start, end }).pipe(response);
});

server.listen(5191, "127.0.0.1", () => {
  process.stdout.write(`Local range source ready at http://127.0.0.1:5191/media (${file.size} bytes)\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
