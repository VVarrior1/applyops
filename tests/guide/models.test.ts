import { describe, it, expect } from "vitest";
import {
  buildModelOptions,
  labelFor,
  resolveChatModel,
  tierFor,
} from "../../src/guide/models";
import { PRICING } from "../../src/llm/pricing";
import type { Provider } from "../../src/llm/model-id";

const FAKE_PRICING = {
  "anthropic:claude-sonnet-5": { inputPerM: 2.0, outputPerM: 10.0 },
  "google:gemini-2.5-flash-lite": { inputPerM: 0.1, outputPerM: 0.4 },
  "google:gemini-3.7-flash": { inputPerM: 0.75, outputPerM: 3.75 },
  "openai:gpt-5.4-nano": { inputPerM: 0.2, outputPerM: 1.25 },
};

const only =
  (...providers: Provider[]) =>
  (provider: Provider) =>
    providers.includes(provider);

describe("buildModelOptions", () => {
  it("returns only models whose provider is configured", () => {
    const options = buildModelOptions(only("google"), FAKE_PRICING);
    expect(options.map((o) => o.id)).toEqual([
      "google:gemini-2.5-flash-lite",
      "google:gemini-3.7-flash",
    ]);
  });

  it("orders cheapest first across providers", () => {
    const options = buildModelOptions(only("google", "openai", "anthropic"), FAKE_PRICING);
    expect(options.map((o) => o.id)).toEqual([
      "google:gemini-2.5-flash-lite",
      "openai:gpt-5.4-nano",
      "google:gemini-3.7-flash",
      "anthropic:claude-sonnet-5",
    ]);
  });

  it("returns nothing when no provider has a key", () => {
    expect(buildModelOptions(() => false, FAKE_PRICING)).toEqual([]);
  });

  it("carries the prices through unchanged, for the UI to show", () => {
    const [cheapest] = buildModelOptions(only("google"), FAKE_PRICING);
    expect(cheapest.inputPerM).toBe(0.1);
    expect(cheapest.outputPerM).toBe(0.4);
  });

  it("labels quality tiers rather than implying cheapest is best", () => {
    const options = buildModelOptions(only("google", "anthropic"), FAKE_PRICING);
    const byId = Object.fromEntries(options.map((o) => [o.id, o.tier]));
    expect(byId["google:gemini-2.5-flash-lite"]).toBe("fast/cheap");
    expect(byId["google:gemini-3.7-flash"]).toBe("balanced");
    expect(byId["anthropic:claude-sonnet-5"]).toBe("strong");
  });

  it("skips a table entry that is not a valid model id", () => {
    const options = buildModelOptions(() => true, {
      ...FAKE_PRICING,
      "not-a-model-id": { inputPerM: 0.01, outputPerM: 0.01 },
    });
    expect(options.some((o) => String(o.id) === "not-a-model-id")).toBe(false);
  });

  it("works against the real pricing table", () => {
    const options = buildModelOptions(() => true);
    expect(options).toHaveLength(Object.keys(PRICING).length);
    const blended = options.map((o) => o.inputPerM * 0.75 + o.outputPerM * 0.25);
    expect([...blended].sort((a, b) => a - b)).toEqual(blended);
  });
});

describe("tierFor / labelFor", () => {
  it("bands by blended price", () => {
    expect(tierFor({ inputPerM: 0.1, outputPerM: 0.4 })).toBe("fast/cheap");
    expect(tierFor({ inputPerM: 0.75, outputPerM: 3.75 })).toBe("balanced");
    expect(tierFor({ inputPerM: 2, outputPerM: 10 })).toBe("strong");
  });

  it("derives a readable label from the id", () => {
    expect(labelFor("google:gemini-3.7-flash")).toBe("Gemini 3.7 Flash (google)");
    expect(labelFor("openai:gpt-5.4-nano")).toBe("GPT 5.4 Nano (openai)");
  });
});

describe("resolveChatModel", () => {
  const fallback = "google:gemini-3.7-flash" as const;

  it("accepts a model the user is allowed to pick", () => {
    expect(
      resolveChatModel("google:gemini-2.5-flash-lite", fallback, only("google"), FAKE_PRICING),
    ).toBe("google:gemini-2.5-flash-lite");
  });

  it("falls back when the id is missing, unpriced, or its provider has no key", () => {
    expect(resolveChatModel(null, fallback, only("google"), FAKE_PRICING)).toBe(fallback);
    expect(resolveChatModel("", fallback, only("google"), FAKE_PRICING)).toBe(fallback);
    expect(
      resolveChatModel("google:made-up-model", fallback, only("google"), FAKE_PRICING),
    ).toBe(fallback);
    expect(
      resolveChatModel("anthropic:claude-sonnet-5", fallback, only("google"), FAKE_PRICING),
    ).toBe(fallback);
  });
});
