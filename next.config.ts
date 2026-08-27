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

  // REQUIRED for src/profile/resume-text.ts (Task 6 upload route). `pdf-parse`
  // pulls in `pdfjs-dist/legacy/build/pdf.mjs`, which resolves its worker
  // (`pdf.worker.mjs`) relative to wherever ITS OWN module ends up at
  // runtime. Bundled into a Turbopack/webpack chunk, that resolution breaks
  // — Next never emits `pdf.worker.mjs` into `.next/**/chunks/` — and every
  // `extractPdfText` call throws "Cannot find module
  // '.../pdf.worker.mjs'", which the upload route maps to a 422 that is
  // indistinguishable from a genuinely bad PDF. `npm run build` stays green
  // throughout because this is a runtime failure, not a compile error.
  // Listing the package here makes Next `require()` it straight from
  // node_modules at request time instead of bundling it, so Node's normal
  // module resolution finds the real worker file. Verified against both
  // `next build && next start` and `next dev` (see tests/config/next-config
  // .test.ts for the regression guard, since a plain unit test of
  // extractPdfText runs under vitest's own Node resolution and would never
  // reproduce this bundler-specific failure).
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
