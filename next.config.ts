import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: keep it external to the server bundle.
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // Uploads are capped in code at MAX_UPLOAD_BYTES; this keeps the
    // framework limit slightly above it so we can return a clean error.
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
