import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function factError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanFact(value, field, max) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw factError(`${field}需为 1–${max} 个字符`);
  return text;
}

export function createPersonalFactsStore(filePath) {
  let pending = Promise.resolve();
  const read = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.facts)) throw factError("个人事实数据格式无效", 500);
      const ids = new Set();
      return parsed.facts.map((fact) => {
        const revision = fact?.revision === undefined ? 1 : fact.revision;
        if (!fact || typeof fact.id !== "string" || !fact.id || ids.has(fact.id)
          || typeof fact.label !== "string" || typeof fact.value !== "string"
          || !Number.isSafeInteger(revision) || revision < 1) throw factError("个人事实数据格式无效", 500);
        ids.add(fact.id);
        return { ...fact, revision };
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  const write = async (facts) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, facts }, null, 2), { flag: "wx", mode: 0o600 });
      await fs.rename(temp, filePath);
    } finally { await fs.unlink(temp).catch(() => null); }
  };
  const mutate = (operation) => {
    const result = pending.then(async () => {
      const facts = await read();
      const next = operation(facts);
      await write(facts);
      return next;
    });
    pending = result.catch(() => null);
    return result;
  };
  const find = (facts, id, revision) => {
    const fact = facts.find((item) => item.id === id);
    if (!fact) throw factError("个人事实已删除或不存在", 404);
    if (revision === undefined) throw factError("请刷新页面后再修改个人事实", 428);
    if (!Number.isSafeInteger(revision) || revision < 1) throw factError("个人事实版本无效");
    if (revision !== fact.revision) throw factError("个人事实已在其他页面修改，请核对最新内容", 409);
    return fact;
  };
  return {
    list: read,
    create: (payload) => mutate((facts) => {
      if (facts.length >= 50) throw factError("个人事实已达到 50 条上限", 409);
      const now = new Date().toISOString();
      const fact = { id: crypto.randomUUID(), label: cleanFact(payload?.label, "事实名称", 80), value: cleanFact(payload?.value, "事实内容", 300), source: "user", revision: 1, createdAt: now, updatedAt: now };
      facts.push(fact);
      return fact;
    }),
    update: (id, payload) => mutate((facts) => {
      const fact = find(facts, id, payload?.revision);
      if (fact.revision === Number.MAX_SAFE_INTEGER) throw factError("个人事实版本已达到上限", 409);
      fact.label = cleanFact(payload?.label, "事实名称", 80);
      fact.value = cleanFact(payload?.value, "事实内容", 300);
      fact.revision += 1;
      fact.updatedAt = new Date().toISOString();
      return fact;
    }),
    remove: (id, payload) => mutate((facts) => {
      const fact = find(facts, id, payload?.revision);
      return facts.splice(facts.indexOf(fact), 1)[0];
    }),
  };
}
