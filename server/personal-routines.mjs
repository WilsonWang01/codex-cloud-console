import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function inputError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function fields(payload) {
  if (typeof payload?.name !== "string" || typeof payload?.prompt !== "string") throw inputError("流程名称和任务内容必须是文本");
  const name = payload.name.trim();
  const prompt = payload.prompt.trim();
  if (!name || name.length > 80) throw inputError("流程名称需为 1–80 个字符");
  if (!prompt || prompt.length > 8000) throw inputError("任务内容需为 1–8000 个字符");
  return { name, prompt };
}

export function personalRoutineAutomation(routine) {
  return {
    id: routine.id,
    name: routine.name,
    repoId: "_personal",
    mode: "on-demand",
    timer: null,
    service: null,
    schedule: "手动运行",
    model: "gpt-6-sol",
    reasoning: "medium",
    prompt: routine.prompt,
    personalRoutine: true,
    revision: routine.revision,
  };
}

export function createPersonalRoutinesStore(filePath) {
  let pending = Promise.resolve();
  const read = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.routines)) throw inputError("个人流程数据格式无效", 500);
      if (parsed.routines.some((item) => !/^personal-routine-[0-9a-f-]{36}$/.test(item?.id || "") ||
        typeof item.name !== "string" || typeof item.prompt !== "string" ||
        !Number.isInteger(item.revision) || item.revision < 1 ||
        (item.archivedAt != null && (typeof item.archivedAt !== "string" || !Number.isFinite(Date.parse(item.archivedAt)))))) throw inputError("个人流程数据格式无效", 500);
      return parsed.routines;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  const mutate = (operation) => {
    const result = pending.then(async () => {
      const routines = await read();
      const value = operation(routines);
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify({ version: 1, routines }, null, 2), { flag: "wx", mode: 0o600 });
        await fs.rename(temp, filePath);
      } finally {
        await fs.unlink(temp).catch(() => null);
      }
      return value;
    });
    pending = result.catch(() => null);
    return result;
  };
  const find = (routines, id, revision) => {
    const routine = routines.find((item) => item.id === id);
    if (!routine) throw inputError("个人流程不存在", 404);
    if (!Number.isInteger(revision) || revision !== routine.revision) throw inputError("流程已在其他页面修改，请刷新后重试", 409);
    return routine;
  };
  return {
    list: read,
    create: (payload) => mutate((routines) => {
      if (routines.length >= 500 || routines.filter((item) => !item.archivedAt).length >= 50) throw inputError("个人流程已达到上限", 409);
      const now = new Date().toISOString();
      const routine = { id: `personal-routine-${crypto.randomUUID()}`, ...fields(payload), revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
      routines.push(routine);
      return routine;
    }),
    update: (id, payload) => mutate((routines) => {
      const routine = find(routines, id, payload?.revision);
      if (routine.archivedAt) throw inputError("请先恢复已归档流程", 409);
      Object.assign(routine, fields(payload), { revision: routine.revision + 1, updatedAt: new Date().toISOString() });
      return routine;
    }),
    archive: (id, revision) => mutate((routines) => {
      const routine = find(routines, id, revision);
      if (routine.archivedAt) throw inputError("流程已归档", 409);
      routine.archivedAt = new Date().toISOString();
      routine.updatedAt = routine.archivedAt;
      routine.revision += 1;
      return routine;
    }),
    restore: (id, revision) => mutate((routines) => {
      const routine = find(routines, id, revision);
      if (!routine.archivedAt) throw inputError("流程未归档", 409);
      if (routines.filter((item) => !item.archivedAt).length >= 50) throw inputError("启用的个人流程已达到 50 条上限", 409);
      routine.archivedAt = null;
      routine.updatedAt = new Date().toISOString();
      routine.revision += 1;
      return routine;
    }),
  };
}
