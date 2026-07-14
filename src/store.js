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
  const existing = await getSettledPairs(companyId);
  // Remove any prior entry for this pair key (idempotent update)
  const filtered = [...existing].filter((e) => !e.startsWith(key + "|"));
  filtered.push(`${key}|${decision}`);
  await updateCompanyProperties(companyId, {
    [PROP]: filtered.join("\n"),
  });
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
