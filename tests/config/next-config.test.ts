import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

describe("next.config.ts", () => {
  it("externalizes pdf-parse so its pdfjs-dist worker resolves from node_modules at runtime", () => {
    // Regression guard for the Task 6 blocker: pdf-parse -> pdfjs-dist
    // resolves its (fake) worker relative to wherever pdfjs-dist's own
    // module ends up at runtime. Bundled by Turbopack/webpack, that
    // resolution breaks (Next never emits pdf.worker.mjs into
    // .next/**/chunks/), so every `extractPdfText` call throws and the
    // upload route (app/api/profile/upload/route.ts) turns that into a 422
    // that looks exactly like a bad PDF. `npm run build` stays green
    // throughout, so this is the only automated check that would catch
    // someone removing this line. A plain unit test of `extractPdfText`
    // (see tests/profile/resume-text*.test.ts, if one exists) runs pdf-parse
    // under vitest's own Node module resolution and would NOT reproduce
    // this bundler-specific failure — asserting the config value directly
    // is the cheap, deterministic way to guard it.
    expect(nextConfig.serverExternalPackages).toContain("pdf-parse");
  });
});
