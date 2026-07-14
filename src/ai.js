import {
  buildClassificationPrompt,
  collectSignals,
  isComplexClassification,
} from "./ai-common.js";

export { summarizeSignals } from "./ai-common.js";

// Returns { decision, reason, confidence } or null on provider failure.
export async function classifyPairWithAI(a, b, blockersList) {
  const { default: config } = await import("./config.js");
  const signals = collectSignals(a, b);
  const isComplex = isComplexClassification(a, b, signals);
  const prompt = buildClassificationPrompt(a, b, signals, blockersList);
  const providerConfig = config.ai[config.ai.provider];

  if (config.ai.provider === "anthropic") {
    const { classifyPairWithAnthropic } = await import("./anthropic.js");
    return classifyPairWithAnthropic(a, b, { prompt, isComplex, providerConfig });
  }

  const { classifyPairWithOpenAI } = await import("./openai.js");
  return classifyPairWithOpenAI(a, b, { prompt, isComplex, providerConfig });
}
