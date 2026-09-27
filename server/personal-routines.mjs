import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nextDistinctPersonalOccurrence, nextPersonalOccurrence, personalScheduleDue, personalScheduleExpired, validatePersonalSchedule } from "./personal-schedule.mjs";

export const personalScheduleDailyRunLimit = 3;
export const personalScheduleKnownTokenLimit = 100_000;

export function personalRoutinePromptHash(prompt) {
  return crypto.createHash("sha256").update(String(prompt).trim()).digest("hex");
}

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
    personalSchedule: routine.personalSchedule || null,
    personalTestApproval: routine.personalTestApproval ? {
      runId: routine.personalTestApproval.runId,
      approvedAt: routine.personalTestApproval.approvedAt,
      current: routine.personalTestApproval.promptHash === personalRoutinePromptHash(routine.prompt),
    } : null,
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
        (item.personalTestApproval && (typeof item.personalTestApproval.runId !== "string" ||
          !/^[0-9a-f]{64}$/.test(item.personalTestApproval.promptHash || "") ||
          !Number.isFinite(Date.parse(item.personalTestApproval.approvedAt || "")))) ||
        (item.archivedAt != null && (typeof item.archivedAt !== "string" || !Number.isFinite(Date.parse(item.archivedAt)))) ||
        (item.personalSchedule && (!validateStoredSchedule(item.personalSchedule) || (item.archivedAt && item.personalSchedule.enabled))))) throw inputError("个人流程数据格式无效", 500);
      if (parsed.claims != null && (!Array.isArray(parsed.claims) || parsed.claims.some((claim) =>
        typeof claim?.id !== "string" || typeof claim.routineId !== "string" ||
        typeof claim.claimedAt !== "string" || !Number.isFinite(Date.parse(claim.claimedAt)) ||
        typeof claim.runId !== "string" || typeof claim.status !== "string"))) throw inputError("个人流程领取记录无效", 500);
      return { routines: parsed.routines, claims: parsed.claims || [] };
    } catch (error) {
      if (error?.code === "ENOENT") return { routines: [], claims: [] };
      throw error;
    }
  };
  const mutate = (operation) => {
    const result = pending.then(async () => {
      const state = await read();
      const value = operation(state);
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify({ version: 1, ...state }, null, 2), { flag: "wx", mode: 0o600 });
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
    list: async () => (await read()).routines,
    claims: async () => (await read()).claims,
    create: (payload) => mutate(({ routines }) => {
      if (routines.length >= 500 || routines.filter((item) => !item.archivedAt).length >= 50) throw inputError("个人流程已达到上限", 409);
      const now = new Date().toISOString();
      const routine = { id: `personal-routine-${crypto.randomUUID()}`, ...fields(payload), revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
      routines.push(routine);
      return routine;
    }),
    update: (id, payload) => mutate(({ routines }) => {
      const routine = find(routines, id, payload?.revision);
      if (routine.archivedAt) throw inputError("请先恢复已归档流程", 409);
      const next = fields(payload);
      if (routine.prompt !== next.prompt && routine.personalSchedule?.enabled) {
        routine.personalSchedule.enabled = false;
        routine.personalSchedule.nextRunAt = null;
      }
      Object.assign(routine, next, { revision: routine.revision + 1, updatedAt: new Date().toISOString() });
      return routine;
    }),
    beginTest: (id, revision) => mutate(({ routines }) => {
      const routine = find(routines, id, revision);
      if (routine.archivedAt) throw inputError("请先恢复已归档流程", 409);
      if (routine.personalSchedule?.enabled) throw inputError("请先暂停计划，再试运行", 409);
      routine.personalTestApproval = null;
      routine.revision += 1;
      routine.updatedAt = new Date().toISOString();
      return routine;
    }),
    approveTest: (id, payload) => mutate(({ routines }) => {
      const routine = find(routines, id, payload?.revision);
      if (routine.archivedAt) throw inputError("请先恢复已归档流程", 409);
      if (payload?.promptHash !== personalRoutinePromptHash(routine.prompt)) throw inputError("任务内容已变化，请重新试运行", 409);
      routine.personalTestApproval = {
        runId: payload.runId,
        promptHash: payload.promptHash,
        approvedAt: new Date().toISOString(),
      };
      routine.revision += 1;
      routine.updatedAt = routine.personalTestApproval.approvedAt;
      return routine;
    }),
    archive: (id, revision) => mutate(({ routines, claims }) => {
      const routine = find(routines, id, revision);
      if (routine.archivedAt) throw inputError("流程已归档", 409);
      if (claims.some((claim) => claim.routineId === id && claim.status === "claimed")) throw inputError("流程正在启动，请稍后再归档", 409);
      routine.archivedAt = new Date().toISOString();
      routine.updatedAt = routine.archivedAt;
      if (routine.personalSchedule) Object.assign(routine.personalSchedule, { enabled: false, nextRunAt: null });
      routine.revision += 1;
      return routine;
    }),
    restore: (id, revision) => mutate(({ routines }) => {
      const routine = find(routines, id, revision);
      if (!routine.archivedAt) throw inputError("流程未归档", 409);
      if (routines.filter((item) => !item.archivedAt).length >= 50) throw inputError("启用的个人流程已达到 50 条上限", 409);
      routine.archivedAt = null;
      routine.updatedAt = new Date().toISOString();
      routine.revision += 1;
      return routine;
    }),
    configureSchedule: (id, payload, now = Date.now()) => mutate(({ routines }) => {
      const routine = find(routines, id, payload?.revision);
      if (routine.archivedAt) throw inputError("请先恢复已归档流程", 409);
      const enabled = payload?.enabled === true;
      if (enabled && routines.filter((item) => !item.archivedAt && item.id !== id && item.personalSchedule?.enabled).length >= personalScheduleDailyRunLimit) {
        throw inputError("最多启用 3 条个人定时流程", 409);
      }
      const fields = enabled ? validatePersonalSchedule(payload) : routine.personalSchedule
        ? { cadence: routine.personalSchedule.cadence, time: routine.personalSchedule.time, timeZone: routine.personalSchedule.timeZone }
        : validatePersonalSchedule(payload);
      if (enabled && routine.personalTestApproval?.promptHash !== personalRoutinePromptHash(routine.prompt)) {
        throw inputError("请先完成当前任务内容的试运行，并确认结果", 409);
      }
      routine.personalSchedule = {
        ...routine.personalSchedule, ...fields, enabled,
        nextRunAt: enabled ? nextPersonalOccurrence(fields, now) : null,
      };
      routine.revision += 1;
      routine.updatedAt = new Date(now).toISOString();
      return routine;
    }),
    claimDue: async (now = Date.now()) => {
      if (!(await read()).routines.some((item) => personalScheduleDue(item.personalSchedule, now))) return null;
      return mutate(({ routines, claims }) => {
        const routine = routines.filter((item) => !item.archivedAt && personalScheduleDue(item.personalSchedule, now))
          .sort((a, b) => Date.parse(a.personalSchedule.nextRunAt) - Date.parse(b.personalSchedule.nextRunAt))[0];
        if (!routine) return null;
        const scheduledAt = routine.personalSchedule.nextRunAt;
        routine.personalSchedule.nextRunAt = nextDistinctPersonalOccurrence(routine.personalSchedule, scheduledAt);
        const today = new Date(now).toISOString().slice(0, 10);
        const capReached = claims.filter((item) => item.claimedAt.startsWith(today)).length >= personalScheduleDailyRunLimit;
        if (personalScheduleExpired({ enabled: true, nextRunAt: scheduledAt }, now) || capReached) {
          routine.personalSchedule.lastResult = { status: "skipped", scheduledAt, detail: capReached ? "今日后台运行次数已达上限" : "错过执行窗口，已跳过" };
          return { skipped: true, routine };
        }
        const claim = {
          id: `${routine.id}:${scheduledAt}`, routineId: routine.id, scheduledAt,
          claimedAt: new Date(now).toISOString(), runId: `run-${routine.id}-${crypto.randomUUID()}`, status: "claimed", revision: routine.revision,
        };
        claims.push(claim);
        claims.splice(0, Math.max(0, claims.length - 100));
        routine.personalSchedule.lastResult = { status: "claimed", scheduledAt, runId: claim.runId };
        return { claim, routine };
      });
    },
    settleClaim: (runId, status, detail = "") => mutate(({ routines, claims }) => {
      const claim = claims.find((item) => item.runId === runId);
      if (!claim) return null;
      claim.status = status;
      claim.detail = String(detail).slice(0, 300);
      if (!["claimed", "running"].includes(status)) claim.finishedAt = new Date().toISOString();
      const routine = routines.find((item) => item.id === claim.routineId);
      if (routine?.personalSchedule?.lastResult?.runId === runId) routine.personalSchedule.lastResult = {
        status, scheduledAt: claim.scheduledAt, runId, detail: claim.detail,
      };
      if (routine?.personalSchedule && routine.revision === claim.revision &&
        ["failed", "needs_reconciliation", "interrupted", "canceled"].includes(status)) {
        routine.personalSchedule.enabled = false;
        routine.personalSchedule.nextRunAt = null;
      }
      return routine || null;
    }),
  };
}

function validateStoredSchedule(schedule) {
  try {
    validatePersonalSchedule(schedule);
    return typeof schedule.enabled === "boolean" &&
      (!schedule.enabled || (typeof schedule.nextRunAt === "string" && Number.isFinite(Date.parse(schedule.nextRunAt))));
  } catch { return false; }
}
