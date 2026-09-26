import assert from "node:assert/strict";
import test from "node:test";
import { checkKnownTokenBudget } from "../server/run-budget.mjs";

const now = Date.parse("2026-09-26T12:00:00Z");
const run = (status, totalTokens, startedAt = "2026-09-26T10:00:00Z") => ({
  runner: "app-server", status, startedAt,
  usage: totalTokens === null ? { status: "unknown" } : { status: "complete", totalTokens },
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
