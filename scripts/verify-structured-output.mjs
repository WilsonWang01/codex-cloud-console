import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOutputSchema, validateStructuredOutput, structuredTurnText } from "../server/structured-output.mjs";

const schema = { type: "object", properties: { answer: { type: "string" }, count: { type: ["integer", "null"] } }, required: ["answer", "count"], additionalProperties: false };
test("bounded schema validation preserves values, rejects unsupported constraints and never repairs output", () => {
  const value = normalizeOutputSchema(schema);
  assert.deepEqual(value, schema); assert.notEqual(value, schema);
  assert.deepEqual(validateStructuredOutput(value, '{"answer":"中文","count":null}').data, { answer: "中文", count: null });
  for (const text of ['{"answer":"ok"}', '{"answer":1,"count":2}', '{"answer":"ok","count":2,"extra":true}', '```json\n{}\n```']) assert.throws(() => validateStructuredOutput(value, text), { statusCode: 502 });
  assert.throws(() => validateStructuredOutput(value, "x".repeat(65537)), { code: "structured_output_too_large" });
  for (const node of [{ ...schema, $ref: "https://example.invalid" }, { ...schema, properties: { answer: { type: "string", pattern: "(a+)+$" } } }, { type: "array", items: { type: "string" } }, { ...schema, additionalProperties: true }, { ...schema, required: [] }, { ...schema, minItems: 3 }]) assert.throws(() => normalizeOutputSchema(node), { statusCode: 400 });
});
test("schema resources are bounded before compilation and absent schemas remain absent", () => {
  assert.equal(normalizeOutputSchema(undefined), null);
  assert.throws(() => normalizeOutputSchema({ ...schema, description: "x".repeat(17000) }), { statusCode: 400 });
  let nested = { type: "string" }; for (let i = 0; i < 9; i++) nested = { type: "object", properties: { child: nested }, required: ["child"], additionalProperties: false };
  assert.throws(() => normalizeOutputSchema(nested), { statusCode: 400 });
  const cyclic = { ...schema }; cyclic.properties = { cyclic }; assert.throws(() => normalizeOutputSchema(cyclic), { statusCode: 400 });
});
test("structured extraction uses one exact final item, not commentary or a later turn", () => {
  const thread = { turns: [{ id: "first", items: [{ type: "agentMessage", phase: "commentary", text: "not JSON" }, { type: "agentMessage", phase: "final_answer", text: '{"answer":"one","count":1}' }] }, { id: "later", items: [{ type: "agentMessage", text: "other" }] }] };
  assert.equal(JSON.parse(structuredTurnText(thread, "first")).answer, "one");
  assert.throws(() => structuredTurnText(thread, "missing"), { statusCode: 502 });
  assert.throws(() => structuredTurnText({ turns: [{ id: "ambiguous", items: [{ type: "agentMessage", text: "one" }, { type: "agentMessage", text: "two" }] }] }, "ambiguous"), { statusCode: 502 });
});
