import { resolveAIProvider } from "./ai-config.js";

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

let aiProvider = null;
try {
  aiProvider = resolveAIProvider();
} catch (err) {
  missing.push(err.message);
}

const config = {
  ai: {
    provider: aiProvider,
    anthropic: {
      apiKey: optional("ANTHROPIC_API_KEY"),
      fastModel: optional("ANTHROPIC_FAST_MODEL", "claude-haiku-4-5-20251001"),
      complexModel: optional("ANTHROPIC_COMPLEX_MODEL", "claude-sonnet-4-6"),
    },
    openai: {
      apiKey: optional("OPENAI_API_KEY"),
      fastModel: optional("OPENAI_FAST_MODEL", "gpt-4o-mini"),
      complexModel: optional("OPENAI_COMPLEX_MODEL", "gpt-4.1"),
    },
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
