import { pairKey } from "./classify.js";

export function dismissedDecisionsByCompany(companyIds) {
  const ids = [...new Set(companyIds.map(String))];
  const decisions = new Map(ids.map((id) => [id, []]));

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = pairKey(ids[i], ids[j]);
      decisions.get(ids[i]).push({ key, decision: "dismissed" });
      decisions.get(ids[j]).push({ key, decision: "dismissed" });
    }
  }

  return decisions;
}

export async function syncCompletedReviewTasks(dependencies = {}) {
  let {
    searchTasks,
    fetchCompanyIds,
    addCompanyDecisions,
    markProcessed,
    logger = console,
  } = dependencies;

  if (!searchTasks || !fetchCompanyIds || !addCompanyDecisions || !markProcessed) {
    const [hubspot, store] = await Promise.all([
      import("./hubspot.js"),
      import("./store.js"),
    ]);
    searchTasks ||= hubspot.searchCompletedDedupTasks;
    fetchCompanyIds ||= hubspot.fetchTaskCompanyIds;
    addCompanyDecisions ||= store.addSettledPairs;
    markProcessed ||= hubspot.markDedupTaskProcessed;
  }

  const tasks = await searchTasks();
  const stats = { found: tasks.length, processed: 0, dismissedPairs: 0, mergedTasks: 0 };

  for (const task of tasks) {
    if (!task.subject.startsWith("[Dedup Review]")) continue;

    const companyIds = [...new Set((await fetchCompanyIds(task.taskId)).map(String))];
    if (companyIds.length < 2) {
      stats.mergedTasks++;
      logger.log(`[dedup] Completed task ${task.taskId}: merged company detected, no dismissal recorded`);
    } else {
      const decisions = dismissedDecisionsByCompany(companyIds);
      const results = await Promise.all(
        [...decisions.entries()].map(([companyId, entries]) =>
          addCompanyDecisions(companyId, entries)
        )
      );
      if (results.some((result) => result === false)) {
        throw new Error(`Failed to store dismissed decisions for task ${task.taskId}`);
      }
      const pairCount = (companyIds.length * (companyIds.length - 1)) / 2;
      stats.dismissedPairs += pairCount;
      logger.log(
        `[dedup] Completed task ${task.taskId}: recorded ${pairCount} dismissed pair(s)`
      );
    }

    await markProcessed(task.taskId, task.body);
    stats.processed++;
  }

  if (stats.found > 0) {
    logger.log(
      `[dedup] Task sync: found=${stats.found} processed=${stats.processed} dismissedPairs=${stats.dismissedPairs} merged=${stats.mergedTasks}`
    );
  }
  return stats;
}
