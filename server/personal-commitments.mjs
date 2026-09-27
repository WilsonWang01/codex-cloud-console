import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function inputError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function titleValue(value) {
  const title = String(value || "").trim();
  if (!title || title.length > 160) throw inputError("事项名称需为 1–160 个字符");
  return title;
}

function noteValue(value) {
  const note = String(value || "").trim();
  if (note.length > 300) throw inputError("下一步不能超过 300 个字符");
  return note;
}

function dueValue(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw inputError("到期时间格式无效");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw inputError("到期时间需为 ISO UTC 时间");
  return date.toISOString();
}

export function createPersonalCommitmentsStore(filePath) {
  let pending = Promise.resolve();
  const read = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.commitments)) throw inputError("个人事项数据格式无效", 500);
      return parsed.commitments;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  const write = async (commitments) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, commitments }, null, 2), { flag: "wx", mode: 0o600 });
      await fs.rename(temp, filePath);
    } finally { await fs.unlink(temp).catch(() => null); }
  };
  const mutate = (operation) => {
    const result = pending.then(async () => {
      const commitments = await read();
      const result = operation(commitments);
      await write(commitments);
      return result;
    });
    pending = result.catch(() => null);
    return result;
  };
  const find = (commitments, id, revision) => {
    const item = commitments.find((entry) => entry.id === id);
    if (!item) throw inputError("个人事项不存在", 404);
    if (!Number.isInteger(revision) || revision !== item.revision) throw inputError("事项已在其他页面修改，请刷新后重试", 409);
    return item;
  };
  return {
    list: read,
    create: (payload) => mutate((commitments) => {
      if (commitments.length >= 100) throw inputError("个人事项已达到 100 条上限", 409);
      const now = new Date().toISOString();
      const item = {
        id: crypto.randomUUID(), title: titleValue(payload?.title), nextStep: noteValue(payload?.nextStep),
        dueAt: dueValue(payload?.dueAt), status: "active", sessionId: null,
        source: "user", revision: 1, createdAt: now, updatedAt: now, completedAt: null,
      };
      commitments.push(item);
      return item;
    }),
    update: (id, payload) => mutate((commitments) => {
      const item = find(commitments, id, payload?.revision);
      if (payload?.title !== undefined) item.title = titleValue(payload.title);
      if (payload?.nextStep !== undefined) item.nextStep = noteValue(payload.nextStep);
      if (payload?.dueAt !== undefined) item.dueAt = dueValue(payload.dueAt);
      if (payload?.status !== undefined) {
        if (!["active", "done"].includes(payload.status)) throw inputError("事项状态无效");
        item.status = payload.status;
        item.completedAt = item.status === "done" ? new Date().toISOString() : null;
      }
      if (payload?.sessionId !== undefined) {
        if (payload.sessionId !== null && (typeof payload.sessionId !== "string" || !payload.sessionId || payload.sessionId.length > 128)) throw inputError("会话 ID 无效");
        item.sessionId = payload.sessionId;
      }
      item.revision += 1;
      item.updatedAt = new Date().toISOString();
      return item;
    }),
    remove: (id, revision) => mutate((commitments) => {
      const item = find(commitments, id, revision);
      commitments.splice(commitments.indexOf(item), 1);
      return item;
    }),
  };
}
