import { readCompanyProperties, updateCompanyProperties } from "./hubspot.js";
import { pairKey } from "./classify.js";

const PROP = "dedup_settled_pairs";

export async function getSettledPairs(companyId) {
  const props = await readCompanyProperties(companyId, [PROP]);
  const raw = props[PROP] || "";
  const pairs = new Set();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) pairs.add(trimmed);
  }
  return pairs;
}

export async function addSettledPair(companyId, key, decision) {
  return addSettledPairs(companyId, [{ key, decision }]);
}

export async function addSettledPairs(companyId, decisions) {
  const existing = await getSettledPairs(companyId);
  const entries = new Map();

  for (const entry of existing) {
    const key = entry.split("|").slice(0, 2).join("|");
    if (key) entries.set(key, entry);
  }
  for (const { key, decision } of decisions) {
    entries.set(key, `${key}|${decision}`);
  }

  const next = [...entries.values()].sort().join("\n");
  const current = [...existing].sort().join("\n");
  if (next === current) return true;
  return updateCompanyProperties(companyId, { [PROP]: next });
}

// Called before executing a merge — unions both records' settled pairs onto survivor,
// remapping any references to the victim ID to the survivor ID.
export async function consolidateOnMerge(survivorId, victimId) {
  const [survivorPairs, victimPairs] = await Promise.all([
    getSettledPairs(survivorId),
    getSettledPairs(victimId),
  ]);

  const merged = new Map(); // key -> entry (deduplicated, remapped)

  for (const entry of [...survivorPairs, ...victimPairs]) {
    const parts = entry.split("|");
    if (parts.length < 3) continue;
    let [idA, idB, decision] = parts;

    // Remap victim ID to survivor ID
    if (idA === String(victimId)) idA = String(survivorId);
    if (idB === String(victimId)) idB = String(survivorId);

    // Skip self-pairs created by the remapping
    if (idA === idB) continue;

    const key = pairKey(idA, idB);
    // Later entry wins if conflict (both records had a decision for same pair)
    merged.set(key, `${key}|${decision}`);
  }

  const consolidated = [...merged.values()].join("\n");
  await updateCompanyProperties(survivorId, { [PROP]: consolidated });
}

export async function markLastScanned(companyIds) {
  const now = new Date().toISOString();
  const BATCH = 10;
  for (let i = 0; i < companyIds.length; i += BATCH) {
    const chunk = companyIds.slice(i, i + BATCH);
    await Promise.all(chunk.map((id) => updateCompanyProperties(id, { dedup_last_scanned_at: now })));
    if (i + BATCH < companyIds.length) await new Promise((r) => setTimeout(r, 1200));
  }
}
