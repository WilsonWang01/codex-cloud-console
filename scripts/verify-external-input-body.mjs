import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import http from "node:http";
import { gzipSync } from "node:zlib";
import express from "express";
import { createExternalBodyParser } from "../server/external-input-body.mjs";
import { createModelApiHandler } from "../server/model-api.mjs";

async function fixture(t, route, options = {}, protocol) {
  const metrics = [];
  const app = express(), parse = createExternalBodyParser({ limit: 1024, timeoutMs: 2000, record: async row => { metrics.push(row); }, ...options });
  app.use((req, res, next) => parse(req, res, next, { clientId: req.get("x-test-client") || "a", protocol }));
  app.post("/", route);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body = "{}", headers = {}) => fetch(origin, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { server, origin, post, metrics };
}

test("bad media, compressed, malformed and oversized bodies release their admission without routing", async t => {
  let routed = 0;
  const f = await fixture(t, (req, res) => { routed++; assert.deepEqual(req.body, {}); res.json({ ok: true }); });
  for (const [body, headers, status] of [["{}", { "content-type": "text/plain" }, 415], ["{", {}, 400],
    [JSON.stringify({ x: "x".repeat(1024) }), {}, 413], [gzipSync("{}"), { "content-encoding": "gzip" }, 415]]) {
    const bad = await f.post(body, headers); assert.equal(bad.status, status);
    assert.equal((await f.post()).status, 200);
  }
  assert.equal(routed, 4);
  assert.deepEqual(f.metrics.map(row => row.status), [415, 400, 413, 415]);
  assert.ok(f.metrics.every(row => row.runId === null));
});

test("aborted or timed-out body reads release only after parsing has settled", async t => {
  const f = await fixture(t, (_req, res) => res.json({ ok: true }), { timeoutMs: 300 });
  for (const abort of [true, false]) {
    const incoming = once(f.server, "request");
    const request = http.request(f.origin, { method: "POST", headers: { "content-type": "application/json", "content-length": "100" } });
    const failed = new Promise(resolve => request.once("error", resolve));
    request.write("{");
    const [serverRequest] = await incoming;
    assert.equal((await f.post()).status, 429);
    const ended = new Promise(resolve => serverRequest.once("aborted", resolve));
    if (abort) request.destroy();
    await ended; await failed;
    assert.equal((await f.post()).status, 200);
  }
});

test("a disconnected model waiter retains its input slot until actual task acceptance settles", async t => {
  let accepted, finish, released;
  const entered = new Promise(resolve => { accepted = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const releaseObserved = new Promise(resolve => { released = resolve; });
  t.after(() => finish());
  const handler = createModelApiHandler({ authenticate: async () => ({ id: "a" }),
    submit: async req => {
      const release = req.releaseInputBody;
      req.releaseInputBody = () => { release(); released(); };
      accepted(); await gate;
      assert.ok(req.body, "aborting the waiter must not discard an input still being accepted");
      return { run: { id: "one", status: "queued", model: "gpt-6-sol", startedAt: new Date().toISOString(), resultPath: "/runs/one" } };
    }, snapshot: async () => ({ id: "one", status: "completed", summary: "ok" }), record: async () => {}, timeoutMs: 1000,
  });
  const f = await fixture(t, (req, res) => handler(req, res, "openai"), {}, "openai");
  const controller = new AbortController();
  const body = JSON.stringify({ model: "gpt-6-sol", messages: [{ role: "user", content: "test" }] });
  const first = fetch(f.origin, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture", "idempotency-key": "body-fixture-0001" }, body, signal: controller.signal }).catch(() => null);
  await entered;
  const busy = await f.post();
  assert.equal(busy.status, 429); assert.equal(busy.headers.get("retry-after"), "1");
  controller.abort(); await first;
  assert.equal((await f.post()).status, 429, "a disconnected but unresolved submission still owns its input slot");
  finish(); await releaseObserved;
  assert.notEqual((await f.post()).status, 429);
});
