import { runInUsageRange } from "./run-usage.mjs";

const iso = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const resultStates = ["ready", "preparing", "expired", "notDelivered", "notRetained", "untracked", "unknown"];
const callbackStates = ["awaiting", "pending", "sending", "delivered", "failed", "notRetained", "untracked", "unknown"];

function resultStatus(run, row, now) {
  if (!row) return { status: "untracked" };
  if (!row.result_state) return { status: "notRetained" };
  if (row.result_client !== run.clientId || row.result_automation !== run.automationId) return { status: "unknown" };
  if (["interrupted", "needs_reconciliation"].includes(run.status)) return { status: "unknown" };
  if (["failed", "canceled", "cancelled"].includes(run.status)) return { status: "notDelivered" };
  if (run.status !== "completed") return { status: ["queued", "running", "canceling"].includes(run.status) ? "preparing" : "unknown" };
  if (["expired", "deleting"].includes(row.result_state)) return { status: row.expires_ms === null ? "notRetained" : "expired" };
  if (row.expires_ms !== null && row.expires_ms <= now) return { status: "expired" };
  if (row.result_state !== "ready") return { status: "unknown" };
  const data = JSON.parse(row.result_record);
  const files = data?.files;
  if (!Array.isArray(files) || files.length > 9 || files.some(file => !file || typeof file !== "object") || !data.manifestId || row.delivery_id !== data.manifestId ||
      !row.thread_id || !row.turn_id || data.threadId !== row.thread_id || data.turnId !== row.turn_id ||
      files.filter(file => file.kind === "manifest" && file.id === data.manifestId).length !== 1 ||
      files.some(file => !Number.isSafeInteger(file.size) || file.size < 0) || !Number.isSafeInteger(row.expires_ms) || !iso(row.expires_ms)) return { status: "unknown" };
  return { status: "ready", artifactCount: files.filter(file => file.kind !== "manifest").length, expiresAt: iso(row.expires_ms) };
}

function callbackStatus(run, row, now) {
  if (!row) return { status: "untracked" };
  if (!row.callback_state) return { status: "notRetained" };
  if (row.callback_client !== run.clientId || row.callback_automation !== run.automationId ||
      !callbackStates.includes(row.callback_state) || !Number.isSafeInteger(row.attempts) || row.attempts < 0) return { status: "unknown" };
  const expired = ["pending", "sending"].includes(row.callback_state) && row.callback_expires !== null && row.callback_expires <= now;
  const status = expired ? "failed" : row.callback_state;
  return { status, attempts: row.attempts, lastCode: expired ? "delivery_expired" : /^[a-z0-9_]{1,64}$/.test(row.last_code || "") ? row.last_code : null,
    nextAttemptAt: status === "pending" ? iso(row.next_ms) : null, deliveredAt: status === "delivered" ? iso(row.delivered_ms) : null };
}

// Metadata only: downloading still verifies ownership, expiry, file bytes and hashes.
export function summarizeDeliveryUsage(db, runs, range, { now = Date.now(), limit = 200 } = {}) {
  if (!Number.isSafeInteger(now) || !iso(now) || !Number.isSafeInteger(limit) || limit < 0 || limit > 200) throw new Error("Invalid delivery summary options");
  const rows = db.prepare(`SELECT t.id, json_extract(t.record,'$.clientId') AS client_id,
    json_extract(t.record,'$.automationId') AS automation_id, json_extract(t.record,'$.delivery.id') AS delivery_id,
    json_extract(t.record,'$.threadId') AS thread_id, json_extract(t.record,'$.turnId') AS turn_id,
    r.state AS result_state, r.client_id AS result_client, r.automation_id AS result_automation, r.record AS result_record, r.expires_ms,
    c.state AS callback_state, c.client_id AS callback_client, c.automation_id AS callback_automation, c.attempts,
    c.expires_ms AS callback_expires, c.next_ms, c.last_code, c.delivered_ms
    FROM external_tasks t LEFT JOIN external_results r ON r.run_id=t.id LEFT JOIN external_callbacks c ON c.run_id=t.id
    WHERE (?='' OR json_extract(t.record,'$.clientId')=?)`).all(range.clientId || "", range.clientId || "");
  const byId = new Map(rows.map(row => [row.id, row]));
  const results = Object.fromEntries(resultStates.map(state => [state, 0]));
  const callbacks = Object.fromEntries(callbackStates.map(state => [state, 0]));
  const details = [];
  let artifacts = 0, attempts = 0, retries = 0;
  for (const run of runs) {
    if (!runInUsageRange(run, range)) continue;
    const row = byId.get(run.id);
    const owned = !row || row.client_id === run.clientId && row.automation_id === run.automationId;
    const result = owned ? resultStatus(run, row, now) : { status: "unknown" };
    const callback = owned ? callbackStatus(run, row, now) : { status: "unknown" };
    results[result.status]++; callbacks[callback.status]++;
    artifacts += result.artifactCount || 0;
    attempts += callback.attempts || 0; retries += Math.max(0, (callback.attempts || 0) - 1);
    details.push({ id: run.id, clientId: run.clientId, automationId: run.automationId, startedAt: run.executionStartedAt || run.startedAt, result, callback });
  }
  details.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id));
  return { asOf: new Date(now).toISOString(), tasks: details.length, results, callbacks, artifacts, attempts, retries,
    details: details.slice(0, limit), detailLimit: limit, attribution: "execution_start_else_acceptance", verification: "metadata_only" };
}
