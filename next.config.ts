import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: this repo lives under a path whose ancestor
  // directories can contain unrelated lockfiles (e.g. ~/package-lock.json),
  // which would otherwise confuse Turbopack's root inference.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
