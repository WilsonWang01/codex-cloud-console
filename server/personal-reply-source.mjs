import crypto from "node:crypto";
import { z } from "zod";

const id = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));
export const personalReplySourceSchema = z.object({ sessionId: id, threadId: id, turnId: id, messageId: id,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const personalReplyDigest = text => crypto.createHash("sha256").update(text).digest("hex");
export const personalReplySourceKey = source => personalReplyDigest(JSON.stringify([source.threadId, source.turnId, source.messageId, source.contentDigest]));
export const personalReplyReferenceList = z.array(personalReplySourceSchema).max(8)
  .refine(items => new Set(items.map(personalReplySourceKey)).size === items.length, "回复结果关联重复");
// Keep existing feedback error codes stable while sharing its source validation.
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code: `personal_feedback_${code}`, statusCode });
const finalReply = item => item.role === "codex" && item.messageType === "agentMessage" && !item.mocked && typeof item.text === "string" && item.text.trim()
  && (item.details?.phase == null || item.details.phase === "final_answer");
const checkItems = turn => {
  if (turn.itemsView != null && turn.itemsView !== "full") throw fail("source_unavailable", "上游尚未提供完整回复，暂时无法核对", 503);
};
function checkedThread(session, snapshot) {
  if (session?.repoId !== "_personal" || !session.codexSessionId) throw fail("session_missing", "未找到可核对的个人会话", 404);
  const thread = snapshot?.thread;
  if (snapshot?.ok !== true || thread?.id !== session.codexSessionId || !Array.isArray(thread.turns) || !Array.isArray(snapshot.messages)) {
    throw fail("source_unavailable", "回复来源暂时无法核对，请稍后重试", 503);
  }
  return thread;
}
export function personalReplyTarget(session, snapshot, input) {
  const thread = checkedThread(session, snapshot);
  const turns = thread.turns.filter(turn => turn.id === input.turnId);
  if (turns.length !== 1 || turns[0].status !== "completed") throw fail("source_changed", "这次回复尚未完成或已变化，请刷新后核对");
  checkItems(turns[0]);
  const message = snapshot.messages.filter(item => item.turnId === input.turnId && finalReply(item)).at(-1);
  if (!message || message.id !== input.messageId || personalReplyDigest(message.text) !== input.contentDigest) {
    throw fail("source_changed", "回复内容已变化，请刷新后核对");
  }
  return personalReplySourceSchema.parse({ sessionId: session.id, threadId: session.codexSessionId, turnId: input.turnId, messageId: message.id, contentDigest: input.contentDigest });
}
export function personalReplyView(session, snapshot, input) {
  const source = personalReplyTarget(session, snapshot, input);
  const message = snapshot.messages.filter(item => item.turnId === source.turnId && finalReply(item)).at(-1);
  const completedAt = snapshot.thread.turns.find(turn => turn.id === source.turnId)?.completedAt;
  const date = typeof completedAt === "number" ? new Date(completedAt * 1000) : null;
  return { source, key: personalReplySourceKey(source), preview: message.text.slice(0, 160), text: message.text.slice(0, 4000),
    truncated: message.text.length > 4000, time: date && Number.isFinite(date.getTime()) ? date.toISOString() : null };
}
export function personalReplyCandidates(session, snapshot) {
  const thread = checkedThread(session, snapshot), completed = new Set(thread.turns.filter(turn => turn.status === "completed").map(turn => turn.id)), messages = new Map();
  thread.turns.filter(turn => turn.status === "completed").forEach(checkItems);
  for (const item of snapshot.messages) if (completed.has(item.turnId) && finalReply(item)) messages.set(item.turnId, item);
  const latest = [...messages.values()].reverse();
  return { results: latest.slice(0, 20).map(item => personalReplyView(session, snapshot, { turnId: item.turnId, messageId: item.id, contentDigest: personalReplyDigest(item.text) })), hasMore: latest.length > 20 };
}
