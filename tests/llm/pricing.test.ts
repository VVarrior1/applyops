import { describe, it, expect } from "vitest";
import { LlmError, type ModelId } from "../../src/llm/model-id";
import {
  KNOWN_MODEL_IDS,
  PRICING,
  estimateCost,
  estimateTokens,
  getPricing,
} from "../../src/llm/pricing";

describe("PRICING table", () => {
  it("carries the seven models the plan priced on 2026-08-27", () => {
    expect([...KNOWN_MODEL_IDS].sort()).toEqual(
      [
        "anthropic:claude-haiku-4-5",
        "anthropic:claude-sonnet-5",
        "google:gemini-2.5-flash",
        "google:gemini-2.5-flash-lite",
        "google:gemini-3.7-flash",
        "openai:gpt-5.4-mini",
        "openai:gpt-5.4-nano",
      ].sort(),
    );
  });

  it("matches the plan's per-1M USD figures", () => {
    expect(PRICING["anthropic:claude-haiku-4-5"]).toEqual({
      inputPerM: 1.0,
      outputPerM: 5.0,
      cachedInputPerM: 0.1,
    });
    expect(PRICING["anthropic:claude-sonnet-5"]).toEqual({
      inputPerM: 2.0,
      outputPerM: 10.0,
      cachedInputPerM: 0.2,
    });
    expect(PRICING["google:gemini-3.7-flash"]).toEqual({
      inputPerM: 0.75,
      outputPerM: 3.75,
      cachedInputPerM: 0.075,
    });
    expect(PRICING["google:gemini-2.5-flash-lite"]).toEqual({
      inputPerM: 0.1,
      outputPerM: 0.4,
      cachedInputPerM: 0.01,
    });
    expect(PRICING["google:gemini-2.5-flash"]).toEqual({
      inputPerM: 0.3,
      outputPerM: 2.5,
      cachedInputPerM: 0.03,
    });
    expect(PRICING["openai:gpt-5.4-mini"]).toEqual({
      inputPerM: 0.75,
      outputPerM: 4.5,
      cachedInputPerM: 0.075,
    });
    expect(PRICING["openai:gpt-5.4-nano"]).toEqual({
      inputPerM: 0.2,
      outputPerM: 1.25,
      cachedInputPerM: 0.02,
    });
  });

  it("prices every known id with a parseable provider prefix", () => {
    for (const id of KNOWN_MODEL_IDS) {
      const p = getPricing(id);
      expect(p).toBeDefined();
      expect(p!.inputPerM).toBeGreaterThan(0);
      expect(p!.outputPerM).toBeGreaterThan(0);
    }
  });

  it("getPricing returns undefined for an unpriced id", () => {
    expect(getPricing("anthropic:claude-does-not-exist")).toBeUndefined();
    expect(getPricing("not-a-model-id")).toBeUndefined();
  });
});

describe("estimateCost", () => {
  it("charges 1M haiku input tokens at exactly $1.00", () => {
    expect(
      estimateCost("anthropic:claude-haiku-4-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(1.0);
  });

  it("charges input and output separately", () => {
    expect(
      estimateCost("anthropic:claude-sonnet-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(12.0);
  });

  it("charges cached input at the cached rate", () => {
    expect(
      estimateCost("anthropic:claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
      }),
    ).toBe(0.1);
  });

  it("handles a realistic small call", () => {
    // 3,000 in / 800 out on haiku = 3000/1e6*1 + 800/1e6*5 = 0.003 + 0.004
    expect(
      estimateCost("anthropic:claude-haiku-4-5", {
        inputTokens: 3_000,
        outputTokens: 800,
      }),
    ).toBe(0.007);
  });

  it("returns 0 for a zero-token call", () => {
    expect(
      estimateCost("google:gemini-2.5-flash-lite", {
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it("clamps negative token counts to zero", () => {
    expect(
      estimateCost("openai:gpt-5.4-nano", {
        inputTokens: -100,
        outputTokens: -1,
      }),
    ).toBe(0);
  });

  it("rounds to six decimals so it fits numeric(10,6)", () => {
    const cost = estimateCost("openai:gpt-5.4-nano", {
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(cost).toBe(Number(cost.toFixed(6)));
  });

  it("throws LlmError for a model with no pricing row", () => {
    expect(() =>
      estimateCost("anthropic:claude-unpriced" as ModelId, {
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow(LlmError);
  });
});

describe("estimateTokens", () => {
  it("approximates ~4 characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });

  it("never returns a fraction", () => {
    expect(Number.isInteger(estimateTokens("abcde"))).toBe(true);
  });
});
