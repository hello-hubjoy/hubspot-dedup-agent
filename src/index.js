import express from "express";
import cron from "node-cron";
import config from "./config.js";
import { runDedup } from "./pipeline.js";

const app = express();

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// Manual trigger — same effect as waiting for the nightly cron.
// This endpoint is unauthenticated. If your deployment URL is guessable, put it
// behind your host's access controls or remove the route and trigger runs from a shell.
app.post("/dedup-run", (req, res) => {
  res.json({ ok: true, message: "Dedup scan triggered — see server logs for results." });
  runDedup({ verbose: false }).catch((err) => {
    console.error("[dedup] Manual run failed:", err);
  });
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
