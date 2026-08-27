import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: this repo lives under a path whose ancestor
  // directories can contain unrelated lockfiles (e.g. ~/package-lock.json),
  // which would otherwise confuse Turbopack's root inference.
  turbopack: {
    root: path.resolve(__dirname),
  },

  // The pipeline's prompts are read from disk at runtime
  // (src/pipeline/prompt-versions.ts) rather than bundled, so that the text
  // stored in `prompt_versions.content` is byte-for-byte the file in git.
  // Next's tracer cannot follow a dynamic `readFileSync`, so the directory is
  // included explicitly — without this, any deployed route that runs a
  // pipeline step would throw "Prompt directory not found".
  outputFileTracingIncludes: {
    "/**/*": ["./src/pipeline/prompts/**/*"],
  },
};

export default nextConfig;
