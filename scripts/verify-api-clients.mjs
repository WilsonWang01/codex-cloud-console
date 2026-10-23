import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
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
  await store.record({ clientId: "a", automationId: "research", trigger: "result", status: 200, runId: "run-1", time });
  await store.record({ clientId: "b", automationId: "research", trigger: "result", status: 404, time });
  await store.record({ clientId: "a", automationId: "research", trigger: "cancel", status: 202, runId: "run-1", time });
  await store.record({ clientId: "b", automationId: "research", trigger: "webhook", status: 429, time });
  await store.record({ clientId: "a", automationId: "research", trigger: "discovery", status: 200, time });
  const result = await store.usage({ from: Date.parse("2026-09-26T06:00:00Z"), to: Date.parse("2026-09-26T07:00:00Z") });
  assert.deepEqual(result.buckets.map(({ clientId, requests, accepted, errors, replayed, polls, pollErrors, controls }) => ({ clientId, requests, accepted, errors, replayed, polls, pollErrors, controls })), [
    { clientId: "a", requests: 2, accepted: 1, errors: 0, replayed: 1, polls: 1, pollErrors: 0, controls: 1 },
    { clientId: "b", requests: 1, accepted: 0, errors: 1, replayed: 0, polls: 1, pollErrors: 1, controls: 0 },
  ]);
  assert.equal(JSON.stringify(state).includes("prompt"), false);
  assert.equal(result.buckets.find((item) => item.clientId === "a").discovery, 1);
  const log = await fs.readFile(path.join(root, "metrics", "2026-09-26.ndjson"), "utf8");
  assert.equal(log.includes("prompt"), false);
  assert.equal(log.trim().split("\n").length, 7);
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

test("full-window summaries are independent of recent-row limits and HTTP wait outcomes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-metric-summary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const row = { id: "request", clientId: "a", automationId: "research", trigger: "webhook", status: 200, runId: "run", time: "2026-09-26T14:10:00+08:00" };
  const rows = Array.from({ length: 1400 }, (_, index) => ({ ...row, id: `request-${index}`, durationMs: index,
    deduplicated: index % 10 === 0, status: [504, 499, 502][index - 1] || 200 }));
  rows.push({ ...row, id: "poll", trigger: "result", status: 404, durationMs: -1 },
    { ...row, id: "discovery", trigger: "discovery", status: 403, durationMs: 8 },
    { ...row, id: "control", trigger: "cancel", status: 409, durationMs: 9 },
    { ...row, id: "rejected", status: 429, runId: null, durationMs: 10 },
    { ...row, id: "other", clientId: "b" }, { ...row, id: "outside", time: "2026-09-26T07:00:00Z" },
    { ...row, status: "200" }, { ...row, time: "invalid" }, null);
  await fs.writeFile(path.join(root, "2026-09-26.ndjson"), rows.map(row => JSON.stringify(row)).join("\n"));
  const store = createApiClientStore({ read: async () => ({ clients: [] }), write: async () => {}, metricsRoot: root });
  const result = await store.usage({ from: Date.parse("2026-09-26T06:00:00Z"), to: Date.parse("2026-09-26T07:00:00Z"), clientId: "a" });
  assert.equal(result.requests.length, 500);
  assert.equal(result.requests[0].id, "rejected");
  assert.equal(result.requests.at(-1).id, "request-904");
  assert.equal(result.requests[0].time, "2026-09-26T06:10:00.000Z");
  assert.equal(result.droppedRequests, 3);
  const groups = Object.fromEntries(result.requestSummary.groups.map(group => [group.kind, group]));
  assert.deepEqual(groups.submit, { kind: "submit", requests: 1401, errors: 4, accepted: 1260, replayed: 140,
    duration: { samples: 1401, p50Ms: 699, p95Ms: 1329 } });
  assert.equal(groups.poll.requests, 1);
  assert.deepEqual(groups.poll.duration, { samples: 0, p50Ms: null, p95Ms: null });
  assert.equal(result.requests.find(row => row.id === "poll").durationMs, null);
  assert.deepEqual(Object.fromEntries(result.requestSummary.errorTypes.map(row => [row.type, row.count])), {
    wait_ended: 2, service_error: 1, unavailable_object: 1, authorization: 1, conflict: 1, rate_limited: 1,
  });
  assert.equal(result.buckets[0].accepted, 1260);
  assert.equal(result.buckets[0].discovery, 1);
  assert.equal(JSON.stringify(result).includes('"clientId":"b"'), false);
});

test("metric scans reject unsafe file types and honor cancellation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-metric-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "2026-09-26.ndjson");
  const store = createApiClientStore({ read: async () => ({ clients: [] }), write: async () => {}, metricsRoot: root });
  const range = { from: Date.parse("2026-09-26T00:00:00Z"), to: Date.parse("2026-09-27T00:00:00Z") };
  await fs.mkdir(filename);
  await assert.rejects(store.usage(range), /普通文件/);
  await fs.rmdir(filename);
  await fs.writeFile(path.join(root, "source"), "secret");
  await fs.symlink(path.join(root, "source"), filename);
  await assert.rejects(store.usage(range), { code: "ELOOP" });
  await fs.unlink(filename);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [filename]);
    await assert.rejects(store.usage(range), /普通文件/);
    await fs.unlink(filename);
  }
  const line = JSON.stringify({ id: "test", clientId: "a", automationId: "research", trigger: "result", status: 200, time: "2026-09-26T06:00:00Z" });
  await fs.writeFile(filename, `${line}\n`.repeat(20_000));
  const controller = new AbortController();
  const scan = store.usage({ ...range, signal: controller.signal });
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(scan, { name: "AbortError" });
  assert.equal((await store.usage(range)).requestSummary.groups[0].requests, 20_000);
  await assert.rejects(store.usage({ ...range, signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("client policy updates are scoped, versioned, bounded and preserve existing tokens", async () => {
  let state = { clients: [] }, clock = Date.parse("2026-10-23T06:00:00Z");
  const store = createApiClientStore({ read: async () => structuredClone(state), write: async next => { state = structuredClone(next); }, concurrencyCeiling: 2, now: () => clock });
  const created = await store.create({ name: "bounded", automationIds: ["research"], maxConcurrent: 1, dailyKnownTokenLimit: 500, expiresAt: "2026-10-24T14:00:00+08:00" });
  assert.equal(created.client.expiresAt, "2026-10-24T06:00:00.000Z");
  const hash = state.clients[0].tokenHash;
  const changed = await store.updatePolicy(created.client.id, { expectedRevision: 0, dailyKnownTokenLimit: 1000, maxConcurrent: null });
  assert.equal(changed.policyRevision, 1);
  assert.equal(changed.maxConcurrent, null);
  assert.equal(changed.dailyKnownTokenLimit, 1000);
  assert.equal(state.clients[0].tokenHash, hash);
  assert.equal((await store.authenticate(created.token, "research")).policyRevision, 1);
  assert.equal(JSON.stringify(changed).includes(hash), false);
  await assert.rejects(store.updatePolicy(created.client.id, { expectedRevision: 0, dailyKnownTokenLimit: null }), { statusCode: 409 });
  for (const patch of [{ maxConcurrent: 3 }, { maxConcurrent: 0 }, { dailyKnownTokenLimit: "100" }, { expiresAt: "yesterday" }, { expiresAt: clock + 1000 }, { automationIds: ["other"] }]) {
    await assert.rejects(store.updatePolicy(created.client.id, { expectedRevision: 1, ...patch }), { statusCode: 400 });
  }
  const second = await store.create({ name: "other", automationIds: ["research"] });
  assert.equal((await store.list()).find(row => row.id === second.client.id).dailyKnownTokenLimit, null);
  clock += 2 * 86_400_000;
  assert.equal(await store.authenticate(created.token, "research"), null);
  const renewed = await store.updatePolicy(created.client.id, { expectedRevision: 1, expiresAt: "2026-10-26T06:00:00Z" });
  assert.equal(renewed.policyRevision, 2);
  assert.ok(await store.authenticate(created.token, "research"));
  await store.revoke(created.client.id);
  assert.equal((await store.list()).find(row => row.id === created.client.id).policyRevision, 3);
  await assert.rejects(store.updatePolicy(created.client.id, { expectedRevision: 3, expiresAt: null }), { statusCode: 409 });
});

test("legacy policy defaults do not rewrite state; malformed limits and expiry fail closed", async () => {
  let writes = 0;
  const row = { id: "legacy", name: "legacy", tokenHash: "0".repeat(64), automationIds: ["research"], expiresAt: null };
  const store = createApiClientStore({ read: async () => ({ clients: [row] }), write: async () => { writes++; } });
  assert.deepEqual((await store.list())[0], { id: "legacy", name: "legacy", automationIds: ["research"], expiresAt: null, policyRevision: 0, maxConcurrent: null, dailyKnownTokenLimit: null });
  assert.equal(writes, 0);
  for (const patch of [{ dailyKnownTokenLimit: -1 }, { maxConcurrent: "2" }, { policyRevision: -1 }, { expiresAt: "invalid" }]) {
    const damaged = createApiClientStore({ read: async () => ({ clients: [{ ...row, ...patch }] }), write: async () => {} });
    await assert.rejects(damaged.list(), { statusCode: 503 });
  }
  for (const state of [{ version: 2, clients: [] }, { clients: "damaged" }, { clients: [row, row] }]) {
    const damaged = createApiClientStore({ read: async () => state, write: async () => { throw new Error("must not overwrite damaged state"); } });
    await assert.rejects(damaged.create({ name: "new", automationIds: ["research"] }), { statusCode: 503 });
  }
});

test("rollback never drops client policy enforcement, including deployments without a task database", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-client-policy-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state"), previous = path.join(root, "previous");
  await fs.mkdir(state); await fs.mkdir(path.join(previous, "server"), { recursive: true });
  const filename = path.join(state, "api-clients.json"), saved = JSON.stringify({ version: 1, clients: [{ id: "a", maxConcurrent: 1, dailyKnownTokenLimit: 100 }] });
  await fs.writeFile(filename, saved);
  const script = new URL("../ops/check-task-rollback.mjs", import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [script, state, previous], { stdio: "pipe" }), error => error.status === 1 && /调用方限制/.test(String(error.stderr)));
  assert.equal(await fs.readFile(filename, "utf8"), saved);
  await fs.writeFile(path.join(previous, "server/api-clients.mjs"), "export const apiClientPolicyVersion = 1;\n");
  execFileSync(process.execPath, [script, state, previous], { stdio: "pipe" });
  assert.equal(await fs.readFile(filename, "utf8"), saved);
});
