import assert from "node:assert/strict";
import test from "node:test";
import { externalWriteAttempt, unresolvedExternalAction } from "../server/external-action-review.mjs";

const item = (overrides = {}) => ({
  type: "mcpToolCall",
  id: "write-1",
  server: "codex_apps",
  tool: "create_event",
  readOnlyHint: false,
  appContext: { connectorId: "calendar-1", appName: "Calendar", actionName: "create_event" },
  ...overrides,
});

test("only explicitly non-read-only MCP calls enter external review", () => {
  assert.equal(externalWriteAttempt(item({ readOnlyHint: true })), null);
  assert.deepEqual(externalWriteAttempt(item({ appContext: null })), { id: "write-1", server: "codex_apps", tool: "create_event", status: "inProgress" });
  assert.equal(externalWriteAttempt(item({ type: "commandExecution" })), null);
  assert.deepEqual(externalWriteAttempt(item()), { id: "write-1", server: "Calendar", tool: "create_event", status: "inProgress" });
});

test("all successful write receipts and a successful turn clear review", () => {
  const attempts = new Map([["write-1", { ...externalWriteAttempt(item()), status: "completed" }]]);
  assert.equal(unresolvedExternalAction(attempts, { ok: true, turnId: "turn-1" }), null);
  assert.match(unresolvedExternalAction(attempts, { ok: false, turnId: "turn-1" }).reason, /未正常结束/);
});

test("incomplete or failed writes stay reviewable even if the model turn completed", () => {
  const attempts = new Map([
    ["write-1", { ...externalWriteAttempt(item()), status: "completed" }],
    ["write-2", { ...externalWriteAttempt(item({ id: "write-2", tool: "delete_event" })), status: "failed" }],
  ]);
  const review = unresolvedExternalAction(attempts, { ok: true, turnId: "turn-2", at: "2026-09-27T00:00:00Z" });
  assert.equal(review.id, "turn-2");
  assert.equal(review.count, 2);
  assert.deepEqual(review.actions.map((action) => action.status), ["completed", "failed"]);
  assert.equal(review.actions[1].tool, "delete_event");
  assert.match(review.reason, /勿直接重试/);
  assert.equal(unresolvedExternalAction(attempts, { ok: false, turnId: "turn-2", automationRunId: "run-1" }).automationRunId, "run-1");
  assert.equal("automationRunId" in review, false);
});
