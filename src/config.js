import { readFileSync } from "fs";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name, fallback = null) {
  return process.env[name] || fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return fallback;
  return v.toLowerCase() === "true";
}

function int(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

const missing = [];
function req(name) {
  const v = process.env[name];
  if (!v) { missing.push(name); return ""; }
  return v;
}

const config = {
  anthropic: {
    apiKey: req("ANTHROPIC_API_KEY"),
  },
  hubspot: {
    token: req("HUBSPOT_TOKEN"),
    portalId: req("HUBSPOT_PORTAL_ID"),
    listId: optional("HUBSPOT_LIST_ID", null), // null = full database scan
    taskQueueId: optional("HUBSPOT_TASK_QUEUE_ID"),
    taskOwnerId: optional("HUBSPOT_TASK_OWNER_ID"),
  },
  behaviour: {
    dedupCron: optional("DEDUP_CRON", "0 2 * * *"),
    cronTz: optional("CRON_TZ", "America/Los_Angeles"),
    dryRun: bool("DEDUP_DRY_RUN", true),
    liveMerge: bool("DEDUP_LIVE_MERGE", false),
    maxAutoMergesPerRun: int("MAX_AUTO_MERGES_PER_RUN", 25),
    maxTasksPerRun: int("MAX_TASKS_PER_RUN", 30),
    scanLimit: int("DEDUP_SCAN_LIMIT", null), // null = no limit (full list)
  },
  port: int("PORT", 3000),
};

if (missing.length > 0) {
  console.error(`\nFATAL: Missing required environment variables:\n  ${missing.join("\n  ")}\n`);
  process.exit(1);
}

export default config;
