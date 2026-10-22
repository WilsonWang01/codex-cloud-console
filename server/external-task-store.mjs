import { mergeAutomationEvents } from "./automation-events.mjs";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const terminal = new Set(["completed", "failed", "canceled", "interrupted", "needs_reconciliation"]);
const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const externalTaskSchemaVersion = 3;
const decode = (row) => row ? JSON.parse(row.record) : null;
function processIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    return /^[0-9]+$/.test(started || "") ? `linux:${boot}:${started}` : null;
  } catch { return null; }
}
export const createExternalTaskOwner = () => `${processIdentity(process.pid) || "pid"}:${randomUUID()}`;
const alive = (pid, owner) => {
  try { process.kill(pid, 0); }
  catch (error) { return error.code !== "ESRCH"; }
  const identity = processIdentity(pid);
  return !identity || !owner.startsWith("linux:") || owner.startsWith(identity + ":");
};

export function createExternalTaskStore(db, { now = () => Date.now(), ownerAlive = alive } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS external_tasks_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT");
  db.prepare("INSERT OR IGNORE INTO external_tasks_meta VALUES ('schema_version', ?)").run(externalTaskSchemaVersion);
  const version = db.prepare("SELECT value FROM external_tasks_meta WHERE key='schema_version'").get().value;
  if (![1, 2, externalTaskSchemaVersion].includes(version)) throw new Error("Unsupported persistent task schema");
  db.prepare("INSERT OR IGNORE INTO external_tasks_meta VALUES ('revision', 0)").run();
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS external_tasks (
      id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)),
      execution TEXT NOT NULL CHECK(json_valid(execution)), created_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','terminal')),
      owner TEXT, owner_pid INTEGER, epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch>=0),
      CHECK(state!='running' OR (owner IS NOT NULL AND owner_pid>0))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS external_queue ON external_tasks(state, created_ms);
    CREATE INDEX IF NOT EXISTS external_client_latest ON external_tasks(json_extract(record,'$.clientId'), json_extract(record,'$.automationId'), created_ms DESC, id DESC)
      WHERE json_extract(record,'$.sessionId') IS NOT NULL AND json_extract(record,'$.sessionId')!='';
    CREATE INDEX IF NOT EXISTS external_run_status ON external_tasks(json_extract(record,'$.status'));
    CREATE TABLE IF NOT EXISTS external_task_keys (
      key_hash TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES external_tasks(id), expires_ms INTEGER NOT NULL
    ) STRICT;`);
  // V3 adds result delivery fields and reservations; preserve old rows and execution claims.
  if (version !== externalTaskSchemaVersion) db.prepare("UPDATE external_tasks_meta SET value=? WHERE key='schema_version'").run(externalTaskSchemaVersion);
  const get = db.prepare("SELECT id, record, state, owner, owner_pid, epoch FROM external_tasks WHERE id=?");
  const save = db.prepare("UPDATE external_tasks SET record=?, state=?, execution=CASE WHEN ?='terminal' THEN '{}' ELSE execution END WHERE id=?");
  const transaction = (callback) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = db.prepare("SELECT total_changes() AS n").get().n;
      const value = callback();
      if (db.prepare("SELECT total_changes() AS n").get().n !== before) db.exec("UPDATE external_tasks_meta SET value=value+1 WHERE key='revision'");
      db.exec("COMMIT"); return value;
    }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const write = (row, record) => {
    const state = terminal.has(record.status) ? "terminal" : row.state;
    if (state === "terminal" && db.prepare("SELECT name FROM sqlite_master WHERE name='external_results'").get()) {
      const result = db.prepare("SELECT expires_ms, record FROM external_results WHERE run_id=?").get(row.id);
      if (result) {
        const ttl = JSON.parse(result.record).retentionMs;
        if (!Number.isSafeInteger(ttl) || ttl < 1) throw failure(503, "结果保留策略无效，未改变任务终态");
        const expires = result.expires_ms ?? now() + ttl;
        db.prepare("UPDATE external_results SET expires_ms=? WHERE run_id=?").run(expires, row.id);
        db.prepare("UPDATE external_task_keys SET expires_ms=max(expires_ms,?) WHERE run_id=?").run(expires, row.id);
      }
    }
    save.run(JSON.stringify(record), state, state, row.id);
    return record;
  };
  const assertClaim = (row, claim) => {
    if (!row || row.state === "queued" || !claim || row.owner !== claim.owner || row.epoch !== claim.epoch) {
      throw failure(409, "任务执行权已变化，旧执行器不能更新结果");
    }
  };
  const lookup = (keyHash, requestHash) => {
    if (!keyHash) return null;
    const key = db.prepare("SELECT k.* FROM external_task_keys k JOIN external_tasks t ON t.id=k.run_id WHERE key_hash=? AND (expires_ms>? OR t.state!='terminal' OR json_extract(t.record,'$.status')='needs_reconciliation')").get(keyHash, now());
    if (!key) return null;
    if (key.request_hash !== requestHash) throw failure(409, "同一 Idempotency-Key 不能用于不同请求");
    const row = get.get(key.run_id);
    if (!row) throw failure(503, "已接收任务的记录缺失，需要核对后恢复");
    return decode(row);
  };
  const latestIds = () => db.prepare(`SELECT id FROM (SELECT id,
    row_number() OVER (PARTITION BY json_extract(record,'$.clientId'), json_extract(record,'$.automationId') ORDER BY created_ms DESC, id DESC) AS n
    FROM external_tasks WHERE json_extract(record,'$.clientId') IS NOT NULL AND json_extract(record,'$.sessionId') IS NOT NULL AND json_extract(record,'$.sessionId')!='') WHERE n=1`).all().map(row => row.id);
  return {
    read(id) { return decode(get.get(id)); },
    runs() { return db.prepare("SELECT record FROM external_tasks ORDER BY created_ms DESC, id").all().map(decode); },
    ids() { return db.prepare("SELECT id FROM external_tasks").all().map(row => row.id); },
    recentRuns(limit = 200) {
      const ids = new Set(db.prepare("SELECT id FROM external_tasks WHERE state IN ('queued','running') UNION SELECT id FROM external_tasks WHERE json_extract(record,'$.status')='needs_reconciliation'").all().map(row => row.id));
      for (const row of db.prepare("SELECT id FROM external_tasks WHERE state='terminal' ORDER BY created_ms DESC, id DESC LIMIT ?").all(limit)) ids.add(row.id);
      return [...ids].map(id => decode(get.get(id)));
    },
    latest(clientId, automationId, { repoId, sessionId } = {}) {
      return decode(db.prepare("SELECT record FROM external_tasks WHERE json_extract(record,'$.clientId')=? AND json_extract(record,'$.automationId')=? AND json_extract(record,'$.sessionId') IS NOT NULL AND json_extract(record,'$.sessionId')!=''" +
        (repoId ? " AND json_extract(record,'$.repoId')=?" : "") + (sessionId ? " AND json_extract(record,'$.sessionId')=?" : "") + " ORDER BY created_ms DESC, id DESC LIMIT 1")
        .get(clientId, automationId, ...(repoId ? [repoId] : []), ...(sessionId ? [sessionId] : [])));
    },
    unaccountedIds() {
      return db.prepare("SELECT t.id FROM external_tasks t LEFT JOIN usage_runs u ON u.id=t.id WHERE t.state='terminal' AND u.id IS NULL").all().map(row => row.id);
    },
    lookup,
    accept({ run, execution, keyHash, requestHash, ttlMs, maxQueued = 32, check = () => {}, onAccepted = () => {} }) {
      return transaction(() => {
        const existing = lookup(keyHash, requestHash);
        if (existing) return { run: existing, deduplicated: true };
        if (!run.id || run.status !== "queued" || !Number.isFinite(Date.parse(run.startedAt))) throw failure(400, "Invalid queued task");
        if (!Number.isSafeInteger(maxQueued) || maxQueued < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Invalid queue limits");
        if (keyHash && (!/^[a-f0-9]{64}$/.test(keyHash) || !/^[a-f0-9]{64}$/.test(requestHash || ""))) throw failure(400, "Invalid idempotency digest");
        if (db.prepare("SELECT count(*) AS n FROM external_tasks WHERE state='queued'").get().n >= maxQueued) {
          throw Object.assign(failure(429, "后台任务队列已满，请稍后使用原事件键重试"), { retryAfterMs: 30000 });
        }
        check();
        db.prepare("DELETE FROM external_task_keys WHERE expires_ms<=? AND run_id IN (SELECT id FROM external_tasks WHERE state='terminal' AND json_extract(record,'$.status')!='needs_reconciliation')").run(now());
        db.prepare("INSERT INTO external_tasks VALUES (?, ?, ?, ?, 'queued', NULL, NULL, 0)").run(
          run.id, JSON.stringify(run), JSON.stringify(execution), now(),
        );
        onAccepted(run);
        if (keyHash) db.prepare("INSERT INTO external_task_keys VALUES (?, ?, ?, ?)").run(keyHash, requestHash, run.id, now() + ttlMs);
        return { run, deduplicated: false };
      });
    },
    claim({ owner, pid = process.pid, maxGlobal = 2, maxPerClient = 1 }) {
      return transaction(() => {
        if (!owner || !Number.isSafeInteger(pid) || pid < 1 || ![maxGlobal, maxPerClient].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid execution owner or concurrency limits");
        const running = db.prepare("SELECT record FROM external_tasks WHERE state='running'").all().map(decode);
        if (running.length >= maxGlobal) return null;
        const queued = db.prepare("SELECT id, record, epoch FROM external_tasks WHERE state='queued' ORDER BY created_ms, id").all();
        for (const row of queued) {
          const record = decode(row);
          if (running.filter((run) => run.clientId === record.clientId).length >= maxPerClient) continue;
          db.prepare("UPDATE external_tasks SET state='running', owner=?, owner_pid=?, epoch=epoch+1 WHERE id=?").run(owner, pid, row.id);
          return { run: record, execution: JSON.parse(db.prepare("SELECT execution FROM external_tasks WHERE id=?").get(row.id).execution), claim: { owner, epoch: row.epoch + 1 } };
        }
        return null;
      });
    },
    update(record, claim) {
      return transaction(() => {
        const row = get.get(record.id);
        assertClaim(row, claim);
        const current = decode(row);
        for (const field of ["id", "clientId", "automationId", "repoId", "startedAt", "triggerIdempotencyHash", "triggerRequestHash"]) {
          if ((current[field] || null) !== (record[field] || null)) throw failure(409, "任务归属或请求摘要不能更改");
        }
        if (JSON.stringify(current.outputSchema || null) !== JSON.stringify(record.outputSchema || null)) throw failure(409, "已接收任务的输出格式不能更改");
        if (JSON.stringify(current.artifactPaths || []) !== JSON.stringify(record.artifactPaths || [])) throw failure(409, "已接收任务的产物路径不能更改");
        if (row.state === "terminal") return current;
        if (current.cancelRequestedAt) {
          record = { ...record, cancelRequestedAt: current.cancelRequestedAt };
          if (!terminal.has(record.status)) record.status = "canceling";
        }
        return write(row, record);
      });
    },
    cancel(id, client, event) {
      return transaction(() => {
        const row = get.get(id), current = decode(row);
        if (!current || current.clientId !== client.id || current.automationId !== client.automationId) throw failure(404, "Run not found");
        if (row.state === "terminal" || current.cancelRequestedAt) return { run: current, pending: row.state !== "terminal" };
        const queued = row.state === "queued";
        const time = new Date(now()).toISOString();
        const record = { ...current, status: queued ? "canceled" : "canceling", cancelRequestedAt: time, updatedAt: time,
          ...(queued ? { finishedAt: time, usage: { status: "complete", source: "not-started", inputTokens: 0, outputTokens: 0, totalTokens: 0 } } : {}),
          ...mergeAutomationEvents(current, [event]),
        };
        return { run: write(row, record), pending: !queued };
      });
    },
    release(id, claim) {
      return transaction(() => {
        const row = get.get(id); assertClaim(row, claim);
        const current = decode(row);
        if (current.cancelRequestedAt) {
          const time = new Date(now()).toISOString();
          return write(row, { ...current, status: "canceled", finishedAt: time, updatedAt: time,
            usage: { status: "complete", source: "not-started", inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
        }
        if (current.status !== "queued") throw failure(409, "已开始执行的任务不能退回队列");
        db.prepare("UPDATE external_tasks SET state='queued', owner=NULL, owner_pid=NULL, epoch=epoch+1 WHERE id=?").run(id);
      });
    },
    recover() {
      return transaction(() => {
        const recovered = [];
        for (const row of db.prepare("SELECT id, record, owner, owner_pid FROM external_tasks WHERE state='running'").all()) {
          if (ownerAlive(row.owner_pid, row.owner)) continue;
          const current = decode(row), time = new Date(now()).toISOString();
          const record = { ...current, status: "needs_reconciliation", updatedAt: time, finishedAt: time,
            interruptionKind: "console-restart", interruptedAt: time,
            error: "执行进程已退出，外部动作结果需要核对；未自动重试。",
            ...mergeAutomationEvents(current, [{ time, type: "needs-reconciliation", text: "执行进程退出，未重复执行" }]),
          };
          write(row, record);
          db.prepare("UPDATE external_tasks SET epoch=epoch+1 WHERE id=?").run(row.id);
          recovered.push(record);
        }
        return recovered;
      });
    },
    retain(ids) {
      const kept = new Set(ids);
      for (const id of latestIds()) kept.add(id);
      transaction(() => {
        db.prepare("DELETE FROM external_task_keys WHERE expires_ms<=? AND run_id IN (SELECT id FROM external_tasks WHERE state='terminal' AND json_extract(record,'$.status')!='needs_reconciliation')").run(now());
        const results = db.prepare("SELECT name FROM sqlite_master WHERE name='external_results'").get();
        for (const row of db.prepare("SELECT id FROM external_tasks WHERE state='terminal' AND json_extract(record,'$.status')!='needs_reconciliation' AND id NOT IN (SELECT run_id FROM external_task_keys)" +
          (results ? " AND id NOT IN (SELECT run_id FROM external_results)" : "")).all()) {
          if (!kept.has(row.id)) db.prepare("DELETE FROM external_tasks WHERE id=?").run(row.id);
        }
      });
    },
    info() { return Object.fromEntries(db.prepare("SELECT state, count(*) AS n FROM external_tasks GROUP BY state").all().map((row) => [row.state, row.n])); },
  };
}
