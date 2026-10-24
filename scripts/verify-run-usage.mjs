import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRunUsage, createTurnUsageMeter, normalizeRunUsage, runUsageDetails, summarizeRunUsage } from "../server/run-usage.mjs";
import { externalRunView } from "../server/external-automation.mjs";

const runUsageFromProtocol = value => {
  const meter = createTurnUsageMeter();
  meter.observe({ ...value, total: value.total || value.last });
  return meter.snapshot();
};

test("one request does not add cache or reasoning subfields twice", () => {
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

test("one turn accumulates request counter deltas, not only last request or previous turns", () => {
  const meter = createTurnUsageMeter();
  const frame = count => ({ total: { inputTokens: count * 10, outputTokens: count * 2 }, last: { inputTokens: 10, outputTokens: 2 } });
  meter.observe(frame(101)); meter.observe(frame(102)); meter.observe(frame(102));
  assert.equal(meter.snapshot().totalTokens, 24);
  assert.equal(meter.snapshot().source, "app-server:turn-counter-delta");
  const next = createTurnUsageMeter(); next.observe(frame(103));
  assert.equal(next.snapshot().totalTokens, 12);
});

test("missing, invalid, regressing or overflowing counters never become complete usage", () => {
  for (const bad of [null, { last: { inputTokens: 10, outputTokens: 2 } },
    { total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 20, outputTokens: 2 } },
    { total: { inputTokens: 0.5, outputTokens: 2 }, last: { inputTokens: 0.5, outputTokens: 2 } },
    { total: { inputTokens: 10, outputTokens: 2, totalTokens: 15 }, last: { inputTokens: 10, outputTokens: 2 } },
    { total: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 }, last: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 } }]) {
    const meter = createTurnUsageMeter(); meter.observe(bad); assert.equal(meter.snapshot().status, "unknown");
  }
  const meter = createTurnUsageMeter();
  meter.observe({ total: { inputTokens: 20, outputTokens: 4 }, last: { inputTokens: 10, outputTokens: 2 } });
  meter.observe({ total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 10, outputTokens: 2 } });
  meter.observe({ total: { inputTokens: 30, outputTokens: 6 }, last: { inputTokens: 10, outputTokens: 2 } });
  assert.equal(meter.snapshot().status, "unknown");
});

test("large historical counters subtract before adding current-turn tokens without losing integer precision", () => {
  const meter = createTurnUsageMeter(), max = Number.MAX_SAFE_INTEGER;
  meter.observe({ total: { inputTokens: max - 1, outputTokens: 0 }, last: { inputTokens: 10, outputTokens: 0 } });
  meter.observe({ total: { inputTokens: max, outputTokens: 0 }, last: { inputTokens: 1, outputTokens: 0 } });
  assert.equal(meter.snapshot().inputTokens, 11);
  assert.equal(meter.snapshot().totalTokens, 11);
});

test("delegation remains unknown despite subsequent parent or child-completed snapshots", () => {
  for (const type of ["subAgentActivity", "collabAgentToolCall"]) {
    const meter = createTurnUsageMeter();
    meter.observeItem({ type, kind: "started" });
    meter.observe({ total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 10, outputTokens: 2 } });
    meter.observeItem({ type, kind: "completed" });
    assert.equal(meter.snapshot().status, "unknown");
    assert.match(meter.snapshot().reason, /独立协作/);
  }
});

test("legacy last-request counts remain retained but no longer qualify as complete run totals", () => {
  const legacy = { status: "complete", source: "app-server:last-turn", inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  const projected = normalizeRunUsage(legacy);
  assert.equal(projected.status, "unknown");
  assert.deepEqual(projected.reportedLastRequest, { source: legacy.source, inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  assert.equal(legacy.status, "complete");
  const runs = [{ id: "old", clientId: "a", status: "completed", startedAt: "2026-09-26T06:00:00Z", usage: legacy }];
  const range = { from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z") };
  assert.equal(aggregateRunUsage(runs, range)[0].totalTokens, 0);
  assert.equal(aggregateRunUsage(runs, range)[0].unknownRuns, 1);
  assert.equal(runUsageDetails(runs, range)[0].usage.status, "unknown");
  assert.match(runUsageDetails(runs, range)[0].usage.reason, /历史快照/);
  assert.equal(summarizeRunUsage(runs, range).unknownUsage, 1);
  assert.equal(externalRunView({ ...runs[0], automationId: "fixture" }, "fixture").usage.status, "unknown");
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
