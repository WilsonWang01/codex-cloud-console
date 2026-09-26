import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { runExternalClient } from "./external-client-example.mjs";

test("reference client submits with a stable event key, polls its result and cancels only explicitly", async (t) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, token: req.headers["x-codex-cloud-token"], key: req.headers["idempotency-key"] });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/automations/research/webhook") return res.end(JSON.stringify({ ok: true, run: { id: "run-1", status: "running" } }));
    if (req.url === "/api/automations/research/runs/run-1/cancel") return res.end(JSON.stringify({ ok: true, run: { id: "run-1", status: "canceling" } }));
    if (req.url === "/api/automations/research/runs/run-1") return res.end(JSON.stringify({ ok: true, run: { id: "run-1", status: "completed", usage: { status: "known", totalTokens: 12 } } }));
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const statusChanges = [];
  const run = await runExternalClient({ command: "submit", automationId: "research", eventId: "business-event-123", origin, token: "test-secret", wait: true, pollMs: 1, onStatus: (item) => statusChanges.push(item.status) });
  assert.equal(run.status, "completed");
  assert.deepEqual(statusChanges, ["running", "completed"]);
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${url}`), [
    "POST /api/automations/research/webhook",
    "GET /api/automations/research/runs/run-1",
  ]);
  assert.equal(calls[0].key, "business-event-123");
  assert.ok(calls.every((call) => call.token === "test-secret"));
  await runExternalClient({ command: "cancel", automationId: "research", runId: "run-1", origin, token: "test-secret" });
  assert.equal(calls.at(-1).method, "POST");
  assert.match(calls.at(-1).url, /\/cancel$/);
  await assert.rejects(runExternalClient({ command: "submit", automationId: "research", eventId: "short", origin, token: "test-secret" }), /event-id/);
});
