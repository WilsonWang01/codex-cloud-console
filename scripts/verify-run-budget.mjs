import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkKnownTokenBudget } from "../server/run-budget.mjs";
import { retainAutomationRuns } from "../server/run-safety.mjs";

const now = Date.parse("2026-09-26T12:00:00Z");
const run = (status, totalTokens, startedAt = "2026-09-26T10:00:00Z") => ({
  runner: "app-server", status, startedAt,
  usage: totalTokens === null ? { status: "unknown" } : { status: "complete", totalTokens },
});
const retention = { now, idempotencyTtlMs: 86_400_000, recoveryMaxAgeMs: 86_400_000 };
const dailyRuns = () => Array.from({ length: 250 }, (_, index) => {
  const startedAt = new Date(now - (250 - index) * 60_000).toISOString();
  return { ...run("completed", 1000, startedAt), id: `manual-${index}`, updatedAt: startedAt };
});

test("disabled budget does not change existing automation behavior", () => {
  assert.deepEqual(checkKnownTokenBudget([run("failed", null)], { limit: "", now }), { ok: true, enabled: false });
});

test("known usage blocks at the configured soft limit and resets on the next UTC day", () => {
  assert.equal(checkKnownTokenBudget([run("completed", 80)], { limit: 100, now }).ok, true);
  const reached = checkKnownTokenBudget([run("completed", 100)], { limit: 100, now });
  assert.equal(reached.statusCode, 429);
  assert.equal(reached.retryAfterMs, 12 * 60 * 60_000);
  assert.equal(checkKnownTokenBudget([run("completed", 100)], { limit: 100, now: now + 86_400_000 }).ok, true);
});

test("unknown and in-flight usage fail closed when a budget is configured", () => {
  assert.equal(checkKnownTokenBudget([run("running", null)], { limit: 100, now }).statusCode, 429);
  assert.equal(checkKnownTokenBudget([run("needs_reconciliation", null)], { limit: 100, now }).statusCode, 409);
  assert.equal(checkKnownTokenBudget([run("completed", null)], { limit: 100, now }).statusCode, 409);
  assert.equal(checkKnownTokenBudget([run("completed", 100, "2026-09-25T23:00:00Z")], { limit: 100, now }).ok, true);
});

test("retention preserves all current-day budget records beyond the history limit", () => {
  const runs = dailyRuns();
  const retained = retainAutomationRuns(runs, retention);
  assert.equal(retained.length, 250);
  assert.deepEqual(checkKnownTokenBudget(retained, { limit: 300_000, now }), {
    ok: true, enabled: true, used: 250_000, limit: 300_000,
  });
  assert.equal(checkKnownTokenBudget(retained, { limit: 240_000, now }).statusCode, 429);
  assert.deepEqual(runs, dailyRuns(), "retention must not mutate its input");
});

test("retention cannot discard unknown, missing or malformed usage to reopen the budget", () => {
  for (const usage of [undefined, { status: "unknown" }, { status: "complete", totalTokens: -1 }]) {
    const runs = dailyRuns();
    runs[0].usage = usage;
    const retained = retainAutomationRuns(runs, retention);
    assert.ok(retained.some((row) => row.id === runs[0].id));
    assert.equal(checkKnownTokenBudget(retained, { limit: 300_000, now }).statusCode, 409);
  }
});

test("budget retention follows the UTC start time, not update time or local calendar date", () => {
  const rows = [
    { ...run("completed", 1000, "2026-09-25T23:59:59.999Z"), id: "previous", updatedAt: new Date(now).toISOString() },
    { ...run("failed", null, "2026-09-26T08:00:00+08:00"), id: "midnight", updatedAt: "2026-09-26T00:00:00Z" },
    { ...run("canceled", 1000, new Date(now).toISOString()), id: "current", updatedAt: new Date(now).toISOString() },
    { ...run("completed", 1000, new Date(now + 1).toISOString()), id: "future", updatedAt: new Date(now).toISOString() },
    { ...run("completed", 1000), id: "systemd", runner: "systemd", updatedAt: new Date(now).toISOString() },
  ];
  const retained = retainAutomationRuns(rows, { ...retention, historyLimit: 0 });
  assert.deepEqual(retained.map((row) => row.id).sort(), ["current", "midnight"]);
  assert.equal(checkKnownTokenBudget(retained, { limit: 300_000, now }).statusCode, 409);
});

test("daily protection expires on the next UTC day while other retention rules remain", () => {
  const rows = dailyRuns();
  const nextDay = Date.parse("2026-09-27T00:00:00Z");
  const protectedRows = [
    { ...rows[0], id: "active", status: "running" },
    { ...rows[0], id: "reconcile", status: "needs_reconciliation" },
    { ...rows[0], id: "idempotency", triggerIdempotencyHash: "key" },
    { ...rows[0], id: "recovery", status: "interrupted" },
    { ...rows[0], id: "client-session", clientId: "client", sessionId: "thread", automationId: "research" },
  ];
  const retained = retainAutomationRuns([...rows, ...protectedRows], { ...retention, now: nextDay });
  assert.equal(retained.filter((row) => row.id.startsWith("manual-")).length, 200);
  for (const row of protectedRows) assert.ok(retained.some((item) => item.id === row.id));
  assert.deepEqual(checkKnownTokenBudget(retained, { limit: 240_000, now: nextDay }), {
    ok: true, enabled: true, used: 0, limit: 240_000,
  });
});

test("persisted retention keeps the same budget when read in a new process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-run-budget-"));
  try {
    const statePath = path.join(root, "automation-runs.json");
    await fs.writeFile(statePath, JSON.stringify({ version: 1, runs: retainAutomationRuns(dailyRuns(), retention) }));
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs/promises";
      import { checkKnownTokenBudget } from ${JSON.stringify(new URL("../server/run-budget.mjs", import.meta.url).href)};
      const { runs } = JSON.parse(await fs.readFile(process.argv[1], "utf8"));
      process.stdout.write(JSON.stringify(checkKnownTokenBudget(runs, { limit: 240000, now: ${now} })));
    `, statePath], { timeout: 10_000 });
    assert.deepEqual(JSON.parse(stdout), checkKnownTokenBudget(dailyRuns(), { limit: 240_000, now }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
