import Anthropic from "@anthropic-ai/sdk";
import { CLASSIFICATION_SCHEMA, validateClassification } from "./ai-common.js";

const CLASSIFY_TOOL = {
  name: "classify_pair",
  description: "Return the dedup classification decision for this company pair",
  input_schema: CLASSIFICATION_SCHEMA,
};

let client;

function getClient(apiKey) {
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

export async function classifyPairWithAnthropic(a, b, { prompt, isComplex, providerConfig }) {
  const model = isComplex ? providerConfig.complexModel : providerConfig.fastModel;

  try {
    const response = await getClient(providerConfig.apiKey).messages.create({
      model,
      max_tokens: 300,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: "classify_pair" },
      messages: [{ role: "user", content: prompt }],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    const result = validateClassification(toolUse?.input);
    if (!result) return null;

    console.log(`[anthropic] ${a.name} / ${b.name} → ${result.decision} (${result.confidence}) — ${result.reason} [${model}]`);
    return result;
  } catch (err) {
    console.error(`[anthropic] classifyPair failed for ${a.name} / ${b.name}: ${err.message}`);
    return null;
  }
}
