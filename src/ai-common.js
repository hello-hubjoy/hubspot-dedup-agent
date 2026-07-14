import {
  signalDomain,
  signalName,
  signalGeo,
  signalSharedContacts,
  signalContactDomainOverlap,
  signalDomainRedirect,
  cooccurrenceIsIdentity,
} from "./signals.js";

export const CLASSIFICATION_SCHEMA = {
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
  additionalProperties: false,
};

export function collectSignals(a, b) {
  return {
    domain: signalDomain(a, b),
    name: signalName(a, b),
    geo: signalGeo(a, b),
    sharedContacts: signalSharedContacts(a, b),
    contactDomainOverlap: signalContactDomainOverlap(a, b),
    redirect: signalDomainRedirect(a, b),
    cooccurrence: cooccurrenceIsIdentity(a, b) ? "STRONG" : "NONE",
  };
}

export function isComplexClassification(a, b, signals) {
  return (
    (a.openDealIds?.length > 0 && b.openDealIds?.length > 0) ||
    signals.sharedContacts === "STRONG" ||
    signals.redirect === "STRONG" ||
    signals.cooccurrence === "STRONG"
  );
}

export function buildClassificationPrompt(a, b, signals, blockersList) {
  const fmt = (company) => [
    `  Name: ${company.name || "(none)"}`,
    `  Domain: ${company.domain || "(none)"}`,
    `  Location: ${[company.city, company.state, company.country].filter(Boolean).join(", ") || "(unknown)"}`,
    `  Open deals: ${company.openDealIds?.length || 0}`,
    `  Contacts: ${company.contactIds?.size || 0} (engagement score: ${company.engagementScore || 0})`,
    `  Redirect destination: ${company.finalDomain || "(none)"}`,
  ].join("\n");

  const sigLines = Object.entries(signals)
    .map(([key, value]) => `  ${key}: ${value}`)
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

export function validateClassification(value) {
  if (!value || typeof value !== "object") return null;
  if (!["AUTO_MERGE", "REVIEW", "IGNORE"].includes(value.decision)) return null;
  if (!["high", "medium", "low"].includes(value.confidence)) return null;
  if (typeof value.reason !== "string" || value.reason.trim() === "") return null;
  return {
    decision: value.decision,
    reason: value.reason.trim(),
    confidence: value.confidence,
  };
}

export function summarizeSignals(a, b) {
  return [
    `domain:${signalDomain(a, b)}`,
    `name:${signalName(a, b)}`,
    `geo:${signalGeo(a, b)}`,
    `contacts:${signalSharedContacts(a, b)}`,
    `redirect:${signalDomainRedirect(a, b)}`,
  ].join(" ");
}
