import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runExternalClient } from "./external-client-example.mjs";
import { validateExternalTriggerInput } from "../server/external-automation.mjs";

const reply = (status = "completed", extra = {}) => ({ ok: true, run: { id: "run-1", automationId: "research", status, ...extra } });
const options = { command: "submit", automationId: "research", eventId: "business-event-123", token: "test-secret", pollMs: 1 };

function pythonClient(origin, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [fileURLToPath(new URL("./external-client-example.py", import.meta.url)), ...args], {
      env: { ...process.env, CODEX_CLOUD_URL: origin, CODEX_CLOUD_API_TOKEN: "test-secret" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("standalone Python client discovers, retries a lost response with the same key, reads and explicitly cancels", async (t) => {
  let lost = false;
  const { origin, calls } = await fixture(t, (req, res) => {
    if (req.url.endsWith("/capabilities")) {
      assert.equal(req.headers.authorization, "Bearer test-secret");
      return res.end(JSON.stringify({ object: "codex_cloud.capabilities", automation_id: "research" }));
    }
    if (req.url.endsWith("/webhook") && !lost) { lost = true; return req.socket.destroy(); }
    res.end(JSON.stringify(reply(req.url.endsWith("/cancel") ? "canceling" : "completed")));
  });
  const caps = await pythonClient(origin, "capabilities", "research");
  assert.equal(caps.code, 0, caps.stderr);
  const submitted = await pythonClient(origin, "submit", "research", "python-event-123", "--prompt", "只读");
  assert.equal(submitted.code, 0, submitted.stderr);
  const posts = calls.filter((call) => call.url.endsWith("/webhook"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body, posts[1].body);
  assert.equal(posts[0].key, posts[1].key);
  const status = await pythonClient(origin, "status", "research", "run-1");
  assert.equal(JSON.parse(status.stdout).status, "completed");
  const canceled = await pythonClient(origin, "cancel", "research", "run-1");
  assert.equal(JSON.parse(canceled.stdout).status, "canceling");
  assert.equal(calls.filter((call) => call.url.endsWith("/cancel")).length, 1);
});

test("Python rejects redirects and unsafe origins without forwarding credentials", async (t) => {
  const sink = await fixture(t, (_req, res) => res.end("{}"));
  const { origin, calls } = await fixture(t, (_req, res) => { res.statusCode = 307; res.setHeader("Location", sink.origin); res.end(); });
  const redirected = await pythonClient(origin, "capabilities", "research");
  assert.equal(redirected.code, 1);
  assert.equal(calls.length, 1);
  assert.equal(sink.calls.length, 0);
  assert.equal((await pythonClient("http://example.com", "capabilities", "research")).code, 1);
});

test("reference client accepts both cancellation spellings as terminal without resubmitting or polling", async (t) => {
  for (const status of ["canceled", "cancelled"]) {
    const { origin, calls } = await fixture(t, (_req, res) => res.end(JSON.stringify(reply(status))));
    assert.equal((await runExternalClient({ ...options, origin, wait: true })).status, status);
    assert.equal(calls.length, 1);
  }
});

test("independent client queries capabilities and models without running a task", async (t) => {
  const { origin, calls } = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-secret");
    res.end(JSON.stringify(req.url.endsWith("/models") ? { object: "list", data: [] } : { object: "codex_cloud.capabilities", automation_id: "research", features: { artifact_download: false } }));
  });
  assert.equal((await runExternalClient({ ...options, command: "capabilities", origin })).features.artifact_download, false);
  assert.deepEqual((await runExternalClient({ ...options, command: "models", origin })).data, []);
  assert.ok(calls.every((call) => call.method === "GET" && !call.key));
});

async function fixture(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, token: req.headers["x-codex-cloud-token"], key: req.headers["idempotency-key"], body: Buffer.concat(chunks).toString() });
    res.setHeader("Content-Type", "application/json");
    handler(req, res, calls.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

test("Node and Python download verified private bytes, ignoring server-supplied foreign URLs", async t => {
  const fileId = "00000000-0000-4000-8000-000000000001";
  const bytes = Buffer.from("artifact bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = { version: 1, runId: "run-1", automationId: "research", status: "completed", text: "complete report", artifacts: [
    { id: fileId, size: bytes.length, sha256, downloadPath: "https://foreign.invalid/do-not-use", name: "report.md" },
  ] };
  const { origin, calls } = await fixture(t, (req, res) => {
    if (req.url.endsWith("/output")) return res.end(JSON.stringify({ ok: true, result: manifest }));
    assert.equal(req.url, `/api/automations/research/runs/run-1/output/files/${fileId}`);
    res.setHeader("X-Content-SHA256", sha256);
    res.end(bytes);
  });
  const result = await runExternalClient({ ...options, command: "download", runId: "run-1", fileId, origin });
  assert.deepEqual(result.buffer, bytes);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "python-artifact-client-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "report.md");
  const python = await pythonClient(origin, "download", "research", "run-1", "--file-id", fileId, "--output", target);
  assert.equal(python.code, 0, python.stderr);
  assert.deepEqual(await fs.readFile(target), bytes);
  const overwrite = await pythonClient(origin, "download", "research", "run-1", "--file-id", fileId, "--output", target);
  assert.notEqual(overwrite.code, 0);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.ok(calls.every(call => call.method === "GET" && call.token === "test-secret"));
});

test("file downloads reject corrupt bytes, mismatched manifests, expiry and redirects without submitting work", async t => {
  const fileId = "00000000-0000-4000-8000-000000000001";
  let mode = "corrupt";
  const { origin, calls } = await fixture(t, (req, res) => {
    if (mode === "expired") { res.statusCode = 410; return res.end(JSON.stringify({ ok: false, error: "expired" })); }
    if (req.url.endsWith("/output")) return res.end(JSON.stringify({ ok: true, result: { version: 1, runId: mode === "mismatch" ? "other" : "run-1",
      automationId: "research", status: "completed", text: "report", artifacts: [{ id: fileId, size: 3, sha256: "a".repeat(64) }] } }));
    if (mode === "redirect") { res.writeHead(302, { location: "https://foreign.invalid/" }); return res.end(); }
    res.setHeader("X-Content-SHA256", "a".repeat(64)); res.end("bad");
  });
  for (mode of ["corrupt", "mismatch", "redirect", "expired"]) {
    await assert.rejects(runExternalClient({ ...options, command: "download", runId: "run-1", fileId, origin }), err => ["INVALID_RESPONSE", "HTTP_ERROR"].includes(err.code));
  }
  assert.ok(calls.every(call => call.method === "GET"));
});

test("reference client submits with a stable event key, polls its result and cancels only explicitly", async (t) => {
  const { origin, calls } = await fixture(t, (req, res) => {
    if (req.url === "/api/automations/research/webhook") return res.end(JSON.stringify(reply("running")));
    if (req.url === "/api/automations/research/runs/run-1/cancel") return res.end(JSON.stringify(reply("canceling")));
    if (req.url?.startsWith("/api/automations/research/runs/run-1")) return res.end(JSON.stringify(reply("completed", { usage: { status: "known", totalTokens: 12 } })));
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });
  const statusChanges = [];
  const run = await runExternalClient({ command: "submit", automationId: "research", eventId: "business-event-123", origin, token: "test-secret", wait: true, pollMs: 1, onStatus: (item) => statusChanges.push(item.status) });
  assert.equal(run.status, "completed");
  assert.deepEqual(statusChanges, ["running", "completed"]);
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${url}`), [
    "POST /api/automations/research/webhook",
    "GET /api/automations/research/runs/run-1?after=0",
  ]);
  assert.equal(calls[0].key, "business-event-123");
  assert.ok(calls.every((call) => call.token === "test-secret"));
  await runExternalClient({ command: "cancel", automationId: "research", runId: "run-1", origin, token: "test-secret" });
  assert.equal(calls.at(-1).method, "POST");
  assert.match(calls.at(-1).url, /\/cancel$/);
  await assert.rejects(runExternalClient({ command: "submit", automationId: "research", eventId: "short", origin, token: "test-secret" }), /event-id/);
});

test("external request contract rejects ignored parameters and webhook session reuse", () => {
  const scope = { trigger: "webhook", scoped: true };
  for (const body of [null, [], { sessionId: "other-chat" }, { prompt: {} }, { prompt: " " }, { prompt: "中".repeat(22_000) },
    { model: "invalid model" }, { reasoning: "typo" }, { search: "false" }, { worktree: "false" }, { runner: "shell" }, { sandbox: "danger-full-access" }, { approval: "never" }, { typo: 1 }]) {
    assert.throws(() => validateExternalTriggerInput(body, scope), { statusCode: 400 });
  }
  validateExternalTriggerInput({ prompt: "调研", model: "gpt-6-sol", reasoning: "medium", search: false }, scope);
  validateExternalTriggerInput({ sessionId: "own-chat" }, { ...scope, trigger: "heartbeat" });
  validateExternalTriggerInput({ sessionId: "trusted-chat", worktree: false }, { ...scope, scoped: false });
});

test("retry preserves POST body and event key after a lost acceptance response", async (t) => {
  const { origin, calls } = await fixture(t, (req, res, count) => {
    if (count === 1) return req.socket.destroy();
    res.end(JSON.stringify(reply()));
  });
  const input = { prompt: "只读研究", model: "gpt-6-sol", reasoning: "medium", search: false };
  const run = await runExternalClient({ ...options, origin, input });
  assert.equal(run.status, "completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].key, calls[1].key);
  assert.deepEqual(JSON.parse(calls[0].body), { runner: "app-server", worktree: true, ...input });
});

test("429 and transient upstream errors retry within the same operation", async (t) => {
  const { origin, calls } = await fixture(t, (_req, res, count) => {
    if (count <= 2) { res.statusCode = count === 1 ? 429 : 503; res.setHeader("Retry-After", "0"); return res.end("proxy unavailable"); }
    res.end(JSON.stringify(reply()));
  });
  assert.equal((await runExternalClient({ ...options, origin })).status, "completed");
  assert.equal(calls.length, 3);
});

test("non-retryable rejection is returned once with recovery identifiers", async (t) => {
  const { origin, calls } = await fixture(t, (_req, res) => {
    res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: "event conflict" }));
  });
  await assert.rejects(runExternalClient({ ...options, origin }), { code: "HTTP_ERROR", statusCode: 409, eventId: options.eventId, runId: null });
  assert.equal(calls.length, 1);
});

test("heartbeat and event cursors expose progress even without a status change", async (t) => {
  const { origin, calls } = await fixture(t, (_req, res, count) => {
    res.end(JSON.stringify({ ...reply(count < 3 ? "running" : "completed"), eventCursor: count, eventGap: count === 2, events: [{ seq: count, type: "status" }] }));
  });
  const progress = [];
  const statuses = [];
  await runExternalClient({ ...options, origin, command: "heartbeat", wait: true, onStatus: (run) => statuses.push(run.status), onProgress: (snapshot) => progress.push(snapshot) });
  assert.match(calls[0].url, /\/heartbeat$/);
  assert.deepEqual(calls.slice(1).map((call) => call.url), ["/api/automations/research/runs/run-1?after=1", "/api/automations/research/runs/run-1?after=2"]);
  assert.deepEqual(statuses, ["running", "completed"]);
  assert.deepEqual(progress.map((snapshot) => snapshot.eventCursor), [1, 2, 3]);
  assert.equal(progress[1].eventGap, true);
});

test("the deadline covers the initial request and prevents retry after Retry-After", async (t) => {
  const { origin, calls } = await fixture(t, (_req, res) => { res.statusCode = 429; res.setHeader("Retry-After", new Date(Date.now() + 60_000).toUTCString()); res.end("{}"); });
  const started = Date.now();
  await assert.rejects(runExternalClient({ ...options, origin, timeoutMs: 80 }), { code: "TIMEOUT", eventId: options.eventId, runId: null });
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls.length, 1);
});

test("a hanging response is bounded by the total deadline", async (t) => {
  const { origin } = await fixture(t, () => {});
  const started = Date.now();
  await assert.rejects(runExternalClient({ ...options, origin, timeoutMs: 80 }), { code: "TIMEOUT" });
  assert.ok(Date.now() - started < 1000);
});

test("individual request timeout retries a response whose body hangs", async (t) => {
  const { origin, calls } = await fixture(t, (_req, res, count) => {
    if (count === 1) { res.writeHead(200); return res.write('{"ok":'); }
    res.end(JSON.stringify(reply()));
  });
  assert.equal((await runExternalClient({ ...options, origin, requestTimeoutMs: 50, timeoutMs: 2000 })).status, "completed");
  assert.equal(calls.length, 2);
});

test("abort and local polling timeout retain the run but never cancel it", async (t) => {
  const { origin, calls } = await fixture(t, (_req, res) => res.end(JSON.stringify(reply("running"))));
  const controller = new AbortController();
  await assert.rejects(runExternalClient({ ...options, origin, wait: true, signal: controller.signal, onStatus: () => controller.abort() }), { code: "ABORTED", runId: "run-1" });
  await assert.rejects(runExternalClient({ ...options, origin, wait: true, timeoutMs: 80, pollMs: 5000 }), { code: "TIMEOUT", runId: "run-1" });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !call.url.includes("/cancel")));
});

test("bad successful responses and mismatched runs are not treated as completion", async (t) => {
  let payload;
  const { origin, calls } = await fixture(t, (_req, res) => res.end(typeof payload === "string" ? payload : JSON.stringify(payload)));
  for (payload of ["not JSON", { ok: false }, reply("unknown"), reply("completed", { automationId: "other" }), reply("completed", { id: {} }), { ...reply(), eventCursor: -1 }]) {
    await assert.rejects(runExternalClient({ ...options, origin }), { code: "INVALID_RESPONSE" });
  }
  payload = reply("completed", { id: "wrong-run" });
  await assert.rejects(runExternalClient({ ...options, origin, command: "status", runId: "run-1" }), { code: "INVALID_RESPONSE", runId: "run-1" });
  assert.equal(calls.length, 7);
});

test("redirects never forward tokens or resubmit the task", async (t) => {
  const sink = await fixture(t, (_req, res) => res.end(JSON.stringify(reply())));
  const { origin, calls } = await fixture(t, (_req, res) => { res.statusCode = 307; res.setHeader("Location", sink.origin); res.end(); });
  await assert.rejects(runExternalClient({ ...options, origin }), { code: "INVALID_RESPONSE", statusCode: 307 });
  assert.equal(calls.length, 1);
  assert.equal(sink.calls.length, 0);
});

test("asynchronous progress persistence is awaited, rejected hooks preserve the run, and hanging hooks are bounded", async (t) => {
  const { origin, calls } = await fixture(t, (_req, res) => res.end(JSON.stringify(reply())));
  let saved = false;
  await runExternalClient({ ...options, origin, onProgress: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5)); saved = true;
  } });
  assert.equal(saved, true);
  await assert.rejects(runExternalClient({ ...options, origin, onProgress: async () => { throw new Error("storage failed"); } }), { message: "storage failed", runId: "run-1" });
  await assert.rejects(runExternalClient({ ...options, origin, timeoutMs: 80, onProgress: () => new Promise(() => {}) }), { code: "TIMEOUT", runId: "run-1" });
  assert.equal(calls.length, 3);
});

test("unsafe origins and invalid budgets fail before making any request", async () => {
  for (const origin of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret"]) {
    await assert.rejects(runExternalClient({ ...options, origin }), /HTTPS origin/);
  }
  for (const invalid of [{ timeoutMs: 0 }, { timeoutMs: NaN }, { pollMs: -1 }, { requestTimeoutMs: Infinity }, { maxRetries: 10 }, { input: [] }]) {
    await assert.rejects(runExternalClient({ ...options, origin: "https://example.com", ...invalid }));
  }
});

test("persistent temporary failures stop at the retry cap without changing the event", async (t) => {
  const { origin, calls } = await fixture(t, (_req, res) => { res.statusCode = 503; res.setHeader("Retry-After", "0"); res.end("{}"); });
  await assert.rejects(runExternalClient({ ...options, origin }), { code: "HTTP_ERROR", statusCode: 503, eventId: options.eventId });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.key === options.eventId));
});
