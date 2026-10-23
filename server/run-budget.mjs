const activeStatuses = new Set(["queued", "running", "canceling"]);

export function dailyTokenBudgetRuns(runs, now) {
  const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  return runs.filter((run) => {
    const startedAt = Date.parse(run.executionStartedAt || run.startedAt || "");
    return run.runner === "app-server" && startedAt >= dayStart && startedAt <= now;
  });
}

export function checkKnownTokenBudget(runs, { limit, now = Date.now(), clientId = "", excludeRunId = null, ignoreUnstartedQueue = false }) {
  const maximum = Number(limit);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return { ok: true, enabled: false };
  const relevant = dailyTokenBudgetRuns(runs, now).filter(run => (!clientId || run.clientId === clientId) && (!excludeRunId || run.id !== excludeRunId) &&
    (!ignoreUnstartedQueue || run.status !== "queued" || run.executionStartedAt));
  if (relevant.some((run) => activeStatuses.has(run.status))) {
    return { ok: false, statusCode: 429, code: "token_usage_pending", retryAfterMs: 30_000, reason: "已有任务尚未结算用量，请等待其结束" };
  }
  if (relevant.some((run) => run.usage?.status !== "complete" || !Number.isSafeInteger(run.usage?.totalTokens) || run.usage.totalTokens < 0)) {
    return { ok: false, statusCode: 409, code: "token_usage_incomplete", reason: "今日存在未知或无效用量，请先核对，不能按零消耗继续" };
  }
  const used = relevant.reduce((sum, run) => sum + run.usage.totalTokens, 0);
  if (used >= maximum) {
    const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
    return { ok: false, statusCode: 429, code: "known_token_limit_reached", retryAfterMs: Math.max(1_000, dayStart + 86_400_000 - now), reason: "已达到今日已知 Token 上限" };
  }
  return { ok: true, enabled: true, used, limit: maximum };
}
