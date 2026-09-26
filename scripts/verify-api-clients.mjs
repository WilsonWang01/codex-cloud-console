import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiClientStore } from "../server/api-clients.mjs";

test("client tokens are unique, scoped, revocable, and never listed in plaintext", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-clients-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let state = { clients: [] };
  let writes = 0;
  let clock = Date.parse("2026-09-26T06:10:00Z");
  const store = createApiClientStore({
    read: async () => structuredClone(state),
    write: async (next) => { writes += 1; state = structuredClone(next); },
    metricsRoot: path.join(root, "metrics"),
    now: () => clock,
  });
  const first = await store.create({ name: "Research agent", automationIds: ["research"] });
  const second = await store.create({ name: "Maintenance bot", automationIds: ["maintenance"] });
  assert.notEqual(first.token, second.token);
  assert.ok(first.token.length > 40);
  assert.equal((await store.authenticate(first.token, "research"))?.id, first.client.id);
  await store.list();
  const writesAfterFirstUse = writes;
  for (let index = 0; index < 5; index += 1) await store.authenticate(first.token, "research");
  await store.list();
  assert.equal(writes, writesAfterFirstUse);
  clock += 60_000;
  await store.authenticate(first.token, "research");
  await store.list();
  assert.equal(writes, writesAfterFirstUse + 1);
  assert.equal(await store.authenticate(first.token, "maintenance"), null);
  assert.equal(await store.authenticate("wrong", "research"), null);
  const listed = await store.list();
  assert.equal(JSON.stringify(listed).includes(first.token), false);
  assert.equal(JSON.stringify(state).includes(first.token), false);
  await store.revoke(first.client.id);
  assert.equal(await store.authenticate(first.token, "research"), null);
  assert.equal((await store.authenticate(second.token, "maintenance"))?.id, second.client.id);
});

test("request curve separates accepted, errors, and replays without request bodies", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-metrics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let state = { clients: [] };
  const store = createApiClientStore({
    read: async () => structuredClone(state),
    write: async (next) => { state = structuredClone(next); },
    metricsRoot: path.join(root, "metrics"),
    now: () => Date.parse("2026-09-26T06:10:00Z"),
  });
  const time = "2026-09-26T06:10:00.000Z";
  await store.record({ clientId: "a", automationId: "research", trigger: "webhook", status: 200, runId: "run-1", time });
  await store.record({ clientId: "a", automationId: "research", trigger: "webhook", status: 200, runId: "run-1", deduplicated: true, time });
  await store.record({ clientId: "b", automationId: "research", trigger: "webhook", status: 429, time });
  const result = await store.usage({ from: Date.parse("2026-09-26T06:00:00Z"), to: Date.parse("2026-09-26T07:00:00Z") });
  assert.deepEqual(result.buckets.map(({ clientId, requests, accepted, errors, replayed }) => ({ clientId, requests, accepted, errors, replayed })), [
    { clientId: "a", requests: 2, accepted: 1, errors: 0, replayed: 1 },
    { clientId: "b", requests: 1, accepted: 0, errors: 1, replayed: 0 },
  ]);
  assert.equal(JSON.stringify(state).includes("prompt"), false);
  const log = await fs.readFile(path.join(root, "metrics", "2026-09-26.ndjson"), "utf8");
  assert.equal(log.includes("prompt"), false);
  assert.equal(log.trim().split("\n").length, 3);
});

test("partial metric lines are reported and do not swallow later requests", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-metric-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const metricsRoot = path.join(root, "metrics");
  await fs.mkdir(metricsRoot);
  await fs.writeFile(path.join(metricsRoot, "2026-09-26.ndjson"), '{"incomplete":', { mode: 0o600 });
  await fs.writeFile(path.join(metricsRoot, "2026-08-01.ndjson"), '\n{"old":true}', { mode: 0o600 });
  const store = createApiClientStore({
    read: async () => ({ clients: [] }),
    write: async () => {},
    metricsRoot,
    now: () => Date.parse("2026-09-26T06:10:00Z"),
  });
  await store.record({ clientId: "a", automationId: "research", trigger: "webhook", status: 200 });
  const result = await store.usage({ from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z") });
  assert.equal(result.requests.length, 1);
  assert.equal(result.droppedRequests, 1);
  await assert.rejects(fs.stat(path.join(metricsRoot, "2026-08-01.ndjson")), { code: "ENOENT" });
});
