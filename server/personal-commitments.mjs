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

function waitingValue(value = "") {
  if (typeof value !== "string" || value.trim().length > 300) throw inputError("等待原因需为不超过 300 个字符的文字");
  return value.trim();
}

export function personalCommitmentLinks(value = []) {
  if (!Array.isArray(value) || value.length > 8 || new Set(value).size !== value.length
    || value.some(id => typeof id !== "string" || !id || id.length > 128)) throw inputError("最多关联 8 个不重复的个人对话");
  return [...value];
}

function milestoneValues(value = [], previous = []) {
  if (!Array.isArray(value) || value.length > 12) throw inputError("最多记录 12 个步骤");
  const seen = new Set();
  return value.map(step => {
    if (!step || typeof step !== "object" || Array.isArray(step) || Object.keys(step).some(key => !["id", "title", "done"].includes(key))
      || typeof step.title !== "string" || typeof step.done !== "boolean") throw inputError("步骤需包含名称与完成状态");
    const existing = step.id === undefined ? null : previous.find(item => item.id === step.id);
    if ((step.id !== undefined && !existing) || seen.has(step.id)) throw inputError("步骤编号无效或重复");
    if (step.id !== undefined) seen.add(step.id);
    return { id: existing?.id || crypto.randomUUID(), title: titleValue(step.title), done: step.done };
  });
}

export function personalCommitmentDraft(item) {
  return [
    `请帮我推进这项个人事项：${item.title}`,
    item.nextStep ? `当前下一步：${item.nextStep}` : "",
    item.waitingReason ? `我记录的等待原因：${item.waitingReason}` : "",
    ...(item.milestones || []).map(step => `我记录的步骤（${step.done ? "已完成" : "未完成"}）：${step.title}`),
    item.dueAt ? `我记录的到期时间（UTC）：${item.dueAt}` : "",
    "这些步骤与等待原因是我维护的记录，不是外部操作成功的证明。请先核对现状，给出下一步并执行你当前有权限完成的部分。对外发送、修改日历、删除数据或产生费用前，先展示具体动作并征得我确认。",
  ].filter(Boolean).join("\n");
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
      try {
        for (const item of parsed.commitments) {
          if (item.milestones !== undefined) {
            if (!Array.isArray(item.milestones) || item.milestones.some(step => typeof step?.id !== "string" || !step.id || step.id.length > 128)) throw inputError("步骤编号无效");
            milestoneValues(item.milestones, item.milestones);
          }
          if (item.waitingReason !== undefined) waitingValue(item.waitingReason);
          if (item.relatedSessionIds !== undefined) personalCommitmentLinks(item.relatedSessionIds);
        }
      } catch { throw inputError("个人事项进度数据格式无效，原记录未改写", 500); }
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
      const result = await operation(commitments);
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
        milestones: milestoneValues(payload?.milestones), waitingReason: waitingValue(payload?.waitingReason),
        relatedSessionIds: personalCommitmentLinks(payload?.relatedSessionIds),
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
      if (payload?.milestones !== undefined) item.milestones = milestoneValues(payload.milestones, item.milestones);
      if (payload?.waitingReason !== undefined) item.waitingReason = waitingValue(payload.waitingReason);
      if (payload?.relatedSessionIds !== undefined) item.relatedSessionIds = personalCommitmentLinks(payload.relatedSessionIds);
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
    startDraft: (id, revision, { getSession, ensureSession, pendingSessionId }) => mutate(async (commitments) => {
      const item = commitments.find((entry) => entry.id === id);
      if (!item) throw inputError("个人事项不存在", 404);
      if (item.status !== "active") throw inputError("事项已完成，请先重新跟进", 409);
      const linked = item.sessionId ? await getSession(item.sessionId) : null;
      if (linked) return { commitment: item, session: linked };
      find(commitments, id, revision);
      const legacy = pendingSessionId ? await getSession(pendingSessionId) : null;
      const reservedId = item.pendingDraftSessionId || legacy?.id || `sess-${crypto.randomUUID()}`;
      // Persist the reservation before writing the chat store so retries survive either write failing.
      item.pendingDraftSessionId = reservedId;
      await write(commitments);
      const session = await ensureSession(reservedId, item);
      item.sessionId = session.id;
      delete item.pendingDraftSessionId;
      item.revision += 1;
      item.updatedAt = new Date().toISOString();
      return { commitment: item, session };
    }),
    remove: (id, revision) => mutate((commitments) => {
      const item = find(commitments, id, revision);
      commitments.splice(commitments.indexOf(item), 1);
      return item;
    }),
  };
}
