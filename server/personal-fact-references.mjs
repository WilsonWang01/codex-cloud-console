import { normalizePersonalFactContext, personalFactDigest } from "./personal-facts.mjs";
import { isActivePersonalToolCall } from "./personal-memory.mjs";

export const personalFactReferenceTool = {
  type: "function", name: "personal_facts_reference",
  description: "Report which user-maintained personal facts you actually rely on in this turn. Use the exact IDs from the provided personal facts, only when relevant; do not report every provided fact by default. This records a model-reported reference in this turn's tool history, not proof of internal reasoning or task completion. It does not edit facts, approve actions or access external services.",
  inputSchema: { type: "object", additionalProperties: false, required: ["factIds"], properties: {
    factIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
  } },
};

const reply = (success, text) => ({ success, contentItems: [{ type: "inputText", text }] });
const validIds = ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 50 && new Set(ids).size === ids.length
  && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 200);

export function handlePersonalFactReferenceCall(params, job) {
  // An already-authorized personal plan may report sources, but this cannot edit facts or approve actions.
  if (!isActivePersonalToolCall(params, job, personalFactReferenceTool)) return reply(false, "引用登记只接受当前个人回合，未登记资料引用。");
  const input = params.arguments;
  if (!input || Object.keys(input).some(key => key !== "factIds") || !validIds(input.factIds)) return reply(false, "请提供不重复的个人资料 ID，最多 50 条；未登记引用。");
  const context = normalizePersonalFactContext({ ...job.personalFactSnapshot?.context, threadId: job.threadId });
  if (!context) return reply(false, "本回合提供的个人资料范围无法核对，未登记引用。");
  const provided = new Map(context.facts.map(fact => [fact.id, fact]));
  if (input.factIds.some(id => !provided.has(id))) return reply(false, "引用包含未向本回合提供的资料 ID，未登记引用。");
  return reply(true, JSON.stringify({ type: "personal_fact_reference", version: 1, source: "model_report",
    threadId: job.threadId, turnId: job.turnId, callId: params.callId,
    recordedAt: new Date().toISOString(), providedAt: context.providedAt, facts: input.factIds.map(id => provided.get(id)),
  }));
}

function referenceReceipt(message, threadId) {
  const detail = message.details;
  if (message.messageType !== "dynamicToolCall" || detail?.tool !== personalFactReferenceTool.name || detail.namespace != null
    || detail.status !== "completed" || detail.success !== true || !Array.isArray(detail.contentItems) || detail.contentItems.length !== 1) return null;
  const content = detail.contentItems[0];
  if (content?.type !== "inputText" || typeof content.text !== "string" || content.text.length > 24000) return null;
  try {
    const receipt = JSON.parse(content.text);
    if (receipt?.type !== "personal_fact_reference" || receipt.version !== 1 || receipt.source !== "model_report"
      || receipt.threadId !== threadId || receipt.turnId !== message.turnId || receipt.callId !== message.id
      || typeof receipt.recordedAt !== "string" || !Number.isFinite(Date.parse(receipt.recordedAt))
      || new Date(receipt.recordedAt).toISOString() !== receipt.recordedAt) return null;
    const context = normalizePersonalFactContext({ version: 1, threadId, providedAt: receipt.providedAt, facts: receipt.facts });
    const ids = detail.arguments?.factIds;
    if (!context || !validIds(ids) || ids.length !== context.facts.length || ids.some((id, i) => id !== context.facts[i].id)) return null;
    return { ...receipt, facts: context.facts };
  } catch { return null; }
}

export function personalFactReferenceMessages(messages, threadId, facts, now = Date.now()) {
  const current = facts && new Map(facts.map(fact => [fact.id, { fact, digest: personalFactDigest(fact) }]));
  return messages.map(message => {
    const receipt = referenceReceipt(message, threadId);
    if (!receipt) return message;
    const references = receipt.facts.map(reference => {
      const entry = current?.get(reference.id), fact = entry?.fact;
      const state = !current ? "unavailable" : !fact ? "removed" : entry.digest !== reference.digest ? "changed"
        : fact.source !== "user" ? "unconfirmed" : fact.enabled === false ? "disabled" : fact.expiresAt && Date.parse(fact.expiresAt) <= now ? "expired"
          : fact.revision !== reference.revision ? "reconfirmed" : "active";
      return { id: reference.id, revision: reference.revision, state,
        ...(fact && !["changed", "removed", "unavailable"].includes(state) ? { label: fact.label } : {}) };
    });
    return { ...message, text: `模型报告引用了 ${references.length} 条个人资料`,
      details: { ...message.details, personalFactReferences: { source: "model_report", recordedAt: receipt.recordedAt, checkedAt: new Date(now).toISOString(), turnId: receipt.turnId, references } } };
  });
}
