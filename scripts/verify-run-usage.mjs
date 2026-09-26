import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRunUsage, runUsageFromProtocol } from "../server/run-usage.mjs";

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
