import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  dismissedDecisionsByCompany,
  syncCompletedReviewTasks,
} from "../src/task-sync.js";

describe("dismissedDecisionsByCompany", () => {
  test("creates every pair for a multi-company review task", () => {
    const decisions = dismissedDecisionsByCompany(["3", "1", "2", "2"]);

    assert.deepEqual(decisions.get("1"), [
      { key: "1|3", decision: "dismissed" },
      { key: "1|2", decision: "dismissed" },
    ]);
    assert.deepEqual(decisions.get("2"), [
      { key: "2|3", decision: "dismissed" },
      { key: "1|2", decision: "dismissed" },
    ]);
    assert.deepEqual(decisions.get("3"), [
      { key: "1|3", decision: "dismissed" },
      { key: "2|3", decision: "dismissed" },
    ]);
  });
});

describe("syncCompletedReviewTasks", () => {
  test("records dismissed pairs and marks the completed task", async () => {
    const writes = [];
    const marked = [];
    const stats = await syncCompletedReviewTasks({
      searchTasks: async () => [{
        taskId: "task-1",
        subject: "[Dedup Review] Acme / Acme Corp",
        body: "Review these companies",
      }],
      fetchCompanyIds: async () => ["10", "20"],
      addCompanyDecisions: async (companyId, decisions) => {
        writes.push({ companyId, decisions });
        return true;
      },
      markProcessed: async (taskId, body) => marked.push({ taskId, body }),
      logger: { log() {} },
    });

    assert.deepEqual(writes, [
      { companyId: "10", decisions: [{ key: "10|20", decision: "dismissed" }] },
      { companyId: "20", decisions: [{ key: "10|20", decision: "dismissed" }] },
    ]);
    assert.deepEqual(marked, [{ taskId: "task-1", body: "Review these companies" }]);
    assert.deepEqual(stats, { found: 1, processed: 1, dismissedPairs: 1, mergedTasks: 0 });
  });

  test("marks a task without writing dismissals after a manual merge", async () => {
    let wroteDecision = false;
    let marked = false;
    const stats = await syncCompletedReviewTasks({
      searchTasks: async () => [{
        taskId: "task-2",
        subject: "[Dedup Review] Acme / Acme Corp",
        body: "Review these companies",
      }],
      fetchCompanyIds: async () => ["10"],
      addCompanyDecisions: async () => {
        wroteDecision = true;
        return true;
      },
      markProcessed: async () => {
        marked = true;
      },
      logger: { log() {} },
    });

    assert.equal(wroteDecision, false);
    assert.equal(marked, true);
    assert.deepEqual(stats, { found: 1, processed: 1, dismissedPairs: 0, mergedTasks: 1 });
  });

  test("does not mark unrelated completed tasks", async () => {
    let marked = false;
    const stats = await syncCompletedReviewTasks({
      searchTasks: async () => [{
        taskId: "task-3",
        subject: "Follow up with Acme",
        body: "Unrelated task",
      }],
      fetchCompanyIds: async () => [],
      addCompanyDecisions: async () => true,
      markProcessed: async () => {
        marked = true;
      },
      logger: { log() {} },
    });

    assert.equal(marked, false);
    assert.deepEqual(stats, { found: 1, processed: 0, dismissedPairs: 0, mergedTasks: 0 });
  });

  test("does not mark a task when company decisions fail to persist", async () => {
    let marked = false;
    await assert.rejects(
      syncCompletedReviewTasks({
        searchTasks: async () => [{
          taskId: "task-4",
          subject: "[Dedup Review] Acme / Acme Corp",
          body: "Review these companies",
        }],
        fetchCompanyIds: async () => ["10", "20"],
        addCompanyDecisions: async (companyId) => companyId !== "20",
        markProcessed: async () => {
          marked = true;
        },
        logger: { log() {} },
      }),
      /Failed to store dismissed decisions/,
    );
    assert.equal(marked, false);
  });
});
