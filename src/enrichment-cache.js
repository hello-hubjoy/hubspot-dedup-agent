import { createHash } from "node:crypto";

const CACHE_VERSION = 1;
export const ENRICHMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ENRICHMENT_CACHE_BYTES = 60_000;

// These raw company properties reflect the associations/activity used by
// enrichment without including dedup properties whose own writes would
// invalidate the cache.
const SOURCE_PROPERTIES = [
  "domain",
  "num_associated_contacts",
  "hs_num_open_deals",
  "notes_last_activity",
  "num_notes",
  "num_contacted_notes",
  "hs_analytics_num_visits",
];

function sourceFingerprint(rawProps = {}) {
  const source = Object.fromEntries(
    SOURCE_PROPERTIES.map((key) => [key, rawProps[key] ?? null])
  );
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function settledPairsFromRaw(rawProps = {}) {
  return new Set(
    String(rawProps.dedup_settled_pairs || "")
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function validEntries(value) {
  return Array.isArray(value) && value.every(
    (entry) => Array.isArray(entry) && entry.length === 2
  );
}

export function serializeEnrichmentCache(company, rawProps, now = Date.now()) {
  const payload = {
    version: CACHE_VERSION,
    cachedAt: new Date(now).toISOString(),
    sourceFingerprint: sourceFingerprint(rawProps),
    contactIds: [...company.contactIds],
    openDealIds: [...(company.openDealIds || [])],
    // Only positive scores are needed to decide whether a shared contact is engaged.
    engagementByContact: [...company.engagementByContact.entries()].filter(([, score]) => score > 0),
    engagedContactDomains: [...company.engagedContactDomains.entries()],
    engagementScore: company.engagementScore || 0,
    finalDomain: company.finalDomain || null,
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ENRICHMENT_CACHE_BYTES) {
    throw new Error(
      `enrichment checkpoint exceeds ${MAX_ENRICHMENT_CACHE_BYTES} bytes for company ${company.id}`
    );
  }
  return serialized;
}

export function hydrateEnrichmentCache(
  shell,
  rawProps,
  rawCache,
  { now = Date.now(), ttlMs = ENRICHMENT_CACHE_TTL_MS } = {}
) {
  if (!rawCache) return null;

  try {
    const payload = JSON.parse(rawCache);
    const cachedAt = new Date(payload.cachedAt).getTime();
    if (
      payload.version !== CACHE_VERSION ||
      !Number.isFinite(cachedAt) ||
      cachedAt > now ||
      now - cachedAt > ttlMs ||
      payload.sourceFingerprint !== sourceFingerprint(rawProps) ||
      !Array.isArray(payload.contactIds) ||
      !Array.isArray(payload.openDealIds) ||
      !validEntries(payload.engagementByContact) ||
      !validEntries(payload.engagedContactDomains)
    ) {
      return null;
    }

    return {
      ...shell,
      contactIds: new Set(payload.contactIds.map(String)),
      openDealIds: payload.openDealIds.map(String),
      engagementByContact: new Map(
        payload.engagementByContact.map(([id, score]) => [String(id), Number(score) || 0])
      ),
      engagedContactDomains: new Map(
        payload.engagedContactDomains.map(([domain, weight]) => [String(domain), Number(weight) || 0])
      ),
      engagementScore: Number(payload.engagementScore) || 0,
      settledPairs: settledPairsFromRaw(rawProps),
      finalDomain: payload.finalDomain || null,
    };
  } catch {
    return null;
  }
}
