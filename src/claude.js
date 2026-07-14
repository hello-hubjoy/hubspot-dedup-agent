import Anthropic from "@anthropic-ai/sdk";
import config from "./config.js";
import {
  signalDomain,
  signalName,
  signalGeo,
  signalSharedContacts,
  signalContactDomainOverlap,
  signalDomainRedirect,
  cooccurrenceIsIdentity,
} from "./signals.js";
import { normalizeName } from "./normalize.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

const CLASSIFY_TOOL = {
  name: "classify_pair",
  description: "Return the dedup classification decision for this company pair",
  input_schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["AUTO_MERGE", "REVIEW", "IGNORE"],
        description: "AUTO_MERGE = same company, high confidence. REVIEW = possibly same, needs human. IGNORE = clearly different.",
      },
      reason: {
        type: "string",
        description: "One concise sentence explaining the key signal(s) that drove the decision.",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
    },
    required: ["decision", "reason", "confidence"],
  },
};

function buildPrompt(a, b, signals, blockersList) {
  const fmt = (c) => [
    `  Name: ${c.name || "(none)"}`,
    `  Domain: ${c.domain || "(none)"}`,
    `  Location: ${[c.city, c.state, c.country].filter(Boolean).join(", ") || "(unknown)"}`,
    `  Open deals: ${c.openDealIds?.length || 0}`,
    `  Contacts: ${c.contactIds?.size || 0} (engagement score: ${c.engagementScore || 0})`,
    `  Redirect destination: ${c.finalDomain || "(none)"}`,
  ].join("\n");

  const sigLines = Object.entries(signals)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  const blockerLine = blockersList.length > 0
    ? `Blockers: ${blockersList.join(", ")}`
    : "Blockers: none";

  return `You are classifying whether two HubSpot company records are duplicates.

Company A:
${fmt(a)}

Company B:
${fmt(b)}

Computed signals:
${sigLines}

${blockerLine}

Decision guidelines:
- AUTO_MERGE: >95% confident these are the exact same legal entity. Requires strong corroborating signals (identical domain + high name similarity, or shared engaged contacts, or domain redirect). Do NOT auto-merge if either company has open deals.
- REVIEW: Meaningful similarity exists but ambiguity remains — needs human judgment. Use this for most non-obvious cases.
- IGNORE: Clearly different companies. Coincidental name match with no corroborating signals, or confirmed different organizations.

Be conservative. When uncertain between AUTO_MERGE and REVIEW, choose REVIEW. When uncertain between REVIEW and IGNORE, choose REVIEW.`;
}

// Returns { decision, reason, confidence } or null on failure
export async function classifyPairWithClaude(a, b, blockersList) {
  const signals = {
    domain: signalDomain(a, b),
    name: signalName(a, b),
    geo: signalGeo(a, b),
    sharedContacts: signalSharedContacts(a, b),
    contactDomainOverlap: signalContactDomainOverlap(a, b),
    redirect: signalDomainRedirect(a, b),
    cooccurrence: cooccurrenceIsIdentity(a, b) ? "STRONG" : "NONE",
  };

  // Escalate to Sonnet for complex cases where judgment matters most
  const isComplex =
    (a.openDealIds?.length > 0 && b.openDealIds?.length > 0) ||
    signals.sharedContacts === "STRONG" ||
    signals.redirect === "STRONG" ||
    signals.cooccurrence === "STRONG";

  const model = isComplex ? SONNET : HAIKU;

  const prompt = buildPrompt(a, b, signals, blockersList);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 300,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: "classify_pair" },
      messages: [{ role: "user", content: prompt }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse?.input) return null;

    const { decision, reason, confidence } = toolUse.input;
    console.log(`[claude] ${a.name} / ${b.name} → ${decision} (${confidence}) — ${reason} [${model === SONNET ? "sonnet" : "haiku"}]`);
    return { decision, reason, confidence };
  } catch (err) {
    console.error(`[claude] classifyPair failed for ${a.name} / ${b.name}: ${err.message}`);
    return null;
  }
}

// Compute signals summary string for use in task body / dry-run output
export function summarizeSignals(a, b) {
  const { normalized: na } = normalizeName(a.name);
  const { normalized: nb } = normalizeName(b.name);
  return [
    `domain:${signalDomain(a, b)}`,
    `name:${signalName(a, b)}`,
    `geo:${signalGeo(a, b)}`,
    `contacts:${signalSharedContacts(a, b)}`,
    `redirect:${signalDomainRedirect(a, b)}`,
  ].join(" ");
}
