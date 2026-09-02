import { createBackend } from "./app.ts";

const backend = createBackend();
await backend.start();
console.log("watchparty listening on %s:%s", backend.host, backend.port);

const shutdown = () => {
  void backend.close().finally(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
