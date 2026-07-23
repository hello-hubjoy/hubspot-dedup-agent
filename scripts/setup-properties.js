// One-time script: creates the dedup property group + properties in HubSpot
// Run: node scripts/setup-properties.js

import config from "../src/config.js";

const BASE = "https://api.hubapi.com";
const headers = {
  Authorization: `Bearer ${config.hubspot.token}`,
  "Content-Type": "application/json",
};

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    // 409 = already exists — treat as success
    if (res.status === 409) return { existed: true, ...data };
    console.error(`POST ${url} failed ${res.status}:`, JSON.stringify(data, null, 2));
    throw new Error(`Request failed: ${res.status}`);
  }
  return data;
}

async function run() {
  console.log("Creating property group: dedup_internal ...");
  await post(`${BASE}/crm/v3/properties/companies/groups`, {
    name: "dedup_internal",
    label: "Dedup (Internal)",
    displayOrder: 99,
  });
  console.log("  ✓ Group ready");

  const properties = [
    {
      name: "dedup_settled_pairs",
      label: "Dedup Settled Pairs",
      type: "string",
      fieldType: "textarea",
      groupName: "dedup_internal",
      description: "Pipe-delimited settled dedup decisions: idA|idB|decision per line. Written by the dedup bot.",
      hidden: false,
      formField: false,
      displayOrder: 1,
    },
    {
      name: "dedup_last_scanned_at",
      label: "Dedup Last Scanned At",
      type: "datetime",
      fieldType: "date",
      groupName: "dedup_internal",
      description: "Timestamp of last time this company was included in a dedup scan.",
      hidden: false,
      formField: false,
      displayOrder: 2,
    },
    {
      name: "dedup_score_cache",
      label: "Dedup Score Cache",
      type: "string",
      fieldType: "textarea",
      groupName: "dedup_internal",
      description: "Durable enrichment checkpoint used to resume interrupted dedup runs. Refreshed after 24 hours or when source counters change.",
      hidden: false,
      formField: false,
      displayOrder: 3,
    },
    {
      name: "dedup_redirect_domain",
      label: "Dedup Redirect Domain",
      type: "string",
      fieldType: "text",
      groupName: "dedup_internal",
      description: "Cached HTTP redirect destination: resolvedHostname|ISO8601timestamp. Refreshed every 30 days.",
      hidden: false,
      formField: false,
      displayOrder: 4,
    },
  ];

  for (const prop of properties) {
    console.log(`Creating property: ${prop.name} ...`);
    const result = await post(`${BASE}/crm/v3/properties/companies`, prop);
    console.log(`  ${result.existed ? "already existed" : "✓ created"}`);
  }

  console.log("\nAll done. Add the dedup_internal group to your RevOps company view in HubSpot.");
  console.log("Settings → Properties → Companies → dedup_internal group → Add to view.");
}

run().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
