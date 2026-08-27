/**
 * The apply agent's tool-use loop — spec §10.
 *
 * Ported from v1 `lib/agent/apply-agent.ts`, which drove Playwright from
 * Claude via `@anthropic-ai/sdk`. Two things changed in the port:
 *
 *  - **Provider-agnostic.** The loop now runs on the `ai` SDK (`generateText`
 *    + `tools`) and resolves its model through `src/llm/provider.ts`, so the
 *    same code runs on Gemini today (the only provider with credit in this
 *    environment) and on Claude the moment `ANTHROPIC_API_KEY` has a balance
 *    — a one-line change at the call site, no rewrite. The tool *names and
 *    schemas* are v1's, unchanged.
 *  - **The approval gate is structural, not advisory.** v1 asked the model to
 *    call `request_user_confirmation` before submitting and trusted it to
 *    comply. Here, `request_user_confirmation` is the only path that can set
 *    `submitApproved`, a dry run can never come back approved no matter what
 *    the confirmation handler returns, and a `mark_done(success: true)` that
 *    arrives without a recorded approval is downgraded to `needs_manual`
 *    instead of being reported as a submitted application. The spec's "no
 *    auto-submit, ever" is thereby a property of this file rather than a
 *    property of the prompt.
 *
 * The loop deliberately does not write to the database. `run.ts` owns the
 * `approvals` row and the application status; this module owns the browser
 * and the conversation, and reports what happened.
 */

import { generateText, tool, type LanguageModel, type ModelMessage } from "ai";
import type { Page } from "playwright";
import { z } from "zod";
import { isTransientError, normalizeUsage } from "../llm/call";
import { JUDGE_MODEL_ID } from "../llm/defaults";
import { estimateCost, type TokenUsage } from "../llm/pricing";
import { LlmError, type ModelId } from "../llm/model-id";
import { resolveModel } from "../llm/provider";
import type { ApplicantData } from "./ats-fastpath";

/**
 * The slice of Playwright's `Page` the loop drives. Declared as a `Pick` of
 * the real type so it cannot drift from the browser API, while still letting
 * tests hand in a hand-rolled fake page (see tests/agent/tool-loop.test.ts).
 */
export type AgentPage = Pick<
  Page,
  | "url"
  | "title"
  | "goto"
  | "click"
  | "fill"
  | "selectOption"
  | "setInputFiles"
  | "waitForSelector"
  | "waitForTimeout"
  | "evaluate"
  | "screenshot"
>;

/** The posting being applied to, as the agent sees it. */
export interface AgentJob {
  title: string;
  company: string;
  location?: string | null;
  remote?: boolean | null;
  url: string;
}

/** What the human is asked to approve, and what they are shown. */
export interface ConfirmationRequest {
  /** The agent's summary of what it filled and what it is about to submit. */
  message: string;
  /** JPEG bytes of the form as filled, or `null` if the capture failed. */
  screenshot: Buffer | null;
  /** The page the submit would happen on. */
  url: string;
  /**
   * True when this run can never submit. The handler should still record the
   * approval row and the screenshot (that's the point of a dry run) but must
   * not block on a terminal prompt — the loop ignores its answer either way.
   */
  dryRun: boolean;
}

export type ApplyStatus = "applied" | "skipped" | "failed" | "needs_manual";

export interface ToolLoopResult {
  status: ApplyStatus;
  notes: string;
  /** The URL the run ended on — where a human would pick it up. */
  url: string;
  /** Model round trips actually used (≤ `maxSteps`). */
  steps: number;
  /** Whether a human approval was recorded during this run. */
  approved: boolean;
  /** Real token counts summed across every model round trip. */
  usage: TokenUsage;
  /** `null` when the model has no row in `src/llm/pricing.ts`. */
  costUsd: number | null;
  modelId: ModelId;
}

export interface ToolLoopOptions {
  job: AgentJob;
  data: ApplicantData;
  resumePath: string | null;
  /** Hard cap on model round trips. Plan default: 35. */
  maxSteps?: number;
  /** Called for `request_user_confirmation`. Must never submit anything itself. */
  onConfirm: (req: ConfirmationRequest) => Promise<boolean>;
  /** Fill nothing in, approve nothing: the run always ends `skipped`. */
  dryRun?: boolean;
  /**
   * What the fast path already handled, so the agent doesn't re-type fields
   * that are already correct (and burn steps re-reading them).
   */
  fastPath?: { filled: string[]; remaining: string[] };
  /**
   * Model to drive the loop. Defaults to `JUDGE_MODEL_ID`, which is the one
   * "the good model" constant this repo has: spec §10 names `claude-sonnet-5`
   * here, and `src/llm/defaults.ts` is the single place that decides what the
   * best available model currently is (Gemini 3.7 Flash while the Anthropic
   * keys have no credit balance). Never hardcode a model id at a call site.
   */
  modelId?: ModelId;
  /** Progress lines (`--verbose`); defaults to silence. */
  log?: (msg: string) => void;
  /**
   * After a click/navigate a new tab may be the real form. `run.ts` tracks the
   * browser context's newest page and passes it back through here.
   */
  resolveActivePage?: (current: AgentPage) => AgentPage;
  /** Transient-provider-error retries per step. Default 3. */
  maxRetries?: number;
  /** Test seams, mirroring `src/llm/call.ts`'s `_internal` convention. */
  _internal?: { model?: LanguageModel; sleep?: (ms: number) => Promise<void> };
}

/** Base backoff for transient provider errors (429/5xx). */
const RETRY_BASE_MS = 2000;

/** How many elements of the page get described to the model per turn. */
const MAX_ELEMENTS = 60;

// ---------------------------------------------------------------------------
// Tool definitions — names and schemas ported verbatim from v1 apply-agent.ts
// ---------------------------------------------------------------------------

const applyTools = {
  get_page_structure: tool({
    description:
      "Get the current page URL, title, and a list of all interactive elements (inputs, buttons, selects, file inputs, links). Call this before deciding what to fill.",
    inputSchema: z.object({}),
  }),
  click_element: tool({
    description:
      "Click a button, link, checkbox, or other clickable element. Prefer CSS selector; fall back to visible text.",
    inputSchema: z.object({
      selector: z
        .string()
        .optional()
        .describe('CSS selector (e.g. "button[type=submit]", "#apply-btn")'),
      text: z
        .string()
        .optional()
        .describe('Visible text to match when selector is unknown (e.g. "Apply Now", "Next")'),
    }),
  }),
  fill_input: tool({
    description: "Type text into an input field, textarea, or contenteditable element.",
    inputSchema: z.object({
      selector: z.string().describe("CSS selector for the field"),
      value: z.string().describe("Text to type"),
      clear_first: z
        .boolean()
        .optional()
        .describe("Clear existing value before typing (default true)"),
    }),
  }),
  select_option: tool({
    description: "Choose a value in a <select> dropdown or custom listbox.",
    inputSchema: z.object({
      selector: z.string().describe("CSS selector for the select element"),
      value: z.string().describe("Option value or visible text to select"),
    }),
  }),
  upload_file: tool({
    description: "Attach a document to a file input element.",
    inputSchema: z.object({
      selector: z.string().describe('CSS selector for the <input type="file">'),
      document: z
        .enum(["resume", "cover_letter", "transcript"])
        .describe("Which document to upload"),
    }),
  }),
  scroll_page: tool({
    description: "Scroll the page to reveal more content or form fields.",
    inputSchema: z.object({
      direction: z.enum(["down", "up"]).optional().describe("Scroll direction"),
      pixels: z.number().optional().describe("Pixels to scroll (default 600)"),
    }),
  }),
  navigate_to: tool({
    description: 'Go to a URL — use this to follow an "Apply" link that opens a new form.',
    inputSchema: z.object({ url: z.string().describe("Full URL to navigate to") }),
  }),
  wait_for_page: tool({
    description: "Wait for a page transition or element to appear after an action.",
    inputSchema: z.object({
      selector: z
        .string()
        .optional()
        .describe("Wait until this CSS selector is visible (optional)"),
      seconds: z.number().optional().describe("Seconds to wait (default 2, max 10)"),
    }),
  }),
  request_user_confirmation: tool({
    description:
      "Pause and ask the human to review the filled form before submission. Call this BEFORE clicking any final Submit button.",
    inputSchema: z.object({
      message: z
        .string()
        .describe("Summary of what has been filled and what is about to be submitted"),
    }),
  }),
  mark_done: tool({
    description:
      "End the agent loop. Call this when the application has been submitted OR when you cannot proceed.",
    inputSchema: z.object({
      success: z
        .boolean()
        .describe("true = submitted successfully, false = could not complete"),
      notes: z
        .string()
        .optional()
        .describe("Confirmation number, reason for failure, or other notes"),
    }),
  }),
} as const;

/** The tool names this loop implements, in the order the spec lists them. */
export const APPLY_TOOL_NAMES = Object.keys(applyTools);

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runToolLoop(
  page: AgentPage,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const {
    job,
    data,
    resumePath,
    maxSteps = 35,
    onConfirm,
    dryRun = false,
    fastPath,
    modelId = JUDGE_MODEL_ID,
    log = () => {},
    resolveActivePage = (p: AgentPage) => p,
    maxRetries = 3,
  } = opts;

  const model = opts._internal?.model ?? resolveModel(modelId);
  const sleep =
    opts._internal?.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let active = page;
  let approved = false;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let steps = 0;

  const system = buildSystemPrompt({ job, data, resumePath, dryRun, fastPath });
  const messages: ModelMessage[] = [
    {
      role: "user",
      content:
        `I am on the job page for "${job.title}" at ${job.company}.\n\n` +
        `Current page structure:\n${await extractPageStructure(active)}\n\n` +
        (fastPath
          ? `A deterministic fast path already filled: ${fastPath.filled.join(", ") || "(nothing)"}. ` +
            `Still to handle: ${fastPath.remaining.join(", ") || "(nothing)"}.\n\n`
          : "") +
        `Please find the apply button/link, navigate to the application form, and fill it out ` +
        `with the candidate information from the system prompt. Before clicking the final ` +
        `Submit/Apply button, call request_user_confirmation.`,
    },
  ];

  const finish = (status: ApplyStatus, notes: string): ToolLoopResult => ({
    status,
    notes,
    url: active.url(),
    steps,
    approved,
    usage: { ...usage },
    costUsd: costOf(modelId, usage),
    modelId,
  });

  for (let step = 0; step < maxSteps; step++) {
    steps = step + 1;
    log(`step ${steps}/${maxSteps}`);

    let generated;
    try {
      generated = await generateWithRetry({
        model,
        system,
        messages,
        maxRetries,
        sleep,
        log,
      });
    } catch (err) {
      return finish("failed", `Model call failed: ${errorText(err)}`);
    }

    const turnUsage = normalizeUsage(generated.usage);
    usage.inputTokens += turnUsage.inputTokens;
    usage.outputTokens += turnUsage.outputTokens;
    usage.cachedInputTokens =
      (usage.cachedInputTokens ?? 0) + (turnUsage.cachedInputTokens ?? 0);
    messages.push(...generated.response.messages);

    if (generated.toolCalls.length === 0) {
      // The model replied with prose instead of a tool call: nothing has been
      // submitted, and a human can finish from where the browser is parked.
      return finish(
        "needs_manual",
        `Model ended its turn without a tool call: ${generated.text.slice(0, 300)}`,
      );
    }

    const toolResults: Array<{
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: { type: "text"; value: string };
    }> = [];
    let done: ToolLoopResult | null = null;
    let sawNavigation = false;

    for (const call of generated.toolCalls) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      log(`tool=${call.toolName}`);
      let text: string;

      try {
        switch (call.toolName) {
          case "get_page_structure":
            text = await extractPageStructure(active);
            break;
          case "click_element":
            text = await doClick(active, input);
            await active.waitForTimeout(800);
            active = resolveActivePage(active);
            sawNavigation = true;
            break;
          case "fill_input":
            text = await doFill(active, input);
            break;
          case "select_option":
            text = await doSelect(active, input);
            break;
          case "upload_file":
            text = await doUpload(active, input, resumePath);
            break;
          case "scroll_page":
            text = await doScroll(active, input);
            break;
          case "navigate_to":
            text = await doNavigate(active, input);
            active = resolveActivePage(active);
            sawNavigation = true;
            break;
          case "wait_for_page":
            text = await doWait(active, input);
            sawNavigation = true;
            break;
          case "request_user_confirmation": {
            const message = String(input.message ?? "Ready to submit");
            const screenshot = await captureScreen(active);
            // The handler records the approval row and (outside a dry run)
            // asks the human. `dryRun && false` is the belt to the handler's
            // braces: a dry run cannot come back approved even if the handler
            // is wrong.
            const answer = await onConfirm({
              message,
              screenshot,
              url: active.url(),
              dryRun,
            });
            approved = dryRun ? false : answer === true;
            if (approved) {
              text = "User confirmed — proceeding to submit";
            } else {
              text = dryRun ? "DRY RUN: submission declined" : "User declined submission";
              done = finish(
                "skipped",
                dryRun ? "Dry run: declined at the approval gate." : "Declined at the approval gate.",
              );
            }
            break;
          }
          case "mark_done": {
            const success = Boolean(input.success);
            const notes = String(input.notes ?? "").trim();
            if (success && !approved) {
              // The model says it submitted, but no human ever approved. Never
              // record that as an application — spec §10, "no auto-submit".
              done = finish(
                "needs_manual",
                `Agent reported success without an approval on record${notes ? `: ${notes}` : "."} ` +
                  `Check the page before recording an outcome.`,
              );
            } else if (success) {
              done = finish("applied", notes || "Submitted after human approval.");
            } else {
              done = finish(
                "needs_manual",
                notes || "Agent could not complete the form; a human needs to finish it.",
              );
            }
            text = `Marked as ${done.status}`;
            break;
          }
          default:
            text = `Unknown tool: ${call.toolName}`;
        }
      } catch (err) {
        text = `Error: ${errorText(err)}`;
        log(text);
      }

      toolResults.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: text },
      });
    }

    messages.push({ role: "tool", content: toolResults });
    if (done) return done;

    // A screenshot costs real tokens, so it is only worth sending after
    // something could have changed what the page looks like (v1's heuristic).
    if (sawNavigation) {
      const shot = await captureScreen(active);
      const content: Array<
        | { type: "text"; text: string }
        | { type: "file"; data: Buffer; mediaType: string; filename: string }
      > = [];
      // A `file` part with an image media type — the AI SDK deprecated the
      // dedicated `image` part in v7.
      if (shot) {
        content.push({
          type: "file",
          data: shot,
          mediaType: "image/jpeg",
          filename: "page.jpg",
        });
      }
      content.push({
        type: "text",
        text: `Updated page after navigation.\n${await extractPageStructure(active)}\nContinue filling the form.`,
      });
      messages.push({ role: "user", content });
    } else {
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Actions completed. Continue filling the form." }],
      });
    }
  }

  return finish("needs_manual", `Hit the ${maxSteps}-step cap without finishing the form.`);
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

async function generateWithRetry(args: {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}) {
  const { model, system, messages, maxRetries, sleep, log } = args;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await generateText({
        model,
        system,
        messages,
        tools: applyTools,
        // The tools have no `execute`, so the SDK hands the calls back to us
        // instead of running them: this loop needs to interleave browser work,
        // screenshots and a human approval between turns.
        maxOutputTokens: 1024,
        // Retrying is this function's job (below), not the SDK's — two nested
        // backoff loops would multiply the wait on a rate limit and make the
        // `_internal.sleep` test seam useless.
        maxRetries: 0,
      });
    } catch (err) {
      lastError = err;
      // Typed classification (see src/llm/call.ts) rather than matching on
      // error strings: only 429/5xx and network blips are worth a retry.
      if (!isTransientError(err) || attempt === maxRetries) throw err;
      const wait = RETRY_BASE_MS * 2 ** attempt;
      log(`transient provider error — retrying in ${wait}ms (${attempt + 1}/${maxRetries})`);
      await sleep(wait);
    }
  }

  throw lastError;
}

function costOf(modelId: ModelId, usage: TokenUsage) {
  try {
    return estimateCost(modelId, usage);
  } catch (err) {
    if (err instanceof LlmError) return null;
    throw err;
  }
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(args: {
  job: AgentJob;
  data: ApplicantData;
  resumePath: string | null;
  dryRun: boolean;
  fastPath?: { filled: string[]; remaining: string[] };
}): string {
  const { job, data, resumePath, dryRun } = args;
  const line = (label: string, value: string | null) =>
    value && value.trim() ? `- **${label}**: ${value}` : null;

  // Work authorisation is deliberately not a bare Yes/No: the profile records
  // where the user may work, while the form asks about *this* posting's
  // country. Answering "Yes" on a posting in another country would be a false
  // statement, so the region travels with the answer and the rules below tell
  // the agent when the answer does not apply.
  const workAuth = data.workAuthLabel
    ? `- **Work authorisation on file**: ${data.workAuthLabel}` +
      (data.workAuthRegion
        ? `\n- **These answers apply ONLY to a role based in ${data.workAuthRegion}**: authorised = ${
            data.workAuthorized === "yes" ? "Yes" : "No"
          }, needs sponsorship = ${data.requiresSponsorship === "yes" ? "Yes" : "No"}. ` +
          `For a role based anywhere else, the answer is UNKNOWN.`
        : "")
    : "- **Work authorisation**: UNKNOWN — the profile does not say. Leave every work-authorisation question blank.";

  const profile = [
    line("Full name", data.fullName),
    line("First name", data.firstName),
    line("Last name", data.lastName),
    line("Email", data.email),
    line("Phone", data.phone),
    line("City", data.city),
    line("LinkedIn", data.linkedin),
    line("GitHub", data.github),
    line("Website/Portfolio", data.website),
    workAuth,
  ]
    .filter(Boolean)
    .join("\n");

  return `You are an autonomous job application agent. You are filling out the application form for "${job.title}" at ${job.company} on behalf of the candidate, in a real browser, using the tools provided.

## Candidate profile (the ONLY facts you may enter)
${profile}

## Documents
- Resume PDF: ${resumePath ?? "not available — skip resume uploads and say so"}

## Job
- Title: ${job.title}
- Company: ${job.company}
- Location: ${job.location ?? "unspecified"}
- Remote: ${job.remote ? "Yes" : "No"}
- URL: ${job.url}

## How to work
1. Call get_page_structure first; call it again whenever the page changes.
2. Find and click the Apply button if you are not already on the form.
3. Fill every required field (marked * or otherwise indicated).
4. Scroll to find fields below the fold.
5. Upload the resume when a file input appears.
6. For demographic/EEO questions choose "I prefer not to say" or "Decline to self-identify".
7. **Before clicking any final Submit/Apply/Send button, call request_user_confirmation** with a summary of every field you filled.
8. Only after the confirmation comes back approved may you click Submit; then call mark_done with success=true.
9. On a CAPTCHA, a login wall, or anything you cannot handle, call mark_done with success=false and say why.

## Hard rules
- Never invent a fact. Everything you type must come from the candidate profile above or be a direct, truthful restatement of it. If a required field has no answer in the profile — salary expectations, GPA, years of experience, work authorisation marked UNKNOWN — leave it blank and call mark_done with success=false explaining what the human must supply.
- Work authorisation: answer those questions only if this posting is based in the region the profile names. Otherwise leave them blank and report them — a wrong answer here is a false statement on a legal document.
- Never write an essay claiming experience that is not in the profile. For open-text questions, answer briefly and only from the profile; if the profile does not support an answer, leave it blank and report it.
- Never click Submit before an approved request_user_confirmation. Calling mark_done with success=true without one is a protocol violation and will be recorded as an incomplete application.
${dryRun ? "- **DRY RUN**: this run cannot submit. Fill the form, then call request_user_confirmation; it will come back declined, and that is the expected end of the run." : ""}`;
}

// ---------------------------------------------------------------------------
// Browser tool implementations
// ---------------------------------------------------------------------------

async function captureScreen(page: AgentPage): Promise<Buffer | null> {
  try {
    return await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
  } catch {
    return null;
  }
}

/**
 * A text description of every interactive element, which is what the model
 * actually steers by — the screenshot is a sanity check, not the primary
 * signal (and costs ~20× the tokens).
 */
export async function extractPageStructure(page: AgentPage): Promise<string> {
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "(unavailable)";
  }

  let elements: string[] = [];
  try {
    elements = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("input, textarea, select").forEach((el) => {
        const e = el as HTMLInputElement;
        const type = e.type ?? el.tagName.toLowerCase();
        const id = e.id ? `#${e.id}` : "";
        const name = e.name ? `[name="${e.name}"]` : "";
        const placeholder = e.placeholder ?? "";
        const label = (() => {
          if (e.id) {
            const l = document.querySelector(`label[for="${e.id}"]`);
            if (l) return l.textContent?.trim() ?? "";
          }
          return el.closest("label")?.textContent?.trim()?.slice(0, 60) ?? "";
        })();
        const required = e.required ? " [REQUIRED]" : "";
        out.push(`${type}${id}${name} label="${label}" placeholder="${placeholder}"${required}`);
      });
      document.querySelectorAll('button, a[href*="apply"], [role="button"]').forEach((el) => {
        const text = el.textContent?.trim()?.slice(0, 60) ?? "";
        if (text) out.push(`button/link: "${text}"`);
      });
      return out;
    });
  } catch (err) {
    return `URL: ${url}\nTitle: ${title}\n\n(could not read the page: ${errorText(err)})`;
  }

  return `URL: ${url}\nTitle: ${title}\n\nElements:\n${elements.slice(0, MAX_ELEMENTS).join("\n")}`;
}

async function doClick(page: AgentPage, input: Record<string, unknown>): Promise<string> {
  const selector = typeof input.selector === "string" ? input.selector : undefined;
  const text = typeof input.text === "string" ? input.text : undefined;

  if (selector) {
    try {
      await page.click(selector, { timeout: 5000 });
      return `Clicked: ${selector}`;
    } catch {
      // fall through to the text-based attempt
    }
  }
  if (text) {
    try {
      // Playwright's own text engine, so the fallback needs no extra page API.
      await page.click(`text=${text}`, { timeout: 5000 });
      return `Clicked by text: "${text}"`;
    } catch {
      await page.click(`role=button[name="${text}"]`, { timeout: 5000 });
      return `Clicked button: "${text}"`;
    }
  }
  throw new Error("click_element needs a selector or text");
}

async function doFill(page: AgentPage, input: Record<string, unknown>): Promise<string> {
  const selector = String(input.selector ?? "");
  const value = String(input.value ?? "");
  if (input.clear_first !== false) await page.fill(selector, "");
  await page.fill(selector, value);
  return `Filled "${selector}" with "${value.slice(0, 40)}${value.length > 40 ? "…" : ""}"`;
}

async function doSelect(page: AgentPage, input: Record<string, unknown>): Promise<string> {
  const selector = String(input.selector ?? "");
  const value = String(input.value ?? "");
  try {
    await page.selectOption(selector, { value });
    return `Selected value="${value}" in ${selector}`;
  } catch {
    await page.selectOption(selector, { label: value });
    return `Selected label="${value}" in ${selector}`;
  }
}

/**
 * Only the resume can be uploaded. v1 also wired up a cover letter and a
 * transcript from hardcoded paths; ApplyOps has neither in the data model, and
 * uploading the wrong person's PDF is worse than uploading nothing. The enum
 * keeps v1's shape so the model can still *ask*, and gets told no.
 */
async function doUpload(
  page: AgentPage,
  input: Record<string, unknown>,
  resumePath: string | null,
): Promise<string> {
  const selector = String(input.selector ?? "");
  const doc = String(input.document ?? "resume");
  if (doc !== "resume") {
    return `Skipped: only the resume is available to upload (asked for ${doc}).`;
  }
  if (!resumePath) return "Skipped: no resume PDF is available for this application.";
  await page.setInputFiles(selector, resumePath);
  return `Uploaded resume to ${selector}`;
}

async function doScroll(page: AgentPage, input: Record<string, unknown>): Promise<string> {
  const dir = input.direction === "up" ? "up" : "down";
  const px = typeof input.pixels === "number" && Number.isFinite(input.pixels) ? input.pixels : 600;
  const delta = dir === "down" ? px : -px;
  await page.evaluate((d: number) => window.scrollBy(0, d), delta);
  await page.waitForTimeout(300);
  return `Scrolled ${dir} ${px}px`;
}

async function doNavigate(page: AgentPage, input: Record<string, unknown>): Promise<string> {
  const url = String(input.url ?? "");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  return `Navigated to ${page.url()}`;
}

async function doWait(page: AgentPage, input: Record<string, unknown>): Promise<string> {
  const selector = typeof input.selector === "string" ? input.selector : undefined;
  const seconds = Math.min(
    typeof input.seconds === "number" && Number.isFinite(input.seconds) ? input.seconds : 2,
    10,
  );
  if (selector) {
    try {
      await page.waitForSelector(selector, { timeout: seconds * 1000 });
      return `Element "${selector}" appeared`;
    } catch {
      return `Timed out waiting for "${selector}" — continuing`;
    }
  }
  await page.waitForTimeout(seconds * 1000);
  return `Waited ${seconds}s`;
}
