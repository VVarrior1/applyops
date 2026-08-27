import { describe, it, expect } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { APICallError } from "ai";
import { z } from "zod";
import { generations, profiles, usageDaily } from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import { LlmError } from "../../src/llm/model-id";
import { BudgetExceededError } from "../../src/llm/budget";
import { callStructured } from "../../src/llm/call";

const schema = z.object({ ok: z.boolean(), note: z.string().optional() });

/**
 * Fake drizzle surface covering exactly what call.ts + budget.ts touch:
 *   db.insert(t).values({...}).returning({...})      (generations)
 *   db.insert(t).values({...}).onConflictDoUpdate()  (usage_daily)
 *   db.select({...}).from(t).where(...).limit(1)     (budget state)
 */
function fakeDb(
  rows: {
    profiles?: Record<string, unknown>[];
    usageDaily?: Record<string, unknown>[];
  } = {},
) {
  const genRows: Record<string, unknown>[] = [];
  const usageRows: Record<string, unknown>[] = [];
  let n = 0;
  const db = {
    select() {
      let picked: Record<string, unknown>[] = [];
      const q = {
        from(table: unknown) {
          picked =
            table === profiles
              ? (rows.profiles ?? [])
              : table === usageDaily
                ? (rows.usageDaily ?? [])
                : [];
          return q;
        },
        where: () => q,
        limit: async () => picked,
      };
      return q;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === generations) genRows.push(values);
          else usageRows.push(values);
          return {
            returning: async () => [{ id: `gen-${++n}` }],
            onConflictDoUpdate: async () => undefined,
          };
        },
      };
    },
  };
  return { db: db as unknown as Db, genRows, usageRows };
}

/** A mock language model whose replies are scripted, one per attempt. */
function scriptedModel(replies: (string | Error)[]) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const reply = replies[Math.min(i, replies.length - 1)];
      i += 1;
      if (reply instanceof Error) throw reply;
      return {
        content: [{ type: "text" as const, text: reply }],
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        usage: {
          inputTokens: {
            total: 2000,
            noCache: 2000,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 400, text: 400, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

function apiError(statusCode: number) {
  return new APICallError({
    message: `HTTP ${statusCode} from provider`,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode,
  });
}

const baseArgs = {
  step: "analyze" as const,
  modelId: "anthropic:claude-haiku-4-5" as const,
  schema,
  system: "You are a job analyst.",
  prompt: "Reply with ok true.",
  promptVersionId: "11111111-1111-4111-8111-111111111111",
};

describe("callStructured — happy path", () => {
  it("parses the model's JSON and records a generations row with a real cost", async () => {
    const { db, genRows, usageRows } = fakeDb();
    const model = scriptedModel(['{"ok":true,"note":"hi"}']);

    const result = await callStructured({
      db,
      userId: null,
      jobId: "22222222-2222-4222-8222-222222222222",
      ...baseArgs,
      _internal: { model },
    });

    expect(result.output).toEqual({ ok: true, note: "hi" });
    expect(result.generationId).toBe("gen-1");
    expect(result.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 400,
      cachedInputTokens: 0,
    });
    // 2000/1e6 * 1.00 + 400/1e6 * 5.00 = 0.002 + 0.002
    expect(result.costUsd).toBe(0.004);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(genRows).toHaveLength(1);
    expect(genRows[0]).toMatchObject({
      userId: null,
      jobId: "22222222-2222-4222-8222-222222222222",
      step: "analyze",
      modelId: "anthropic:claude-haiku-4-5",
      promptVersionId: baseArgs.promptVersionId,
      inputTokens: 2000,
      outputTokens: 400,
      error: null,
    });
    expect(Number(genRows[0].costUsd)).toBeGreaterThan(0);
    expect(genRows[0].output).toEqual({ ok: true, note: "hi" });

    // userId null (owner CLI / eval) never touches usage_daily
    expect(usageRows).toHaveLength(0);
  });

  it("uses the per-step default model when no modelId is given", async () => {
    const { db, genRows } = fakeDb();
    await callStructured({
      db,
      userId: null,
      step: "tailor",
      schema,
      system: "s",
      prompt: "p",
      promptVersionId: baseArgs.promptVersionId,
      _internal: { model: scriptedModel(['{"ok":true}']) },
    });
    expect(genRows[0].modelId).toBe("anthropic:claude-sonnet-5");
  });

  it("charges a real user's usage_daily after a successful call", async () => {
    const { db, usageRows } = fakeDb({
      profiles: [{ dailyBudgetUsd: "1.00" }],
    });
    await callStructured({
      db,
      userId: "33333333-3333-4333-8333-333333333333",
      ...baseArgs,
      _internal: { model: scriptedModel(['{"ok":true}']) },
    });
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      userId: "33333333-3333-4333-8333-333333333333",
      calls: 1,
    });
    expect(Number(usageRows[0].costUsd)).toBeGreaterThan(0);
  });
});

describe("callStructured — schema repair retry", () => {
  it("retries exactly once with the zod error appended, then succeeds", async () => {
    const { db, genRows } = fakeDb();
    const model = scriptedModel(["I am not JSON.", '{"ok":true}']);

    const result = await callStructured({
      db,
      userId: null,
      ...baseArgs,
      _internal: { model },
    });

    expect(result.output).toEqual({ ok: true });
    expect(model.doGenerateCalls).toHaveLength(2);

    const first = JSON.stringify(model.doGenerateCalls[0].prompt);
    const second = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(first).not.toContain("could not be parsed");
    expect(second).toContain("could not be parsed");

    // Tokens burned by the failed attempt are still billed.
    expect(result.usage.inputTokens).toBe(4000);
    expect(result.usage.outputTokens).toBe(800);
    expect(genRows).toHaveLength(1);
    expect(genRows[0].error).toBeNull();
  });

  it("repairs a reply that parses as JSON but violates the schema", async () => {
    const { db } = fakeDb();
    const model = scriptedModel(['{"ok":"yes"}', '{"ok":false}']);
    const result = await callStructured({
      db,
      userId: null,
      ...baseArgs,
      _internal: { model },
    });
    expect(result.output).toEqual({ ok: false });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("gives up after one repair attempt and records the failure", async () => {
    const { db, genRows } = fakeDb();
    const model = scriptedModel(["nope", "still nope", '{"ok":true}']);

    await expect(
      callStructured({ db, userId: null, ...baseArgs, _internal: { model } }),
    ).rejects.toBeInstanceOf(LlmError);

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(genRows).toHaveLength(1);
    expect(genRows[0].error).toBeTruthy();
    expect(genRows[0].output).toBeNull();
  });
});

describe("callStructured — transient provider errors", () => {
  it("retries a 429 with exponential backoff and succeeds on the third attempt", async () => {
    const { db } = fakeDb();
    const slept: number[] = [];
    const model = scriptedModel([apiError(429), apiError(503), '{"ok":true}']);

    const result = await callStructured({
      db,
      userId: null,
      ...baseArgs,
      _internal: {
        model,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
      },
    });

    expect(result.output).toEqual({ ok: true });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(slept).toEqual([500, 1000]);
  });

  it("stops after the configured number of retries", async () => {
    const { db, genRows } = fakeDb();
    const slept: number[] = [];
    const model = scriptedModel([apiError(500)]);

    await expect(
      callStructured({
        db,
        userId: null,
        ...baseArgs,
        _internal: {
          model,
          sleep: async (ms: number) => {
            slept.push(ms);
          },
        },
      }),
    ).rejects.toBeInstanceOf(LlmError);

    expect(model.doGenerateCalls).toHaveLength(3); // 1 attempt + 2 retries
    expect(slept).toEqual([500, 1000]);
    expect(genRows).toHaveLength(1);
    expect(genRows[0].error).toContain("500");
  });

  it("honours an explicit maxRetries of 0", async () => {
    const { db } = fakeDb();
    const model = scriptedModel([apiError(429)]);
    await expect(
      callStructured({
        db,
        userId: null,
        ...baseArgs,
        maxRetries: 0,
        _internal: { model, sleep: async () => {} },
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("never retries a non-429 4xx", async () => {
    const { db, genRows } = fakeDb();
    const model = scriptedModel([apiError(400)]);

    await expect(
      callStructured({
        db,
        userId: null,
        ...baseArgs,
        _internal: { model, sleep: async () => {} },
      }),
    ).rejects.toBeInstanceOf(LlmError);

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(genRows).toHaveLength(1);
    expect(genRows[0].error).toBeTruthy();
  });
});

describe("callStructured — budget", () => {
  it("refuses to call the model when the user is out of budget", async () => {
    const { db, genRows } = fakeDb({
      profiles: [{ dailyBudgetUsd: "1.00" }],
      usageDaily: [{ costUsd: "1.000000", calls: 40 }],
    });
    const model = scriptedModel(['{"ok":true}']);

    await expect(
      callStructured({
        db,
        userId: "33333333-3333-4333-8333-333333333333",
        ...baseArgs,
        _internal: { model },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(genRows).toHaveLength(0);
  });

  it("bypasses the budget for the null (owner CLI / eval) user", async () => {
    const { db } = fakeDb({
      profiles: [{ dailyBudgetUsd: "0.00" }],
      usageDaily: [{ costUsd: "99.000000", calls: 1 }],
    });
    const result = await callStructured({
      db,
      userId: null,
      ...baseArgs,
      _internal: { model: scriptedModel(['{"ok":true}']) },
    });
    expect(result.output).toEqual({ ok: true });
  });
});

describe("callStructured — validation", () => {
  it("rejects an unparseable model id before touching the database", async () => {
    const { db, genRows } = fakeDb();
    await expect(
      callStructured({
        db,
        userId: null,
        ...baseArgs,
        modelId: "mistral:large" as never,
        _internal: { model: scriptedModel(['{"ok":true}']) },
      }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(genRows).toHaveLength(0);
  });
});
