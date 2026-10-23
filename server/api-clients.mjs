import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { recordDuration, summarizeDurations, requestErrorType } from "./usage-statistics.mjs";

export const apiClientPolicyVersion = 1;

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const policyError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const positiveLimit = (value, statusCode = 503) => {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw policyError(statusCode, "调用方限制必须是正整数或 null");
  return value;
};
const clientPolicy = client => {
  const policyRevision = client.policyRevision ?? 0;
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 0 || client.expiresAt != null && (typeof client.expiresAt !== "string" || !Number.isFinite(Date.parse(client.expiresAt)))) throw policyError(503, "调用方限制记录无效，需要核对配置");
  return { maxConcurrent: positiveLimit(client.maxConcurrent), dailyKnownTokenLimit: positiveLimit(client.dailyKnownTokenLimit), policyRevision };
};
const safeClient = ({ tokenHash, ...client }) => ({ ...client, ...clientPolicy(client) });

export function createApiClientStore({ read, write, metricsRoot, now = () => Date.now(), concurrencyCeiling = 1 }) {
  if (positiveLimit(concurrencyCeiling) === null) throw new Error("Invalid server concurrency ceiling");
  let writeQueue = Promise.resolve();
  let requestQueue = Promise.resolve();
  let prunedDay = "";
  const lastSeenWrite = new Map();
  const load = async () => {
    const state = await read();
    if (!state || typeof state !== "object" || state.version != null && state.version !== 1 || !Array.isArray(state.clients)) throw policyError(503, "调用方记录格式无效，未修改原配置");
    const ids = new Set();
    for (const client of state.clients) {
      if (!client || typeof client.id !== "string" || !client.id || ids.has(client.id) || !Array.isArray(client.automationIds) || client.automationIds.some(id => typeof id !== "string" || !id)) throw policyError(503, "调用方身份或权限范围记录无效，未修改原配置");
      ids.add(client.id); clientPolicy(client);
    }
    return { ...state, version: 1 };
  };
  const mutate = (callback) => {
    const task = writeQueue.catch(() => null).then(async () => {
      const state = await load();
      const result = callback(state);
      await write(state);
      return result;
    });
    writeQueue = task.catch(() => null);
    return task;
  };
  const policyChanges = (input, current = {}) => {
    const result = {};
    for (const field of ["maxConcurrent", "dailyKnownTokenLimit"]) {
      if (!Object.hasOwn(input, field)) continue;
      result[field] = positiveLimit(input[field], 400);
    }
    if (result.maxConcurrent > concurrencyCeiling) throw policyError(400, "调用方并发不能超过服务器上限");
    if (Object.hasOwn(input, "expiresAt")) {
      if (input.expiresAt != null && (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt)) || input.expiresAt !== current.expiresAt && Date.parse(input.expiresAt) <= now())) throw policyError(400, "有效期必须是未来时间或 null");
      result.expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt).toISOString();
    }
    return result;
  };

  const metricFileName = (time) => `${new Date(time).toISOString().slice(0, 10)}.ndjson`;
  const metricFiles = async () => {
    try { return (await fs.readdir(metricsRoot)).filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const appendMetric = async (row) => {
    await fs.mkdir(metricsRoot, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(metricsRoot, metricFileName(row.time)), `\n${JSON.stringify(row)}`, { mode: 0o600 });
    const today = new Date(now()).toISOString().slice(0, 10);
    if (prunedDay === today) return;
    const cutoffDay = new Date(now() - 30 * 86_400_000).toISOString().slice(0, 10);
    for (const name of await metricFiles()) {
      if (name.slice(0, 10) < cutoffDay) await fs.unlink(path.join(metricsRoot, name));
    }
    prunedDay = today;
  };
  const requestRows = async ({ from, to, clientId, signal }) => {
    await requestQueue;
    signal?.throwIfAborted();
    let recent = [];
    let ordinal = 0;
    let droppedRequests = 0;
    let missingMetricFiles = 0;
    const buckets = new Map(), groups = new Map(), errorTypes = new Map();
    const trimRecent = () => { recent.sort((a, b) => b.row.time.localeCompare(a.row.time) || b.ordinal - a.ordinal); recent.length = Math.min(500, recent.length); };
    for (const name of await metricFiles()) {
      signal?.throwIfAborted();
      const day = Date.parse(name.slice(0, 10) + "T00:00:00Z");
      if (day + 86_400_000 <= from || day >= to) continue;
      let handle;
      try { handle = await fs.open(path.join(metricsRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (error.code === "ENOENT") { missingMetricFiles++; continue; } throw error; }
      try {
        if (!(await handle.stat()).isFile()) throw new Error("请求指标必须是普通文件");
        signal?.throwIfAborted();
      } catch (error) { await handle.close(); throw error; }
      const stream = handle.createReadStream({ autoClose: false });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let readError = null;
      const failedRead = error => { readError = error; lines.close(); };
      const aborted = () => stream.destroy(signal.reason);
      stream.on("error", failedRead);
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        if (signal?.aborted) aborted();
        for await (const line of lines) {
          signal?.throwIfAborted();
          if (!line) continue;
          let row, time;
          try {
            row = JSON.parse(line);
            time = typeof row?.time === "string" ? Date.parse(row.time) : NaN;
            if (!Number.isFinite(time) || typeof row.clientId !== "string" || !row.clientId || typeof row.trigger !== "string" || !row.trigger ||
                !Number.isInteger(row.status) || row.status < 100 || row.status > 599 || typeof row.id !== "string" || typeof row.automationId !== "string" ||
                row.runId != null && typeof row.runId !== "string" || row.deduplicated != null && typeof row.deduplicated !== "boolean") throw new Error("Invalid metric row");
          } catch { droppedRequests++; continue; }
          if (time < from || time >= to || clientId && row.clientId !== clientId) continue;
          row = { id: row.id, clientId: row.clientId, automationId: row.automationId, trigger: row.trigger, status: row.status,
            runId: row.runId || null, deduplicated: row.deduplicated === true, time: new Date(time).toISOString(),
            durationMs: Number.isSafeInteger(row.durationMs) && row.durationMs >= 0 ? row.durationMs : null };
          recent.push({ row, ordinal: ordinal++ });
          if (recent.length >= 1000) trimRecent();
          const hour = row.time.slice(0, 13) + ":00:00Z", key = `${hour}:${row.clientId}`;
          const bucket = buckets.get(key) || { hour, clientId: row.clientId, requests: 0, accepted: 0, errors: 0, replayed: 0, polls: 0, pollErrors: 0, controls: 0, discovery: 0 };
          const kind = row.trigger === "discovery" ? "discovery" : row.trigger === "cancel" ? "control" : row.trigger === "result" ? "poll" : "submit";
          const group = groups.get(kind) || { kind, requests: 0, errors: 0, accepted: 0, replayed: 0, durations: new Map() };
          group.requests++;
          recordDuration(group.durations, row.durationMs);
          if (row.status >= 400) {
            group.errors++;
            const type = requestErrorType(row.status);
            errorTypes.set(type, (errorTypes.get(type) || 0) + 1);
          }
          if (kind === "discovery") bucket.discovery++;
          else if (kind === "control") bucket.controls++;
          else if (kind === "poll") { bucket.polls++; if (row.status >= 400) bucket.pollErrors++; }
          else {
            bucket.requests++;
            // A synchronous timeout can follow durable acceptance; a run ID is the evidence, not HTTP 2xx.
            if (row.runId && !row.deduplicated) { bucket.accepted++; group.accepted++; }
            if (row.status >= 400) bucket.errors++;
            if (row.deduplicated) { bucket.replayed++; group.replayed++; }
          }
          groups.set(kind, group); buckets.set(key, bucket);
        }
        signal?.throwIfAborted();
        if (readError) throw readError;
      } finally { signal?.removeEventListener("abort", aborted); lines.close(); stream.destroy(); await handle.close(); }
    }
    trimRecent();
    return { buckets: [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour)), requests: recent.map(({ row }) => row), droppedRequests, missingMetricFiles,
      requestSummary: { groups: [...groups.values()].map(({ durations, ...group }) => ({ ...group, duration: summarizeDurations(durations) })),
        errorTypes: [...errorTypes].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
        coverage: "recorded_authenticated_requests_only;_some_rate_limit_rejections_excluded" } };
  };

  return {
    async list() {
      await writeQueue;
      return (await load()).clients.map(safeClient);
    },
    limits() { return { maxConcurrent: concurrencyCeiling, dailyBudgetTimezone: "UTC", budgetMode: "known_usage_soft_limit" }; },
    async create({ name, automationIds, expiresAt = null, maxConcurrent = null, dailyKnownTokenLimit = null }) {
      const label = String(name || "").trim().slice(0, 80);
      if (!label) throw Object.assign(new Error("Client name is required"), { statusCode: 400 });
      if (!Array.isArray(automationIds) || !automationIds.length || automationIds.some((id) => typeof id !== "string" || !id)) {
        throw Object.assign(new Error("At least one automation scope is required"), { statusCode: 400 });
      }
      const policy = policyChanges({ expiresAt, maxConcurrent, dailyKnownTokenLimit });
      const token = `ccc_${crypto.randomBytes(32).toString("base64url")}`;
      const client = {
        id: crypto.randomUUID(),
        name: label,
        tokenPrefix: token.slice(0, 12),
        tokenHash: digest(token),
        automationIds: [...new Set(automationIds)],
        createdAt: new Date(now()).toISOString(),
        ...policy,
        policyRevision: 0,
        revokedAt: null,
        lastUsedAt: null,
      };
      await mutate((state) => {
        state.clients.push(client);
      });
      return { client: safeClient(client), token };
    },
    async updatePolicy(id, input) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["expectedRevision", "expiresAt", "maxConcurrent", "dailyKnownTokenLimit"].includes(key)) || !Number.isSafeInteger(input.expectedRevision) || Object.keys(input).length < 2) throw policyError(400, "限制更新需要当前版本及明确的修改字段");
      return mutate(state => {
        const client = state.clients.find(item => item.id === id);
        if (!client) throw policyError(404, "调用方不存在");
        const policy = clientPolicy(client);
        if (client.revokedAt) throw policyError(409, "已撤销的调用方不能重新启用");
        if (policy.policyRevision !== input.expectedRevision) throw policyError(409, "调用方限制已在其他页面修改，请刷新核对；当前输入未保存");
        Object.assign(client, policy, policyChanges(input, client), { policyRevision: policy.policyRevision + 1 });
        return safeClient(client);
      });
    },
    async revoke(id) {
      return mutate((state) => {
        const client = state.clients.find((item) => item.id === id);
        if (!client) throw Object.assign(new Error("Unknown API client"), { statusCode: 404 });
        if (!client.revokedAt) {
          client.policyRevision = clientPolicy(client).policyRevision + 1;
          client.revokedAt = new Date(now()).toISOString();
        }
        return safeClient(client);
      });
    },
    async authenticate(token, automationId) {
      if (!token) return null;
      await writeQueue;
      const tokenHash = digest(String(token));
      const state = await load();
      for (const client of state.clients) {
        if (!crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(String(client.tokenHash || "").padEnd(64, "0").slice(0, 64)))) continue;
        if (client.revokedAt || (client.expiresAt && Date.parse(client.expiresAt) <= now())) return null;
        if (!client.automationIds.includes(automationId)) return null;
        const seenAt = now();
        const persistedAt = Date.parse(client.lastUsedAt || "") || 0;
        if (seenAt - Math.max(persistedAt, lastSeenWrite.get(client.id) || 0) >= 60_000) {
          lastSeenWrite.set(client.id, seenAt);
          void mutate((next) => {
            const current = next.clients.find((item) => item.id === client.id);
            if (current) current.lastUsedAt = new Date(seenAt).toISOString();
          }).catch(() => { if (lastSeenWrite.get(client.id) === seenAt) lastSeenWrite.delete(client.id); });
        }
        return safeClient(client);
      }
      return null;
    },
    async record({ clientId, automationId, trigger, status, runId = null, deduplicated = false, durationMs = 0, time = new Date(now()).toISOString() }) {
      const row = {
        id: crypto.randomUUID(), clientId: clientId || "unknown", automationId, trigger,
        status, runId, deduplicated, durationMs, time,
      };
      const task = requestQueue.catch(() => null).then(() => appendMetric(row));
      requestQueue = task.catch(() => null);
      return task;
    },
    async usage({ from = now() - 7 * 24 * 60 * 60_000, to = now(), clientId = "", signal } = {}) {
      return requestRows({ from, to, clientId, signal });
    },
  };
}
