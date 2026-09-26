import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRunUsage, runUsageDetails, runUsageFromProtocol } from "../server/run-usage.mjs";

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
    { ...base, id: "failed", status: "failed" },
  ], { from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z") });
  assert.equal(buckets[0].runs, 3);
  assert.equal(buckets[0].failed, 1);
  assert.equal(buckets[0].unknownRuns, 1);
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
