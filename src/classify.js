import {
  STRONG, MEDIUM, WEAK, NONE, NEGATIVE,
  signalDomain, signalSharedContacts, signalContactDomainOverlap,
  signalName, signalGeo, cooccurrenceIsIdentity,
  engagedContactDomainsDistinctNoCross, signalDomainRedirect,
} from "./signals.js";
import { normalizeName } from "./normalize.js";
import { classifyPairWithAI } from "./ai.js";

export const AUTO_MERGE = "AUTO_MERGE";
export const REVIEW = "REVIEW";
export const IGNORE = "IGNORE";
export const CONFIRMED_DISTINCT = "CONFIRMED_DISTINCT";

// ---------------------------------------------------------------------------
// Stub detection — absorbing an empty record risks almost nothing
// ---------------------------------------------------------------------------
const STUB_FILL_THRESHOLD = 4; // <= 4 non-empty properties = stub

export function isStub(company) {
  return (
    (!company.openDealIds || company.openDealIds.length === 0) &&
    (company.engagementScore || 0) === 0 &&
    company.contactIds.size <= 1 &&
    (company.propertyFillCount || 0) <= STUB_FILL_THRESHOLD
  );
}

// ---------------------------------------------------------------------------
// Blockers — any hit => never AUTO_MERGE
// ---------------------------------------------------------------------------
export function blockers(a, b) {
  const B = [];
  const country_a = a.country?.toLowerCase();
  const country_b = b.country?.toLowerCase();
  if (country_a && country_b && country_a !== country_b) {
    B.push("different_country");
  }
  if (a.openDealIds?.length > 0 && b.openDealIds?.length > 0) {
    B.push("both_open_deals");
  }
  if (isModeledParentChild(a, b)) {
    B.push("modeled_parent_child");
  }
  if (engagedContactDomainsDistinctNoCross(a, b)) {
    B.push("distinct_contact_domains");
  }
  const { isGeneric: genA } = normalizeName(a.name);
  const { isGeneric: genB } = normalizeName(b.name);
  if ((genA || genB) && signalGeo(a, b) === NEGATIVE) {
    B.push("generic_name_diff_region");
  }
  return B;
}

function isModeledParentChild(a, b) {
  return (
    a.parentId === b.id ||
    b.parentId === a.id ||
    (a.childIds || []).includes(b.id) ||
    (b.childIds || []).includes(a.id)
  );
}

// ---------------------------------------------------------------------------
// Survivor selection — property survivorship only; associations always union
// ---------------------------------------------------------------------------
export function chooseSurvivor(a, b) {
  return [a, b].sort((x, y) => {
    if (!!x.openDealIds?.length !== !!y.openDealIds?.length)
      return x.openDealIds?.length ? -1 : 1;
    const xAct = x.lastActivityAt ? new Date(x.lastActivityAt).getTime() : 0;
    const yAct = y.lastActivityAt ? new Date(y.lastActivityAt).getTime() : 0;
    if (xAct !== yAct) return yAct - xAct;
    if ((x.propertyFillCount || 0) !== (y.propertyFillCount || 0))
      return (y.propertyFillCount || 0) - (x.propertyFillCount || 0);
    if ((x.engagementScore || 0) !== (y.engagementScore || 0))
      return (y.engagementScore || 0) - (x.engagementScore || 0);
    // Tiebreak: older record (established history)
    const xCreated = x.createdAt ? new Date(x.createdAt).getTime() : 0;
    const yCreated = y.createdAt ? new Date(y.createdAt).getTime() : 0;
    return xCreated - yCreated;
  })[0].id;
}

// ---------------------------------------------------------------------------
// Pair classification — core decision logic
// ---------------------------------------------------------------------------
export function classifyPair(a, b, settledDecisions = new Set()) {
  const key = pairKey(a.id, b.id);

  // 0) Suppress previously settled pairs
  for (const entry of settledDecisions) {
    if (entry.startsWith(key + "|")) {
      const decision = entry.split("|")[2];
      if (decision === "dismissed" || decision === "confirmed_distinct") {
        return { decision: CONFIRMED_DISTINCT, reason: "previously_settled", survivorId: null };
      }
    }
  }

  const B = blockers(a, b);
  const HARD = new Set(["different_country", "modeled_parent_child"]);
  const hardHit = B.filter((b) => HARD.has(b));

  // 1) Stub-absorption express lane
  const aIsStub = isStub(a);
  const bIsStub = isStub(b);
  if ((aIsStub || bIsStub) && hardHit.length === 0) {
    const keep = aIsStub ? b.id : a.id;
    if (
      signalDomain(a, b) === STRONG &&
      (signalName(a, b) === STRONG || signalName(a, b) === MEDIUM)
    ) {
      return { decision: AUTO_MERGE, reason: "stub_absorption", survivorId: keep };
    }
  }

  // 2) Hard blockers
  if (B.includes("modeled_parent_child")) {
    return { decision: CONFIRMED_DISTINCT, reason: "modeled_parent_child", survivorId: null };
  }

  // 3) Require at least one real similarity signal before any blocker can promote to REVIEW.
  //    A blocker alone (e.g. split_ownership_active on two unrelated GCs in the same region)
  //    is not enough — there must be a name, domain, or contact signal that makes this pair
  //    genuinely worth human review.
  const redirectStrong = signalDomainRedirect(a, b) === STRONG;
  const { isGeneric: genA } = normalizeName(a.name);
  const { isGeneric: genB } = normalizeName(b.name);
  // For generic names, name similarity alone is not a real signal — two unrelated
  // "Apex Builders" in different markets share a name, not an identity. Require a
  // domain or contact signal to surface them at all.
  const nameCountsAsReal = signalName(a, b) !== NONE && !(genA || genB);
  const hasRealSignal =
    redirectStrong ||
    nameCountsAsReal ||
    signalDomain(a, b) !== NONE ||
    signalSharedContacts(a, b) !== NONE ||
    signalContactDomainOverlap(a, b) !== NONE ||
    cooccurrenceIsIdentity(a, b);

  if (B.length > 0) {
    if (!hasRealSignal) {
      return { decision: IGNORE, reason: "below_floor", survivorId: null };
    }
    // A domain redirect is so strong it warrants AUTO_MERGE even with blockers
    // (acquisition is the intended outcome — different owners is expected post-M&A)
    if (redirectStrong && !B.includes("different_country") && !B.includes("both_open_deals")) {
      return { decision: AUTO_MERGE, reason: "domain_redirect", survivorId: chooseSurvivor(a, b) };
    }
    return {
      decision: REVIEW,
      reason: "blocked:" + B.join(","),
      survivorId: chooseSurvivor(a, b),
    };
  }

  // 4) Unblocked — require >= 2 independent strong signals
  const domStrong = signalDomain(a, b) === STRONG ? 1 : 0;
  const contactStrong = signalSharedContacts(a, b) === STRONG ? 1 : 0;
  const domainOverlapStrong = signalContactDomainOverlap(a, b) === STRONG ? 1 : 0;
  const strong = domStrong + contactStrong + domainOverlapStrong + (redirectStrong ? 1 : 0);
  const geo = signalGeo(a, b);

  // If both companies have domains and they clearly go to different places (no domain match,
  // no redirect relationship), name similarity alone is not enough — they are different companies.
  const domainsConfirmedDifferent =
    a.domain && b.domain &&
    signalDomain(a, b) === NONE &&
    !redirectStrong;

  if (geo === NEGATIVE) {
    return {
      decision: strong >= 1 ? REVIEW : IGNORE,
      reason: "geo_conflict",
      survivorId: strong >= 1 ? chooseSurvivor(a, b) : null,
    };
  }

  if (strong >= 2) {
    return { decision: AUTO_MERGE, reason: "two_independent_strong_signals", survivorId: chooseSurvivor(a, b) };
  }

  // 5) Review band — name-only matches are suppressed when domains confirm different companies
  if (
    strong >= 1 ||
    (!domainsConfirmedDifferent && signalName(a, b) !== NONE) ||
    signalDomain(a, b) === WEAK ||
    signalContactDomainOverlap(a, b) === MEDIUM ||
    cooccurrenceIsIdentity(a, b)
  ) {
    return { decision: REVIEW, reason: "review_band", survivorId: chooseSurvivor(a, b) };
  }

  return { decision: IGNORE, reason: "below_floor", survivorId: null };
}

// ---------------------------------------------------------------------------
// AI-powered classifier — replaces rule-based decision with LLM judgment.
// Falls back to rule-based classifyPair() if the configured provider is unavailable or errors.
// Settled-pair suppression and hard blockers are still handled deterministically.
// ---------------------------------------------------------------------------
export async function classifyPairAsync(a, b, settledDecisions = new Set()) {
  const key = pairKey(a.id, b.id);

  // Settled pairs are always deterministic — never ask the AI provider about them
  for (const entry of settledDecisions) {
    if (entry.startsWith(key + "|")) {
      const decision = entry.split("|")[2];
      if (decision === "dismissed" || decision === "confirmed_distinct") {
        return { decision: CONFIRMED_DISTINCT, reason: "previously_settled", survivorId: null };
      }
    }
  }

  // Hard structural blockers — the AI provider can't override these
  if (isModeledParentChild(a, b)) {
    return { decision: CONFIRMED_DISTINCT, reason: "modeled_parent_child", survivorId: null };
  }

  const B = blockers(a, b);

  // Ask the configured AI provider for the decision, passing the blocker context
  const result = await classifyPairWithAI(a, b, B);

  if (result) {
    const survivorId = result.decision !== IGNORE && result.decision !== CONFIRMED_DISTINCT
      ? chooseSurvivor(a, b)
      : null;
    return { decision: result.decision, reason: result.reason, survivorId };
  }

  // Fallback to rule-based classifier if the provider fails
  console.warn(`[classify] AI provider unavailable for ${a.name} / ${b.name} — falling back to rule-based`);
  return classifyPair(a, b, settledDecisions);
}

// ---------------------------------------------------------------------------
// Union-Find clustering — N dupes => 1 cluster, not N*(N-1)/2 tasks
// ---------------------------------------------------------------------------
export function unionFind(pairs) {
  const parent = new Map();

  function find(id) {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
    return parent.get(id);
  }

  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const [a, b] of pairs) {
    union(a.id, b.id);
  }

  const clusters = new Map();
  const allIds = new Set(pairs.flatMap(([a, b]) => [a.id, b.id]));
  for (const id of allIds) {
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root).add(id);
  }
  return [...clusters.values()].map((s) => [...s]);
}

// ---------------------------------------------------------------------------
// Most conservative decision wins when reconciling a cluster
// ---------------------------------------------------------------------------
const DECISION_RANK = { CONFIRMED_DISTINCT: 0, REVIEW: 1, AUTO_MERGE: 2, IGNORE: 3 };

export function reconcileClusterDecision(cluster, pairResults, companyMap) {
  let worst = AUTO_MERGE;
  for (const [pair, { decision }] of pairResults) {
    const [a, b] = pair;
    if (cluster.includes(a.id) || cluster.includes(b.id)) {
      if (DECISION_RANK[decision] < DECISION_RANK[worst]) {
        worst = decision;
      }
    }
  }
  return worst;
}

export function pairKey(idA, idB) {
  const a = String(idA), b = String(idB);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
