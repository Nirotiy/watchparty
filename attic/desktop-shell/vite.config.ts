import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll("\\", "/")
          if (normalized.includes("/node_modules/")) {
            // Fluent's component, icon, and react-dom internals reference each other. Keeping
            // them together avoids a circular vendor graph while still isolating the UI stack.
            if (normalized.includes("/@fluentui/") || normalized.includes("/react-dom/") || normalized.includes("/scheduler/")) return "vendor-fluent-ui"
            if (normalized.includes("/node_modules/react/")) return "vendor-react"
            if (normalized.includes("/@radix-ui/") || normalized.includes("/node_modules/radix-ui/")) return "vendor-radix"
            if (normalized.includes("/node_modules/@kawarp/")) return "vendor-kawarp"
          }
          if (normalized.includes("/shared/musicparty-adapter.") || normalized.includes("/shared/musicparty-connection.")) return "musicparty-core"
          if (normalized.includes("/shared/native-audio-player.") || normalized.includes("/shared/player.")) return "musicparty-player"
          return undefined
        },
      },
    },
  },
  server: {
    strictPort: true,
  },
})
