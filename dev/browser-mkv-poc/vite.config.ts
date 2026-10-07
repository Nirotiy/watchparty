import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["jassub"],
    include: ["throughput"],
  },
  worker: {
    format: "es",
  },
  server: {
    watch: {
      ignored: ["**/verify/**"],
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
});
