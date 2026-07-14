import { parse as parseTld } from "tldts";

export const INDUSTRY_SUFFIXES = new Set([
  "construction", "constructors", "builders", "building", "contracting",
  "contractors", "companies", "company", "group", "holdings", "enterprises",
  "services", "inc", "llc", "ltd", "corp", "co", "the",
]);

// Seed from real data — names that are too generic to trust on name alone
export const GENERIC_NAME_TOKENS = new Set([
  "summit", "apex", "premier", "elite", "united", "national", "advanced",
  "american", "western", "eastern", "northern", "southern", "pacific",
  "central", "metro", "tri", "bay", "mountain", "valley", "coastal",
  "heritage", "landmark", "signature", "legacy", "pinnacle", "crest",
]);

export function normalizeName(raw) {
  if (!raw) return { normalized: "", isGeneric: true };
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(Boolean);
  const core = tokens.filter((t) => !INDUSTRY_SUFFIXES.has(t));
  const isGeneric =
    core.length === 0 ||
    core.length <= 1 ||
    core.some((t) => GENERIC_NAME_TOKENS.has(t));
  return { normalized: core.join(" "), isGeneric };
}

// Strip scheme, www, path → registrable domain ("silich.co.uk" → "silich.co.uk")
export function registrableDomain(raw) {
  if (!raw) return "";
  let s = raw.trim().toLowerCase();
  // Strip protocol
  s = s.replace(/^https?:\/\//, "");
  // Strip path/query
  s = s.split("/")[0];
  // Strip port
  s = s.split(":")[0];
  const parsed = parseTld(s, { allowPrivateDomains: false });
  return parsed.domain || s; // e.g. "silich.com"
}

// Second-level domain label only: "silich.com" → "silich", "silich.co.uk" → "silich"
export function sld(domain) {
  const d = registrableDomain(domain);
  if (!d) return "";
  // domain is already registrable; strip TLD suffix(es)
  const parsed = parseTld(d, { allowPrivateDomains: false });
  return parsed.domainWithoutSuffix || d.split(".")[0];
}

export function domainRelationship(aDom, bDom) {
  const a = registrableDomain(aDom);
  const b = registrableDomain(bDom);
  if (!a || !b) return "NONE";
  if (a === b) return "IDENTICAL";
  const sa = sld(a);
  const sb = sld(b);
  if (sa === sb) return "TLD_SWAP"; // silich.com vs silich.ca
  if (sa.includes(sb) || sb.includes(sa)) return "SLD_SUBSTRING"; // silich vs silichconstruction
  return "NONE";
}

// Token Jaccard similarity on normalized name cores
function tokenJaccard(a, b) {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

// Normalized edit distance (Levenshtein / max length)
function editSimilarity(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const dp = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[la][lb] / Math.max(la, lb);
}

// Blend of token Jaccard and edit distance
export function nameSimilarity(normA, normB) {
  if (normA === normB) return 1;
  if (!normA || !normB) return 0;
  const jaccard = tokenJaccard(normA, normB);
  const edit = editSimilarity(normA, normB);
  return 0.6 * jaccard + 0.4 * edit;
}

// Region key for geo disambiguation — state + first 3 of zip (rough metro bucket)
export function regionKey(company) {
  const parts = [];
  if (company.country) parts.push(company.country.toLowerCase());
  if (company.state) parts.push(company.state.toLowerCase());
  if (company.zip) parts.push(company.zip.slice(0, 3));
  return parts.join("|");
}

export function sameRegion(a, b) {
  const ra = regionKey(a);
  const rb = regionKey(b);
  if (!ra || !rb) return null; // unknown
  return ra === rb;
}
