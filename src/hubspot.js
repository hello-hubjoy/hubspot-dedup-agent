import config from "./config.js";

const BASE = "https://api.hubapi.com";
const TIMEOUT_MS = 30_000;

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.hubspot.token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function hubspotGet(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError" ||
      err.cause?.code === "UND_ERR_CONNECT_TIMEOUT" || err.cause?.code === "UND_ERR_SOCKET";
    if (attempt < 3 && isTimeout) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
      return hubspotGet(url, attempt + 1);
    }
    throw err;
  }
  if (res.status === 429 && attempt < 3) {
    const retry = parseInt(res.headers.get("Retry-After") || "2", 10);
    await new Promise((r) => setTimeout(r, Math.max(1, retry) * 1000));
    return hubspotGet(url, attempt + 1);
  }
  if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < 3) {
    await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
    return hubspotGet(url, attempt + 1);
  }
  return res;
}

async function hubspotPost(url, body, attempt = 0) {
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429 && attempt < 3) {
    const retry = parseInt(res.headers.get("Retry-After") || "2", 10);
    await new Promise((r) => setTimeout(r, Math.max(1, retry) * 1000));
    return hubspotPost(url, body, attempt + 1);
  }
  if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < 3) {
    await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
    return hubspotPost(url, body, attempt + 1);
  }
  return res;
}

async function hubspotPatch(url, body, attempt = 0) {
  const res = await fetch(url, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429 && attempt < 3) {
    const retry = parseInt(res.headers.get("Retry-After") || "2", 10);
    await new Promise((r) => setTimeout(r, Math.max(1, retry) * 1000));
    return hubspotPatch(url, body, attempt + 1);
  }
  if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < 3) {
    await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
    return hubspotPatch(url, body, attempt + 1);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Full database scan — paginate all company IDs (no list required)
// ---------------------------------------------------------------------------
export async function fetchAllCompanyIds() {
  const ids = [];
  let after = null;
  while (true) {
    const params = new URLSearchParams({ limit: 100 });
    if (after) params.set("after", after);
    const res = await hubspotGet(`${BASE}/crm/v3/objects/companies?${params}`);
    if (!res.ok) {
      console.error(`fetchAllCompanyIds failed: ${res.status}`);
      break;
    }
    const data = await res.json();
    for (const obj of data.results || []) {
      ids.push(obj.id);
    }
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// List membership — paginated, optional delta filter by lastmodifieddate
// ---------------------------------------------------------------------------
export async function fetchListMembers(listId, { deltaAfter = null } = {}) {
  const ids = [];
  let after = null;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({ limit });
    if (after) params.set("after", after);

    const res = await hubspotGet(
      `${BASE}/crm/v3/lists/${listId}/memberships?${params}`
    );
    if (!res.ok) {
      console.error(`fetchListMembers failed: ${res.status}`);
      break;
    }
    const data = await res.json();
    for (const m of data.results || []) {
      ids.push(m.recordId);
    }
    if (data.paging?.next?.after) {
      after = data.paging.next.after;
    } else {
      break;
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Company batch read — up to 100 per call, chunked
// ---------------------------------------------------------------------------
const COMPANY_PROPS = [
  "name",
  "domain",
  "country",
  "state",
  "city",
  "zip",
  "hubspot_owner_id",
  "createdate",
  "hs_lastmodifieddate",
  "notes_last_activity",
  "num_associated_contacts",
  "hs_num_open_deals",
  "hs_parent_company_id",
  "num_notes",
  "num_contacted_notes",
  "hs_analytics_num_visits",
  "dedup_settled_pairs",
  "dedup_last_scanned_at",
  "dedup_redirect_domain",
];

export async function fetchCompanyBatch(ids) {
  if (ids.length === 0) return [];
  const CHUNK = 100;
  const companies = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const res = await hubspotPost(`${BASE}/crm/v3/objects/companies/batch/read`, {
      inputs: chunk.map((id) => ({ id })),
      properties: COMPANY_PROPS,
    });
    if (!res.ok) {
      console.error(`fetchCompanyBatch failed: ${res.status}`);
      continue;
    }
    const data = await res.json();
    companies.push(...(data.results || []));
  }
  return companies;
}

// ---------------------------------------------------------------------------
// Associations — contacts for a company (v4)
// ---------------------------------------------------------------------------
export async function fetchAssociatedContactIds(companyId) {
  const res = await hubspotGet(
    `${BASE}/crm/v4/objects/companies/${companyId}/associations/contacts?limit=500`
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((r) => r.toObjectId);
}

// ---------------------------------------------------------------------------
// Contact engagement — basic activity count to determine "engaged" contacts
// ---------------------------------------------------------------------------
export async function fetchContactEngagementScore(contactId) {
  const res = await hubspotGet(
    `${BASE}/crm/v3/objects/contacts/${contactId}?properties=num_contacted_notes,hs_email_sends_since_last_engagement,notes_last_contacted`
  );
  if (!res.ok) return 0;
  const data = await res.json();
  const p = data.properties || {};
  return (
    parseInt(p.num_contacted_notes || "0", 10) +
    (p.notes_last_contacted ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// Contact email domains — for contact-domain overlap signal
// Returns a Map of email domain -> activity count
// ---------------------------------------------------------------------------
export async function fetchContactEmailDomains(contactIds) {
  if (contactIds.length === 0) return new Map();
  const CHUNK = 100;
  const domainCounts = new Map();

  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const chunk = contactIds.slice(i, i + CHUNK);
    const res = await hubspotPost(`${BASE}/crm/v3/objects/contacts/batch/read`, {
      inputs: chunk.map((id) => ({ id })),
      properties: ["email", "num_contacted_notes", "notes_last_contacted"],
    });
    if (!res.ok) continue;
    const data = await res.json();
    for (const contact of data.results || []) {
      const email = contact.properties?.email;
      if (!email || !email.includes("@")) continue;
      const domain = email.split("@")[1].toLowerCase();
      const score =
        parseInt(contact.properties?.num_contacted_notes || "0", 10) +
        (contact.properties?.notes_last_contacted ? 1 : 0);
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + Math.max(1, score));
    }
  }
  return domainCounts;
}

// ---------------------------------------------------------------------------
// Open deals for a company
// ---------------------------------------------------------------------------
export async function fetchOpenDealIds(companyId) {
  const res = await hubspotGet(
    `${BASE}/crm/v4/objects/companies/${companyId}/associations/deals?limit=100`
  );
  if (!res.ok) return [];
  const data = await res.json();
  const dealIds = (data.results || []).map((r) => r.toObjectId);
  if (dealIds.length === 0) return [];

  const batchRes = await hubspotPost(`${BASE}/crm/v3/objects/deals/batch/read`, {
    inputs: dealIds.map((id) => ({ id })),
    properties: ["dealstage", "closedate", "hs_is_closed"],
  });
  if (!batchRes.ok) return [];
  const batchData = await batchRes.json();
  return (batchData.results || [])
    .filter((d) => d.properties?.hs_is_closed !== "true")
    .map((d) => d.id);
}

// ---------------------------------------------------------------------------
// Tasks — create a review task in the Dedup Review queue
// ---------------------------------------------------------------------------
export async function createTask({ subject, body, ownerId, queueId, companyIds = [] }) {
  const associations = companyIds.map((id) => ({
    to: { id },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 192 }],
  }));

  const res = await hubspotPost(`${BASE}/crm/v3/objects/tasks`, {
    properties: {
      hs_task_subject: subject,
      hs_task_body: body,
      hs_task_status: "NOT_STARTED",
      hs_task_priority: "MEDIUM",
      hs_task_type: "TODO",
      hs_timestamp: Date.now().toString(),
      ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
      ...(queueId ? { hs_queue_membership_ids: queueId } : {}),
    },
    associations,
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`createTask failed: ${res.status} ${err}`);
    return null;
  }
  return (await res.json()).id;
}

// ---------------------------------------------------------------------------
// Completed review task polling
// ---------------------------------------------------------------------------
export const DEDUP_TASK_PROCESSED_MARKER = "DEDUP_PROCESSED";

export async function searchCompletedDedupTasks() {
  const tasks = [];
  let after = null;

  while (true) {
    const res = await hubspotPost(`${BASE}/crm/v3/objects/tasks/search`, {
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_task_status", operator: "EQ", value: "COMPLETED" },
            { propertyName: "hs_task_subject", operator: "CONTAINS_TOKEN", value: "Dedup" },
            { propertyName: "hs_task_body", operator: "NOT_CONTAINS_TOKEN", value: DEDUP_TASK_PROCESSED_MARKER },
          ],
        },
      ],
      properties: ["hs_task_subject", "hs_task_status", "hs_task_body"],
      sorts: ["hs_lastmodifieddate"],
      limit: 200,
      ...(after ? { after } : {}),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`searchCompletedDedupTasks failed: ${res.status} ${err}`);
    }

    const data = await res.json();
    for (const task of data.results || []) {
      const subject = task.properties?.hs_task_subject || "";
      const body = task.properties?.hs_task_body || "";
      if (
        subject.startsWith("[Dedup Review]") &&
        !body.includes(DEDUP_TASK_PROCESSED_MARKER)
      ) {
        tasks.push({ taskId: String(task.id), subject, body });
      }
    }

    after = data.paging?.next?.after || null;
    if (!after) break;
  }

  return tasks;
}

export async function fetchTaskCompanyIds(taskId) {
  const companyIds = [];
  let after = null;

  while (true) {
    const params = new URLSearchParams({ limit: 500 });
    if (after) params.set("after", after);
    const res = await hubspotGet(
      `${BASE}/crm/v4/objects/tasks/${taskId}/associations/companies?${params}`
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`fetchTaskCompanyIds(${taskId}) failed: ${res.status} ${err}`);
    }
    const data = await res.json();
    companyIds.push(...(data.results || []).map((result) => String(result.toObjectId)));
    after = data.paging?.next?.after || null;
    if (!after) break;
  }

  return [...new Set(companyIds)];
}

export async function markDedupTaskProcessed(taskId, currentBody = "") {
  if (currentBody.includes(DEDUP_TASK_PROCESSED_MARKER)) return true;
  const body = `${currentBody.trim()}\n\n[${DEDUP_TASK_PROCESSED_MARKER}]`.trim();
  const res = await hubspotPatch(`${BASE}/crm/v3/objects/tasks/${taskId}`, {
    properties: { hs_task_body: body },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`markDedupTaskProcessed(${taskId}) failed: ${res.status} ${err}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Idempotency check — returns true if an open dedup task already exists
// with this exact subject (prevents duplicate task creation on re-runs)
// ---------------------------------------------------------------------------
export async function findOpenDedupTask(subject) {
  const res = await hubspotPost(`${BASE}/crm/v3/objects/tasks/search`, {
    filterGroups: [
      {
        filters: [
          { propertyName: "hs_task_subject", operator: "EQ", value: subject },
          { propertyName: "hs_task_status", operator: "NEQ", value: "COMPLETED" },
        ],
      },
    ],
    properties: ["hs_task_subject", "hs_task_status"],
    limit: 1,
  });
  if (!res.ok) return false; // fail open — let task creation proceed
  const data = await res.json();
  return (data.total || 0) > 0;
}

// ---------------------------------------------------------------------------
// Merge companies — primary survives, secondary is retired
// Requires companies.write + merge scope on the service key
// ---------------------------------------------------------------------------
export async function mergeCompanies(primaryId, secondaryId) {
  const res = await hubspotPost(
    `${BASE}/crm/v3/objects/companies/merge`,
    { primaryObjectId: primaryId, objectIdToMerge: secondaryId }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`mergeCompanies failed: ${res.status} ${err}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Property read/write helpers
// ---------------------------------------------------------------------------
export async function readCompanyProperties(id, propNames) {
  const params = propNames.map((p) => `properties=${p}`).join("&");
  const res = await hubspotGet(`${BASE}/crm/v3/objects/companies/${id}?${params}`);
  if (!res.ok) return {};
  const data = await res.json();
  return data.properties || {};
}

export async function updateCompanyProperties(id, props) {
  const res = await hubspotPatch(`${BASE}/crm/v3/objects/companies/${id}`, {
    properties: props,
  });
  if (!res.ok) {
    if (res.status === 404) return false; // retired/merged record — silent skip
    const err = await res.text();
    console.error(`updateCompanyProperties(${id}) failed: ${res.status} ${err}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Audit note — written to survivor after merge
// ---------------------------------------------------------------------------
export async function createNote(companyId, body) {
  const res = await hubspotPost(`${BASE}/crm/v3/objects/notes`, {
    properties: {
      hs_note_body: body,
      hs_timestamp: Date.now().toString(),
    },
    associations: [
      {
        to: { id: companyId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }],
      },
    ],
  });
  if (!res.ok) {
    console.error(`createNote failed: ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Parent/child associations
// ---------------------------------------------------------------------------
export async function fetchParentCompanyId(companyId) {
  const props = await readCompanyProperties(companyId, ["hs_parent_company_id"]);
  return props.hs_parent_company_id || null;
}
