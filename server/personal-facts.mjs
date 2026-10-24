import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createKeyedQueue } from "./run-safety.mjs";
import { readRootedFile } from "./safe-file-read.mjs";

const serialize = createKeyedQueue();
const maxBytes = 1024 * 1024;
export const personalFactsFormatVersion = 2;
const factError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const isoDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function cleanFact(value, field, max) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw factError(`${field}需为 1–${max} 个字符`);
  return text;
}

function settings(payload, previous = { enabled: true, expiresAt: null }) {
  const enabled = payload.enabled === undefined ? previous.enabled : payload.enabled;
  const expiresAt = payload.expiresAt === undefined ? previous.expiresAt : payload.expiresAt;
  if (typeof enabled !== "boolean" || (expiresAt !== null && !isoDate(expiresAt))) throw factError("启用状态或有效期无效");
  return { enabled, expiresAt };
}

export function activePersonalFacts(facts, now = Date.now()) {
  return facts.filter((fact) => fact.source === "user" && fact.enabled !== false
    && (fact.expiresAt == null || Date.parse(fact.expiresAt) > now));
}

export function personalFactSnapshot(facts, now = Date.now()) {
  const active = activePersonalFacts(facts, now);
  return {
    facts: active,
    context: { version: 1, providedAt: new Date(now).toISOString(), facts: active.map(({ id, revision, label, value }) => ({
      id, revision, digest: crypto.createHash("sha256").update(JSON.stringify([id, label, value])).digest("hex"),
    })) },
  };
}

export function normalizePersonalFactContext(value) {
  if (value?.version !== 1 || typeof value.threadId !== "string" || !value.threadId || !isoDate(value.providedAt)
    || !Array.isArray(value.facts) || value.facts.length > 50) return null;
  const ids = new Set();
  for (const fact of value.facts) {
    if (!fact || typeof fact.id !== "string" || !fact.id || ids.has(fact.id)
      || !Number.isSafeInteger(fact.revision) || fact.revision < 1 || !/^[a-f0-9]{64}$/.test(fact.digest)) return null;
    ids.add(fact.id);
  }
  return { version: 1, threadId: value.threadId, providedAt: value.providedAt, facts: value.facts.map(({ id, revision, digest }) => ({ id, revision, digest })) };
}

export function personalFactContextIssue(session, snapshot) {
  if (!session.codexSessionId) return null;
  const previous = normalizePersonalFactContext(session.personalFactContext);
  if (!previous || previous.threadId !== session.codexSessionId) return "旧会话的资料范围尚未核对。请开启新上下文，原历史会保留。";
  const current = new Map(snapshot.context.facts.map((fact) => [fact.id, fact.digest]));
  if (previous.facts.some((fact) => current.get(fact.id) !== fact.digest)) {
    return "这段会话曾收到的个人资料已更正、停用、到期或删除。请开启新上下文，避免继续使用旧内容。";
  }
  return null;
}

export function createPersonalFactsStore(filePath) {
  filePath = path.resolve(filePath);
  const read = async () => {
    try {
      const { buffer } = await readRootedFile(path.dirname(filePath), path.basename(filePath), maxBytes);
      const parsed = JSON.parse(buffer.toString("utf8"));
      if (![1, 2].includes(parsed?.version) || !Array.isArray(parsed.facts) || parsed.facts.length > 50) throw factError("个人事实数据格式无效", 500);
      const ids = new Set();
      const facts = parsed.facts.map((fact) => {
        const revision = fact?.revision === undefined && parsed.version === 1 ? 1 : fact?.revision;
        if (!fact || typeof fact.id !== "string" || !fact.id || ids.has(fact.id)
          || typeof fact.label !== "string" || !fact.label.trim() || fact.label.length > 80
          || typeof fact.value !== "string" || !fact.value.trim() || fact.value.length > 300
          || !Number.isSafeInteger(revision) || revision < 1) throw factError("个人事实数据格式无效", 500);
        ids.add(fact.id);
        const legacy = parsed.version === 1;
        if (!legacy && (typeof fact.enabled !== "boolean" || (fact.confirmedAt !== null && !isoDate(fact.confirmedAt))
          || (fact.expiresAt !== null && !isoDate(fact.expiresAt)))) throw factError("个人事实数据格式无效", 500);
        return { ...fact, revision, ...(legacy ? { enabled: fact.source === "user", expiresAt: null, confirmedAt: null } : {}) };
      });
      return { ...parsed, facts };
    } catch (error) {
      if (error?.code === "file_not_found") return { version: 1, facts: [] };
      throw error;
    }
  };
  const write = async (document) => {
    const data = JSON.stringify({ ...document, version: 2 }, null, 2);
    if (Buffer.byteLength(data) > maxBytes) throw factError("个人事实数据超过允许大小", 413);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = filePath + "." + crypto.randomUUID() + ".tmp";
    let handle;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temp, filePath);
    } finally { await handle?.close(); await fs.unlink(temp).catch(() => null); }
  };
  // One console process owns this file; share the queue across store instances in that process.
  const mutate = (operation) => serialize(filePath, async () => {
    const document = await read();
    const result = operation(document.facts);
    await write(document);
    return result;
  });
  const find = (facts, id, revision) => {
    const fact = facts.find((item) => item.id === id);
    if (!fact) throw factError("个人事实已删除或不存在", 404);
    if (revision === undefined) throw factError("请刷新页面后再修改个人事实", 428);
    if (!Number.isSafeInteger(revision) || revision < 1) throw factError("个人事实版本无效");
    if (revision !== fact.revision) throw factError("个人事实已在其他页面修改，请核对最新内容", 409);
    return fact;
  };
  return {
    list: async () => (await read()).facts,
    snapshot: async () => personalFactSnapshot((await read()).facts),
    create: (payload = {}) => mutate((facts) => {
      if (facts.length >= 50) throw factError("个人事实已达到 50 条上限", 409);
      const now = new Date().toISOString();
      const fact = { id: crypto.randomUUID(), label: cleanFact(payload.label, "事实名称", 80), value: cleanFact(payload.value, "事实内容", 300), source: "user", ...settings(payload), confirmedAt: now, revision: 1, createdAt: now, updatedAt: now };
      facts.push(fact);
      return fact;
    }),
    update: (id, payload = {}) => mutate((facts) => {
      const fact = find(facts, id, payload.revision);
      if (fact.revision === Number.MAX_SAFE_INTEGER) throw factError("个人事实版本已达到上限", 409);
      const label = cleanFact(payload.label, "事实名称", 80);
      const value = cleanFact(payload.value, "事实内容", 300);
      Object.assign(fact, { label, value, ...settings(payload, fact), source: "user", confirmedAt: new Date().toISOString(), revision: fact.revision + 1, updatedAt: new Date().toISOString() });
      return fact;
    }),
    remove: (id, payload) => mutate((facts) => {
      const fact = find(facts, id, payload?.revision);
      return facts.splice(facts.indexOf(fact), 1)[0];
    }),
  };
}
