// Dry-run: prints candidate pairs + decisions to console without writing anything to HubSpot
// Run: node scripts/dry-run.js
// Env: DEDUP_DRY_RUN=true (default), DEDUP_LIVE_MERGE=false (default)

import { runDedup } from "../src/pipeline.js";

console.log("=== Dedup Dry Run ===");
console.log("DEDUP_DRY_RUN is forced true — no HubSpot writes will occur.\n");

// Force dry-run regardless of env
process.env.DEDUP_DRY_RUN = "true";
process.env.DEDUP_LIVE_MERGE = "false";

runDedup({ verbose: true })
  .then((stats) => {
    console.log("\n=== Summary ===");
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("Dry run failed:", err);
    process.exit(1);
  });
