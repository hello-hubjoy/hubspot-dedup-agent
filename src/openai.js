import OpenAI from "openai";
import { CLASSIFICATION_SCHEMA, validateClassification } from "./ai-common.js";

let client;

function getClient(apiKey) {
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

export async function classifyPairWithOpenAI(a, b, { prompt, isComplex, providerConfig }) {
  const model = isComplex ? providerConfig.complexModel : providerConfig.fastModel;

  try {
    const response = await getClient(providerConfig.apiKey).responses.create({
      model,
      input: [{ role: "user", content: prompt }],
      max_output_tokens: 300,
      text: {
        format: {
          type: "json_schema",
          name: "classify_pair",
          strict: true,
          schema: CLASSIFICATION_SCHEMA,
        },
      },
    });

    const result = validateClassification(JSON.parse(response.output_text));
    if (!result) return null;

    console.log(`[openai] ${a.name} / ${b.name} → ${result.decision} (${result.confidence}) — ${result.reason} [${model}]`);
    return result;
  } catch (err) {
    console.error(`[openai] classifyPair failed for ${a.name} / ${b.name}: ${err.message}`);
    return null;
  }
}
