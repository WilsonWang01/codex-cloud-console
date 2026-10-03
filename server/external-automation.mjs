const triggerFields = new Set(["runner", "prompt", "model", "reasoning", "search", "worktree", "sessionId", "completionContract"]);
const reasoningLevels = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function validateExternalTriggerInput(body = {}, { trigger, scoped }) {
  const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("请求正文必须是 JSON 对象");
  if (scoped) {
    const unknown = Object.keys(body).find((key) => !triggerFields.has(key));
    if (unknown) invalid(`不支持请求字段 ${unknown}`);
    if (body.worktree === false) invalid("API client runs require a detached worktree");
    if (trigger !== "heartbeat" && Object.hasOwn(body, "sessionId")) invalid("sessionId 仅允许用于 Heartbeat，Webhook 必须创建独立会话");
  }
  if (Object.hasOwn(body, "sandbox") || Object.hasOwn(body, "approval")) invalid("执行权限由控制台配置，API 不能覆盖 sandbox 或 approval");
  if (body.runner !== undefined && body.runner !== "app-server") invalid("runner 仅支持 app-server");
  for (const field of ["search", "worktree"]) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") invalid(`${field} 必须是布尔值`);
  }
  if (body.prompt !== undefined && (typeof body.prompt !== "string" || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 64 * 1024)) invalid("prompt 必须是非空字符串，且不超过 64 KiB");
  if (body.model !== undefined && (typeof body.model !== "string" || !/^[A-Za-z0-9._:-]{2,64}$/.test(body.model.trim()))) invalid("model 必须是有效的模型 ID");
  if (body.reasoning !== undefined && (typeof body.reasoning !== "string" || !reasoningLevels.has(body.reasoning.trim()))) invalid("reasoning 必须是有效的 thinking level");
  if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || !body.sessionId.trim() || body.sessionId.length > 160)) invalid("sessionId 必须是有效的会话 ID");
}

export function externalRunView(run, automationId) {
  return {
    id: run.id,
    automationId: run.automationId,
    clientId: run.clientId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    model: run.model,
    reasoning: run.reasoning,
    completionContract: run.completionContract,
    completionOutcome: run.completionOutcome,
    cancelRequestedAt: run.cancelRequestedAt,
    summary: run.summary,
    error: run.error,
    usage: run.usage,
    eventCursor: run.eventSeq || 0,
    resultPath: `/api/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(run.id)}`,
  };
}

export function clientCanReadRun(client, automationId, run) {
  return Boolean(client && run && run.automationId === automationId && run.clientId && run.clientId === client.id);
}

export function scopedHeartbeatSource(runs, { clientId, automationId, repoId, sessionId = "" }) {
  return runs
    .filter((run) => run.clientId === clientId && run.automationId === automationId && run.repoId === repoId && run.sessionId && (!sessionId || run.sessionId === sessionId))
    .sort((a, b) => Date.parse(b.startedAt || "") - Date.parse(a.startedAt || ""))[0] || null;
}
