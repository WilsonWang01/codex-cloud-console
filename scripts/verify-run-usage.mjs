import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRunUsage, runUsageDetails, runUsageFromProtocol, summarizeRunUsage } from "../server/run-usage.mjs";

test("last-turn usage does not add cache or reasoning subfields twice", () => {
  const usage = runUsageFromProtocol({
    total: { inputTokens: 200, outputTokens: 40 },
    last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5 },
  });
  assert.equal(usage.totalTokens, 120);
  assert.equal(usage.cachedInputTokens, 40);
  assert.equal(usage.reasoningOutputTokens, 5);
  assert.equal(runUsageFromProtocol({ total: { inputTokens: 200, outputTokens: 40 } }).status, "unknown");
  assert.equal(runUsageFromProtocol({ last: { inputTokens: 100 } }).status, "unknown");
});

test("repeated snapshots replace one run's usage instead of summing events", () => {
  const run = {
    id: "run-1", clientId: "client-a", startedAt: "2026-09-26T06:00:00Z", status: "completed",
    usage: runUsageFromProtocol({ last: { inputTokens: 100, outputTokens: 50 } }),
  };
  run.usage = runUsageFromProtocol({ last: { inputTokens: 100, outputTokens: 50 } });
  const buckets = aggregateRunUsage([run], { from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z") });
  assert.equal(buckets[0].runs, 1);
  assert.equal(buckets[0].totalTokens, 150);
  assert.equal(buckets[0].knownRuns, 1);
});

test("queued and running work is not mislabeled as missing final usage", () => {
  const base = { clientId: "client-a", startedAt: "2026-09-26T06:00:00Z", usage: { status: "unknown" } };
  const buckets = aggregateRunUsage([
    { ...base, id: "queued", status: "queued" },
    { ...base, id: "running", status: "running" },
    { ...base, id: "canceling", status: "canceling" },
    { ...base, id: "failed", status: "failed" },
  ], { from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z") });
  assert.equal(buckets[0].runs, 4);
  assert.equal(buckets[0].failed, 1);
  assert.equal(buckets[0].unknownRuns, 1);
});

test("canceled and legacy cancelled runs retain known or unknown usage without counting as failures", () => {
  for (const status of ["canceled", "cancelled"]) {
    const range = { from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z") };
    const run = { id: "canceled", clientId: "client-a", startedAt: "2026-09-26T06:00:00Z", status };
    const known = aggregateRunUsage([{ ...run, usage: runUsageFromProtocol({ last: { inputTokens: 100, outputTokens: 20 } }) }], range)[0];
    assert.equal(known.totalTokens, 120);
    assert.equal(known.knownRuns, 1);
    assert.equal(known.failed, 0);
    assert.equal(known.completed, 0);
    assert.equal(aggregateRunUsage([{ ...run, usage: { status: "unknown" } }], range)[0].unknownRuns, 1);
  }
});

test("request drilldown returns scoped per-run usage without prompt content", () => {
  const range = { from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z"), clientId: "client-a" };
  const rows = runUsageDetails([
    { id: "run-a", clientId: "client-a", automationId: "research", status: "completed", startedAt: "2026-09-26T06:00:00Z", prompt: "private", model: "gpt-5.6-terra", usage: { status: "complete", inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    { id: "run-b", clientId: "client-b", automationId: "research", status: "failed", startedAt: "2026-09-26T07:00:00Z" },
  ], range);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage.totalTokens, 120);
  assert.equal("prompt" in rows[0], false);
});

test("task quality separates uncertain outcomes and computes percentiles from valid timings only", () => {
  const range = { from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z"), clientId: "a" };
  const base = { clientId: "a", startedAt: "2026-09-26T06:00:00Z", executionStartedAt: "2026-09-26T06:00:01Z", finishedAt: "2026-09-26T06:00:03Z" };
  const rows = [
    { ...base, id: "complete", status: "completed", threadId: "thread", turnId: "turn", usage: runUsageFromProtocol({ last: { inputTokens: 10, outputTokens: 2 } }) },
    { ...base, id: "failed", status: "failed", threadId: "thread", turnId: "turn", finishedAt: "2026-09-26T06:00:11Z" },
    { ...base, id: "canceled", status: "canceled", executionStartedAt: null },
    { ...base, id: "interrupted", status: "interrupted", finishedAt: "2026-09-26T23:00:00Z" },
    { ...base, id: "reconcile", status: "needs_reconciliation", finishedAt: "2026-09-26T23:00:00Z" },
    { ...base, id: "running", status: "running" },
    { ...base, id: "queued", status: "queued", executionStartedAt: null },
    { ...base, id: "future-status", status: "new-status", executionStartedAt: "2026-09-26T05:59:59Z" },
    { ...base, id: "other", status: "completed", clientId: "b" },
    { ...base, id: "outside", status: "completed", executionStartedAt: "2026-09-27T00:00:00Z" },
  ];
  const summary = summarizeRunUsage(rows, range);
  assert.deepEqual(summary, { tasks: 8, completed: 1, failed: 1, canceled: 1, unresolved: 2, active: 2, unclassified: 1,
    knownUsage: 1, unknownUsage: 4, observedModelTurns: 1, successRate: 0.5, unknownUsageRate: 0.8,
    queueWait: { samples: 5, p50Ms: 1000, p95Ms: 1000 }, execution: { samples: 2, p50Ms: 2000, p95Ms: 10000 },
    attribution: "execution_start_else_acceptance", successRateBasis: "completed_and_failed_only" });
  const bucket = aggregateRunUsage(rows, range).find(bucket => bucket.hour === "2026-09-26T06:00:00Z");
  assert.equal(bucket.failed, 1);
  assert.equal(bucket.unresolved, 2);
  assert.equal(bucket.canceled, 1);
  assert.equal(bucket.unknownRuns, 4);
  const empty = summarizeRunUsage([], range);
  assert.equal(empty.successRate, null);
  assert.equal(empty.unknownUsageRate, null);
  assert.deepEqual(empty.execution, { samples: 0, p50Ms: null, p95Ms: null });
});
