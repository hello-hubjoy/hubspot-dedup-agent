import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveAIProvider } from "../src/ai-config.js";
import { validateClassification } from "../src/ai-common.js";

describe("resolveAIProvider", () => {
  test("selects Anthropic when only its key is set", () => {
    assert.equal(resolveAIProvider({ ANTHROPIC_API_KEY: "anthropic-key" }), "anthropic");
  });

  test("selects OpenAI when only its key is set", () => {
    assert.equal(resolveAIProvider({ OPENAI_API_KEY: "openai-key" }), "openai");
  });

  test("uses AI_PROVIDER when both keys are set", () => {
    const env = {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      AI_PROVIDER: "openai",
    };
    assert.equal(resolveAIProvider(env), "openai");
  });

  test("rejects two keys without an explicit provider", () => {
    assert.throws(
      () => resolveAIProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }),
      /Both AI keys are set/,
    );
  });

  test("rejects a provider whose key is missing", () => {
    assert.throws(
      () => resolveAIProvider({ AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "a" }),
      /OPENAI_API_KEY is missing/,
    );
  });

  test("rejects missing keys", () => {
    assert.throws(() => resolveAIProvider({}), /Set either ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  });
});

describe("validateClassification", () => {
  test("normalizes a valid provider response", () => {
    assert.deepEqual(
      validateClassification({
        decision: "REVIEW",
        reason: "  Similar names need human review.  ",
        confidence: "medium",
      }),
      {
        decision: "REVIEW",
        reason: "Similar names need human review.",
        confidence: "medium",
      },
    );
  });

  test("rejects output outside the shared schema", () => {
    assert.equal(
      validateClassification({ decision: "MERGE", reason: "Looks close", confidence: "high" }),
      null,
    );
  });
});
