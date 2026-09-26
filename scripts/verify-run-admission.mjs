import assert from "node:assert/strict";
import test from "node:test";
import { createRunAdmission } from "../server/run-admission.mjs";

test("global and client limits reject new work without consuming a slot", () => {
  const admission = createRunAdmission({ maxGlobal: 2, maxPerClient: 1 });
  const releaseA = admission.reserve("client-a");
  assert.throws(() => admission.reserve("client-a"), { statusCode: 429 });
  const releaseB = admission.reserve("client-b");
  assert.throws(() => admission.reserve("client-c"), { statusCode: 429 });
  releaseA();
  releaseA();
  assert.equal(admission.status().active, 1);
  const releaseC = admission.reserve("client-c");
  releaseB();
  releaseC();
  assert.equal(admission.status().active, 0);
});

test("invalid limits use conservative defaults", () => {
  const admission = createRunAdmission({ maxGlobal: 0, maxPerClient: -1 });
  assert.deepEqual(admission.status(), { active: 0, maxGlobal: 2, maxPerClient: 1 });
});
