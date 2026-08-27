/**
 * `applyToApplication()` — the top of the apply agent (spec §10).
 *
 * Everything that touches the database or the filesystem lives here, so
 * `ats-fastpath.ts` stays pure and `tool-loop.ts` only ever knows about a
 * browser page and a model. The sequence is:
 *
 *   application row → owner check → ApplicantData from the profile
 *     → persistent browser context (per ATS vendor)
 *     → deterministic fast path
 *     → LLM tool loop, whose approval gate writes an `approvals` row
 *     → application status / outcome event
 *
 * The browser context is *persistent* (`launchPersistentContext`) and keyed by
 * ATS vendor: a Greenhouse or Lever account stays signed in between runs, so
 * the second application to a Greenhouse company skips the account wall
 * entirely. That is also why the profile directory lives outside the repo, in
 * `~/.applyops/browser/<vendor>` — it holds cookies for the user's real
 * accounts and must never be committed or shipped in the Docker image.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { eq } from "drizzle-orm";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Db } from "../db/client";
import {
  applications,
  approvals,
  companies,
  jobs,
  outcomeEvents,
  profiles,
  searchPrefs,
} from "../db/schema";
import type { ModelId } from "../llm/model-id";
import { RESUME_BUCKET, getStorageAdminClient } from "../profile/storage";
import {
  buildApplicantData,
  detectAts,
  fillFastPath,
  type ApplicantData,
  type AtsKind,
} from "./ats-fastpath";
import {
  runToolLoop,
  type ApplyStatus,
  type ConfirmationRequest,
  type ToolLoopResult,
} from "./tool-loop";

/** Everything the agent keeps between runs, outside the repo. */
export const APPLYOPS_HOME = path.join(os.homedir(), ".applyops");

export interface ApplyOptions {
  /** Fill the form, screenshot it, then decline at the gate. Never submits. */
  dryRun?: boolean;
  /** Headless is for CI/Docker; a real apply run wants to be watchable. */
  headless?: boolean;
  verbose?: boolean;
  maxSteps?: number;
  modelId?: ModelId;
  /** Override the browser profile root (tests, Docker). */
  browserDir?: string;
  /** Override where review screenshots are written. */
  screenshotDir?: string;
  /**
   * How the human is asked. Defaults to a `y/N` prompt on the terminal;
   * injected by tests and by any non-interactive caller.
   */
  ask?: (req: ConfirmationRequest) => Promise<boolean>;
}

export interface ApplyRunResult extends ToolLoopResult {
  applicationId: string;
  jobUrl: string;
  ats: AtsKind;
  fastPath: { filled: string[]; remaining: string[] };
  /** `approvals.id` written during this run, if the gate was reached. */
  approvalId: string | null;
  screenshotPath: string | null;
}

/** Raised for the conditions a human can fix, so the CLI can print them plainly. */
export class ApplyError extends Error {
  readonly name = "ApplyError";
}

export async function applyToApplication(
  db: Db,
  applicationId: string,
  opts: ApplyOptions = {},
): Promise<ApplyRunResult> {
  const {
    dryRun = false,
    headless = false,
    verbose = false,
    maxSteps = 35,
    modelId,
    browserDir = path.join(APPLYOPS_HOME, "browser"),
    screenshotDir = path.join(APPLYOPS_HOME, "screenshots"),
  } = opts;

  const log = (msg: string) => {
    if (verbose) process.stdout.write(`  [agent] ${msg}\n`);
  };

  const row = await loadApplication(db, applicationId);
  const ats = detectAts(row.jobUrl);
  const data = buildApplicantData({ contact: row.contact, prefs: row.prefs });
  assertApplicable(data);

  const resumePath = await materialiseResume(row.resumePdfPath, applicationId, log);

  fs.mkdirSync(screenshotDir, { recursive: true });
  const profileDir = path.join(browserDir, ats);
  fs.mkdirSync(profileDir, { recursive: true });

  let approvalId: string | null = null;
  let screenshotPath: string | null = null;

  const ask = opts.ask ?? terminalAsk;

  /**
   * The approval gate, spec §10: screenshot → `approvals` row (`pending`) →
   * terminal `y/N` → the row is closed out `approved` or `declined`. The row
   * is written *before* the human is asked, so an abandoned run leaves a
   * visible pending approval on the dashboard rather than no trace at all.
   */
  const onConfirm = async (req: ConfirmationRequest): Promise<boolean> => {
    screenshotPath = req.screenshot
      ? writeScreenshot(screenshotDir, applicationId, req.screenshot)
      : null;

    const [created] = await db
      .insert(approvals)
      .values({
        applicationId,
        screenshotPath,
        summary: req.dryRun ? `[dry run] ${req.message}` : req.message,
        decision: "pending",
      })
      .returning({ id: approvals.id });
    approvalId = created?.id ?? null;

    const decision = req.dryRun ? false : await ask(req);

    if (approvalId) {
      await db
        .update(approvals)
        .set({ decision: decision ? "approved" : "declined", decidedAt: new Date() })
        .where(eq(approvals.id, approvalId));
    }
    return decision;
  };

  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      slowMo: headless ? 0 : 60,
      viewport: { width: 1280, height: 900 },
      // Chromium's own sandbox cannot initialise as root inside a container.
      // The Dockerfile runs as a non-root user precisely so this stays off;
      // it exists for CI executors that force root. See Dockerfile.
      args:
        process.env.APPLYOPS_BROWSER_NO_SANDBOX === "1"
          ? ["--no-sandbox", "--disable-dev-shm-usage"]
          : [],
    });

    // A careers page frequently opens the real form in a new tab; track the
    // newest one so the loop keeps driving the page the human is looking at.
    let newest: Page = context.pages()[0] ?? (await context.newPage());
    context.on("page", (p) => {
      newest = p;
    });

    log(`opening ${row.jobUrl} (ats=${ats}, dryRun=${dryRun})`);
    await newest.goto(row.jobUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await newest.waitForTimeout(2000);

    const fastPath = await fillFastPath(newest, ats, data, { resumePath });
    log(`fast path filled: ${fastPath.filled.join(", ") || "(nothing)"}`);
    log(`remaining for the agent: ${fastPath.remaining.join(", ") || "(nothing)"}`);

    const loop = await runToolLoop(newest, {
      job: {
        title: row.jobTitle,
        company: row.companyName,
        location: row.jobLocation,
        remote: row.jobRemote,
        url: row.jobUrl,
      },
      data,
      resumePath,
      maxSteps,
      dryRun,
      fastPath,
      modelId,
      onConfirm,
      log,
      // `runToolLoop` re-reads the active page after every navigation.
      resolveActivePage: () => newest,
    });

    await recordOutcome(db, applicationId, loop.status);

    return {
      ...loop,
      applicationId,
      jobUrl: row.jobUrl,
      ats,
      fastPath,
      approvalId,
      screenshotPath,
    };
  } finally {
    // Closing the persistent context is what flushes cookies to the profile
    // directory, so it must happen even when the run threw.
    if (context) await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

interface ApplicationRow {
  userId: string;
  isOwner: boolean;
  jobUrl: string;
  jobTitle: string;
  jobLocation: string | null;
  jobRemote: boolean | null;
  companyName: string;
  resumePdfPath: string | null;
  contact: typeof profiles.$inferSelect.contact;
  prefs: { locations: string[] | null; workAuth: string | null } | null;
}

async function loadApplication(db: Db, applicationId: string): Promise<ApplicationRow> {
  const [row] = await db
    .select({
      userId: applications.userId,
      resumePdfPath: applications.resumePdfPath,
      jobUrl: jobs.url,
      jobTitle: jobs.title,
      jobLocation: jobs.location,
      jobRemote: jobs.remote,
      companyName: companies.name,
      isOwner: profiles.isOwner,
      contact: profiles.contact,
    })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .innerJoin(profiles, eq(profiles.userId, applications.userId))
    .where(eq(applications.id, applicationId))
    .limit(1);

  if (!row) throw new ApplyError(`No application ${applicationId}.`);
  // Spec §10: the apply agent is owner-only in v1. It drives a real browser on
  // the operator's own machine with the operator's own logged-in sessions;
  // running it on someone else's behalf would apply to jobs from the owner's
  // browser profile.
  if (!row.isOwner) {
    throw new ApplyError(
      `Application ${applicationId} belongs to a non-owner profile; the apply agent is owner-only in v1.`,
    );
  }

  const [prefs] = await db
    .select({ locations: searchPrefs.locations, workAuth: searchPrefs.workAuth })
    .from(searchPrefs)
    .where(eq(searchPrefs.userId, row.userId))
    .limit(1);

  return { ...row, prefs: prefs ?? null };
}

/**
 * Only a run that a human approved *and* the agent confirmed as submitted
 * moves the application forward. `skipped` (declined / dry run),
 * `needs_manual` and `failed` deliberately leave the row in `draft`: the
 * funnel in spec §9 is derived from `outcome_events`, and an "applied" event
 * that never happened would quietly poison every conversion rate downstream.
 */
async function recordOutcome(db: Db, applicationId: string, status: ApplyStatus) {
  if (status !== "applied") return;
  await db
    .update(applications)
    .set({ status: "applied" })
    .where(eq(applications.id, applicationId));
  await db.insert(outcomeEvents).values({
    applicationId,
    type: "applied",
    notes: "Submitted by the apply agent after human approval.",
  });
}

/**
 * Test seam, mirroring `src/llm/call.ts`'s `_internal` convention. Everything
 * else in this module needs a real browser; `recordOutcome` is the piece whose
 * rule ("only `applied` writes anything") has to hold for the funnel in spec
 * §9 to mean anything, so it is reachable from tests without Playwright.
 */
export const _internal = { recordOutcome };

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function writeScreenshot(dir: string, applicationId: string, bytes: Buffer): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `apply_${applicationId}_${stamp}.jpg`);
  fs.writeFileSync(file, bytes);
  return file;
}

/**
 * `applications.resume_pdf_path` is a key in the private `resumes` Supabase
 * bucket; Playwright needs a real file on disk. Downloads it once per run into
 * `~/.applyops/resumes/`. A path that already exists locally is used as-is,
 * which is what makes an end-to-end dry run possible without Storage.
 *
 * A missing resume is not fatal: the agent is told there is none and will
 * report the upload as something a human must finish.
 */
async function materialiseResume(
  storedPath: string | null,
  applicationId: string,
  log: (msg: string) => void,
): Promise<string | null> {
  if (!storedPath) return null;
  if (fs.existsSync(storedPath)) return path.resolve(storedPath);

  try {
    const client = getStorageAdminClient();
    const { data, error } = await client.storage.from(RESUME_BUCKET).download(storedPath);
    if (error || !data) throw error ?? new Error("empty download");
    const dir = path.join(APPLYOPS_HOME, "resumes");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${applicationId}.pdf`);
    fs.writeFileSync(file, Buffer.from(await data.arrayBuffer()));
    log(`resume downloaded to ${file}`);
    return file;
  } catch (err) {
    log(`could not fetch the resume (${err instanceof Error ? err.message : String(err)}) — continuing without it`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Guards & prompts
// ---------------------------------------------------------------------------

/**
 * Refuse to open a browser at all when the profile cannot answer the questions
 * every application asks. Failing here costs nothing; failing halfway through
 * a form wastes a real submission slot at a real company.
 */
function assertApplicable(data: ApplicantData): void {
  const missing: string[] = [];
  if (!data.fullName) missing.push("name");
  if (!data.email) missing.push("email");
  if (missing.length > 0) {
    throw new ApplyError(
      `Profile is missing ${missing.join(" and ")} — set them in Settings → Contact details before applying.`,
    );
  }
}

/** The `y/N` gate. Anything other than `y` means no. */
async function terminalAsk(req: ConfirmationRequest): Promise<boolean> {
  process.stdout.write(`\n${"=".repeat(64)}\n  REVIEW BEFORE SUBMISSION\n${"=".repeat(64)}\n`);
  process.stdout.write(`\n${req.message}\n\n`);
  process.stdout.write(`Page: ${req.url}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question("Submit this application? [y/N]: ", resolve),
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
