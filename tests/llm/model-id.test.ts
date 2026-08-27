import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDERS,
  LlmError,
  formatModelId,
  isModelId,
  isProvider,
  parseModelId,
} from "../../src/llm/model-id";

describe("parseModelId", () => {
  it("splits a well-formed id into provider and model", () => {
    expect(parseModelId("google:gemini-3.7-flash")).toEqual({
      provider: "google",
      model: "gemini-3.7-flash",
    });
    expect(parseModelId("anthropic:claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(parseModelId("openai:gpt-5.4-nano")).toEqual({
      provider: "openai",
      model: "gpt-5.4-nano",
    });
  });

  it("keeps colons that belong to the model name", () => {
    expect(parseModelId("openai:ft:gpt-5.4-mini:acme")).toEqual({
      provider: "openai",
      model: "ft:gpt-5.4-mini:acme",
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseModelId("  anthropic:claude-sonnet-5  ")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it("throws on a missing separator", () => {
    expect(() => parseModelId("claude-haiku-4-5")).toThrow(LlmError);
  });

  it("throws on an unknown provider", () => {
    expect(() => parseModelId("mistral:large")).toThrow(LlmError);
    expect(() => parseModelId("Anthropic:claude-haiku-4-5")).toThrow(LlmError);
  });

  it("throws on an empty model name", () => {
    expect(() => parseModelId("anthropic:")).toThrow(LlmError);
    expect(() => parseModelId("anthropic:   ")).toThrow(LlmError);
  });

  it("throws on an empty string", () => {
    expect(() => parseModelId("")).toThrow(LlmError);
  });

  it("tags the thrown error with code invalid_model_id", () => {
    try {
      parseModelId("nope");
      throw new Error("expected parseModelId to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe("invalid_model_id");
    }
  });
});

describe("isProvider / isModelId / formatModelId", () => {
  it("recognises exactly the three supported providers", () => {
    expect([...LLM_PROVIDERS]).toEqual(["anthropic", "google", "openai"]);
    for (const p of LLM_PROVIDERS) expect(isProvider(p)).toBe(true);
    expect(isProvider("mistral")).toBe(false);
  });

  it("isModelId is a non-throwing form of parseModelId", () => {
    expect(isModelId("anthropic:claude-haiku-4-5")).toBe(true);
    expect(isModelId("mistral:large")).toBe(false);
    expect(isModelId("anthropic:")).toBe(false);
  });

  it("formatModelId round-trips through parseModelId", () => {
    const id = formatModelId("google", "gemini-2.5-flash");
    expect(id).toBe("google:gemini-2.5-flash");
    expect(parseModelId(id)).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
    });
  });
});
