import { recordDuration, summarizeDurations } from "./usage-statistics.mjs";

const terminalStatuses = new Set(["completed", "failed", "interrupted", "needs_reconciliation", "canceled", "cancelled"]);
const unresolvedStatuses = new Set(["interrupted", "needs_reconciliation"]);
export const runInUsageRange = (run, { from, to, clientId = "" }) => {
  const time = Date.parse(run.executionStartedAt || run.startedAt || "");
  return run.clientId && (!clientId || run.clientId === clientId) && Number.isFinite(time) && time >= from && time < to;
};

function field(value, camel, snake) {
  const raw = value?.[camel] ?? value?.[snake];
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

function requestUsageFromProtocol(value) {
  const last = value?.last || value?.last_turn || value?.lastTurn;
  if (!last || typeof last !== "object") return { status: "unknown", reason: "No request usage snapshot" };
  const inputTokens = field(last, "inputTokens", "input_tokens");
  const outputTokens = field(last, "outputTokens", "output_tokens");
  if (inputTokens === null || outputTokens === null) {
    return { status: "unknown", reason: "Request input or output tokens are missing" };
  }
  const reportedTotal = field(last, "totalTokens", "total_tokens");
  if ((last.totalTokens != null || last.total_tokens != null) && reportedTotal === null) return { status: "unknown", reason: "原生总用量无效" };
  if (reportedTotal !== null && reportedTotal !== inputTokens + outputTokens) return { status: "unknown", reason: "原生输入、输出和总用量不一致" };
  return {
    status: "complete",
    source: "app-server:last-request",
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? inputTokens + outputTokens,
    cachedInputTokens: field(last, "cachedInputTokens", "cached_input_tokens"),
    reasoningOutputTokens: field(last, "reasoningOutputTokens", "reasoning_output_tokens"),
  };
}

const tokenFields = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningOutputTokens"];

export function createTurnUsageMeter() {
  let counter, accumulated, failure;
  const unknown = reason => { failure ||= reason; };
  return {
    observe(value) {
      if (!value || failure) return;
      const last = requestUsageFromProtocol(value), total = requestUsageFromProtocol({ last: value.total });
      if (last.status !== "complete" || total.status !== "complete" || tokenFields.some(key => last[key] !== null && total[key] !== null && last[key] > total[key])) {
        unknown("原生用量缺少完整请求或累计计数，无法确认本回合用量"); return;
      }
      if (counter && tokenFields.some(key => total[key] !== null && counter[key] !== null && total[key] < counter[key])) {
        unknown("原生累计用量倒退，未将不可靠的计数标为完整"); return;
      }
      // `last` is one provider request; later cumulative deltas include tool-loop requests without counting duplicate notifications twice.
      const next = Object.fromEntries(tokenFields.map(key => [key, !counter ? last[key]
        : accumulated[key] === null || total[key] === null || counter[key] === null ? null : accumulated[key] + (total[key] - counter[key])]));
      if (tokenFields.some(key => next[key] !== null && (!Number.isSafeInteger(next[key]) || next[key] < 0))) {
        unknown("本回合用量超出可可靠计量的范围"); return;
      }
      accumulated = next; counter = total;
    },
    observeItem(item) {
      if (["subAgentActivity", "collabAgentToolCall"].includes(item?.type)) unknown("存在独立协作或后续回合，用量尚未完整归集；父回合快照不代表全部消耗");
    },
    snapshot() {
      if (failure || !accumulated) return { status: "unknown", reason: failure || "没有本回合的可靠用量通知" };
      return { status: "complete", source: "app-server:turn-counter-delta", ...accumulated };
    },
  };
}

export function normalizeRunUsage(usage) {
  if (usage?.status === "complete" && ["app-server:last-turn", "app-server:last-request"].includes(usage.source)) {
    return { status: "unknown", reason: "历史快照只记录末次模型请求，不能证明完整回合消耗", reportedLastRequest: {
      source: usage.source, ...Object.fromEntries(tokenFields.filter(key => usage[key] !== undefined).map(key => [key, usage[key]])),
    } };
  }
  return usage || { status: "unknown", reason: "没有本回合的可靠用量记录" };
}

export function aggregateRunUsage(runs, { from, to, clientId = "" }) {
  const buckets = new Map();
  for (const run of runs) {
    if (!runInUsageRange(run, { from, to, clientId })) continue;
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
    const usage = normalizeRunUsage(run.usage);
    if (usage.status === "complete") {
      bucket.knownRuns += 1;
      bucket.inputTokens += usage.inputTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.totalTokens += usage.totalTokens;
      bucket.cachedInputTokens += usage.cachedInputTokens || 0;
      bucket.reasoningOutputTokens += usage.reasoningOutputTokens || 0;
    } else {
      bucket.unknownRuns += 1;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

export function runUsageDetails(runs, { from, to, clientId = "", limit = 200 }) {
  return runs.filter(run => runInUsageRange(run, { from, to, clientId })).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit).map(run => {
    const usage = normalizeRunUsage(run.usage);
    return {
      id: run.id, clientId: run.clientId, automationId: run.automationId, status: run.status,
      startedAt: run.startedAt, executionStartedAt: run.executionStartedAt || null, finishedAt: run.finishedAt || null,
      model: run.model || null, reasoning: run.reasoning || null,
      usage: usage.status === "complete" ? {
        status: "complete", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens, cachedInputTokens: usage.cachedInputTokens,
      } : { status: "unknown", reason: String(usage.reason || "没有本回合的可靠用量记录").slice(0, 320) },
    };
  });
}
export function summarizeRunUsage(runs, range) {
  const counts = { tasks: 0, completed: 0, failed: 0, canceled: 0, unresolved: 0, active: 0, unclassified: 0, knownUsage: 0, unknownUsage: 0 };
  const queue = new Map(), execution = new Map(), turns = new Set();
  for (const run of runs) {
    if (!runInUsageRange(run, range)) continue;
    counts.tasks++;
    if (run.status === "completed") counts.completed++;
    else if (run.status === "failed") counts.failed++;
    else if (["canceled", "cancelled"].includes(run.status)) counts.canceled++;
    else if (unresolvedStatuses.has(run.status)) counts.unresolved++;
    else if (["queued", "running", "canceling"].includes(run.status)) counts.active++;
    else counts.unclassified++;
    if (terminalStatuses.has(run.status)) {
      if (normalizeRunUsage(run.usage).status === "complete") counts.knownUsage++;
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
