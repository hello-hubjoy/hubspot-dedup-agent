import {
  registrableDomain,
  sld,
  domainRelationship,
  normalizeName,
  nameSimilarity,
  sameRegion,
} from "./normalize.js";

export const STRONG = "STRONG";
export const MEDIUM = "MEDIUM";
export const WEAK = "WEAK";
export const NONE = "NONE";
export const NEGATIVE = "NEGATIVE";

export function signalDomain(a, b) {
  const rel = domainRelationship(
    registrableDomain(a.domain),
    registrableDomain(b.domain)
  );
  if (rel === "IDENTICAL") return STRONG;
  if (rel === "TLD_SWAP" || rel === "SLD_SUBSTRING") return WEAK;
  return NONE;
}

// Best single independent identity signal: same engaged humans on both records
export function signalSharedContacts(a, b) {
  const overlap = [...a.contactIds].filter((id) => b.contactIds.has(id));
  if (overlap.length === 0) return NONE;
  // Check any of the overlapping contacts are "engaged" (have activity score > 0)
  const anyEngaged = overlap.some(
    (id) => (a.engagementByContact?.get(id) || 0) > 0 || (b.engagementByContact?.get(id) || 0) > 0
  );
  return anyEngaged ? STRONG : NONE;
}

// Weighted overlap of engaged-contact email domains between the two records
export function signalContactDomainOverlap(a, b) {
  const domainsA = a.engagedContactDomains; // Map<domain, weight>
  const domainsB = b.engagedContactDomains;
  if (!domainsA || !domainsB || domainsA.size === 0 || domainsB.size === 0) return NONE;

  let numerator = 0;
  let denominator = 0;
  const allDomains = new Set([...domainsA.keys(), ...domainsB.keys()]);
  for (const d of allDomains) {
    const wa = domainsA.get(d) || 0;
    const wb = domainsB.get(d) || 0;
    numerator += Math.min(wa, wb);
    denominator += Math.max(wa, wb);
  }
  if (denominator === 0) return NONE;
  const sim = numerator / denominator;
  if (sim >= 0.8) return STRONG;
  if (sim >= 0.4) return MEDIUM;
  return NONE;
}

export function signalName(a, b) {
  const { normalized: na, isGeneric: genA } = normalizeName(a.name);
  const { normalized: nb, isGeneric: genB } = normalizeName(b.name);
  const sim = nameSimilarity(na, nb);
  let level = sim >= 0.92 ? STRONG : sim >= 0.80 ? MEDIUM : NONE;
  // Generic names can't be STRONG on name alone
  if ((genA || genB) && level === STRONG) level = MEDIUM;
  return level;
}

export function signalGeo(a, b) {
  const same = sameRegion(a, b);
  if (same === null) return NONE;
  return same ? STRONG : NEGATIVE;
}

// Cooccurrence proves relatedness, not identity — only counts if email domains cross
export function cooccurrenceIsIdentity(a, b) {
  const sharedDeals = (a.openDealIds || []).some((id) => (b.openDealIds || []).includes(id));
  if (!sharedDeals) return false;
  return engagedContactDomainsCross(a, b);
}

// True if the *same email domain* appears in engaged contacts on BOTH records
function engagedContactDomainsCross(a, b) {
  const domainsA = new Set(a.engagedContactDomains?.keys() || []);
  const domainsB = new Set(b.engagedContactDomains?.keys() || []);
  for (const d of domainsA) {
    if (domainsB.has(d)) return true;
  }
  return false;
}

// True if the two records have engaged contact domains with NO overlap —
// the xyz.com / xyz.net "two real orgs at separate domains" case
export function engagedContactDomainsDistinctNoCross(a, b) {
  const domainsA = a.engagedContactDomains;
  const domainsB = b.engagedContactDomains;
  if (!domainsA || !domainsB || domainsA.size === 0 || domainsB.size === 0) return false;
  for (const d of domainsA.keys()) {
    if (domainsB.has(d)) return false;
  }
  return true;
}

// Domain redirect signal — catches acquisitions and rebrands.
// a.finalDomain / b.finalDomain are resolved during Phase 2 enrichment.
// STRONG: A's domain redirects to B's domain, B's to A's, or both redirect to the same place.
// NONE: no redirect relationship detected.
export function signalDomainRedirect(a, b) {
  const aDomain = sld(registrableDomain(a.domain));
  const bDomain = sld(registrableDomain(b.domain));
  const aFinal = a.finalDomain ? sld(registrableDomain(a.finalDomain)) : null;
  const bFinal = b.finalDomain ? sld(registrableDomain(b.finalDomain)) : null;

  if (!aFinal && !bFinal) return NONE;

  // A redirected to B's home domain
  if (aFinal && bDomain && aFinal === bDomain && aFinal !== aDomain) return STRONG;
  // B redirected to A's home domain
  if (bFinal && aDomain && bFinal === aDomain && bFinal !== bDomain) return STRONG;
  // Both redirect to the same third destination (co-acquired / shared parent)
  if (aFinal && bFinal && aFinal === bFinal && aFinal !== aDomain && bFinal !== bDomain) return STRONG;

  return NONE;
}
