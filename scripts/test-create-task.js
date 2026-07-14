/**
 * One-shot test: creates a single sample Dedup Review task in HubSpot
 * so you can see how it looks before enabling live runs.
 *
 * Uses real company IDs from the dry-run output (Keen Project Solutions pair).
 * Safe to re-run — just creates another task.
 *
 * Usage (Railway console):
 *   node scripts/test-create-task.js
 *
 * To use different companies, set env vars:
 *   TEST_COMPANY_A_ID=<id> TEST_COMPANY_A_NAME="Foo Inc"
 *   TEST_COMPANY_B_ID=<id> TEST_COMPANY_B_NAME="Foo, Inc."
 */

import config from "../src/config.js";
import { createTask } from "../src/hubspot.js";

const PORTAL = `https://app.hubspot.com/contacts/${config.hubspot.portalId}`;

// Override via env vars to test with specific companies
const A_ID   = process.env.TEST_COMPANY_A_ID   || null;
const A_NAME = process.env.TEST_COMPANY_A_NAME  || "Company A (test)";
const B_ID   = process.env.TEST_COMPANY_B_ID   || null;
const B_NAME = process.env.TEST_COMPANY_B_NAME  || "Company B (test)";

const companyUrl = (id) => id ? `${PORTAL}/company/${id}` : "(no id)";

const subject = `[Dedup Review TEST] ${A_NAME} / ${B_NAME}`;
const body = [
  "⚠️ This is a TEST task created by scripts/test-create-task.js — safe to delete.",
  "",
  "Possible duplicate companies flagged for review.",
  "",
  `• ${A_NAME}: ${companyUrl(A_ID)}`,
  `• ${B_NAME}: ${companyUrl(B_ID)}`,
  "",
  "Signals: review_band (name similarity, no domain conflict)",
  "",
  "Action: Compare the two records. If they are the same company, merge them (keep the more complete record). If they are genuinely different, dismiss this task.",
].join("\n");

console.log("Creating test task...");
console.log(`  Subject: ${subject}`);
console.log(`  Queue ID: ${config.hubspot.taskQueueId || "(none)"}`);
console.log(`  Owner ID: ${config.hubspot.taskOwnerId || "(none)"}`);
console.log(`  Company IDs: ${[A_ID, B_ID].filter(Boolean).join(", ") || "(no IDs set)"}`);

const taskId = await createTask({
  subject,
  body,
  ownerId: config.hubspot.taskOwnerId,
  queueId: config.hubspot.taskQueueId,
  companyIds: [A_ID, B_ID].filter(Boolean),
});

if (taskId) {
  console.log(`\n✓ Task created: ${PORTAL}/tasks/${taskId}`);
  console.log(`\nDirect link: ${PORTAL}/tasks`);
  if (config.hubspot.taskQueueId) {
    console.log(`Queue link:  ${PORTAL}/tasks?taskQueue=${config.hubspot.taskQueueId}`);
  }
} else {
  console.error("\n✗ Task creation failed — check logs above");
  process.exit(1);
}
