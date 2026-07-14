import config from "./config.js";
import { createTask, createNote, readCompanyProperties } from "./hubspot.js";
import { pairKey } from "./classify.js";

const PORTAL = () => `https://app.hubspot.com/contacts/${config.hubspot.portalId}`;

function companyUrl(id) {
  return `${PORTAL()}/company/${id}`;
}

// Full property snapshot before merge (written as a note on each company)
export async function snapshotBeforeMerge(companies) {
  for (const company of companies) {
    const props = await readCompanyProperties(company.id, [
      "name", "domain", "country", "state", "city",
      "hubspot_owner_id", "hs_num_open_deals", "num_associated_contacts",
      "createdate", "hs_lastmodifieddate", "dedup_settled_pairs",
    ]);
    const body = `[Dedup pre-merge snapshot]\n${JSON.stringify(props, null, 2)}`;
    await createNote(company.id, body);
  }
}

// Build human-readable evidence summary for a cluster
export function clusterEvidence(cluster, companyMap, pairResults) {
  const lines = [];
  for (const id of cluster) {
    const c = companyMap.get(id);
    if (!c) continue;
    lines.push(`• ${c.name} (${companyUrl(id)}) — ${c.openDealIds?.length || 0} open deals, ${c.contactIds?.size || 0} contacts`);
  }

  // Find the highest-signal pair result in this cluster
  const clusterSet = new Set(cluster);
  const relevant = pairResults.filter(([pair]) =>
    clusterSet.has(pair[0].id) || clusterSet.has(pair[1].id)
  );
  if (relevant.length > 0) {
    const { reason } = relevant[0][1];
    lines.push(`\nSignals: ${reason}`);
  }
  return lines.join("\n");
}

export async function createReviewTask(cluster, companyMap, pairResults) {
  const companies = cluster.map((id) => companyMap.get(id)).filter(Boolean);
  if (companies.length < 2) return null;

  const names = companies.map((c) => c.name).join(" / ");
  const subject = `[Dedup Review] ${names}`;

  const evidence = clusterEvidence(cluster, companyMap, pairResults);
  const links = companies.map((c) => `${c.name}: ${companyUrl(c.id)}`).join("\n");
  const body = `Possible duplicate companies flagged for review.\n\n${links}\n\n${evidence}`;

  const ownerId = config.hubspot.taskOwnerId;

  return createTask({
    subject,
    body,
    ownerId,
    queueId: config.hubspot.taskQueueId,
    companyIds: companies.map((c) => c.id),
  });
}

export async function writeAuditNoteOnSurvivor(survivorId, cluster, companyMap, reason) {
  const companies = cluster.map((id) => companyMap.get(id)).filter(Boolean);
  const merged = companies.filter((c) => c.id !== survivorId).map((c) => `${c.name} (${c.id})`).join(", ");
  const body = `[Dedup auto-merge]\nAbsorbed: ${merged}\nReason: ${reason}\nSurvivor: ${survivorId}`;
  await createNote(survivorId, body);
}
