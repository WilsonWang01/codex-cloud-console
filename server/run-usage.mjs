function field(value, camel, snake) {
  const raw = value?.[camel] ?? value?.[snake];
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

export function runUsageFromProtocol(value) {
  const last = value?.last || value?.last_turn || value?.lastTurn;
  if (!last || typeof last !== "object") return { status: "unknown", reason: "No per-turn usage snapshot" };
  const inputTokens = field(last, "inputTokens", "input_tokens");
  const outputTokens = field(last, "outputTokens", "output_tokens");
  if (inputTokens === null || outputTokens === null) {
    return { status: "unknown", reason: "Per-turn input or output tokens are missing" };
  }
  const reportedTotal = field(last, "totalTokens", "total_tokens");
  return {
    status: "complete",
    source: "app-server:last-turn",
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? inputTokens + outputTokens,
    cachedInputTokens: field(last, "cachedInputTokens", "cached_input_tokens"),
    reasoningOutputTokens: field(last, "reasoningOutputTokens", "reasoning_output_tokens"),
  };
}

export function aggregateRunUsage(runs, { from, to, clientId = "" }) {
  const buckets = new Map();
  for (const run of runs) {
    if (!run.clientId || (clientId && run.clientId !== clientId)) continue;
    const time = Date.parse(run.startedAt || "");
    if (!Number.isFinite(time) || time < from || time >= to) continue;
    const hour = new Date(time).toISOString().slice(0, 13) + ":00:00Z";
    const key = `${hour}:${run.clientId}`;
    const bucket = buckets.get(key) || {
      hour, clientId: run.clientId, runs: 0, completed: 0, failed: 0,
      knownRuns: 0, unknownRuns: 0, inputTokens: 0, outputTokens: 0,
      cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    };
    bucket.runs += 1;
    if (run.status === "completed") bucket.completed += 1;
    if (["failed", "interrupted"].includes(run.status)) bucket.failed += 1;
    if (run.usage?.status === "complete") {
      bucket.knownRuns += 1;
      bucket.inputTokens += run.usage.inputTokens;
      bucket.outputTokens += run.usage.outputTokens;
      bucket.totalTokens += run.usage.totalTokens;
      bucket.cachedInputTokens += run.usage.cachedInputTokens || 0;
      bucket.reasoningOutputTokens += run.usage.reasoningOutputTokens || 0;
    } else {
      bucket.unknownRuns += 1;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}
