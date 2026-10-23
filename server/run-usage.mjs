import { recordDuration, summarizeDurations } from "./usage-statistics.mjs";

const terminalStatuses = new Set(["completed", "failed", "interrupted", "needs_reconciliation", "canceled", "cancelled"]);
const unresolvedStatuses = new Set(["interrupted", "needs_reconciliation"]);
const inRange = (run, { from, to, clientId = "" }) => {
  const time = Date.parse(run.executionStartedAt || run.startedAt || "");
  return run.clientId && (!clientId || run.clientId === clientId) && Number.isFinite(time) && time >= from && time < to;
};

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
    if (!inRange(run, { from, to, clientId })) continue;
    const time = Date.parse(run.executionStartedAt || run.startedAt || "");
    const hour = new Date(time).toISOString().slice(0, 13) + ":00:00Z";
    const key = `${hour}:${run.clientId}`;
    const bucket = buckets.get(key) || {
      hour, clientId: run.clientId, runs: 0, completed: 0, failed: 0, unresolved: 0, canceled: 0,
      knownRuns: 0, unknownRuns: 0, inputTokens: 0, outputTokens: 0,
      cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    };
    bucket.runs += 1;
    if (run.status === "completed") bucket.completed += 1;
    if (run.status === "failed") bucket.failed += 1;
    if (unresolvedStatuses.has(run.status)) bucket.unresolved++;
    if (["canceled", "cancelled"].includes(run.status)) bucket.canceled++;
    if (!terminalStatuses.has(run.status)) {
      buckets.set(key, bucket);
      continue;
    }
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

export function runUsageDetails(runs, { from, to, clientId = "", limit = 200 }) {
  return runs.filter(run => inRange(run, { from, to, clientId })).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit).map((run) => ({
    id: run.id,
    clientId: run.clientId,
    automationId: run.automationId,
    status: run.status,
    startedAt: run.startedAt,
    executionStartedAt: run.executionStartedAt || null,
    finishedAt: run.finishedAt || null,
    model: run.model || null,
    reasoning: run.reasoning || null,
    usage: run.usage?.status === "complete" ? {
      status: "complete",
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      totalTokens: run.usage.totalTokens,
      cachedInputTokens: run.usage.cachedInputTokens,
    } : { status: "unknown" },
  }));
}
export function summarizeRunUsage(runs, range) {
  const counts = { tasks: 0, completed: 0, failed: 0, canceled: 0, unresolved: 0, active: 0, unclassified: 0, knownUsage: 0, unknownUsage: 0 };
  const queue = new Map(), execution = new Map(), turns = new Set();
  for (const run of runs) {
    if (!inRange(run, range)) continue;
    counts.tasks++;
    if (run.status === "completed") counts.completed++;
    else if (run.status === "failed") counts.failed++;
    else if (["canceled", "cancelled"].includes(run.status)) counts.canceled++;
    else if (unresolvedStatuses.has(run.status)) counts.unresolved++;
    else if (["queued", "running", "canceling"].includes(run.status)) counts.active++;
    else counts.unclassified++;
    if (terminalStatuses.has(run.status)) {
      if (run.usage?.status === "complete") counts.knownUsage++;
      else counts.unknownUsage++;
    }
    if (run.threadId && run.turnId) turns.add(JSON.stringify([run.threadId, run.turnId]));
    const accepted = Date.parse(run.startedAt), started = Date.parse(run.executionStartedAt), finished = Date.parse(run.finishedAt);
    if (Number.isFinite(accepted) && Number.isFinite(started)) recordDuration(queue, started - accepted);
    // Recovery timestamps do not establish when interrupted execution actually stopped.
    if (terminalStatuses.has(run.status) && !unresolvedStatuses.has(run.status) && Number.isFinite(started) && Number.isFinite(finished)) recordDuration(execution, finished - started);
  }
  const resolved = counts.completed + counts.failed, measured = counts.knownUsage + counts.unknownUsage;
  return { ...counts, observedModelTurns: turns.size, successRate: resolved ? counts.completed / resolved : null,
    unknownUsageRate: measured ? counts.unknownUsage / measured : null, queueWait: summarizeDurations(queue), execution: summarizeDurations(execution),
    attribution: "execution_start_else_acceptance", successRateBasis: "completed_and_failed_only" };
}
