import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safeClient = ({ tokenHash, ...client }) => client;

export function createApiClientStore({ read, write, metricsRoot, now = () => Date.now() }) {
  let writeQueue = Promise.resolve();
  let requestQueue = Promise.resolve();
  let prunedDay = "";
  const lastSeenWrite = new Map();
  const load = async () => {
    const state = await read();
    return {
      version: 1,
      clients: Array.isArray(state?.clients) ? state.clients : [],
    };
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
  const requestRows = async ({ from, to }) => {
    await requestQueue;
    const rows = [];
    let droppedRequests = 0;
    for (const name of await metricFiles()) {
      const day = Date.parse(name.slice(0, 10) + "T00:00:00Z");
      if (day + 86_400_000 <= from || day >= to) continue;
      const contents = await fs.readFile(path.join(metricsRoot, name), "utf8");
      for (const line of contents.split("\n")) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          const time = Date.parse(row.time);
          if (Number.isFinite(time) && time >= from && time < to) rows.push(row);
        } catch { droppedRequests += 1; }
      }
    }
    rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    return { rows, droppedRequests };
  };

  return {
    async list() {
      await writeQueue;
      return (await load()).clients.map(safeClient);
    },
    async create({ name, automationIds, expiresAt = null }) {
      const label = String(name || "").trim().slice(0, 80);
      if (!label) throw Object.assign(new Error("Client name is required"), { statusCode: 400 });
      if (!Array.isArray(automationIds) || !automationIds.length || automationIds.some((id) => typeof id !== "string" || !id)) {
        throw Object.assign(new Error("At least one automation scope is required"), { statusCode: 400 });
      }
      if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now())) {
        throw Object.assign(new Error("Expiry must be in the future"), { statusCode: 400 });
      }
      const token = `ccc_${crypto.randomBytes(32).toString("base64url")}`;
      const client = {
        id: crypto.randomUUID(),
        name: label,
        tokenPrefix: token.slice(0, 12),
        tokenHash: digest(token),
        automationIds: [...new Set(automationIds)],
        createdAt: new Date(now()).toISOString(),
        expiresAt: expiresAt || null,
        revokedAt: null,
        lastUsedAt: null,
      };
      await mutate((state) => {
        state.clients.push(client);
      });
      return { client: safeClient(client), token };
    },
    async revoke(id) {
      return mutate((state) => {
        const client = state.clients.find((item) => item.id === id);
        if (!client) throw Object.assign(new Error("Unknown API client"), { statusCode: 404 });
        client.revokedAt ||= new Date(now()).toISOString();
        return safeClient(client);
      });
    },
    async authenticate(token, automationId) {
      if (!token) return null;
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
    async usage({ from = now() - 7 * 24 * 60 * 60_000, to = now(), clientId = "" } = {}) {
      const { rows: allRows, droppedRequests } = await requestRows({ from, to });
      const rows = allRows.filter((item) => !clientId || item.clientId === clientId);
      const buckets = new Map();
      for (const row of rows) {
        const hour = row.time.slice(0, 13) + ":00:00Z";
        const key = `${hour}:${row.clientId}`;
        const bucket = buckets.get(key) || { hour, clientId: row.clientId, requests: 0, accepted: 0, errors: 0, replayed: 0, polls: 0, pollErrors: 0, controls: 0 };
        if (row.trigger === "cancel") {
          bucket.controls += 1;
        } else if (row.trigger === "result") {
          bucket.polls += 1;
          if (row.status >= 400) bucket.pollErrors += 1;
        } else {
          bucket.requests += 1;
          if (row.status >= 200 && row.status < 300 && !row.deduplicated) bucket.accepted += 1;
          if (row.status >= 400) bucket.errors += 1;
          if (row.deduplicated) bucket.replayed += 1;
        }
        buckets.set(key, bucket);
      }
      return { buckets: [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour)), requests: rows.slice(-500).reverse(), droppedRequests };
    },
  };
}
