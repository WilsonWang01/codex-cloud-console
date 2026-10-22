#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const activeStatuses = new Set(["queued", "running", "canceling"]);
const terminalStatuses = new Set(["completed", "failed", "canceled", "cancelled", "interrupted", "needs_reconciliation"]);
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

export async function runExternalClient({ command, automationId, eventId = "", runId = "", fileId = "", origin, token, input = {}, wait = false,
  pollMs = 5000, timeoutMs = 60 * 60_000, requestTimeoutMs = 30_000, maxRetries = 2, signal,
  onStatus = () => {}, onProgress = () => {} }) {
  if (!origin || !token || !automationId) throw new Error("CODEX_CLOUD_URL, CODEX_CLOUD_API_TOKEN and automation-id are required");
  origin = serviceOrigin(origin);
  const submitting = ["submit", "heartbeat"].includes(command);
  const discovery = ["models", "capabilities"].includes(command);
  const output = ["output", "download"].includes(command);
  if (!submitting && !discovery && !output && !["status", "cancel"].includes(command)) throw new Error("command must be submit, heartbeat, status, cancel, models, capabilities, output or download");
  if (command === "download" && !/^[a-f0-9-]{36}$/.test(fileId)) throw new Error("a valid artifact file-id is required");
  if (submitting && !/^[A-Za-z0-9._:-]{8,160}$/.test(eventId)) throw new Error("event-id must be 8-160 letters, numbers, dots, underscores, colons or dashes and stable across retries");
  if (!submitting && !discovery && !runId) throw new Error("run-id is required");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be a JSON object");
  for (const [name, value] of Object.entries({ pollMs, timeoutMs, requestTimeoutMs })) positiveMilliseconds(value, name);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error("maxRetries must be between 0 and 5");
  const deadline = Date.now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const delay = (ms) => sleep(Math.min(ms, 2_147_483_647), undefined, { signal: operationSignal });
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
  const request = async (pathname, options = {}, binary = false) => {
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
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body || []) {
          size += chunk.length;
          if (size > (binary && response.ok ? 8 : 20) * 1024 * 1024) throw new ExternalClientError("Response exceeds the delivery limit", { code: "INVALID_RESPONSE" });
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        if (binary && response.ok) return { buffer, sha256: response.headers.get("x-content-sha256") };
        let payload;
        try { payload = JSON.parse(buffer.toString("utf8")); }
        catch (caught) { if (!(caught instanceof SyntaxError)) throw caught; }
        if (response.ok) {
          if (!payload) throw new ExternalClientError("Server returned a non-JSON response", { code: "INVALID_RESPONSE" });
          return payload;
        }
        error = new ExternalClientError(payload?.error?.message || payload?.error || payload?.output || `HTTP ${response.status}`, {
          code: "HTTP_ERROR", serverCode: payload?.code || payload?.error?.code || null, statusCode: response.status, retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
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
    if (discovery) {
      const payload = await request(`/api/automations/${encodeURIComponent(automationId)}/v1/${command}`, { headers: { authorization: `Bearer ${token}` } });
      if (command === "models" ? payload.object !== "list" || !Array.isArray(payload.data) : payload.object !== "codex_cloud.capabilities" || payload.automation_id !== automationId) {
        throw new ExternalClientError("Server returned invalid discovery information", { code: "INVALID_RESPONSE" });
      }
      return payload;
    }
    if (output) {
      const base = `${resultPath(automationId, runId)}/output`;
      const payload = await request(base);
      const manifest = payload?.result;
      if (!payload?.ok || manifest?.version !== 1 || manifest.runId !== runId || manifest.automationId !== automationId || manifest.status !== "completed" ||
          typeof manifest.text !== "string" || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 8) {
        throw new ExternalClientError("Server returned an invalid result manifest", { code: "INVALID_RESPONSE" });
      }
      if (command === "output") return manifest;
      const artifact = manifest.artifacts.find(file => file.id === fileId);
      if (!artifact || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        throw new ExternalClientError("Artifact is missing or has invalid integrity metadata", { code: "INVALID_RESPONSE" });
      }
      // Construct the path locally; never follow a server-supplied URL with credentials.
      const downloaded = await request(`${base}/files/${encodeURIComponent(fileId)}`, {}, true);
      const sha256 = createHash("sha256").update(downloaded.buffer).digest("hex");
      if (sha256 !== artifact.sha256 || downloaded.sha256 !== sha256 || downloaded.buffer.length !== artifact.size) {
        throw new ExternalClientError("Artifact integrity check failed", { code: "INVALID_RESPONSE" });
      }
      return { artifact, buffer: downloaded.buffer };
    }
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
  const [command, automationId, value, ...args] = process.argv.slice(2);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const cli = async () => {
    const fs = await import("node:fs/promises"), { constants } = await import("node:fs"), path = await import("node:path");
    const read = async (name, limit) => {
      const handle = await fs.open(name, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error("Input must be a regular file within the documented size limit");
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) { controller.signal.throwIfAborted(); const { bytesRead } = await handle.read(buffer, size, buffer.length - size); if (!bytesRead) break; size += bytesRead; }
        if (size > limit) throw new Error("Input file exceeds the documented size limit");
        return buffer.subarray(0, size);
      } finally { await handle.close(); }
    };
    let input = {}, prompt, wait = false, fileId = "", destination;
    const attachments = [];
    if (command === "download") {
      if (args.length !== 2) throw new Error("download requires file-id and destination; existing files are never overwritten");
      [fileId, destination] = args;
    } else for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--wait") { wait = true; continue; }
      if (!["--input", "--prompt", "--attach"].includes(flag) || !args[i + 1]) throw new Error("Supported options: --wait, --input request.json, --prompt text, --attach file");
      if (!["submit", "heartbeat"].includes(command)) throw new Error("Input options are only for submit or heartbeat");
      const item = args[++i];
      if (flag === "--input") {
        const bytes = await read(item, 12 * 1024 * 1024);
        try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new Error("--input must contain valid UTF-8 JSON; file contents are not logged"); }
      }
      else if (flag === "--prompt") prompt = item;
      else attachments.push(item);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("--input must contain a JSON object");
    if (prompt !== undefined) input.prompt = prompt;
    const mimes = { ".txt": "text/plain", ".md": "text/markdown", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
    if (attachments.length) {
      if (input.attachments !== undefined && !Array.isArray(input.attachments)) throw new Error("attachments must be an array");
      input.attachments ||= [];
      if (input.attachments.length + attachments.length > 8) throw new Error("At most eight attachments are allowed");
      for (const name of attachments) {
        const mimeType = mimes[path.extname(name).toLowerCase()];
        if (!mimeType) throw new Error("Attachments must be txt/md/png/jpeg/webp files");
        const bytes = await read(name, mimeType.startsWith("image/") ? 4 * 1024 * 1024 : 64 * 1024);
        input.attachments.push({ name: path.basename(name), mimeType, dataBase64: bytes.toString("base64") });
      }
    }
    const result = await runExternalClient({
      command, automationId, eventId: ["submit", "heartbeat"].includes(command) ? value : "", runId: ["submit", "heartbeat"].includes(command) ? "" : value,
      fileId, input,
      origin: process.env.CODEX_CLOUD_URL, token: process.env.CODEX_CLOUD_API_TOKEN, wait, signal: controller.signal,
      onStatus: (run) => process.stderr.write(`${run.id}: ${run.status}\n`),
    });
    if (command === "download") {
      await fs.writeFile(destination, result.buffer, { flag: "wx", mode: 0o600 });
      return process.stdout.write(`${JSON.stringify({ artifact: result.artifact, destination }, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (terminalStatuses.has(result.status) && result.status !== "completed") process.exitCode = 1;
  };
  cli().catch((error) => {
    process.stderr.write(`${error.message}${error.runId ? ` (run-id: ${error.runId})` : ""}${error.eventId ? ` (event-id: ${error.eventId})` : ""}\n`);
    process.exitCode = 1;
  });
}
