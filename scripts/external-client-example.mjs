#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const activeStatuses = new Set(["queued", "running", "canceling"]);
const terminalStatuses = new Set(["completed", "failed", "canceled", "interrupted", "needs_reconciliation"]);
const retryStatuses = new Set([429, 502, 503, 504]);

export class ExternalClientError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExternalClientError";
    Object.assign(this, details);
  }
}

function resultPath(automationId, runId) {
  return `/api/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`;
}

function positiveMilliseconds(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`${name} must be a positive integer in milliseconds`);
}

function serviceOrigin(value) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new Error("CODEX_CLOUD_URL must be an HTTPS origin without credentials (loopback HTTP is allowed)");
  }
  return url.origin;
}

function retryAfterMs(value) {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function runExternalClient({ command, automationId, eventId = "", runId = "", origin, token, input = {}, wait = false,
  pollMs = 5000, timeoutMs = 60 * 60_000, requestTimeoutMs = 30_000, maxRetries = 2, signal,
  onStatus = () => {}, onProgress = () => {} }) {
  if (!origin || !token || !automationId) throw new Error("CODEX_CLOUD_URL, CODEX_CLOUD_API_TOKEN and automation-id are required");
  origin = serviceOrigin(origin);
  const submitting = ["submit", "heartbeat"].includes(command);
  if (!submitting && !["status", "cancel"].includes(command)) throw new Error("command must be submit, heartbeat, status or cancel");
  if (submitting && !/^[A-Za-z0-9._:-]{8,160}$/.test(eventId)) throw new Error("event-id must be 8-160 letters, numbers, dots, underscores, colons or dashes and stable across retries");
  if (!submitting && !runId) throw new Error("run-id is required");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be a JSON object");
  for (const [name, value] of Object.entries({ pollMs, timeoutMs, requestTimeoutMs })) positiveMilliseconds(value, name);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error("maxRetries must be between 0 and 5");
  const deadline = Date.now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const delay = (ms) => sleep(Math.min(ms, Math.max(1, deadline - Date.now())), undefined, { signal: operationSignal });
  let current;
  let cursor = 0;
  let lastStatus;
  const accept = async (payload) => {
    const run = payload?.run;
    if (payload?.ok !== true || typeof run?.id !== "string" || !run.id || run.automationId !== automationId ||
      (runId && run.id !== runId) || (!activeStatuses.has(run.status) && !terminalStatuses.has(run.status))) {
      throw new ExternalClientError("Server returned an invalid or mismatched run", { code: "INVALID_RESPONSE" });
    }
    const nextCursor = payload.eventCursor ?? run.eventCursor ?? 0;
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0) throw new ExternalClientError("Server returned an invalid event cursor", { code: "INVALID_RESPONSE" });
    current = run;
    runId = run.id;
    cursor = nextCursor;
    operationSignal.throwIfAborted();
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(operationSignal.reason);
      operationSignal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([aborted, (async () => {
        if (run.status !== lastStatus) { lastStatus = run.status; await onStatus(run); }
        operationSignal.throwIfAborted();
        await onProgress({ ...payload, eventCursor: cursor });
      })()]);
    } finally { operationSignal.removeEventListener("abort", abort); }
    return run;
  };
  const request = async (pathname, options = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      operationSignal.throwIfAborted();
      let error;
      try {
        const response = await fetch(new URL(pathname, origin), {
          ...options, redirect: "manual",
          signal: AbortSignal.any([operationSignal, AbortSignal.timeout(Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())))]),
          headers: { "x-codex-cloud-token": token, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new ExternalClientError("API redirects are not followed; use the final HTTPS origin", { code: "INVALID_RESPONSE", statusCode: response.status });
        }
        let payload;
        try { payload = await response.json(); }
        catch (caught) { if (!(caught instanceof SyntaxError)) throw caught; }
        if (response.ok) {
          if (!payload) throw new ExternalClientError("Server returned a non-JSON response", { code: "INVALID_RESPONSE" });
          return payload;
        }
        error = new ExternalClientError(payload?.error || payload?.output || `HTTP ${response.status}`, {
          code: "HTTP_ERROR", statusCode: response.status, retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
        });
      } catch (caught) {
        operationSignal.throwIfAborted();
        error = caught instanceof ExternalClientError ? caught : new ExternalClientError("API request failed; retry with the same event ID or query the known run", { code: "NETWORK_ERROR", cause: caught });
      }
      const retryable = error.code === "NETWORK_ERROR" || retryStatuses.has(error.statusCode);
      if (!retryable || attempt >= maxRetries) throw error;
      await delay(error.retryAfterMs ?? Math.min(250 * 2 ** attempt, 2000));
    }
  };
  try {
    const payload = submitting
      ? await request(`/api/automations/${encodeURIComponent(automationId)}/${command === "heartbeat" ? "heartbeat" : "webhook"}`, {
          method: "POST", headers: { "idempotency-key": eventId }, body: JSON.stringify({ runner: "app-server", worktree: true, ...input }),
        })
      : await request(`${resultPath(automationId, runId)}${command === "cancel" ? "/cancel" : ""}`, command === "cancel" ? { method: "POST" } : {});
    await accept(payload);
    if (command === "cancel") return payload;
    while (wait && activeStatuses.has(current.status)) {
      await delay(pollMs);
      await accept(await request(`${resultPath(automationId, runId)}?after=${cursor}`));
    }
    return current;
  } catch (error) {
    if (operationSignal.aborted) {
      throw new ExternalClientError(signal?.aborted ? "Local waiting was aborted; the server run was not canceled" : "Local request/wait deadline expired; query the run or retry the same event ID, not a new one", {
        code: signal?.aborted ? "ABORTED" : "TIMEOUT", runId: runId || null, eventId: eventId || null, cause: operationSignal.reason,
      });
    }
    if (error instanceof Error) { error.runId = runId || null; error.eventId = eventId || null; }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, automationId, value, option] = process.argv.slice(2);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  runExternalClient({
    command, automationId, eventId: ["submit", "heartbeat"].includes(command) ? value : "", runId: ["submit", "heartbeat"].includes(command) ? "" : value,
    origin: process.env.CODEX_CLOUD_URL, token: process.env.CODEX_CLOUD_API_TOKEN, wait: option === "--wait", signal: controller.signal,
    onStatus: (run) => process.stderr.write(`${run.id}: ${run.status}\n`),
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (terminalStatuses.has(result.status) && result.status !== "completed") process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.message}${error.runId ? ` (run-id: ${error.runId})` : ""}${error.eventId ? ` (event-id: ${error.eventId})` : ""}\n`);
    process.exitCode = 1;
  });
}
