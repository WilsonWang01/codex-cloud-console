import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withPublicationLock } from "../server/publication-lock.mjs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openRunUsageLedger } from "../server/run-usage-ledger.mjs";
import { createExternalTaskStore, createExternalTaskOwner } from "../server/external-task-store.mjs";

const time = Date.parse("2026-10-23T00:00:00Z");
const task = (id, clientId = "client-a") => ({ id, clientId, automationId: "research", repoId: "repo", status: "queued", startedAt: new Date(time).toISOString(), triggerIdempotencyHash: "a".repeat(64), triggerRequestHash: "b".repeat(64), events: [], eventSeq: 0 });
const options = (id, client) => ({ run: task(id, client), execution: { prompt: "private queued input" }, keyHash: id.padEnd(64, "a").slice(0, 64), requestHash: "b".repeat(64), ttlMs: 10000 });
async function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-external-tasks-"));
  let clock = time;
  const ledger = openRunUsageLedger(path.join(root, "run-usage.sqlite"));
  const store = createExternalTaskStore(ledger.database, { now: () => clock, ownerAlive: () => false });
  try { return await callback({ store, ledger, root, advance: (ms) => { clock += ms; } }); }
  finally { ledger.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test("acceptance and idempotency commit together; changed input conflicts and failed admission leaves no reservation", () => fixture(({ store }) => {
  const input = options("1");
  assert.throws(() => store.accept({ ...input, check() { throw new Error("budget exceeded"); } }), /budget/);
  assert.equal(store.runs().length, 0);
  assert.equal(store.lookup(input.keyHash, input.requestHash), null);
  const accepted = store.accept(input);
  assert.equal(accepted.deduplicated, false);
  assert.equal(store.accept({ ...input, run: task("new") }).run.id, "1");
  assert.throws(() => store.accept({ ...input, requestHash: "c".repeat(64) }), { statusCode: 409 });
  assert.equal(store.runs().length, 1);
}));

test("queue limits reject only new acceptance; claims enforce global and per-client limits", () => fixture(({ store }) => {
  store.accept({ ...options("1"), maxQueued: 2 });
  store.accept({ ...options("2"), maxQueued: 2 });
  assert.throws(() => store.accept({ ...options("3"), maxQueued: 2 }), { statusCode: 429 });
  assert.equal(store.accept({ ...options("1"), maxQueued: 2 }).deduplicated, true);
  const first = store.claim({ owner: "worker-a", maxGlobal: 2, maxPerClient: 1 });
  assert.equal(first.run.id, "1");
  assert.equal(store.claim({ owner: "worker-b", maxGlobal: 2, maxPerClient: 1 }), null);
  store.accept(options("3", "client-b"));
  assert.equal(store.claim({ owner: "worker-b", maxGlobal: 2, maxPerClient: 1 }).run.id, "3");
  assert.equal(store.claim({ owner: "worker-c", maxGlobal: 2, maxPerClient: 1 }), null);
}));

test("unclaimed tasks survive reopen; dead executions need reconciliation and old owners cannot overwrite", () => fixture(({ store, ledger }) => {
  store.accept(options("1")); store.accept(options("2", "client-b"));
  const claimed = store.claim({ owner: "old", pid: 12345 });
  const reopened = createExternalTaskStore(ledger.database, { now: () => time, ownerAlive: () => false });
  const changed = reopened.recover();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, "needs_reconciliation");
  assert.equal(reopened.read("2").status, "queued");
  assert.throws(() => store.update({ ...claimed.run, status: "completed" }, claimed.claim), { statusCode: 409 });
  assert.equal(reopened.claim({ owner: "new" }).run.id, "2");
  assert.equal(reopened.recover().filter((run) => run.id === "1").length, 0);
}));

test("live owners are never reclaimed and returning a claim increments its generation", () => fixture(({ store, ledger }) => {
  store.accept(options("1"));
  const claimed = store.claim({ owner: "one" });
  const observer = createExternalTaskStore(ledger.database, { now: () => time, ownerAlive: (pid, owner) => {
    assert.equal(pid, process.pid); assert.equal(owner, "one"); return true;
  } });
  assert.deepEqual(observer.recover(), []);
  store.release(claimed.run.id, claimed.claim);
  const replacement = store.claim({ owner: "two" });
  assert.ok(replacement.claim.epoch > claimed.claim.epoch);
  assert.throws(() => store.update({ ...claimed.run, status: "completed" }, claimed.claim), { statusCode: 409 });
}));

test("uncertain execution without a key is retained until explicitly reconciled", () => fixture(({ store }) => {
  store.accept({ ...options("1"), keyHash: null });
  store.claim({ owner: "exited" }); store.recover(); store.retain([]);
  assert.equal(store.read("1").status, "needs_reconciliation");
}));

test("Linux process identity distinguishes a reused PID from the original execution", { skip: process.platform !== "linux" }, () => fixture(({ ledger }) => {
  const store = createExternalTaskStore(ledger.database, { now: () => time });
  store.accept(options("1"));
  const original = createExternalTaskOwner();
  store.claim({ owner: original, pid: process.pid });
  assert.equal(store.recover().length, 0);
  ledger.database.prepare("UPDATE external_tasks SET owner=? WHERE id='1'").run("linux:different-boot:1:old-owner");
  assert.equal(store.recover()[0].status, "needs_reconciliation");
}));

test("canceling unclaimed work prevents execution and records zero only when it never started", () => fixture(({ store }) => {
  store.accept(options("1"));
  assert.throws(() => store.cancel("1", { id: "other", automationId: "research" }, {}), { statusCode: 404 });
  const result = store.cancel("1", { id: "client-a", automationId: "research" }, { type: "cancel-requested" });
  assert.equal(result.pending, false);
  assert.equal(result.run.status, "canceled");
  assert.equal(result.run.usage.totalTokens, 0);
  assert.equal(store.claim({ owner: "one" }), null);
  store.accept(options("2"));
  const claimed = store.claim({ owner: "one" });
  assert.equal(store.cancel("2", { id: "client-a", automationId: "research" }, {}).pending, true);
  store.release("2", claimed.claim);
  assert.equal(store.read("2").status, "canceled");
  store.accept(options("3"));
  const rejected = store.claim({ owner: "one" });
  store.cancel("3", { id: "client-a", automationId: "research" }, {});
  store.update({ ...store.read("3"), status: "canceled", error: "client revoked before execution",
    usage: { status: "complete", source: "not-started", inputTokens: 0, outputTokens: 0, totalTokens: 0 } }, rejected.claim);
  assert.equal(store.read("3").status, "canceled");
  assert.equal(store.claim({ owner: "next" }), null);
}));

test("terminal retries cannot rewrite results; retained keys outlive history pruning until expiry", () => fixture(({ store, ledger, advance }) => {
  const input = options("1"); store.accept(input);
  const claimed = store.claim({ owner: "one" });
  store.update({ ...claimed.run, status: "completed", summary: "original" }, claimed.claim);
  assert.equal(store.update({ ...claimed.run, status: "failed", summary: "stale" }, claimed.claim).summary, "original");
  const raw = ledger.database.prepare("SELECT execution FROM external_tasks WHERE id='1'").get();
  assert.equal(raw.execution, "{}");
  store.retain([]);
  assert.equal(store.lookup(input.keyHash, input.requestHash).id, "1");
  advance(10001); store.retain([]);
  assert.equal(store.read("1"), null);
  assert.equal(store.lookup(input.keyHash, input.requestHash), null);
}));

test("pending and uncertain work keeps its original key beyond the nominal TTL", () => fixture(({ store, advance }) => {
  const input = options("1"); store.accept(input);
  advance(20000);
  assert.equal(store.accept(input).deduplicated, true);
  const claim = store.claim({ owner: "exited", pid: 12345 });
  store.recover(); store.retain([]);
  advance(20000);
  assert.equal(store.accept({ ...input, run: task("other") }).run.id, claim.run.id);
  assert.throws(() => store.accept({ ...input, requestHash: "c".repeat(64) }), { statusCode: 409 });
}));

test("unknown task schema is not rewritten", () => fixture(({ ledger }) => {
  ledger.database.exec("UPDATE external_tasks_meta SET value=2 WHERE key='schema_version'; DELETE FROM external_tasks_meta WHERE key='revision'");
  const before = ledger.database.prepare("SELECT * FROM external_tasks_meta").all();
  assert.throws(() => createExternalTaskStore(ledger.database), /Unsupported/);
  assert.deepEqual(ledger.database.prepare("SELECT * FROM external_tasks_meta").all(), before);
}));

test("separate processes accept one run for the same key and recover an exited execution without replay", () => fixture(async ({ ledger, root }) => {
  const file = path.join(root, "run-usage.sqlite");
  const source = `
    import {openRunUsageLedger} from ${JSON.stringify(new URL("../server/run-usage-ledger.mjs", import.meta.url).href)};
    import {createExternalTaskStore} from ${JSON.stringify(new URL("../server/external-task-store.mjs", import.meta.url).href)};
    const ledger=openRunUsageLedger(process.argv[1]);
    const store=createExternalTaskStore(ledger.database,{now:()=>${time}});
    const input=JSON.parse(process.argv[2]);
    const result=input.claim ? store.claim({owner:"exited-process"}) : store.accept(input);
    console.log(JSON.stringify(result));ledger.close();
  `;
  const execute = async (input) => JSON.parse((await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, file, JSON.stringify(input)], { timeout: 10000 })).stdout);
  const one = options("1"), two = { ...options("2"), keyHash: one.keyHash };
  const accepted = await Promise.all([execute(one), execute(two)]);
  assert.equal(new Set(accepted.map((result) => result.run.id)).size, 1);
  assert.equal(accepted.filter((result) => result.deduplicated).length, 1);
  const claim = await execute({ claim: true });
  const current = createExternalTaskStore(ledger.database, { now: () => time });
  assert.equal(current.recover()[0].status, "needs_reconciliation");
  assert.equal(current.claim({ owner: "replacement" }), null);
  assert.throws(() => current.update({ ...claim.run, status: "completed" }, claim.claim), { statusCode: 409 });
}));

test("rollback rejects incompatible releases without altering task data", () => fixture(async ({ store, root }) => {
  const previous = path.join(root, "previous"); fs.mkdirSync(path.join(previous, "server"), { recursive: true });
  const script = new URL("../ops/check-task-rollback.mjs", import.meta.url).pathname;
  const execute = () => promisify(execFile)(process.execPath, [script, root, previous], { timeout: 10000 });
  await execute();
  store.accept(options("1"));
  await assert.rejects(execute, /不能自动退回/);
  assert.equal(store.runs().length, 1);
  fs.writeFileSync(path.join(previous, "server/external-task-store.mjs"), "export const externalTaskSchemaVersion = 1;");
  await execute();
  fs.writeFileSync(path.join(previous, "server/external-task-store.mjs"), "export const externalTaskSchemaVersion = 2;");
  await assert.rejects(execute, /不能自动退回/);
  assert.equal(store.runs().length, 1);
}));

test("consistent backup preserves queued input, idempotency keys and execution generations together", () => fixture(async ({ store, ledger, root }) => {
  store.accept(options("1")); store.accept(options("2", "client-b"));
  store.claim({ owner: "backup-fixture" });
  const destination = path.join(root, "restored.sqlite");
  const result = await promisify(execFile)(process.execPath, [new URL("../ops/backup-usage-ledger.mjs", import.meta.url).pathname, path.join(root, "run-usage.sqlite"), destination]);
  assert.equal(JSON.parse(result.stdout).externalTaskRows, 2);
  const restored = new DatabaseSync(destination, { readOnly: true });
  try {
    for (const table of ["external_tasks", "external_task_keys", "external_tasks_meta"]) {
      assert.deepEqual(JSON.parse(JSON.stringify(restored.prepare(`SELECT * FROM ${table}`).all())), JSON.parse(JSON.stringify(ledger.database.prepare(`SELECT * FROM ${table}`).all())));
    }
  } finally { restored.close(); }
}));

test("Linux publication locks block acceptance during deployment and release after failure", { skip: process.platform !== "linux" }, () => fixture(async ({ root }) => {
  const file = path.join(root, "release.lock"); fs.writeFileSync(file, "");
  const writer = spawn("flock", ["--exclusive", file, process.execPath, "-e", "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolve) => writer.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Publication writer did not start")), 3000);
      writer.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      writer.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    let called = false;
    await assert.rejects(() => withPublicationLock(file, () => { called = true; }), { statusCode: 503 });
    assert.equal(called, false);
  } finally { writer.stdin.end(); await closed; }
  await assert.rejects(() => withPublicationLock(file, () => { throw new Error("task failure"); }), /task failure/);
  assert.equal(await withPublicationLock(file, () => 42), 42);
}));
