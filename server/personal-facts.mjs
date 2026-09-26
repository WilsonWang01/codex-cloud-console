import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function factError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanFact(value, field, max) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw factError(`${field} must be between 1 and ${max} characters`);
  return text;
}

export function createPersonalFactsStore(filePath) {
  let pending = Promise.resolve();
  const read = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      return Array.isArray(parsed?.facts) ? parsed.facts : [];
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
  return {
    list: read,
    create: (payload) => mutate((facts) => {
      if (facts.length >= 50) throw factError("Personal facts limit reached", 409);
      const now = new Date().toISOString();
      const fact = { id: crypto.randomUUID(), label: cleanFact(payload?.label, "label", 80), value: cleanFact(payload?.value, "value", 300), source: "user", createdAt: now, updatedAt: now };
      facts.push(fact);
      return fact;
    }),
    update: (id, payload) => mutate((facts) => {
      const fact = facts.find((item) => item.id === id);
      if (!fact) throw factError("Personal fact not found", 404);
      fact.label = cleanFact(payload?.label, "label", 80);
      fact.value = cleanFact(payload?.value, "value", 300);
      fact.updatedAt = new Date().toISOString();
      return fact;
    }),
    remove: (id) => mutate((facts) => {
      const index = facts.findIndex((item) => item.id === id);
      if (index < 0) throw factError("Personal fact not found", 404);
      return facts.splice(index, 1)[0];
    }),
  };
}
