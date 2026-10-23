import { randomUUID } from "node:crypto";

export const callbackLimits = Object.freeze({ records: 4096, attempts: 5, lifetimeMs: 86_400_000, retentionMs: 7 * 86_400_000, leaseMs: 30_000, timeoutMs: 10_000 });
const retryMs = [30_000, 120_000, 600_000, 3_600_000];
const fail = (message) => Object.assign(new Error(message), { statusCode: 503 });

export function createExternalCallbackStore(db, { now = () => Date.now() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS external_callbacks (
    run_id TEXT PRIMARY KEY REFERENCES external_tasks(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, automation_id TEXT NOT NULL,
    target_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('awaiting','pending','sending','delivered','failed')),
    body TEXT CHECK(body IS NULL OR json_valid(body)), created_ms INTEGER NOT NULL,
    expires_ms INTEGER, next_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    lease_id TEXT, lease_until INTEGER, last_code TEXT, delivered_ms INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS external_callback_due ON external_callbacks(state,next_ms);`);
  const transaction = callback => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = db.prepare("SELECT total_changes() AS n").get().n;
      const result = callback();
      if (db.prepare("SELECT total_changes() AS n").get().n !== before) db.exec("UPDATE external_tasks_meta SET value=value+1 WHERE key='revision'");
      db.exec("COMMIT"); return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const prune = () => db.prepare("DELETE FROM external_callbacks WHERE state IN ('delivered','failed') AND coalesce(delivered_ms,expires_ms)<?").run(now() - callbackLimits.retentionMs);
  const expire = () => db.prepare("UPDATE external_callbacks SET state='failed',last_code='delivery_expired',lease_id=NULL,lease_until=NULL WHERE state IN ('pending','sending') AND (expires_ms<=? OR (attempts>=? AND lease_until<=?))")
    .run(now(), callbackLimits.attempts, now());
  return {
    due() { return Boolean(db.prepare("SELECT 1 FROM external_callbacks WHERE state='pending' AND next_ms<=? OR state='sending' AND lease_until<=? LIMIT 1").get(now(),now())); },
    sweep() { return transaction(() => { expire(); prune(); }); },
    // These two methods run inside the task store's acceptance/terminal transaction.
    reserve(run, binding) {
      if (!binding) return;
      if (typeof binding.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(binding.id) || typeof binding.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(binding.fingerprint) || !run.clientId) throw fail("回调登记无效，未接收任务");
      prune();
      if (db.prepare("SELECT count(*) AS n FROM external_callbacks").get().n >= callbackLimits.records) throw fail("回调记录容量已满，未接收任务；请使用原事件键稍后重试");
      db.prepare("INSERT INTO external_callbacks (run_id,event_id,client_id,automation_id,target_id,fingerprint,state,created_ms,next_ms) VALUES (?,?,?,?,?,?,'awaiting',?,?)")
        .run(run.id, randomUUID(), run.clientId, run.automationId, binding.id, binding.fingerprint, now(), now());
    },
    terminal(run) {
      const row = db.prepare("SELECT event_id FROM external_callbacks WHERE run_id=? AND state='awaiting'").get(run.id);
      if (!row) return;
      const resultPath = `/api/automations/${encodeURIComponent(run.automationId)}/runs/${encodeURIComponent(run.id)}`;
      const body = JSON.stringify({ id: row.event_id, type: "automation.run.terminal", created_at: new Date(now()).toISOString(),
        data: { run_id: run.id, automation_id: run.automationId, status: run.status, result_path: resultPath,
          ...(run.delivery ? { output_path: resultPath + "/output" } : {}) } });
      if (Buffer.byteLength(body) > 2048) throw fail("回调元数据过大，未改变任务终态");
      db.prepare("UPDATE external_callbacks SET state='pending',body=?,created_ms=?,expires_ms=?,next_ms=? WHERE run_id=?")
        .run(body, now(), now() + callbackLimits.lifetimeMs, now(), run.id);
    },
    claim() {
      return transaction(() => {
        prune();
        expire();
        const row = db.prepare("SELECT * FROM external_callbacks WHERE (state='pending' AND next_ms<=? OR state='sending' AND lease_until<=?) AND attempts<? ORDER BY next_ms,run_id LIMIT 1")
          .get(now(), now(), callbackLimits.attempts);
        if (!row) return null;
        const lease = randomUUID();
        db.prepare("UPDATE external_callbacks SET state='sending',attempts=attempts+1,lease_id=?,lease_until=? WHERE run_id=?")
          .run(lease, now() + callbackLimits.leaseMs, row.run_id);
        return { ...row, attempts: row.attempts + 1, lease_id: lease };
      });
    },
    finish(claim, { ok = false, code = "network_unavailable", retryable = true } = {}) {
      if (!/^[a-z0-9_]{1,64}$/.test(code)) throw new Error("Invalid callback outcome code");
      return transaction(() => {
        const row = db.prepare("SELECT * FROM external_callbacks WHERE run_id=? AND state='sending' AND lease_id=?").get(claim.run_id, claim.lease_id);
        if (!row) return false;
        const retry = !ok && retryable && row.attempts < callbackLimits.attempts && row.expires_ms > now();
        db.prepare("UPDATE external_callbacks SET state=?,next_ms=?,lease_id=NULL,lease_until=NULL,last_code=?,delivered_ms=? WHERE run_id=?")
          .run(ok ? "delivered" : retry ? "pending" : "failed", now() + (retryMs[row.attempts - 1] || 0), code, ok ? now() : null, row.run_id);
        return true;
      });
    },
    status(id) {
      const row = db.prepare("SELECT event_id,state,attempts,last_code,next_ms,delivered_ms FROM external_callbacks WHERE run_id=?").get(id);
      return row ? { eventId: row.event_id, status: row.state, attempts: row.attempts, lastCode: row.last_code,
        nextAttemptAt: row.state === "pending" ? new Date(row.next_ms).toISOString() : null,
        deliveredAt: row.delivered_ms ? new Date(row.delivered_ms).toISOString() : null } : null;
    },
    info() { return Object.fromEntries(db.prepare("SELECT state,count(*) AS n FROM external_callbacks GROUP BY state").all().map(row => [row.state,row.n])); },
  };
}
