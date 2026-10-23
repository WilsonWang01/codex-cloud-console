import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createExternalTaskStore } from "../server/external-task-store.mjs";
import { createExternalResultStore, resultLimits, normalizeArtifactPaths, artifactBaseline, requestedArtifacts, nativeSources } from "../server/external-results.mjs";
import { openRunUsageLedger } from "../server/run-usage-ledger.mjs";
import { summarizeDeliveryUsage } from "../server/delivery-usage.mjs";

const start = Date.parse("2026-10-23T00:00:00Z");
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, limits = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-results-"));
  let clock = start;
  const ledger = openRunUsageLedger(path.join(root, "state.sqlite"));
  const tasks = createExternalTaskStore(ledger.database, { now: () => clock, ownerAlive: () => false });
  const results = createExternalResultStore(ledger.database, path.join(root, "blobs"), { now: () => clock, retentionMs: 10000, ...limits });
  t.after(() => { ledger.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const accept = (id, clientId = "client-a") => tasks.accept({ run: { id, clientId, automationId: "demo", repoId: "repo", status: "queued",
    startedAt: new Date(clock).toISOString(), delivery: { status: "pending" } }, execution: {}, keyHash: hash(id), requestHash: hash("request-" + id), ttlMs: 10000,
    onAccepted: run => results.reserve(run),
  }).run;
  const begin = (id, clientId) => {
    accept(id, clientId);
    const claimed = tasks.claim({ owner: "worker", maxPerClient: 10 });
    assert.equal(claimed.run.id, id);
    const run = tasks.update({ ...claimed.run, status: "running", threadId: `thread-${id}`, turnId: `turn-${id}` }, claimed.claim);
    return { run, claim: claimed.claim };
  };
  const complete = async (id, output = {}, clientId) => {
    const { run, claim } = begin(id, clientId);
    const delivery = await results.capture(run, claim, { text: "complete output".repeat(500), ...output });
    return tasks.update({ ...run, delivery, status: "completed", finishedAt: new Date(clock).toISOString() }, claim);
  };
  return { root, ledger, tasks, results, accept, begin, complete, advance: ms => { clock += ms; } };
}

test("delivery usage scopes metadata, separates outcomes, and never reads or writes result files", async t => {
  const f = await fixture(t);
  const ready = await f.complete("ready", { files: [{ name: "report.md", mimeType: "text/markdown", buffer: Buffer.from("secret file contents"), provenance: "requested-path-changed-during-run" }] });
  const other = await f.complete("other", {}, "client-b");
  const failed = f.begin("failed");
  const failedRun = f.tasks.update({ ...failed.run, status: "failed", finishedAt: new Date(start).toISOString() }, failed.claim);
  const unresolved = f.begin("unresolved");
  const unknownRun = f.tasks.update({ ...unresolved.run, status: "needs_reconciliation" }, unresolved.claim);
  const queued = f.accept("queued");
  const legacy = { ...ready, id: "old-without-metadata" };
  const binding = { id: "secret-target", fingerprint: "a".repeat(64) };
  f.tasks.callbacks.reserve(ready, binding); f.tasks.callbacks.terminal(ready);
  const claim = f.tasks.callbacks.claim();
  assert.equal(claim.run_id, ready.id);
  f.tasks.callbacks.finish(claim, { ok: true, code: "http_204" });
  await f.results.sweep();
  const manifest = await f.results.manifest(ready);
  // The summary must not mistake metadata for verified bytes or fail on a missing blob.
  fs.unlinkSync(path.join(f.root, "blobs", manifest.artifacts[0].id + ".blob"));
  const changes = f.ledger.database.prepare("SELECT total_changes() AS n").get().n;
  const runs = [ready, other, failedRun, unknownRun, queued, legacy];
  const range = { from: start, to: start + 1, clientId: "client-a" };
  const view = summarizeDeliveryUsage(f.ledger.database, runs, range, { now: start });
  assert.equal(f.ledger.database.prepare("SELECT total_changes() AS n").get().n, changes);
  assert.equal(view.tasks, 5);
  assert.deepEqual(view.results, { ready: 1, preparing: 1, expired: 0, notDelivered: 1, notRetained: 0, untracked: 1, unknown: 1 });
  assert.equal(view.artifacts, 1);
  assert.equal(view.callbacks.delivered, 1); assert.equal(view.callbacks.notRetained, 3); assert.equal(view.callbacks.untracked, 1);
  assert.equal(view.attempts, 1); assert.equal(view.retries, 0);
  assert.equal(view.verification, "metadata_only");
  assert.equal(view.details.find(row => row.id === "ready").callback.lastCode, "http_204");
  for (const secret of ["secret file contents", "secret-target", binding.fingerprint, manifest.artifacts[0].sha256, manifest.artifacts[0].name, "report.md", f.root]) assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal(summarizeDeliveryUsage(f.ledger.database, runs, { ...range, clientId: "client-b" }, { now: start }).tasks, 1);
  assert.equal(summarizeDeliveryUsage(f.ledger.database, runs, { from: start - 1, to: start }, { now: start }).tasks, 0);
  assert.equal(summarizeDeliveryUsage(f.ledger.database, runs, { ...range, clientId: "no-client" }, { now: start }).tasks, 0);
});

test("delivery expiry and callback attempts use current snapshots without sweeping or replaying", async t => {
  const f = await fixture(t);
  const ready = await f.complete("ready");
  const binding = { id: "receiver", fingerprint: "b".repeat(64) };
  f.tasks.callbacks.reserve(ready, binding); f.tasks.callbacks.terminal(ready);
  f.tasks.callbacks.finish(f.tasks.callbacks.claim(), { code: "http_503" });
  const range = { from: start, to: start + 1 };
  let view = summarizeDeliveryUsage(f.ledger.database, [ready], range, { now: start });
  assert.equal(view.results.ready, 1); assert.equal(view.callbacks.pending, 1); assert.equal(view.retries, 0);
  assert.equal(view.details[0].callback.nextAttemptAt, new Date(start + 30000).toISOString());
  f.advance(30000);
  f.tasks.callbacks.finish(f.tasks.callbacks.claim(), { code: "http_400", retryable: false });
  view = summarizeDeliveryUsage(f.ledger.database, [ready], range, { now: start + 30000 });
  assert.equal(view.results.expired, 1); assert.equal(view.callbacks.failed, 1); assert.equal(view.attempts, 2); assert.equal(view.retries, 1);
  assert.equal(view.details[0].callback.nextAttemptAt, null);
  assert.equal(f.ledger.database.prepare("SELECT state FROM external_results").get().state, "ready");
  const db = f.ledger.database;
  db.prepare("UPDATE external_callbacks SET state='pending',expires_ms=?,next_ms=?").run(start, start);
  view = summarizeDeliveryUsage(db, [ready], range, { now: start + 1 });
  assert.equal(view.callbacks.failed, 1); assert.equal(view.details[0].callback.lastCode, "delivery_expired");
  assert.equal(db.prepare("SELECT state FROM external_callbacks").get().state, "pending");
});

test("delivery metadata conflicts and unavailable records remain unknown or unretained, not successful", async t => {
  const f = await fixture(t), ready = await f.complete("ready"), db = f.ledger.database;
  const range = { from: start, to: start + 1 };
  const original = db.prepare("SELECT record FROM external_results").get().record;
  const invalid = { ...JSON.parse(original), manifestId: "different" };
  for (const malformed of ["null", JSON.stringify({ ...JSON.parse(original), files: [null] })]) {
    db.prepare("UPDATE external_results SET record=?").run(malformed);
    assert.equal(summarizeDeliveryUsage(db, [ready], range, { now: start }).results.unknown, 1);
  }
  db.prepare("UPDATE external_results SET record=?").run(JSON.stringify(invalid));
  assert.equal(summarizeDeliveryUsage(db, [ready], range, { now: start }).results.unknown, 1);
  db.prepare("UPDATE external_results SET record=?,client_id='wrong-client'").run(original);
  assert.equal(summarizeDeliveryUsage(db, [ready], range, { now: start }).results.unknown, 1);
  db.prepare("DELETE FROM external_results").run();
  assert.equal(summarizeDeliveryUsage(db, [ready], range, { now: start }).results.notRetained, 1);
  const wrong = { ...ready, clientId: "other-owner" };
  const view = summarizeDeliveryUsage(db, [wrong], range, { now: start });
  assert.equal(view.results.unknown, 1); assert.equal(view.callbacks.unknown, 1);
  assert.throws(() => summarizeDeliveryUsage(db, [ready], range, { now: start, limit: 201 }));
});

test("delivery summaries cover the complete cohort while details are bounded and sorted", async t => {
  const f = await fixture(t), ready = await f.complete("ready");
  const runs = Array.from({ length: 450 }, (_, i) => ({ ...ready, id: `old-${i}`, executionStartedAt: new Date(start + i).toISOString() }));
  const view = summarizeDeliveryUsage(f.ledger.database, runs, { from: start + 10, to: start + 449 }, { now: start + 1000 });
  assert.equal(view.tasks, 439); assert.equal(view.results.untracked, 439); assert.equal(view.details.length, 200);
  assert.equal(view.details[0].id, "old-448"); assert.equal(view.details.at(-1).id, "old-249");
});

test("artifact requests reject system paths and only changed/new requested files are deliverable", async t => {
  const f = await fixture(t);
  const repo = path.join(f.root, "repo"); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "report.md"), "old content");
  assert.deepEqual(normalizeArtifactPaths(undefined), []);
  assert.deepEqual(normalizeArtifactPaths(["结果/report.md"]), ["结果/report.md"]);
  for (const value of [null, {}, ["/etc/passwd"], ["../outside.md"], [".env"], ["a/.secret.txt"], ["node_modules/a.txt"],
    ["a\\b.md"], ["C:/file.txt"], ["a/./b.txt"], ["a//b.txt"], ["report.exe"], ["a.txt", "a.txt"], Array(5).fill("a.md"), ["bad\n.txt"]]) {
    assert.throws(() => normalizeArtifactPaths(value), { statusCode: 400 });
  }
  const names = ["report.md", "new.md"], baseline = await artifactBaseline(repo, names);
  assert.equal(baseline["new.md"], null);
  await assert.rejects(requestedArtifacts(repo, ["report.md"], baseline), { code: "artifact_not_generated" });
  fs.writeFileSync(path.join(repo, "report.md"), "new content"); fs.writeFileSync(path.join(repo, "new.md"), "new file");
  const files = await requestedArtifacts(repo, names, baseline);
  assert.deepEqual(files.map(file => file.buffer.toString()), ["new content", "new file"]);
  const run = await f.complete("one", { files });
  fs.rmSync(repo, { recursive: true });
  const result = await f.results.manifest(run);
  assert.equal(result.text.length, 7500);
  assert.equal(result.artifacts.length, 2);
  assert.equal((await f.results.file(run, result.artifacts[0].id)).buffer.toString(), "new content");
  const metadata = f.ledger.database.prepare("SELECT record FROM external_results").get().record;
  assert.equal(metadata.includes("new content"), false);
  assert.equal(metadata.includes("base64"), false);
  assert.equal(JSON.stringify(result).includes(repo), false);
});

test("result storage, task insertion and idempotency reserve atomically; replay consumes no new capacity", async t => {
  const f = await fixture(t, { globalBytes: resultLimits.packageBytes, clientBytes: resultLimits.packageBytes });
  f.accept("one");
  assert.equal(f.results.info().reservedBytes, resultLimits.packageBytes);
  assert.equal(f.accept("one").id, "one");
  assert.equal(f.results.info().runs, 1);
  assert.throws(() => f.accept("two", "client-b"), { code: "result_storage_full" });
  assert.equal(f.tasks.read("two"), null);
  assert.equal(f.ledger.database.prepare("SELECT count(*) AS n FROM external_task_keys").get().n, 1);
  assert.equal(f.tasks.cancel("one", { id: "client-a", automationId: "demo" }, {}).run.delivery.status, "failed");
  await f.results.sweep();
  assert.equal(f.results.info().reservedBytes, 0);
  f.accept("two", "client-b");
  assert.equal(f.results.info().reservedBytes, resultLimits.packageBytes);
});

test("client quota is separate from global capacity and publication binds original execution", async t => {
  const f = await fixture(t, { clientBytes: resultLimits.packageBytes });
  f.accept("one");
  assert.throws(() => f.accept("two"), { code: "result_storage_full" });
  f.accept("three", "client-b");
  const claim = f.tasks.claim({ owner: "worker" });
  const run = f.tasks.update({ ...claim.run, status: "running", threadId: "thread", turnId: "turn" }, claim.claim);
  for (const patch of [{ clientId: "other" }, { automationId: "other" }, { threadId: "other" }, { turnId: "other" }]) {
    await assert.rejects(f.results.capture({ ...run, ...patch }, claim.claim, { text: "result" }), { code: "result_claim_changed" });
  }
  assert.equal(fs.readdirSync(path.join(f.root, "blobs")).length, 0);
});

test("small results still obey per-client and global record limits without accepting a task", async t => {
  const f = await fixture(t, { globalRuns: 2, clientRuns: 1 });
  await f.complete("one");
  assert.throws(() => f.accept("two"), { code: "result_record_limit" });
  assert.equal(f.tasks.read("two"), null);
  await f.complete("three", {}, "client-b");
  assert.throws(() => f.accept("four", "client-c"), { code: "result_record_limit" });
  assert.equal(f.tasks.read("four"), null);
  assert.equal(f.results.info().runs, 2);
  assert.equal(f.ledger.database.prepare("SELECT count(*) AS n FROM external_task_keys").get().n, 2);
});

test("a consistent database backup plus private blobs restores the same authenticated delivery", async t => {
  const f = await fixture(t);
  const run = await f.complete("one", { files: [{ name: "report.md", mimeType: "text/markdown", buffer: Buffer.from("restore this report"), provenance: "requested-path-changed-during-run" }] });
  const destination = path.join(f.root, "restored.sqlite");
  const { stdout } = await promisify(execFile)(process.execPath, [new URL("../ops/backup-usage-ledger.mjs", import.meta.url).pathname, path.join(f.root, "state.sqlite"), destination]);
  assert.equal(JSON.parse(stdout).externalResultRows, 1);
  const blobs = path.join(f.root, "restored-blobs");
  fs.mkdirSync(blobs, { mode: 0o700 });
  fs.cpSync(path.join(f.root, "blobs"), blobs, { recursive: true, errorOnExist: true, force: false });
  assert.equal(fs.statSync(blobs).mode & 0o077, 0);
  for (const name of fs.readdirSync(blobs)) assert.equal(fs.statSync(path.join(blobs, name)).mode & 0o077, 0);
  const restored = openRunUsageLedger(destination);
  try {
    const tasks = createExternalTaskStore(restored.database);
    const results = createExternalResultStore(restored.database, blobs, { now: () => start });
    const manifest = await results.manifest(tasks.read(run.id));
    assert.equal(manifest.runId, run.id);
    assert.equal((await results.file(tasks.read(run.id), manifest.artifacts[0].id)).buffer.toString(), "restore this report");
    assert.equal(results.info().reservedBytes, f.results.info().reservedBytes);
  } finally { restored.close(); }
});

test("result copies persist independently of native history, cannot cross runs, and detect missing/changed/link data", async t => {
  const f = await fixture(t);
  const run = await f.complete("one", { structuredOutput: { status: "validated", data: { answer: 42 } }, files: [
    { name: "图片.png", mimeType: "image/png", buffer: Buffer.from("fixture image"), provenance: "native-image-item", nativeItemId: "native-one", revisedPrompt: "verified prompt" },
  ] });
  const reopened = createExternalResultStore(f.ledger.database, path.join(f.root, "blobs"), { now: () => start, retentionMs: 10000 });
  const manifest = await reopened.manifest(run), artifact = manifest.artifacts[0];
  assert.equal(manifest.turnId, run.turnId);
  assert.deepEqual(manifest.structuredOutput.data, { answer: 42 });
  assert.equal((await reopened.file(run, artifact.id)).revisedPrompt, "verified prompt");
  await assert.rejects(reopened.file({ ...run, clientId: "other" }, artifact.id), { statusCode: 404 });
  await assert.rejects(reopened.file({ ...run, automationId: "other" }, artifact.id), { statusCode: 404 });
  await assert.rejects(reopened.file(run, run.delivery.id), { statusCode: 404 });
  await assert.rejects(reopened.file(run, "../private"), { statusCode: 404 });
  await assert.rejects(reopened.manifest({ ...run, turnId: "new-turn" }), { statusCode: 503 });
  const file = path.join(f.root, "blobs", `${artifact.id}.blob`);
  fs.writeFileSync(file, "tampered bytes");
  await assert.rejects(reopened.file(run, artifact.id), { code: "result_integrity_failed" });
  fs.unlinkSync(file);
  await assert.rejects(reopened.file(run, artifact.id), { statusCode: 404 });
  fs.symlinkSync(path.join(f.root, "state.sqlite"), file);
  await assert.rejects(reopened.file(run, artifact.id), { statusCode: 403 });
});

test("delivery lifetime starts at capture and extends the event key; expiration removes only private copies", async t => {
  const f = await fixture(t);
  const original = path.join(f.root, "original.md"); fs.writeFileSync(original, "keep original");
  const { run, claim } = f.begin("one");
  f.advance(8000);
  const delivery = await f.results.capture(run, claim, { text: "result", files: [{ name: "report.md", mimeType: "text/markdown", buffer: Buffer.from("copied report"), provenance: "requested-path-changed-during-run" }] });
  const saved = f.tasks.update({ ...run, delivery, status: "completed" }, claim);
  assert.equal(f.ledger.database.prepare("SELECT expires_ms FROM external_task_keys WHERE run_id='one'").get().expires_ms, Date.parse(delivery.expiresAt));
  f.advance(3000);
  f.tasks.retain([]);
  assert.ok(f.tasks.read("one"), "result foreign key protects task after its event key expires");
  assert.equal((await f.results.manifest(saved)).text, "result");
  f.advance(7001);
  f.tasks.retain([]);
  assert.ok(f.tasks.read("one"), "retained copies protect their run even after its event key expires");
  await assert.rejects(f.results.manifest(saved), { statusCode: 410 });
  await f.results.sweep();
  assert.deepEqual(fs.readdirSync(path.join(f.root, "blobs")), []);
  assert.equal(f.results.info().reservedBytes, 0);
  assert.equal(fs.readFileSync(original, "utf8"), "keep original");
  f.advance(10001); await f.results.sweep(); f.tasks.retain([]);
  assert.equal(f.tasks.read("one"), null);
});

test("unknown execution keeps quota and unpublished snapshots; an old executor cannot publish", async t => {
  const f = await fixture(t);
  const { run, claim } = f.begin("one");
  const open = fsp.open;
  let recovered = false;
  fsp.open = async function (...args) {
    const handle = await open.apply(this, args);
    if (String(args[0]).endsWith(".blob") && !recovered) { f.tasks.recover(); recovered = true; }
    return handle;
  };
  try { await assert.rejects(f.results.capture(run, claim, { text: "uncertain original" }), { code: "result_claim_changed" }); }
  finally { fsp.open = open; }
  f.advance(60000); await f.results.sweep();
  assert.equal(f.tasks.read("one").status, "needs_reconciliation");
  assert.equal(f.results.info().reservedBytes, resultLimits.packageBytes);
  assert.equal(fs.readdirSync(path.join(f.root, "blobs")).length, 1);
  await assert.rejects(f.results.manifest(f.tasks.read("one")), { statusCode: 409 });
  assert.equal(f.tasks.claim({ owner: "replacement" }), null);
});

test("failed writes and failed cleanup retain reservations until copies are actually removed", async t => {
  const f = await fixture(t);
  const { run, claim } = f.begin("one");
  const open = fsp.open;
  fsp.open = async function (...args) { if (String(args[0]).endsWith(".blob")) throw new Error("private absolute path"); return open.apply(this, args); };
  try { await assert.rejects(f.results.capture(run, claim, { text: "result" }), { code: "result_persistence_failed" }); }
  finally { fsp.open = open; }
  f.tasks.update({ ...run, status: "failed" }, claim);
  assert.equal(f.results.info().reservedBytes, resultLimits.packageBytes);
  f.advance(10001);
  const unlink = fsp.unlink;
  fsp.unlink = async () => { throw Object.assign(new Error("cleanup denied"), { code: "EACCES" }); };
  try { await assert.rejects(f.results.sweep(), /cleanup denied/); }
  finally { fsp.unlink = unlink; }
  assert.equal(f.results.info().reservedBytes, resultLimits.packageBytes);
  await f.results.sweep();
  assert.equal(f.results.info().reservedBytes, 0);
});

test("only native exact-turn web actions contribute sources; text and other turns are not citations", () => {
  const thread = { turns: [{ id: "one", items: [
    { type: "agentMessage", text: "https://invented.test/" },
    { type: "webSearch", id: "a", action: { type: "openPage", url: "https://verified.test/path" } },
    { type: "webSearch", id: "b", action: { type: "findInPage", url: "https://verified.test/path" } },
    { type: "webSearch", id: "c", action: { type: "openPage", url: "https://user:password@private.test/" } },
    { type: "webSearch", id: "d", action: { type: "openPage", url: "file:///private" } },
  ] }, { id: "other", items: [{ type: "webSearch", id: "z", action: { type: "openPage", url: "https://other.test/" } }] }] };
  assert.deepEqual(nativeSources(thread, "one"), [{ url: "https://verified.test/path", itemId: "a", kind: "openPage" }]);
});

test("disk capacity checks roll back admission and output limits fail before writing any private blob", async t => {
  const f = await fixture(t);
  const statfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1n, bsize: 4096n });
  try { assert.throws(() => f.accept("disk-full"), { code: "result_disk_full" }); }
  finally { fs.statfsSync = statfs; }
  assert.equal(f.tasks.read("disk-full"), null);
  assert.equal(f.results.info().runs, 0);
  const { run, claim } = f.begin("one");
  await assert.rejects(f.results.capture(run, claim, { text: "x".repeat(resultLimits.textBytes + 1) }), { code: "result_too_large" });
  const buffer = Buffer.alloc(resultLimits.fileBytes);
  const files = [1, 2, 3].map(i => ({ name: `file-${i}.txt`, mimeType: "text/plain", provenance: "requested-path-changed-during-run", buffer }));
  await assert.rejects(f.results.capture(run, claim, { text: "result", files }), { code: "result_too_large" });
  assert.deepEqual(fs.readdirSync(path.join(f.root, "blobs")), []);
});

test("version-two execution rows keep their claims and immutable requested paths cannot change", async t => {
  const f = await fixture(t);
  const { run, claim } = f.begin("one");
  const before = f.ledger.database.prepare("SELECT * FROM external_tasks").all();
  f.ledger.database.exec("UPDATE external_tasks_meta SET value=2 WHERE key='schema_version'");
  const reopened = createExternalTaskStore(f.ledger.database);
  assert.deepEqual(f.ledger.database.prepare("SELECT * FROM external_tasks").all(), before);
  assert.equal(reopened.read("one").id, run.id);
  assert.throws(() => reopened.update({ ...run, artifactPaths: ["new.txt"] }, claim), { statusCode: 409 });
});
