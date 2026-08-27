import { describe, it, expect } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { APICallError } from "ai";
import {
  runToolLoop,
  isSubmitLike,
  APPLY_TOOL_NAMES,
  type AgentPage,
  type ConfirmationRequest,
} from "../../src/agent/tool-loop";
import type { ApplicantData } from "../../src/agent/ats-fastpath";

type ScriptTurn =
  | { text: string }
  | { calls: { name: string; input: Record<string, unknown> }[] }
  | Error;

/** A mock model that replays a fixed script of turns, one per `doGenerate`. */
function scriptedModel(turns: ScriptTurn[]) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      if (turn instanceof Error) throw turn;
      const content =
        "text" in turn
          ? [{ type: "text" as const, text: turn.text }]
          : turn.calls.map((c, n) => ({
              type: "tool-call" as const,
              toolCallId: `call-${i}-${n}`,
              toolName: c.name,
              input: JSON.stringify(c.input),
            }));
      return {
        content,
        finishReason: {
          unified: ("text" in turn ? "stop" : "tool-calls") as "stop" | "tool-calls",
          raw: "text" in turn ? "end_turn" : "tool_use",
        },
        usage: {
          inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 120, text: 120, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

/** A fake page recording what the loop did to the browser. */
function fakePage(url = "https://job-boards.greenhouse.io/acme/jobs/1") {
  const actions: string[] = [];
  const page = {
    url: () => url,
    title: async () => "Acme — Backend Engineer",
    goto: async (to: string) => {
      actions.push(`goto ${to}`);
      url = to;
      return null;
    },
    click: async (selector: string) => {
      actions.push(`click ${selector}`);
    },
    fill: async (selector: string, value: string) => {
      if (value !== "") actions.push(`fill ${selector}=${value}`);
    },
    selectOption: async (selector: string) => {
      actions.push(`select ${selector}`);
      return [];
    },
    setInputFiles: async (selector: string, files: string) => {
      actions.push(`upload ${selector}<-${files}`);
    },
    waitForSelector: async () => null,
    waitForTimeout: async () => {},
    evaluate: async () => ["input#email label=\"Email\" [REQUIRED]"],
    screenshot: async () => Buffer.from("jpegbytes"),
  };
  return { page: page as unknown as AgentPage, actions };
}

const data: ApplicantData = {
  firstName: "Ada",
  lastName: "Lovelace",
  fullName: "Ada Lovelace",
  email: "ada@example.test",
  phone: "555-0100",
  linkedin: null,
  github: null,
  website: null,
  city: "Calgary",
  currentOrg: null,
  workAuthorized: "yes",
  requiresSponsorship: "no",
  workAuthRegion: "Canada",
  workAuthLabel: "Authorised to work in Canada without sponsorship.",
};

const job = {
  title: "Backend Engineer",
  company: "Acme",
  location: "Calgary, AB",
  remote: false,
  url: "https://job-boards.greenhouse.io/acme/jobs/1",
};

function baseOpts(model: MockLanguageModelV3, over: Record<string, unknown> = {}) {
  return {
    job,
    data,
    resumePath: "/tmp/resume.pdf",
    maxSteps: 6,
    onConfirm: async () => true,
    _internal: { model, sleep: async () => {} },
    ...over,
  };
}

describe("tool definitions", () => {
  it("exposes exactly the ten tools the spec names", () => {
    expect(APPLY_TOOL_NAMES).toEqual([
      "get_page_structure",
      "click_element",
      "fill_input",
      "select_option",
      "upload_file",
      "scroll_page",
      "navigate_to",
      "wait_for_page",
      "request_user_confirmation",
      "mark_done",
    ]);
  });
});

describe("runToolLoop — the approval gate", () => {
  it("records applied only after an approved confirmation", async () => {
    const { page } = fakePage();
    const seen: ConfirmationRequest[] = [];
    const model = scriptedModel([
      { calls: [{ name: "fill_input", input: { selector: "input#email", value: "ada@example.test" } }] },
      { calls: [{ name: "request_user_confirmation", input: { message: "Email + resume filled." } }] },
      { calls: [{ name: "mark_done", input: { success: true, notes: "Confirmation #A1" } }] },
    ]);

    const result = await runToolLoop(
      page,
      baseOpts(model, {
        onConfirm: async (req: ConfirmationRequest) => {
          seen.push(req);
          return true;
        },
      }) as never,
    );

    expect(result.status).toBe("applied");
    expect(result.approved).toBe(true);
    expect(result.notes).toBe("Confirmation #A1");
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("Email + resume filled.");
    expect(seen[0].screenshot?.toString()).toBe("jpegbytes");
    expect(seen[0].dryRun).toBe(false);
  });

  it("returns skipped when the human declines", async () => {
    const { page } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "request_user_confirmation", input: { message: "Ready" } }] },
    ]);
    const result = await runToolLoop(page, baseOpts(model, { onConfirm: async () => false }) as never);
    expect(result.status).toBe("skipped");
    expect(result.approved).toBe(false);
    expect(result.notes).toBe("Declined at the approval gate.");
  });

  it("a dry run can never come back approved, even if the handler says yes", async () => {
    const { page } = fakePage();
    const seen: ConfirmationRequest[] = [];
    const model = scriptedModel([
      { calls: [{ name: "request_user_confirmation", input: { message: "Ready" } }] },
      { calls: [{ name: "mark_done", input: { success: true } }] },
    ]);

    const result = await runToolLoop(
      page,
      baseOpts(model, {
        dryRun: true,
        onConfirm: async (req: ConfirmationRequest) => {
          seen.push(req);
          return true; // a buggy handler
        },
      }) as never,
    );

    expect(result.status).toBe("skipped");
    expect(result.approved).toBe(false);
    expect(seen[0].dryRun).toBe(true);
    // The screenshot and summary still reach the handler, so the approvals row
    // and the review JPEG are written for a dry run too.
    expect(seen[0].screenshot).not.toBeNull();
  });

  it("downgrades a success claimed without an approval to needs_manual", async () => {
    const { page } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "mark_done", input: { success: true, notes: "submitted!" } }] },
    ]);
    const result = await runToolLoop(page, baseOpts(model) as never);
    expect(result.status).toBe("needs_manual");
    expect(result.approved).toBe(false);
    expect(result.notes).toContain("without an approval on record");
  });

  it("maps mark_done(success=false) to needs_manual with the model's reason", async () => {
    const { page } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "mark_done", input: { success: false, notes: "hCaptcha wall" } }] },
    ]);
    const result = await runToolLoop(page, baseOpts(model) as never);
    expect(result.status).toBe("needs_manual");
    expect(result.notes).toBe("hCaptcha wall");
  });
});

describe("runToolLoop — browser tools", () => {
  it("executes fill/upload/click/select against the page", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      {
        calls: [
          { name: "get_page_structure", input: {} },
          { name: "fill_input", input: { selector: "input#email", value: "ada@example.test" } },
          { name: "upload_file", input: { selector: "input#resume", document: "resume" } },
          { name: "select_option", input: { selector: "select#country", value: "Canada" } },
          { name: "click_element", input: { selector: "button#next" } },
        ],
      },
      { calls: [{ name: "mark_done", input: { success: false, notes: "done poking" } }] },
    ]);

    const result = await runToolLoop(page, baseOpts(model) as never);
    expect(actions).toEqual([
      "fill input#email=ada@example.test",
      "upload input#resume<-/tmp/resume.pdf",
      "select select#country",
      "click button#next",
    ]);
    expect(result.steps).toBe(2);
    // Two model turns at 1000/120 tokens each.
    expect(result.usage.inputTokens).toBe(2000);
    expect(result.usage.outputTokens).toBe(240);
  });

  it("refuses to upload anything but the resume", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "upload_file", input: { selector: "input#cl", document: "cover_letter" } }] },
      { calls: [{ name: "mark_done", input: { success: false } }] },
    ]);
    await runToolLoop(page, baseOpts(model) as never);
    expect(actions).toEqual([]);
  });

  it("skips the resume upload when there is no resume on file", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "upload_file", input: { selector: "input#r", document: "resume" } }] },
      { calls: [{ name: "mark_done", input: { success: false } }] },
    ]);
    await runToolLoop(page, baseOpts(model, { resumePath: null }) as never);
    expect(actions).toEqual([]);
  });
});

describe("runToolLoop — endings that are not a submission", () => {
  it("stops at the step cap with needs_manual", async () => {
    const { page } = fakePage();
    const model = scriptedModel([{ calls: [{ name: "get_page_structure", input: {} }] }]);
    const result = await runToolLoop(page, baseOpts(model, { maxSteps: 3 }) as never);
    expect(result.status).toBe("needs_manual");
    expect(result.steps).toBe(3);
    expect(result.notes).toContain("3-step cap");
  });

  it("treats a prose-only reply as needs_manual, not as a failure", async () => {
    const { page } = fakePage();
    const model = scriptedModel([{ text: "I think you should apply by email." }]);
    const result = await runToolLoop(page, baseOpts(model) as never);
    expect(result.status).toBe("needs_manual");
    expect(result.notes).toContain("without a tool call");
  });

  it("retries a 429 and then succeeds", async () => {
    const { page } = fakePage();
    const rateLimited = new APICallError({
      message: "HTTP 429",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode: 429,
    });
    const model = scriptedModel([
      rateLimited,
      { calls: [{ name: "mark_done", input: { success: false, notes: "ok after retry" } }] },
    ]);
    const result = await runToolLoop(page, baseOpts(model) as never);
    expect(result.status).toBe("needs_manual");
    expect(result.notes).toBe("ok after retry");
  });

  it("fails (without retrying) on a non-transient provider error", async () => {
    const { page } = fakePage();
    const badRequest = new APICallError({
      message: "HTTP 400 credit balance is too low",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode: 400,
    });
    const model = scriptedModel([badRequest]);
    const result = await runToolLoop(page, baseOpts(model) as never);
    expect(result.status).toBe("failed");
    expect(result.notes).toContain("credit balance is too low");
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe("isSubmitLike", () => {
  it("gates the unambiguous submit shapes regardless of form state", () => {
    for (const input of [
      { selector: "button[type=submit]" },
      { selector: 'input[type="submit"]' },
      { selector: "#submit-application" },
      { text: "Submit Application" },
      { text: "Send Application" },
      { text: "Send" },
    ]) {
      expect(isSubmitLike(input, false)).toBe(true);
    }
  });

  it("lets an Apply click through until something has been filled", () => {
    // On a Lever/Ashby posting page "Apply for this job" opens the form; gating
    // it would leave the agent unable to reach any form at all.
    expect(isSubmitLike({ text: "Apply for this job" }, false)).toBe(false);
    expect(isSubmitLike({ selector: "#apply-btn" }, false)).toBe(false);
    // Once fields hold data an "Apply" button can be the terminal action.
    expect(isSubmitLike({ text: "Apply for this job" }, true)).toBe(true);
    expect(isSubmitLike({ selector: "#apply-btn" }, true)).toBe(true);
  });

  it("does not gate ordinary form navigation", () => {
    expect(isSubmitLike({ selector: "button#next" }, true)).toBe(false);
    expect(isSubmitLike({ text: "Continue" }, true)).toBe(false);
    expect(isSubmitLike({ selector: "input#resume" }, true)).toBe(false);
  });
});

describe("runToolLoop — the approval gate cannot be walked around", () => {
  // Regression for the review blocker: `done` was set inside the tool-call
  // loop but only read after it, and `break` inside the switch leaves only the
  // switch. A single turn of [confirm, submit-click] therefore clicked Submit
  // after the human said no — in a dry run too.
  for (const dryRun of [false, true]) {
    it(`does not click submit when the same turn's confirmation is declined (dryRun=${dryRun})`, async () => {
      const { page, actions } = fakePage();
      const model = scriptedModel([
        {
          calls: [
            { name: "request_user_confirmation", input: { message: "Ready to submit" } },
            { name: "click_element", input: { selector: "button[type=submit]" } },
          ],
        },
      ]);

      const result = await runToolLoop(
        page,
        baseOpts(model, { dryRun, onConfirm: async () => false }) as never,
      );

      expect(result.status).toBe("skipped");
      expect(result.approved).toBe(false);
      expect(actions).toEqual([]);
    });
  }

  it("ignores a dry run's buggy 'approved' handler in the same turn", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      {
        calls: [
          { name: "request_user_confirmation", input: { message: "Ready" } },
          { name: "click_element", input: { text: "Submit Application" } },
          { name: "mark_done", input: { success: true, notes: "sent" } },
        ],
      },
    ]);

    const result = await runToolLoop(
      page,
      baseOpts(model, { dryRun: true, onConfirm: async () => true }) as never,
    );

    expect(result.status).toBe("skipped");
    expect(result.approved).toBe(false);
    expect(actions).toEqual([]);
  });

  it("refuses a submit click that was never confirmed at all", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "click_element", input: { selector: "button[type=submit]" } }] },
      { calls: [{ name: "mark_done", input: { success: false, notes: "gate refused it" } }] },
    ]);

    const result = await runToolLoop(page, baseOpts(model) as never);
    expect(actions).toEqual([]);
    expect(result.status).toBe("needs_manual");
  });

  it("executes nothing else in a turn once mark_done has ended the run", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      {
        calls: [
          { name: "mark_done", input: { success: false, notes: "captcha" } },
          { name: "fill_input", input: { selector: "input#email", value: "ada@example.test" } },
          { name: "click_element", input: { selector: "button#next" } },
        ],
      },
    ]);

    const result = await runToolLoop(page, baseOpts(model) as never);
    expect(result.notes).toBe("captcha");
    expect(actions).toEqual([]);
  });

  it("spends the approval on exactly one submit click", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "request_user_confirmation", input: { message: "Ready" } }] },
      { calls: [{ name: "click_element", input: { selector: "button[type=submit]" } }] },
      { calls: [{ name: "click_element", input: { selector: "button[type=submit]" } }] },
      { calls: [{ name: "mark_done", input: { success: true, notes: "Confirmation #B2" } }] },
    ]);

    const result = await runToolLoop(page, baseOpts(model, { onConfirm: async () => true }) as never);

    // The first click goes through; the second is refused because the ticket
    // was spent. The approval itself stays on record, so mark_done still lands.
    expect(actions).toEqual(["click button[type=submit]"]);
    expect(result.status).toBe("applied");
    expect(result.approved).toBe(true);
    expect(result.notes).toBe("Confirmation #B2");
  });

  it("allows the Apply click that opens the form, then gates it once filled", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "click_element", input: { text: "Apply for this job" } }] },
      { calls: [{ name: "fill_input", input: { selector: "input#email", value: "ada@example.test" } }] },
      { calls: [{ name: "click_element", input: { text: "Apply" } }] },
      { calls: [{ name: "mark_done", input: { success: false, notes: "needs approval" } }] },
    ]);

    await runToolLoop(page, baseOpts(model) as never);
    expect(actions).toEqual([
      "click text=Apply for this job",
      "fill input#email=ada@example.test",
    ]);
  });

  it("refuses a javascript: navigation", async () => {
    const { page, actions } = fakePage();
    const model = scriptedModel([
      { calls: [{ name: "navigate_to", input: { url: "javascript:document.forms[0].submit()" } }] },
      { calls: [{ name: "mark_done", input: { success: false } }] },
    ]);

    await runToolLoop(page, baseOpts(model) as never);
    expect(actions).toEqual([]);
  });
});
