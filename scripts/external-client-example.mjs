#!/usr/bin/env node
import { fileURLToPath } from "node:url";

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resultPath(automationId, runId) {
  return `/api/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`;
}

async function requestJson(origin, token, pathname, options = {}) {
  const response = await fetch(new URL(pathname, origin), {
    ...options,
    signal: AbortSignal.timeout(30_000),
    headers: { "x-codex-cloud-token": token, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.statusCode = response.status;
    error.retryAfterMs = Math.max(0, Number(response.headers.get("retry-after") || 0) * 1000);
    throw error;
  }
  return payload;
}

export async function runExternalClient({ command, automationId, eventId = "", runId = "", origin, token, wait = false, pollMs = 5000, timeoutMs = 60 * 60_000, onStatus = () => {} }) {
  required(origin, "CODEX_CLOUD_URL");
  required(token, "CODEX_CLOUD_API_TOKEN");
  required(automationId, "automation-id");
  if (!["submit", "status", "cancel"].includes(command)) throw new Error("command must be submit, status or cancel");
  if (command === "submit" && !/^[A-Za-z0-9._:-]{8,160}$/.test(eventId)) throw new Error("event-id must be 8-160 letters, numbers, dots, underscores, colons or dashes and stable across retries");
  if (command !== "submit" && !runId) throw new Error("run-id is required");
  if (command === "cancel") return requestJson(origin, token, `${resultPath(automationId, runId)}/cancel`, { method: "POST" });
  let current = command === "submit"
    ? (await requestJson(origin, token, `/api/automations/${encodeURIComponent(automationId)}/webhook`, {
        method: "POST", headers: { "idempotency-key": eventId }, body: JSON.stringify({ runner: "app-server", worktree: true }),
      })).run
    : (await requestJson(origin, token, resultPath(automationId, runId))).run;
  if (!current?.id) throw new Error("Server did not return a run ID");
  onStatus(current);
  if (!wait || !["queued", "running", "canceling"].includes(current.status)) return current;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = current.status;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    try { current = (await requestJson(origin, token, resultPath(automationId, current.id))).run; }
    catch (error) {
      if (error.statusCode === 429) { await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs || pollMs)); continue; }
      throw error;
    }
    if (!current?.id) throw new Error("Server result lost the run ID");
    if (current.status !== lastStatus) { lastStatus = current.status; onStatus(current); }
    if (!["queued", "running", "canceling"].includes(current.status)) return current;
  }
  throw new Error(`Run ${current.id} is still active after the local polling timeout; query status before retrying the original event`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, automationId, value, option] = process.argv.slice(2);
  runExternalClient({
    command, automationId,
    eventId: command === "submit" ? value : "",
    runId: command === "submit" ? "" : value,
    origin: process.env.CODEX_CLOUD_URL,
    token: process.env.CODEX_CLOUD_API_TOKEN,
    wait: option === "--wait",
    onStatus: (run) => process.stderr.write(`${run.id}: ${run.status}\n`),
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "failed" || result.status === "needs_reconciliation") process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
