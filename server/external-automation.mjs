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
