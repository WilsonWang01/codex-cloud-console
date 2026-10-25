import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mergeUsageRuns, openRunUsageLedger } from "../server/run-usage-ledger.mjs";
import { aggregateRunUsage } from "../server/run-usage.mjs";
import { checkKnownTokenBudget } from "../server/run-budget.mjs";
import { retainAutomationRuns } from "../server/run-safety.mjs";

const day = 86400000;
const start = Date.parse("2026-10-22T12:00:00Z");
const range = { from: start - day, to: start + day };
const run = (id, extra = {}) => ({
  id, clientId: "client-a", automationId: "research", runner: "app-server", status: "completed",
  startedAt: new Date(start).toISOString(), updatedAt: new Date(start + 1000).toISOString(),
  finishedAt: new Date(start + 1000).toISOString(), threadId: "thread", turnId: id,
  usage: { status: "complete", inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 },
  prompt: "private prompt must not enter accounting", ...extra,
});
async function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-ledger-"));
  const file = path.join(root, "usage.sqlite");
  let clock = start + 10000;
  let ledger = openRunUsageLedger(file, { now: () => clock });
  const control = {
    root, file, get ledger() { return ledger; }, setTime(time) { clock = time; },
    reopen() { ledger.close(); ledger = openRunUsageLedger(file, { now: () => clock }); },
  };
  try { await callback(control); }
  finally { ledger.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test("accounting survives history pruning, process restart and replay without storing prompt or events", () => fixture(({ file, ledger }) => {
  const runs = Array.from({ length: 450 }, (_, i) => run(`run-${i}`, { startedAt: new Date(start - day).toISOString() }));
  ledger.sync(runs);
  const trimmed = retainAutomationRuns(runs, { now: start + 10000, idempotencyTtlMs: 1, recoveryMaxAgeMs: 1 });
  assert.equal(trimmed.length, 200);
  ledger.sync(trimmed);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {openRunUsageLedger} from ${JSON.stringify(new URL("../server/run-usage-ledger.mjs", import.meta.url).href)};
    const ledger=openRunUsageLedger(process.argv[1],{now:()=>${start + 10000}});
    console.log(JSON.stringify(ledger.rows(${JSON.stringify(range)})));ledger.close();
  `, file], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const rows = JSON.parse(child.stdout);
  assert.equal(rows.length, 450);
  const buckets = aggregateRunUsage(rows, range);
  assert.equal(buckets[0].totalTokens, 54000);
  assert.equal(JSON.stringify(rows).includes("private prompt"), false);
  assert.equal("events" in rows[0], false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}));

test("unknown evidence survives restart and cannot replace already known turn usage", () => fixture((f) => {
  const unknown = run("missing", { usage: { status: "unknown", reason: "upstream missing" } });
  f.ledger.sync([run("known"), unknown, run("bad", { usage: { status: "complete", inputTokens: -1, outputTokens: 1, totalTokens: 0 } })]);
  f.ledger.sync([run("known", { status: "needs_reconciliation", updatedAt: new Date(start + 2000).toISOString(), usage: { status: "unknown" } })]);
  f.reopen();
  const rows = f.ledger.rows(range);
  assert.equal(rows.find((r) => r.id === "known").usage.totalTokens, 120);
  assert.equal(rows.find((r) => r.id === "missing").usage.reason, "upstream missing");
  assert.equal(rows.find((r) => r.id === "bad").usage.status, "unknown");
  assert.equal(checkKnownTokenBudget(rows, { limit: 1000, now: start + 10000 }).statusCode, 409);
}));

test("legacy native snapshots remain preserved but cannot bypass unknown-usage budget gates after pruning", () => fixture((f) => {
  const old = run("legacy", { usage: { status: "complete", source: "app-server:last-turn", inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
  f.ledger.sync([run("legacy")]);
  f.ledger.database.prepare("UPDATE usage_runs SET snapshot=? WHERE id=?").run(JSON.stringify({ ...old, prompt: undefined }), old.id);
  const raw = () => f.ledger.database.prepare("SELECT snapshot FROM usage_runs WHERE id=?").get(old.id).snapshot;
  const before = raw();
  const read = f.ledger.rows(range)[0];
  assert.equal(read.usage.status, "unknown");
  assert.equal(read.usage.reportedLastRequest.totalTokens, 12);
  assert.equal(raw(), before, "read projection must not overwrite the original stored snapshot");
  for (const rows of [mergeUsageRuns([], [old]), mergeUsageRuns([old], f.ledger.rows(range))]) {
    assert.equal(rows[0].usage.status, "unknown");
    assert.equal(checkKnownTokenBudget(rows, { limit: 1000, now: start + 10000 }).statusCode, 409);
  }
  f.reopen();
  assert.equal(f.ledger.rows(range)[0].usage.reportedLastRequest.totalTokens, 12);
}));

test("newly seeded legacy counts retain original numbers without becoming billable known totals", () => fixture(({ ledger }) => {
  const old = run("legacy-seed", { usage: { status: "complete", source: "app-server:last-turn", inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
  ledger.sync([old]);
  const saved = ledger.rows(range)[0];
  assert.equal(saved.usage.status, "unknown");
  assert.deepEqual(saved.usage.reportedLastRequest, { source: old.usage.source, inputTokens: 10, outputTokens: 2, totalTokens: 12 });
}));

test("batch failure rolls back all rows; ownership and Codex turn collisions fail closed", () => fixture(({ ledger }) => {
  ledger.sync([run("one")]);
  for (const patch of [{ clientId: "other" }, { automationId: "other" }, { startedAt: new Date(start + 1).toISOString() }, { turnId: "other" }]) {
    assert.throws(() => ledger.sync([run("new"), run("one", patch)]), /ownership|Codex turn/);
    assert.equal(ledger.rows(range).length, 1);
  }
  assert.throws(() => ledger.sync([run("same-turn", { turnId: "one" })]), /UNIQUE/);
  assert.equal(ledger.rows(range).length, 1);
}));

test("active state still blocks budget while retained terminal totals enforce the UTC limit", () => fixture(({ ledger }) => {
  ledger.sync([run("finished")]);
  const saved = ledger.rows(range);
  assert.equal(checkKnownTokenBudget(mergeUsageRuns([], saved), { limit: 120, now: start + 10000 }).statusCode, 429);
  const running = run("finished", { status: "running", usage: { status: "unknown" } });
  assert.equal(checkKnownTokenBudget(mergeUsageRuns([running], saved), { limit: 1000, now: start + 10000 }).statusCode, 429);
  assert.equal(checkKnownTokenBudget(mergeUsageRuns([], saved), { limit: 120, now: start + day }).ok, true);
  assert.equal(aggregateRunUsage(mergeUsageRuns([run("live", { status: "running" })], saved), range)[0].knownRuns, 1);
}));

test("retention follows UTC start time and reports historical coverage instead of fabricating old totals", () => fixture((f) => {
  f.ledger.sync([run("one")]);
  const seeded = f.ledger.info().seededAt;
  f.setTime(start + 32 * day);
  f.ledger.sync([]);
  assert.equal(f.ledger.rows({ from: start, to: start + 1 }).length, 1);
  f.setTime(start + 33 * day);
  f.ledger.sync([]);
  f.ledger.sync([run("one")]);
  assert.equal(f.ledger.rows({ from: start, to: start + 1 }).length, 0);
  assert.equal(f.ledger.info().seededAt, seeded);
  assert.equal(f.ledger.info().historicalCoverage, "retained_records_only");
  assert.equal(f.ledger.info().timezone, "UTC");
}));

test("late execution is accounted on execution time even when accepted before the retention window", () => fixture(({ ledger }) => {
  const row = run("long-queued", { startedAt: new Date(start - 40 * day).toISOString(), executionStartedAt: new Date(start).toISOString() });
  ledger.sync([row]);
  const rows = ledger.rows({ from: start, to: start + 1 });
  assert.equal(rows.length, 1);
  assert.equal(aggregateRunUsage(rows, { from: start, to: start + 1 })[0].totalTokens, 120);
}));

test("consistent backup includes WAL writes, verifies restore and refuses an existing destination", () => fixture(({ ledger, file, root }) => {
  ledger.sync([run("backed-up")]);
  const destination = path.join(root, "backup.sqlite");
  const script = new URL("../ops/backup-usage-ledger.mjs", import.meta.url).pathname;
  const child = spawnSync(process.execPath, [script, file, destination], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).verified, true);
  const restored = new DatabaseSync(destination, { readOnly: true });
  assert.equal(restored.prepare("SELECT count(*) AS n FROM usage_runs").get().n, 1);
  restored.close();
  const before = fs.readFileSync(destination);
  assert.notEqual(spawnSync(process.execPath, [script, file, destination], { encoding: "utf8" }).status, 0);
  assert.deepEqual(fs.readFileSync(destination), before);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
}));

test("corrupt, future schema and symlink files are rejected without replacing them", () => fixture(({ root }) => {
  const bad = path.join(root, "bad.sqlite");
  fs.writeFileSync(bad, "not a database");
  assert.throws(() => openRunUsageLedger(bad));
  assert.equal(fs.readFileSync(bad, "utf8"), "not a database");
  const future = path.join(root, "future.sqlite");
  const db = new DatabaseSync(future); db.exec("PRAGMA user_version=9"); db.close();
  assert.throws(() => openRunUsageLedger(future), /Unsupported/);
  const target = path.join(root, "absent.sqlite");
  const link = path.join(root, "link.sqlite");
  fs.symlinkSync(target, link);
  assert.throws(() => openRunUsageLedger(link), /regular/);
  assert.equal(fs.existsSync(target), false);
}));
