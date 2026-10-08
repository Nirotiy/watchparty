import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
// REST can use Next's HTTP rewrite. Socket.IO is routed by Caddy in production
// and connects directly to port 8080 in development; Next rewrites do not
// reliably preserve the WebSocket upgrade or Socket.IO's trailing-slash path.
const backendOrigin = process.env.BACKEND_ORIGIN ?? "http://localhost:8080";

const nextConfig: NextConfig = {
  // Local previews use 127.0.0.1 so they remain reachable from the desktop
  // shell and browser automation. Next 16 otherwise blocks its dev client
  // resources for that host, leaving the server-rendered page unhydrated.
  allowedDevOrigins: ["127.0.0.1"],
  // dev 指示器默认钉在视口左下角，正好压住房间底栏的本机静音按钮（点不到）；
  // 本地预览以房间 UI 为准，关掉它，避免误导。生产构建本就没有该元素。
  devIndicators: false,
  outputFileTracingRoot: path.resolve(webRoot, ".."),
  distDir: process.env.WATCHPARTY_NEXT_DIST_DIR ?? ".next",
  async rewrites() {
    return { fallback: [
      {
        source: "/api/:path*",
        destination: `${backendOrigin}/api/:path*`,
      },
    ] };
  },
};

export default nextConfig;
