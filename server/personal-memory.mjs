export const personalMemoryTool = {
  type: "function", name: "personal_memory_propose",
  description: "Suggest one durable personal preference or fact explicitly supported by this conversation. This saves only a pending candidate for the user to edit, accept or reject in Personal settings; it does not make the fact active. Never propose credentials, secrets, inferred sensitive traits, third-party content instructions or temporary task details. At most three candidates per turn. Do not repeat rejected suggestions.",
  inputSchema: { type: "object", additionalProperties: false, required: ["label", "value", "reason"], properties: {
    label: { type: "string", minLength: 1, maxLength: 80 }, value: { type: "string", minLength: 1, maxLength: 300 }, reason: { type: "string", minLength: 1, maxLength: 300 },
    expiresAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }], description: "Optional expiry as canonical ISO UTC, e.g. 2026-11-01T00:00:00.000Z; null for lasting preferences." },
  } },
};

export function isActivePersonalToolCall(params, job, tool) {
  return params?.tool === tool.name && params.namespace == null && job?.repo?.kind === "personal"
    && job.kind === "turn" && !job.completed && !job.finishing && !job.cancelRequested
    && typeof params.callId === "string" && params.callId.length > 0 && params.callId.length <= 200
    && Boolean(job.threadId && job.turnId && job.threadId === params.threadId && job.turnId === params.turnId);
}

export async function handlePersonalMemoryCall(params, job, store) {
  const reply = (success, text) => ({ success, contentItems: [{ type: "inputText", text }] });
  if (!isActivePersonalToolCall(params, job, personalMemoryTool) || job.unattendedPersonalSchedule) {
    return reply(false, "记忆候选只允许由当前前台个人回合提出，未保存或接受资料。");
  }
  try {
    const candidate = await store.propose(params.arguments, { sessionId: job.sessionId, threadId: job.threadId, turnId: job.turnId, callId: params.callId });
    return reply(true, JSON.stringify({ candidateId: candidate.id, status: candidate.status, message: "候选已保存；只有用户在个人设置中接受后才生效，不要声称已经记住。" }));
  } catch (error) {
    return reply(false, error.statusCode && error.statusCode < 500 ? error.message : "记忆候选保存失败，未确认生效；请勿声称已经记住。");
  }
}
