import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createExternalTaskStore } from "../server/external-task-store.mjs";
import { createExternalResultStore, resultPath } from "../server/external-results.mjs";
import { createExternalResultHandler } from "../server/external-result-api.mjs";
import { externalApiToken } from "../server/external-auth.mjs";
import { isExternalApiPath } from "../server/external-api-paths.mjs";
import { openRunUsageLedger } from "../server/run-usage-ledger.mjs";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-result-api-"));
  let clock = Date.now();
  const ledger = openRunUsageLedger(path.join(root, "state.sqlite"));
  const tasks = createExternalTaskStore(ledger.database);
  const results = createExternalResultStore(ledger.database, path.join(root, "files"), { now: () => clock, retentionMs: 10000 });
  tasks.accept({ run: { id: "one", clientId: "a", automationId: "demo", status: "queued", startedAt: new Date().toISOString(), delivery: { status: "pending" } }, execution: {}, ttlMs: 10000,
    onAccepted: run => results.reserve(run) });
  const claim = tasks.claim({ owner: "owner" });
  let run = tasks.update({ ...claim.run, status: "running", threadId: "private-thread", turnId: "original-turn" }, claim.claim);
  const delivery = await results.capture(run, claim.claim, { text: "full result", files: [{ name: "报告.html", mimeType: "text/html", buffer: Buffer.from("<h1>download only</h1>"), provenance: "requested-path-changed-during-run" }] });
  run = tasks.update({ ...run, status: "completed", delivery }, claim.claim);
  const manifest = await results.manifest(run);
  const clients = new Map([["token-a", { id: "a" }], ["token-b", { id: "b" }]]);
  const metrics = [];
  let limit = 0;
  const app = express();
  const handle = createExternalResultHandler({ authenticate: async (req, token) => req.params.id === "demo" ? clients.get(token) : null,
    readRun: async id => tasks.read(id), results: () => results, rateLimit: () => limit, record: async metric => { metrics.push(metric); } });
  app.get("/api/automations/:id/runs/:runId/output", handle);
  app.get("/api/automations/:id/runs/:runId/output/files/:fileId", handle);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); ledger.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { results, tasks, clients, metrics, run, manifest, base, url: base + resultPath(run),
    expire() { clock += 10001; }, limit() { limit = 5; } };
}

test("HTTP clients retrieve an exact-turn manifest and hash-verified attachment without server paths", async t => {
  const f = await fixture(t);
  for (const headers of [{ authorization: "Bearer token-a" }, { "x-api-key": "token-a" }, { "x-codex-cloud-token": "token-a" }]) {
    const response = await fetch(f.url, { headers });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result.text, "full result");
    assert.equal(data.result.turnId, "original-turn");
    assert.equal(JSON.stringify(data).includes("private-thread"), false);
    assert.equal(JSON.stringify(data).includes(os.tmpdir()), false);
    const artifact = data.result.artifacts[0];
    const downloaded = await fetch(f.base + artifact.downloadPath, { headers });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
    assert.match(downloaded.headers.get("content-disposition"), /^attachment;/);
    assert.match(downloaded.headers.get("content-disposition"), /%E6%8A%A5%E5%91%8A.html/);
    assert.equal(downloaded.headers.get("content-security-policy"), "sandbox");
    assert.equal(downloaded.headers.get("cache-control"), "no-store");
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    const buffer = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(buffer.toString(), "<h1>download only</h1>");
    assert.equal(downloaded.headers.get("x-content-sha256"), createHash("sha256").update(buffer).digest("hex"));
  }
  assert.equal(f.metrics.length, 6);
  assert.equal(f.metrics.every(metric => metric.clientId === "a" && metric.trigger === "result"), true);
});

test("unauthorized, conflicting, wrong-scope and cross-client requests never retrieve a file", async t => {
  const f = await fixture(t);
  for (const headers of [{}, { authorization: "Basic invalid" }, { authorization: "Bearer invalid" },
    { authorization: "Bearer token-a", "x-codex-cloud-token": "token-b" }, { authorization: "Bearer token-a", "x-api-key": "token-b" }]) {
    assert.equal((await fetch(f.url, { headers })).status, 401);
  }
  assert.equal((await fetch(f.url, { headers: { authorization: "Bearer token-b" } })).status, 404);
  assert.equal((await fetch(f.url.replace("/demo/", "/other/"), { headers: { authorization: "Bearer token-a" } })).status, 401);
  assert.equal((await fetch(f.url + "?path=/etc/passwd", { headers: { authorization: "Bearer token-a" } })).status, 400);
  assert.equal((await fetch(f.url + "/files/unknown", { headers: { authorization: "Bearer token-a" } })).status, 404);
  assert.equal((await fetch(f.url + "/files/" + f.run.delivery.id, { headers: { authorization: "Bearer token-a" } })).status, 404);
  f.limit();
  const throttled = await fetch(f.url, { headers: { authorization: "Bearer token-a" } });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "5");
});

test("expiry and revocation during an asynchronous read fail before sending attachment bytes", async t => {
  const f = await fixture(t);
  const read = f.results.file;
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.results.file = async (...args) => { entered(); await gate; return read(...args); };
  const request = fetch(f.base + f.manifest.artifacts[0].downloadPath, { headers: { authorization: "Bearer token-a" } });
  await started;
  f.clients.delete("token-a"); release();
  const response = await request;
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes("download only"), false);
  f.clients.set("token-a", { id: "a" });
  f.expire();
  assert.equal((await fetch(f.url, { headers: { authorization: "Bearer token-a" } })).status, 410);
});

test("shared token parsing rejects conflicting identities and keeps explicit legacy Basic compatibility", () => {
  const req = headers => ({ get: name => headers[name] });
  assert.equal(externalApiToken(req({})), null);
  assert.equal(externalApiToken(req({ authorization: "Bearer a", "x-codex-cloud-token": "a", "x-api-key": "a" })), "a");
  assert.throws(() => externalApiToken(req({ authorization: "Bearer a", "x-codex-cloud-token": "b" })), { statusCode: 401 });
  assert.throws(() => externalApiToken(req({ authorization: "Basic x", "x-codex-cloud-token": "a" })), { statusCode: 401 });
  assert.equal(externalApiToken(req({ authorization: "Basic x", "x-codex-cloud-token": "a" }), { allowLegacyBasic: true }), "a");
});

test("external relay paths are exact and do not include admin interfaces or arbitrary suffixes", () => {
  for (const suffix of ["webhook", "heartbeat", "runs/one", "runs/one/cancel", "runs/one/output", "runs/one/output/files/id", "v1/models", "v1/capabilities", "v1/responses"]) {
    assert.equal(isExternalApiPath(`/api/automations/demo/${suffix}`), true);
  }
  for (const url of ["/api/clients", "/api/automations/runs", "/api/automations/demo/run", "/api/automations/demo/runs/one/output/admin", "/api/automations/demo/runs/one/output/files/id/more", "/api/codex/models"]) assert.equal(isExternalApiPath(url), false);
});
