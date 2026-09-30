import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "../../src") } },
  server: { host: "127.0.0.1", port: 3013, strictPort: true, fs: { allow: [path.resolve(__dirname, "../..")] }, proxy: { "/__fixture": { target: "http://127.0.0.1:8099", rewrite: value => value.replace(/^\/__fixture/, "") } } },
})
