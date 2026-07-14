import express from "express";
import cron from "node-cron";
import config from "./config.js";
import { runDedup } from "./pipeline.js";
import { fetchTaskWithCompanies } from "./hubspot.js";
import { addSettledPair } from "./store.js";
import { pairKey } from "./classify.js";

const app = express();
app.use(express.json());

// Simple concurrency limiter — prevents bulk HubSpot webhook batches from
// exceeding the API rate limit (110 req/10s burst). Queue excess requests
// rather than dropping them.
const WEBHOOK_CONCURRENCY = 10;
let webhookActive = 0;
const webhookQueue = [];

function withConcurrencyLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      webhookActive++;
      fn().then(resolve, reject).finally(() => {
        webhookActive--;
        if (webhookQueue.length > 0) webhookQueue.shift()();
      });
    };
    if (webhookActive < WEBHOOK_CONCURRENCY) {
      run();
    } else {
      webhookQueue.push(run);
    }
  });
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// Manual trigger — same effect as waiting for the nightly cron.
// Unauthenticated (parity with the HubSpot workflow webhook below); if your
// deployment URL is guessable, put this behind your host's access controls
// or remove the route and trigger runs from a shell instead.
app.post("/dedup-run", (req, res) => {
  res.json({ ok: true, message: "Dedup scan triggered — see server logs for results." });
  runDedup({ verbose: false }).catch((err) => {
    console.error("[dedup] Manual run failed:", err);
  });
});

// ---------------------------------------------------------------------------
// Webhook: HubSpot workflow calls this when a Dedup Review task is completed.
// Writes "dismissed" to dedup_settled_pairs on all associated companies so
// the pair is never re-surfaced by the nightly scan.
//
// Setup: create a HubSpot workflow on Task → "Task status is Completed"
//   filter: Task subject starts with "[Dedup Review]"
//   action: Send webhook → POST https://<your-host>/dedup-task-completed
//   body:   { "taskId": "{{taskId}}" }
// ---------------------------------------------------------------------------
async function processDedupTaskCompleted(taskId) {
  const task = await fetchTaskWithCompanies(taskId);
  if (!task) return { status: 404, body: { error: "task not found" } };
  if (!task.subject.startsWith("[Dedup Review]")) return { status: 200, body: { skipped: "not a dedup task" } };

  // After a manual HubSpot merge, the victim record is retired and HubSpot drops
  // its task association — we only get 1 (or 0) company IDs back. The victim no
  // longer exists so the pair can never be regenerated. No settled-pair write needed.
  const ids = task.companyIds;
  if (ids.length < 2) {
    console.log(`[dedup] task-completed: task ${taskId} has ${ids.length} company — victim was merged, skipping`);
    return { status: 200, body: { skipped: "victim merged — pair cannot resurface" } };
  }

  const key = pairKey(ids[0], ids[1]);
  await Promise.all(ids.map((id) => addSettledPair(id, key, "dismissed")));
  console.log(`[dedup] Dismissed pair ${key} (task ${taskId}: ${task.subject})`);
  return { status: 200, body: { ok: true, pair: key, companies: ids } };
}

app.post("/dedup-task-completed", async (req, res) => {
  const taskId = req.body?.taskId || req.query?.taskId;
  if (!taskId) return res.status(400).json({ error: "taskId required" });

  const { status, body } = await withConcurrencyLimit(() => processDedupTaskCompleted(taskId));
  res.status(status).json(body);
});

// Job lock to prevent overlapping cron runs
let jobRunning = false;

async function scheduledRun() {
  if (jobRunning) {
    console.log("[dedup] Skipping — previous run still in progress.");
    return;
  }
  jobRunning = true;
  try {
    await runDedup();
  } catch (err) {
    console.error("[dedup] Cron run failed:", err);
  } finally {
    jobRunning = false;
  }
}

// Validate and schedule cron
const { dedupCron, cronTz } = config.behaviour;
if (!cron.validate(dedupCron)) {
  console.error(`[dedup] Invalid DEDUP_CRON: "${dedupCron}" — falling back to "0 2 * * *"`);
  cron.schedule("0 2 * * *", scheduledRun, { timezone: cronTz });
} else {
  cron.schedule(dedupCron, scheduledRun, { timezone: cronTz });
  console.log(`[dedup] Scheduled: "${dedupCron}" (${cronTz})`);
}

// Start HTTP server
app.listen(config.port, () => {
  console.log(`[dedup] Server running on port ${config.port}`);
});
