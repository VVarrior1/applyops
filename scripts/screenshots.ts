/**
 * Captures real dashboard screenshots into `docs/img/` for the README
 * (plan Task 16 Step 2). Run against a locally running app —
 * `npm run build && npm run start` in one terminal, then in another:
 *
 *   npx tsx scripts/screenshots.ts
 *
 * Public pages (`/`, `/results`, `/benchmark`) are captured unauthenticated.
 * Authenticated pages (`/jobs`, `/funnel`, `/applications`) are captured
 * with a REAL owner session, minted the same way `session.mts` has done for
 * earlier tasks' live verification: `supabase.auth.admin.generateLink()` +
 * `verifyOtp()` against the live Supabase project (`OWNER_EMAIL`,
 * `SUPABASE_SERVICE_ROLE_KEY`), never a fabricated cookie. No password or
 * token is ever printed — only "captured <path>" lines.
 *
 * Every screenshot is real product state from the live dev database, not a
 * mock — whatever is actually in the DB at the moment this runs is what
 * shows up in the image, so re-run this after seeding/verification work
 * changes the data and the images will look different. That's intentional.
 *
 * PII masking: the authenticated nav bar renders the signed-in owner's real
 * email address (`user.email` in `app/(app)/layout.tsx`). Before every
 * screenshot — public or authenticated — `maskPiiInPage()` walks the DOM
 * text nodes for anything email-shaped and replaces it with
 * `owner@example.com`, in-page, before `page.screenshot()` ever runs. This
 * is baked into `shoot()` itself (not a one-off manual edit) specifically
 * so a future re-run of this script can never re-leak the real address into
 * a committed PNG, even if new authenticated pages are added to
 * AUTH_TARGETS later.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve(__dirname, "../docs/img");

const PUBLIC_TARGETS: { path: string; file: string }[] = [
  { path: "/", file: "landing.png" },
  { path: "/results", file: "results.png" },
  { path: "/benchmark", file: "benchmark.png" },
];

const AUTH_TARGETS: { path: string; file: string; fullPage?: boolean }[] = [
  // Not fullPage: /jobs lists ~200 rows (JOBS_PAGE_LIMIT) and a full-page
  // capture of the whole list is not useful in a README — one viewport of
  // the ranked list makes the point.
  { path: "/jobs", file: "jobs.png", fullPage: false },
  { path: "/funnel", file: "funnel.png" },
  { path: "/applications", file: "applications.png" },
];

/** Mints a real owner session and returns cookies in Playwright's `addCookies` shape. Mirrors the technique documented in Task 11's completed-task notes. */
async function mintOwnerCookies(): Promise<{ name: string; value: string; domain: string; path: string }[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.OWNER_EMAIL;
  if (!url || !anon || !service || !email) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / OWNER_EMAIL in .env.local",
    );
  }

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) throw new Error("generateLink did not return a hashed_token");

  const jar = new Map<string, string>();
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const verified = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  if (verified.error) throw verified.error;

  const host = new URL(BASE_URL).hostname;
  return [...jar.entries()].map(([name, value]) => ({ name, value, domain: host, path: "/" }));
}

/**
 * Replaces any email-shaped text anywhere in the page with a placeholder,
 * in-browser, before a screenshot is taken. Walks text nodes rather than
 * targeting a specific selector/class so it keeps working even if the nav
 * markup changes — see the PII-masking note in this file's header comment.
 */
async function maskPiiInPage(page: import("playwright").Page): Promise<void> {
  await page.evaluate(() => {
    const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      nodes.push(current as Text);
      current = walker.nextNode();
    }
    for (const node of nodes) {
      if (node.textContent && EMAIL_RE.test(node.textContent)) {
        node.textContent = node.textContent.replace(EMAIL_RE, "owner@example.com");
      }
    }
  });
}

async function shoot(context: BrowserContext, target: { path: string; file: string; fullPage?: boolean }) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const res = await page.goto(`${BASE_URL}${target.path}`, { waitUntil: "networkidle", timeout: 30_000 });
  if (!res || res.status() >= 400) {
    throw new Error(`${target.path} -> HTTP ${res?.status() ?? "no response"}`);
  }
  // Redirected to /login means the session did not attach — fail loudly
  // rather than silently saving a screenshot of the login page.
  if (page.url().includes("/login") && target.path !== "/login") {
    throw new Error(`${target.path} redirected to /login — session did not attach`);
  }
  await page.waitForTimeout(400); // let charts/fonts settle
  await maskPiiInPage(page); // never let a real email reach the PNG — see header comment
  await page.screenshot({
    path: path.join(OUT_DIR, target.file),
    fullPage: target.fullPage ?? true,
  });
  await page.close();
  console.log(`captured ${target.path} -> docs/img/${target.file}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  try {
    const publicContext = await browser.newContext();
    for (const target of PUBLIC_TARGETS) {
      await shoot(publicContext, target);
    }
    await publicContext.close();

    const cookies = await mintOwnerCookies();
    const authContext = await browser.newContext();
    await authContext.addCookies(cookies);
    for (const target of AUTH_TARGETS) {
      await shoot(authContext, target);
    }
    await authContext.close();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
