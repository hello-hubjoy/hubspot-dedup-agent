import { sld, registrableDomain, normalizeName, nameSimilarity } from "./normalize.js";

// Name pairs that only share a blocking token must clear this gate before they
// consume HubSpot enrichment calls or an AI classification.
const NAME_CANDIDATE_SIMILARITY = 0.65;

function normalizedNameParts(name) {
  const { normalized } = normalizeName(name);
  return {
    normalized,
    compact: normalized.replace(/\s+/g, ""),
    firstToken: normalized.split(" ")[0] || "",
  };
}

function plausiblePrefixNamePair(a, b) {
  const aName = normalizedNameParts(a.name);
  const bName = normalizedNameParts(b.name);
  if (!aName.normalized || !bName.normalized) return false;
  if (aName.normalized === bName.normalized) return true;
  if (aName.compact.length >= 6 && aName.compact === bName.compact) return true;
  return nameSimilarity(aName.normalized, bName.normalized) >= NAME_CANDIDATE_SIMILARITY;
}

function localPairKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}

// Blocking-key bucketing using cheap company shells only. Domain matches are
// always candidates. Exact and whitespace-insensitive names are candidates;
// broad first-token buckets must additionally pass the similarity gate.
export function candidatePairs(shells) {
  const buckets = new Map();

  function addToBucket(key, shell) {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(shell);
  }

  for (const company of shells) {
    const domKey = sld(registrableDomain(company.domain));
    if (domKey) addToBucket(`dom:${domKey}`, company);

    const { normalized, compact, firstToken } = normalizedNameParts(company.name);
    if (normalized) addToBucket(`name-exact:${normalized}`, company);
    if (compact.length >= 6) addToBucket(`name-compact:${compact}`, company);
    if (firstToken.length >= 4) addToBucket(`name-prefix:${firstToken}`, company);
  }

  const seen = new Set();
  const pairs = [];

  for (const [bucketKey, bucket] of buckets.entries()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (bucketKey.startsWith("name-prefix:") && !plausiblePrefixNamePair(bucket[i], bucket[j])) {
          continue;
        }
        const key = localPairKey(bucket[i].id, bucket[j].id);
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([bucket[i], bucket[j]]);
      }
    }
  }

  return pairs;
}
