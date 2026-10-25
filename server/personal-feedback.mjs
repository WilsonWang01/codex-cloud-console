import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { createKeyedQueue } from "./run-safety.mjs";
import { readRootedFile } from "./safe-file-read.mjs";
import { personalReplySourceSchema, personalReplyDigest, personalReplyTarget } from "./personal-reply-source.mjs";

const serialize = createKeyedQueue();
const limits = { entries: 1000, bytes: 1024 * 1024 };
const id = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));
const instant = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decision = z.enum(["helpful", "not_helpful"]).nullable();
const sourceSchema = personalReplySourceSchema;
const inputSchema = z.object({ turnId: id, messageId: id, contentDigest: digest, decision, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const entrySchema = sourceSchema.extend({ key: digest, source: z.literal("user"), decision, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), createdAt: instant, updatedAt: instant }).strict();
const stateSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(limits.entries) }).strict();
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code: `personal_feedback_${code}`, statusCode });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const sourceKey = value => hash(JSON.stringify([value.threadId, value.turnId]));

export const personalFeedbackDigest = personalReplyDigest;
export const personalFeedbackTarget = personalReplyTarget;

export function personalFeedbackSummary(entries, now = Date.now()) {
  const from = now - 7 * 86400_000;
  const recent = entries.filter(entry => entry.decision !== null && Date.parse(entry.updatedAt) >= from && Date.parse(entry.updatedAt) <= now);
  const helpfulCount = recent.filter(entry => entry.decision === "helpful").length;
  return { from: new Date(from).toISOString(), until: new Date(now).toISOString(), ratedCount: recent.length,
    helpfulCount, notHelpfulCount: recent.length - helpfulCount, helpfulRatio: recent.length ? helpfulCount / recent.length : null };
}

export function createPersonalFeedbackStore(filePath, { now = () => Date.now() } = {}) {
  filePath = path.resolve(filePath);
  const read = async () => {
    try {
      const { buffer } = await readRootedFile(path.dirname(filePath), path.basename(filePath), limits.bytes);
      const parsed = stateSchema.safeParse(JSON.parse(buffer.toString("utf8")));
      if (!parsed.success || parsed.data.entries.some(entry => entry.key !== sourceKey(entry))
        || new Set(parsed.data.entries.map(entry => entry.key)).size !== parsed.data.entries.length) throw fail("invalid", "评价记录无法核对，原数据未改写", 503);
      return parsed.data;
    } catch (error) {
      if (error.code === "file_not_found") return { version: 1, entries: [] };
      throw fail("invalid", "评价记录无法安全读取，原数据未改写", 503);
    }
  };
  const write = async state => {
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > limits.bytes) throw fail("capacity", "评价记录已达到容量上限，原数据未覆盖", 503);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temp, "wx", 0o600); await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, filePath);
      const directory = await fs.open(path.dirname(filePath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await handle?.close(); await fs.unlink(temp).catch(() => null); }
  };
  return {
    list: async threadId => (await read()).entries.filter(entry => !threadId || entry.threadId === threadId),
    summary: async () => personalFeedbackSummary((await read()).entries, now()),
    set: (source, input, authorize = async () => true) => serialize(filePath, async () => {
      source = sourceSchema.parse(source); input = inputSchema.parse(input);
      if (["turnId", "messageId", "contentDigest"].some(key => source[key] !== input[key])) throw fail("source_changed", "评价内容与回复来源不一致");
      const state = await read(), key = sourceKey(source), previous = state.entries.find(entry => entry.key === key);
      if (await authorize() !== true) throw fail("source_changed", "个人会话已变化，未保存评价");
      if (previous && input.expectedRevision <= previous.revision && previous.messageId === source.messageId && previous.contentDigest === source.contentDigest && previous.decision === input.decision) return previous;
      if ((previous?.revision || 0) !== input.expectedRevision) throw fail("conflict", "评价已在其他页面变化，请刷新核对后再保存");
      if (!previous && input.decision === null) throw fail("missing", "这条回复还没有已保存的评价");
      if (!previous && state.entries.length >= limits.entries) throw fail("capacity", "个人评价已达 1000 条上限，原记录保留，已有评价仍可修改", 503);
      if (previous?.revision === Number.MAX_SAFE_INTEGER) throw fail("capacity", "这条评价已达到版本上限，原记录未覆盖", 503);
      const at = new Date(now()).toISOString();
      const entry = { ...source, key, source: "user", decision: input.decision, revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || at, updatedAt: at };
      if (previous) state.entries[state.entries.indexOf(previous)] = entry; else state.entries.push(entry);
      await write(state); return entry;
    }),
  };
}

export function personalFeedbackRouter({ store, resolveSession, readThread }) {
  const router = Router();
  const route = (method, url, operation) => router[method](url, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json({ ok: true, version: 1, ...(await operation(req)) }); }
    catch (error) {
      const known = error.code?.startsWith("personal_feedback_");
      res.status(error instanceof z.ZodError ? 400 : known ? error.statusCode : 503).json({ ok: false,
        error: error instanceof z.ZodError ? "评价参数无效" : known ? error.message : method === "post"
          ? "评价保存结果未能核对，请刷新查看；未自动重复提交" : "评价暂不可用，请稍后重试", ...(known ? { code: error.code } : {}) });
    }
  });
  const resolve = async id => {
    const session = await resolveSession(id);
    if (!session || session.repoId !== "_personal") throw fail("session_missing", "个人会话不存在", 404);
    return session;
  };
  route("get", "/feedback", async () => ({ summary: await store.summary() }));
  route("get", "/sessions/:id/feedback", async req => {
    const session = await resolve(req.params.id);
    return { enabled: Boolean(session.codexSessionId), threadId: session.codexSessionId || null, feedback: session.codexSessionId ? await store.list(session.codexSessionId) : [] };
  });
  route("post", "/sessions/:id/feedback", async req => {
    const input = inputSchema.parse(req.body), session = await resolve(req.params.id);
    const target = personalFeedbackTarget(session, await readThread(session), input);
    const entry = await store.set(target, input, async () => {
      const latest = await resolve(req.params.id);
      return latest.id === session.id && latest.codexSessionId === target.threadId;
    });
    return { feedback: entry };
  });
  return router;
}
