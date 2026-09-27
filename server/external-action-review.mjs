export function externalWriteAttempt(item = {}) {
  if (item.type !== "mcpToolCall" || item.readOnlyHint !== false || !item.id) return null;
  return {
    id: String(item.id).slice(0, 120),
    server: String(item.appContext?.appName || item.server || "connected service").slice(0, 100),
    tool: String(item.tool || item.appContext?.actionName || "action").slice(0, 120),
    status: "inProgress",
  };
}

export function unresolvedExternalAction(attempts, { ok, turnId, automationRunId, at = new Date().toISOString() } = {}) {
  const writes = [...attempts.values()];
  if (ok && writes.every((item) => item.status === "completed")) return null;
  const last = writes.at(-1);
  if (!last) return null;
  const unfinished = writes.some((item) => item.status !== "completed");
  return {
    id: String(turnId || "turn").slice(0, 120),
    ...(automationRunId ? { automationRunId: String(automationRunId).slice(0, 120) } : {}),
    server: last.server,
    tool: last.tool,
    count: writes.length,
    actions: writes.slice(-10).map(({ server, tool, status }) => ({ server, tool, status })),
    at,
    reason: unfinished
      ? "连接服务写入尚无可信的成功回执，是否已执行尚不明确。请先在对应服务核对，勿直接重试。"
      : "连接服务报告写入完成，但本轮会话未正常结束。请先核对对应服务中的结果，勿直接重试。",
  };
}
