import { Router } from "express";
import { z } from "zod";
import { personalReplySourceSchema, personalReplySourceKey, personalReplyCandidates, personalReplyView } from "./personal-reply-source.mjs";

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { code: "personal_result_reference", statusCode });
const input = z.object({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), source: personalReplySourceSchema }).strict();
export function personalResultReferencesRouter({ store, resolveSession, readThread }) {
  const router = Router();
  const route = (method, url, action) => router[method](url, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json({ ok: true, version: 1, ...(await action(req)) }); }
    catch (error) {
      const known = error.code === "personal_result_reference" || error.code === "personal_commitment_error" || error.code?.startsWith("personal_feedback_");
      res.status(error instanceof z.ZodError ? 400 : known ? error.statusCode : 503).json({ ok: false,
        error: error instanceof z.ZodError ? "结果关联参数无效" : known ? error.message : "原回复结果暂时无法核对，关联记录和输入仍保留；未自动重试" });
    }
  });
  const sessionFor = async id => {
    const session = await resolveSession(id);
    if (!session || session.repoId !== "_personal") throw fail("原个人对话不存在或不可用", 404);
    return session;
  };
  const itemFor = async (id, revision) => {
    const item = (await store.list()).find(item => item.id === id);
    if (!item) throw fail("个人事项不存在", 404);
    if (revision !== undefined && revision !== item.revision) throw fail("事项已在其他页面修改，请刷新核对；当前选择仍保留");
    return item;
  };
  const matchingSession = async source => {
    const session = await sessionFor(source.sessionId);
    if (session.id !== source.sessionId || session.codexSessionId !== source.threadId) throw fail("原个人对话的上下文已变化，未改动关联记录");
    return session;
  };
  route("get", "/sessions/:id/reply-results", async req => {
    const session = await sessionFor(req.params.id);
    if (!session.codexSessionId) return { sessionId: session.id, checkedAt: new Date().toISOString(), results: [], hasMore: false };
    const snapshot = await readThread(session), latest = await sessionFor(session.id);
    if (latest.codexSessionId !== session.codexSessionId) throw fail("个人对话上下文已变化，请刷新后重新读取");
    return { sessionId: session.id, checkedAt: new Date().toISOString(), ...personalReplyCandidates(session, snapshot) };
  });
  route("get", "/commitments/:id/result-references", async req => {
    const item = await itemFor(req.params.id), snapshots = new Map();
    const results = await Promise.all((item.resultReferences || []).map(async source => {
      try {
        const session = await matchingSession(source);
        if (!snapshots.has(source.threadId)) snapshots.set(source.threadId, Promise.resolve().then(() => readThread(session)));
        const view = personalReplyView(session, await snapshots.get(source.threadId), source);
        await matchingSession(source);
        return { ...view, state: "available" };
      } catch (error) {
        return { source, key: personalReplySourceKey(source), state: error.statusCode === 404 ? "missing" : error.statusCode === 409 ? "changed" : "unavailable",
          reason: error.statusCode === 404 ? "原个人对话暂不可用，关联记录保留" : error.statusCode === 409 ? "原回复或上下文已变化，请重新核对" : "原回复暂时无法读取，不能把旧结果当作刚刚核对成功" };
      }
    }));
    await itemFor(item.id, item.revision);
    return { commitment: item, checkedAt: new Date().toISOString(), results };
  });
  route("post", "/commitments/:id/result-references", async req => {
    const value = input.parse(req.body), item = await itemFor(req.params.id, value.revision), session = await matchingSession(value.source);
    const { source } = personalReplyView(session, await readThread(session), value.source);
    await matchingSession(source);
    await itemFor(item.id, item.revision);
    const refs = item.resultReferences || [];
    if (refs.some(ref => personalReplySourceKey(ref) === personalReplySourceKey(source))) return { commitment: item };
    if (refs.length >= 8) throw fail("每项事项最多关联 8 条回复结果，原记录保留");
    const commitment = await store.update(item.id, { revision: value.revision, resultReferences: [...refs, source] },
      () => matchingSession(source).then(() => true, () => false));
    return { commitment };
  });
  route("delete", "/commitments/:id/result-references", async req => {
    const value = input.parse(req.body), item = await itemFor(req.params.id, value.revision), refs = item.resultReferences || [];
    const remaining = refs.filter(ref => ref.sessionId !== value.source.sessionId || personalReplySourceKey(ref) !== personalReplySourceKey(value.source));
    return { commitment: remaining.length === refs.length ? item : await store.update(item.id, { revision: value.revision, resultReferences: remaining }) };
  });
  return router;
}
