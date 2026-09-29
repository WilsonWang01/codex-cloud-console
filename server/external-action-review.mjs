export function externalWriteAttempt(item = {}, { includeUnverified = false } = {}) {
  if (item.type !== "mcpToolCall" || !item.id || item.readOnlyHint === true) return null;
  if (item.readOnlyHint !== false && !includeUnverified) return null;
  return {
    id: String(item.id).slice(0, 120),
    server: String(item.appContext?.appName || item.server || "connected service").slice(0, 100),
    tool: String(item.tool || item.appContext?.actionName || "action").slice(0, 120),
    status: "inProgress",
    ...(item.readOnlyHint !== false ? { unverifiedReadOnly: true } : {}),
  };
}

export function unresolvedExternalAction(attempts, { ok, turnId, automationRunId, at = new Date().toISOString() } = {}) {
  const writes = [...attempts.values()];
  if (ok && writes.every((item) => item.status === "completed")) return null;
  const last = writes.at(-1);
  if (!last) return null;
  const unfinished = writes.some((item) => item.status !== "completed");
  const unverifiedOnly = writes.every((item) => item.unverifiedReadOnly);
  const reason = unverifiedOnly
    ? "连接服务操作未声明只读，是否造成外部修改尚不明确。请先在对应服务核对，勿直接重试。"
    : unfinished
      ? "连接服务写入尚无可信的成功回执，是否已执行尚不明确。请先在对应服务核对，勿直接重试。"
      : "连接服务报告写入完成，但本轮会话未正常结束。请先核对对应服务中的结果，勿直接重试。";
  return {
    id: String(turnId || "turn").slice(0, 120),
    ...(automationRunId ? { automationRunId: String(automationRunId).slice(0, 120) } : {}),
    server: last.server,
    tool: last.tool,
    count: writes.length,
    actions: writes.slice(-10).map(({ server, tool, status }) => ({ server, tool, status })),
    at,
    reason,
  };
}
