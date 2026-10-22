const activeStatuses = new Set(["queued", "running", "canceling"]);

export function dailyTokenBudgetRuns(runs, now) {
  const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  return runs.filter((run) => {
    const startedAt = Date.parse(run.startedAt || "");
    return run.runner === "app-server" && startedAt >= dayStart && startedAt <= now;
  });
}

export function checkKnownTokenBudget(runs, { limit, now = Date.now() }) {
  const maximum = Number(limit);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return { ok: true, enabled: false };
  const relevant = dailyTokenBudgetRuns(runs, now);
  if (relevant.some((run) => activeStatuses.has(run.status))) {
    return { ok: false, statusCode: 429, retryAfterMs: 30_000, reason: "A running automation has not reported final token usage" };
  }
  if (relevant.some((run) => run.usage?.status !== "complete" || !Number.isSafeInteger(run.usage?.totalTokens) || run.usage.totalTokens < 0)) {
    return { ok: false, statusCode: 409, reason: "Today's automation token usage is incomplete; review it before starting another run" };
  }
  const used = relevant.reduce((sum, run) => sum + run.usage.totalTokens, 0);
  if (used >= maximum) {
    const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
    return { ok: false, statusCode: 429, retryAfterMs: Math.max(1_000, dayStart + 86_400_000 - now), reason: "Known daily automation token limit reached" };
  }
  return { ok: true, enabled: true, used, limit: maximum };
}
