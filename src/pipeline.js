import config from "./config.js";
import {
  fetchListMembers,
  fetchAllCompanyIds,
  fetchCompanyBatch,
  fetchAssociatedContactIds,
  fetchContactEngagementScore,
  fetchContactEmailDomains,
  fetchOpenDealIds,
  mergeCompanies,
  updateCompanyProperties,
  findOpenDedupTask,
} from "./hubspot.js";
import { sld, registrableDomain } from "./normalize.js";
import { candidatePairs } from "./candidates.js";
import {
  classifyPair,
  classifyPairAsync,
  unionFind,
  reconcileClusterDecision,
  chooseSurvivor,
  pairKey,
  AUTO_MERGE,
  REVIEW,
  CONFIRMED_DISTINCT,
} from "./classify.js";
import { getSettledPairs, addSettledPair, consolidateOnMerge, markLastScanned } from "./store.js";
import { snapshotBeforeMerge, createReviewTask, writeAuditNoteOnSurvivor } from "./tasks.js";
import { syncCompletedReviewTasks } from "./task-sync.js";
import { resolveFinalDomain } from "./http.js";

const ENRICH_BATCH = 25; // concurrent enrichments per batch

// ---------------------------------------------------------------------------
// Phase 1: cheap shell — only what we get from the batch company read.
// Used for bucketing only; no extra API calls.
// ---------------------------------------------------------------------------
function shellFromRaw(raw) {
  const p = raw.properties || {};
  return {
    id: raw.id,
    name: p.name || "",
    domain: p.domain || "",
    country: p.country || "",
    state: p.state || "",
    city: p.city || "",
    zip: p.zip || "",
    ownerId: p.hubspot_owner_id || null,
    parentId: p.hs_parent_company_id || null,
    lastActivityAt: p.notes_last_activity || p.hs_lastmodifieddate || null,
    createdAt: p.createdate || null,
    propertyFillCount: Object.values(p).filter((v) => v !== null && v !== undefined && v !== "").length,
    // Placeholders — populated in Phase 2 for candidates only
    openDealIds: [],
    childIds: [],
    contactIds: new Set(),
    engagedContactDomains: new Map(),
    engagementByContact: new Map(),
    engagementScore: 0,
    settledPairs: new Set(),
    finalDomain: null, // resolved redirect destination, set during enrichment
  };
}

// ---------------------------------------------------------------------------
// Phase 2: full enrichment — only called for companies in candidate pairs
// ---------------------------------------------------------------------------
async function enrichCompany(shell, rawProps) {
  const companyId = shell.id;

  const [contactIds, openDealIds, settledPairs] = await Promise.all([
    fetchAssociatedContactIds(companyId),
    fetchOpenDealIds(companyId),
    getSettledPairs(companyId),
  ]);

  // Engagement scores for all contacts (batched via Promise.all)
  const engagementByContact = new Map();
  let totalEngagement = 0;
  if (contactIds.length > 0) {
    const scores = await Promise.all(contactIds.map(fetchContactEngagementScore));
    for (let i = 0; i < contactIds.length; i++) {
      engagementByContact.set(contactIds[i], scores[i]);
      totalEngagement += scores[i];
    }
  }

  const engagedIds = contactIds.filter((cid) => (engagementByContact.get(cid) || 0) > 0);
  const [engagedContactDomains, finalDomain] = await Promise.all([
    fetchContactEmailDomains(engagedIds),
    resolveFinalDomain(shell.domain),
  ]);

  return {
    ...shell,
    openDealIds,
    contactIds: new Set(contactIds),
    engagedContactDomains,
    engagementByContact,
    engagementScore: totalEngagement,
    settledPairs,
    finalDomain,
  };
}

// ---------------------------------------------------------------------------
// Phase 1.5: redirect pre-pass — finds hidden acquisition/rebrand duplicates
// by resolving HTTP redirects for all companies and cross-referencing against
// the primary domain index. Returns [idA, idB] pairs that would never surface
// from name/domain bucketing alone.
// ---------------------------------------------------------------------------
const REDIRECT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REDIRECT_RESOLVE_CONCURRENCY = 50;
const REDIRECT_UPDATE_BATCH = 10;

async function buildRedirectCandidates(shells, rawMap, dryRun) {
  const now = Date.now();

  // Split shells into cache-fresh vs needs-resolve
  const freshCache = new Map(); // id -> resolvedHostname
  const toResolve = [];

  for (const shell of shells) {
    if (!shell.domain) continue;
    const raw = rawMap.get(shell.id)?.properties?.dedup_redirect_domain || "";
    if (raw) {
      const [hostname, ts] = raw.split("|");
      if (hostname && ts && now - new Date(ts).getTime() < REDIRECT_CACHE_TTL_MS) {
        freshCache.set(shell.id, hostname);
        continue;
      }
    }
    toResolve.push(shell);
  }

  console.log(`[dedup] Redirect pre-pass: ${freshCache.size} cached, ${toResolve.length} to resolve`);

  // Resolve stale/missing in concurrent batches
  const newlyResolved = new Map(); // id -> hostname | null
  for (let i = 0; i < toResolve.length; i += REDIRECT_RESOLVE_CONCURRENCY) {
    const batch = toResolve.slice(i, i + REDIRECT_RESOLVE_CONCURRENCY);
    const results = await Promise.all(batch.map((s) => resolveFinalDomain(s.domain)));
    for (let j = 0; j < batch.length; j++) {
      newlyResolved.set(batch[j].id, results[j]);
    }
    if ((i + REDIRECT_RESOLVE_CONCURRENCY) % 500 === 0) {
      console.log(`[dedup] Redirect resolved ${Math.min(i + REDIRECT_RESOLVE_CONCURRENCY, toResolve.length)}/${toResolve.length}`);
    }
  }

  // Persist new resolutions to HubSpot — always write, even in dry run.
  // Redirect cache is infrastructure (not a decision), so writing it doesn't
  // violate dry-run semantics and prevents re-resolving every dry run.
  {
    const isoNow = new Date().toISOString();
    const updates = [...newlyResolved.entries()].filter(([, h]) => h !== null);
    for (let i = 0; i < updates.length; i += REDIRECT_UPDATE_BATCH) {
      const chunk = updates.slice(i, i + REDIRECT_UPDATE_BATCH);
      await Promise.all(chunk.map(([id, hostname]) =>
        updateCompanyProperties(id, { dedup_redirect_domain: `${hostname}|${isoNow}` })
      ));
      if (i + REDIRECT_UPDATE_BATCH < updates.length) await new Promise((r) => setTimeout(r, 1200));
    }
  }

  // Merge fresh cache + newly resolved into one map
  const allResolved = new Map(freshCache);
  for (const [id, hostname] of newlyResolved.entries()) {
    if (hostname) allResolved.set(id, hostname);
  }

  // Primary domain index: SLD -> companyId
  const primarySldIndex = new Map();
  for (const shell of shells) {
    const s = sld(registrableDomain(shell.domain));
    if (s) primarySldIndex.set(s, shell.id);
  }

  // Cross-reference: companies whose redirect destination matches another company's primary domain
  const seen = new Set();
  const pairs = [];
  for (const shell of shells) {
    const resolvedHostname = allResolved.get(shell.id);
    if (!resolvedHostname) continue;
    const resolvedSld = sld(registrableDomain(resolvedHostname));
    if (!resolvedSld) continue;
    const ownSld = sld(registrableDomain(shell.domain));
    if (resolvedSld === ownSld) continue; // not actually a redirect

    const matchId = primarySldIndex.get(resolvedSld);
    if (!matchId || matchId === shell.id) continue;

    const key = pairKey(shell.id, matchId);
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push([shell.id, matchId]);
    }
  }

  console.log(`[dedup] Redirect pre-pass: ${pairs.length} cross-reference pairs found`);
  return pairs;
}

// ---------------------------------------------------------------------------
// Main dedup pipeline — two-phase: cheap bucket pass, then enrich candidates
// ---------------------------------------------------------------------------
export async function runDedup({ verbose = false } = {}) {
  const { dryRun, liveMerge, maxAutoMergesPerRun, maxTasksPerRun } = config.behaviour;

  console.log(
    `[dedup] Starting run — dryRun=${dryRun}, liveMerge=${liveMerge}, maxAutoMerges=${maxAutoMergesPerRun}, maxTasks=${maxTasksPerRun}`
  );

  // Reconcile completed review tasks before generating new candidates. A failed
  // sync aborts the live run so completed tasks cannot be recreated as duplicates.
  if (!dryRun) {
    await syncCompletedReviewTasks();
  }

  // 1. Fetch scan set: ICP list or full database if no list ID configured
  let memberIds;
  if (config.hubspot.listId) {
    memberIds = await fetchListMembers(config.hubspot.listId);
    console.log(`[dedup] List ${config.hubspot.listId} members: ${memberIds.length}`);
  } else {
    console.log("[dedup] No HUBSPOT_LIST_ID — scanning full company database");
    memberIds = await fetchAllCompanyIds();
    console.log(`[dedup] Full database: ${memberIds.length} companies`);
  }
  if (config.behaviour.scanLimit) {
    memberIds = memberIds.slice(0, config.behaviour.scanLimit);
    console.log(`[dedup] Scan limit active — using ${memberIds.length} of full list`);
  }
  if (memberIds.length === 0) {
    console.log("[dedup] Empty list — nothing to do.");
    return { scanned: 0, pairs: 0, autoMerged: 0, tasksCreated: 0, dryRun };
  }

  // 2. Batch-fetch raw company records (name, domain, country, etc.)
  const rawCompanies = await fetchCompanyBatch(memberIds);
  console.log(`[dedup] Fetched ${rawCompanies.length} company records`);

  // 3. Build cheap shells — no extra API calls
  const shells = rawCompanies.map(shellFromRaw);
  const rawMap = new Map(rawCompanies.map((r) => [r.id, r]));

  // 3b. Delta filter — only surface pairs that include at least one company
  // modified since it was last scanned. On first run (no dedup_last_scanned_at),
  // all companies are included.
  const deltaIds = new Set(
    rawCompanies
      .filter((r) => {
        const lastScanned = r.properties?.dedup_last_scanned_at;
        const lastModified = r.properties?.hs_lastmodifieddate;
        if (!lastScanned) return true;
        if (!lastModified) return true;
        return new Date(lastModified) > new Date(lastScanned);
      })
      .map((r) => r.id)
  );
  console.log(`[dedup] Delta: ${deltaIds.size} of ${shells.length} companies new or modified since last scan`);

  // 4a. Bucket-based candidate pairs (name token + domain SLD)
  // Keep only pairs where at least one member is in the delta set
  const bucketPairs = candidatePairs(shells).filter(([a, b]) => deltaIds.has(a.id) || deltaIds.has(b.id));

  // 4b. Redirect pre-pass — finds acquisition/rebrand pairs invisible to name/domain bucketing
  const shellMap = new Map(shells.map((s) => [s.id, s]));
  const redirectIdPairs = await buildRedirectCandidates(shells, rawMap, dryRun);
  const redirectShellPairs = redirectIdPairs
    .map(([idA, idB]) => [shellMap.get(idA), shellMap.get(idB)])
    .filter(([a, b]) => a && b);

  // Merge, deduplicating against bucket pairs; apply delta filter to redirect pairs too
  const bucketKeys = new Set(bucketPairs.map(([a, b]) => pairKey(a.id, b.id)));
  const newRedirectPairs = redirectShellPairs.filter(
    ([a, b]) => !bucketKeys.has(pairKey(a.id, b.id)) && (deltaIds.has(a.id) || deltaIds.has(b.id))
  );
  const candidatePairList = [...bucketPairs, ...newRedirectPairs];

  console.log(`[dedup] Candidate pairs: ${bucketPairs.length} from buckets + ${newRedirectPairs.length} from redirects = ${candidatePairList.length} total`);

  if (candidatePairList.length === 0) {
    if (!dryRun) {
      await markLastScanned(shells.map((s) => s.id));
    }
    return { scanned: shells.length, pairs: 0, autoMerged: 0, tasksCreated: 0, dryRun };
  }

  // 5. Enrich only the companies that appear in at least one candidate pair
  const candidateIds = new Set(candidatePairList.flatMap(([a, b]) => [a.id, b.id]));
  const candidateShells = shells.filter((s) => candidateIds.has(s.id));
  console.log(`[dedup] Enriching ${candidateShells.length} candidate companies (of ${shells.length} total)...`);

  const enriched = new Map();
  for (let i = 0; i < candidateShells.length; i += ENRICH_BATCH) {
    const chunk = candidateShells.slice(i, i + ENRICH_BATCH);
    const results = await Promise.all(chunk.map((s) => enrichCompany(s, rawMap.get(s.id)?.properties || {})));
    for (const c of results) enriched.set(c.id, c);
    if (verbose) process.stdout.write(`\r[dedup] Enriched ${Math.min(i + ENRICH_BATCH, candidateShells.length)}/${candidateShells.length}`);
  }
  if (verbose) console.log();

  // 6. Classify all candidate pairs — Claude-powered with rule-based fallback
  const pairResults = [];
  for (const [shellA, shellB] of candidatePairList) {
    const a = enriched.get(shellA.id) || shellA;
    const b = enriched.get(shellB.id) || shellB;
    const allSettled = new Set([...a.settledPairs, ...b.settledPairs]);
    const result = await classifyPairAsync(a, b, allSettled);
    pairResults.push([[a, b], result]);
    if (verbose) {
      console.log(`  ${a.name} / ${b.name} → ${result.decision} (${result.reason})`);
    }
  }

  // 7. Cluster with union-find over non-IGNORE pairs
  const activePairs = pairResults
    .filter(([, { decision }]) => decision === AUTO_MERGE || decision === REVIEW)
    .map(([[a, b]]) => [a, b]);
  const clusters = unionFind(activePairs);
  console.log(`[dedup] Clusters: ${clusters.length}`);

  // 8. Dispatch
  const companyMap = new Map([...shells.map((s) => [s.id, s]), ...enriched]);
  let autoMerged = 0;
  let tasksCreated = 0;

  const portalId = config.hubspot.portalId;

  for (const cluster of clusters) {
    const decision = reconcileClusterDecision(cluster, pairResults, companyMap);
    if (decision === CONFIRMED_DISTINCT) continue;

    const clusterCompanies = cluster.map((id) => companyMap.get(id)).filter(Boolean);
    const clusterPairs = pairResults.filter(([[a, b]]) => cluster.includes(a.id) && cluster.includes(b.id));
    const reason = clusterPairs[0]?.[1]?.reason || "";

    if (dryRun) {
      const survivorId = chooseSurvivor(clusterCompanies[0], clusterCompanies[1]);
      const survivor = companyMap.get(survivorId);
      const label = decision === AUTO_MERGE ? "AUTO_MERGE" : "REVIEW";
      console.log(`\n[${label}] ${clusterCompanies.map((c) => c.name).join(" / ")}`);
      console.log(`  reason   : ${reason}`);
      console.log(`  survivor : ${survivor?.name} (${survivorId})`);
      for (const c of clusterCompanies) {
        console.log(`  company  : ${c.name} — https://app.hubspot.com/contacts/${portalId}/company/${c.id}`);
      }
      for (const [[a, b], res] of clusterPairs) {
        console.log(`  pair     : ${a.name} / ${b.name} → ${res.decision} (${res.reason})`);
      }
      tasksCreated++; // count would-be tasks
      continue;
    }

    if (liveMerge && decision === AUTO_MERGE && autoMerged < maxAutoMergesPerRun) {
      const survivorId = chooseSurvivor(clusterCompanies[0], clusterCompanies[1]);
      const victims = clusterCompanies.filter((c) => c.id !== survivorId);
      await snapshotBeforeMerge(clusterCompanies);
      for (const victim of victims) {
        await consolidateOnMerge(survivorId, victim.id);
        await mergeCompanies(survivorId, victim.id);
        console.log(`[dedup] AUTO_MERGE: ${victim.name} (${victim.id}) → ${survivorId}`);
      }
      await writeAuditNoteOnSurvivor(survivorId, cluster, companyMap, reason);
      autoMerged++;
      for (const victim of victims) {
        await addSettledPair(survivorId, pairKey(survivorId, victim.id), "merged");
      }
    } else if (decision === AUTO_MERGE || decision === REVIEW) {
      if (tasksCreated >= maxTasksPerRun) {
        console.log(`[dedup] Task cap reached (${maxTasksPerRun}) — skipping remaining clusters`);
        break;
      }
      // Idempotency: skip if an open task already exists for this cluster
      const companies = cluster.map((id) => companyMap.get(id)).filter(Boolean);
      const subject = `[Dedup Review] ${companies.map((c) => c.name).join(" / ")}`;
      const alreadyExists = await findOpenDedupTask(subject);
      if (alreadyExists) {
        console.log(`[dedup] Skipping — open task already exists: ${subject}`);
        continue;
      }
      const taskId = await createReviewTask(cluster, companyMap, pairResults);
      if (taskId) tasksCreated++;
    }
  }

  // 9. Mark all scanned companies (skip in dry run — no writes)
  if (!dryRun) {
    await markLastScanned(shells.map((s) => s.id));
  }

  const stats = { scanned: shells.length, pairs: candidatePairList.length, autoMerged, tasksCreated, dryRun };
  console.log(`\n[dedup] Done — scanned=${stats.scanned} pairs=${stats.pairs} autoMerged=${autoMerged} tasks=${tasksCreated}`);
  return stats;
}
