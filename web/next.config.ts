import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
// REST can use Next's HTTP rewrite. Socket.IO is routed by Caddy in production
// and connects directly to port 8080 in development; Next rewrites do not
// reliably preserve the WebSocket upgrade or Socket.IO's trailing-slash path.
const backendOrigin = process.env.BACKEND_ORIGIN ?? "http://localhost:8080";

const nextConfig: NextConfig = {
  outputFileTracingRoot: webRoot,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
