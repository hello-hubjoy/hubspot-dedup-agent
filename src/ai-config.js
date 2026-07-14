const PROVIDERS = new Set(["anthropic", "openai"]);

export function resolveAIProvider(env = process.env) {
  const requested = env.AI_PROVIDER?.trim().toLowerCase() || null;
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
  const hasOpenAI = Boolean(env.OPENAI_API_KEY);

  if (requested && !PROVIDERS.has(requested)) {
    throw new Error("AI_PROVIDER must be either 'anthropic' or 'openai'");
  }

  if (requested === "anthropic") {
    if (!hasAnthropic) {
      throw new Error("AI_PROVIDER is 'anthropic' but ANTHROPIC_API_KEY is missing");
    }
    return requested;
  }

  if (requested === "openai") {
    if (!hasOpenAI) {
      throw new Error("AI_PROVIDER is 'openai' but OPENAI_API_KEY is missing");
    }
    return requested;
  }

  if (hasAnthropic && hasOpenAI) {
    throw new Error("Both AI keys are set; add AI_PROVIDER=anthropic or AI_PROVIDER=openai");
  }
  if (hasAnthropic) return "anthropic";
  if (hasOpenAI) return "openai";

  throw new Error("Set either ANTHROPIC_API_KEY or OPENAI_API_KEY");
}
