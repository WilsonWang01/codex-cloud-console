import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCalendarProposalStore } from "../server/personal-calendar-proposals.mjs";
import { createPersonalCalendarActions } from "../server/personal-calendar-actions.mjs";
import { handlePersonalCalendarCall, personalCalendarTool, personalCalendarProposalMessages } from "../server/personal-calendar-tool.mjs";
import { createCalendarActionFixture } from "./fixtures/calendar-action-runtime.mjs";

const form = { title: "合成行程准备", description: "合成对话明确要求，仅保存草稿", location: "", attendees: [], allDay: false, timeZone: "Asia/Shanghai", startLocal: "2026-10-25T10:00", endLocal: "2026-10-25T10:30" };
function fixture() {
  let state = null, saves = 0, savingFails = false;
  const options = { read: async () => structuredClone(state), write: async value => { if (savingFails) throw new Error("PRIVATE-FILE-ERROR"); state = structuredClone(value); saves++; }, now: () => Date.parse("2026-10-24T00:00:00Z") };
  const store = createCalendarProposalStore(options), runtime = createCalendarActionFixture();
  const context = () => ({ cwd: "/synthetic-personal", model: "gpt-6-sol" });
  const actions = createPersonalCalendarActions({ store, request: runtime.request, context });
  const job = { kind: "turn", repo: { kind: "personal" }, repoId: "_personal", sessionId: "personal-session", threadId: "personal-thread", turnId: "personal-turn" };
  const params = { tool: personalCalendarTool.name, namespace: null, threadId: job.threadId, turnId: job.turnId, callId: "calendar-call", arguments: { form: structuredClone(form), reason: "用户明确提出安排材料准备时间" } };
  return { options, store, runtime, actions, context, job, params, state: () => state, setState: value => { state = value; }, saves: () => saves, failSave: () => { savingFails = true; } };
}
const record = result => JSON.parse(result.contentItems[0].text);
const message = (f, result) => ({ id: f.params.callId, turnId: f.job.turnId, messageType: "dynamicToolCall", text: "native tool", details: { kind: "tool", namespace: null, tool: personalCalendarTool.name, status: "completed", success: result.success, arguments: f.params.arguments, contentItems: result.contentItems } });

test("current personal turn saves a sourced model proposal but never reads events or writes a calendar", async () => {
  const f = fixture(), result = await handlePersonalCalendarCall(f.params, f.job, f.actions);
  assert.equal(result.success, true); const receipt = record(result), item = (await f.actions.list())[0];
  assert.equal(item.id, receipt.proposalId); assert.equal(item.source, "assistant"); assert.equal(item.status, "draft"); assert.equal(item.preview, null); assert.equal(item.attempted, false);
  assert.equal(item.origin.sessionId, f.job.sessionId); assert.equal(item.origin.callId, f.params.callId); assert.equal(item.origin.reason, f.params.arguments.reason);
  assert.equal(f.state().version, 2); assert.equal(f.runtime.writes(), 0);
  assert.deepEqual(f.runtime.calls.filter(call => call.method === "mcpServer/tool/call").map(call => call.params.tool), ["google_calendar.get_profile"]);
  assert.match(receipt.message, /未检查空闲、创建日程或发送邀请/); assert.doesNotMatch(JSON.stringify(receipt), /fixture-link|contract/);
});

test("same native call is idempotent across restart and preserves edits and rejected status without another account call", async () => {
  const f = fixture(), result = await handlePersonalCalendarCall(f.params, f.job, f.actions), id = record(result).proposalId;
  let item = await f.store.get(id);
  item = await f.store.edit(id, item.revision, { ...item.payload, title: "用户编辑后的标题" });
  item = await f.store.defer(id, item.revision, "rejected");
  const origin = structuredClone(item.origin), reopened = createCalendarProposalStore(f.options);
  const restarted = createPersonalCalendarActions({ store: reopened, request: f.runtime.request, context: f.context });
  const calls = f.runtime.calls.length, repeat = await handlePersonalCalendarCall(f.params, f.job, restarted);
  assert.equal(record(repeat).status, "rejected"); assert.equal(record(repeat).proposalId, id); assert.equal(f.runtime.calls.length, calls);
  assert.equal((await restarted.list()).length, 1); assert.deepEqual((await restarted.list())[0].origin, origin);
  const changed = structuredClone(f.params); changed.arguments.form.title = "同号异体";
  assert.equal((await handlePersonalCalendarCall(changed, f.job, restarted)).success, false);
});

test("work, background, stale, cancelled, cross-thread and unknown tool calls cannot create proposals", async () => {
  for (const [changeJob, changeParams] of [
    [{ repo: { kind: "work" } }, {}], [{ kind: "compact" }, {}], [{ completed: true }, {}], [{ finishing: true }, {}], [{ cancelRequested: true }, {}], [{ unattendedPersonalSchedule: true }, {}],
    [{}, { namespace: "injected" }], [{}, { threadId: "other" }], [{}, { turnId: "other" }], [{}, { callId: "" }], [{}, { tool: "calendar_execute" }],
  ]) {
    const f = fixture(); const result = await handlePersonalCalendarCall({ ...f.params, ...changeParams }, { ...f.job, ...changeJob }, f.actions);
    assert.equal(result.success, false); assert.equal(f.saves(), 0); assert.equal(f.runtime.calls.length, 0);
  }
});

test("missing details, ambiguous time and model-supplied permissions are rejected before connector access", async () => {
  for (const mutate of [
    input => { input.confirm = true; }, input => { input.origin = { sessionId: "work" }; }, input => { input.form.execute = true; }, input => { delete input.form.attendees; },
    input => { input.form.timeZone = "bad"; }, input => { input.form.startLocal = "明天十点"; }, input => { input.reason = "bad\nreason"; },
    input => Object.assign(input.form, { timeZone: "America/New_York", startLocal: "2026-11-01T01:10", endLocal: "2026-11-01T01:30" }),
  ]) {
    const f = fixture(); mutate(f.params.arguments); assert.equal((await handlePersonalCalendarCall(f.params, f.job, f.actions)).success, false); assert.equal(f.runtime.calls.length, 0); assert.equal(f.saves(), 0);
  }
});

test("a turn ending during account verification cannot save a stale proposal", async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { entered = resolve; });
  const actions = createPersonalCalendarActions({ store: f.store, context: f.context, request: async (method, params) => { if (params?.tool === "google_calendar.get_profile") { entered(); await gate; } return f.runtime.request(method, params); } });
  const pending = handlePersonalCalendarCall(f.params, f.job, actions); await seen; f.job.cancelRequested = true; release();
  assert.equal((await pending).success, false); assert.equal(f.saves(), 0); assert.equal(f.runtime.writes(), 0);
});

test("model proposals have a durable three-per-turn cap and failed writes preserve legacy data", async () => {
  const f = fixture();
  for (let n = 0; n < 4; n++) { const params = structuredClone(f.params); params.callId += n; params.arguments.form.title += n; assert.equal((await handlePersonalCalendarCall(params, f.job, f.actions)).success, n < 3); }
  assert.equal((await createCalendarProposalStore(f.options).list()).length, 3); assert.equal(f.runtime.writes(), 0);
  const failed = fixture(); failed.setState({ version: 1, proposals: [] }); const before = structuredClone(failed.state()); failed.failSave();
  const result = await handlePersonalCalendarCall(failed.params, failed.job, failed.actions); assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-FILE-ERROR/); assert.deepEqual(failed.state(), before);
});

test("history projects only matching native source receipts and never presents draft saving as event creation", async () => {
  const f = fixture(), result = await handlePersonalCalendarCall(f.params, f.job, f.actions), native = message(f, result);
  let item = (await f.store.list())[0]; item = await f.store.edit(item.id, item.revision, { ...item.payload, title: "用户修改标题" });
  const project = (msg = native, list = [item]) => personalCalendarProposalMessages([msg], f.job.threadId, list)[0];
  assert.equal(project().details.personalCalendarProposal.available, true); assert.equal(project().details.personalCalendarProposal.status, "draft"); assert.match(project().text, /用户修改标题/); assert.doesNotMatch(project().text, /已创建/);
  for (const changed of [
    { ...native, id: "wrong-call" }, { ...native, turnId: "other-turn" }, { ...native, details: { ...native.details, status: "inProgress" } }, { ...native, details: { ...native.details, success: false } },
    { ...native, details: { ...native.details, arguments: { ...f.params.arguments, form: { ...form, title: "伪造原始内容" } } } },
  ]) assert.equal(project(changed).details.personalCalendarProposal, undefined);
  assert.equal(project(native, []).details.personalCalendarProposal.available, false); assert.equal(project(native, null).details.personalCalendarProposal.available, false);
});

test("legacy records stay untouched on read; model format blocks older rollback and malformed provenance fails closed", async t => {
  const f = fixture(); f.setState({ version: 1, proposals: [] }); await f.store.list(); assert.equal(f.saves(), 0); assert.equal(f.state().version, 1);
  await handlePersonalCalendarCall(f.params, f.job, f.actions); const state = structuredClone(f.state()), saves = f.saves();
  f.state().proposals[0].origin.threadId = "forged"; await assert.rejects(f.actions.list()); assert.equal(f.saves(), saves); f.setState(state);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-calendar-model-rollback-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, "previous"); await fs.mkdir(path.join(previous, "server"), { recursive: true });
  const file = path.join(root, "personal-calendar-proposals.json"); await fs.writeFile(file, JSON.stringify(state)); const original = await fs.readFile(file, "utf8");
  const script = new URL("../ops/check-task-rollback.mjs", import.meta.url).pathname;
  await fs.writeFile(path.join(previous, "server/personal-calendar-proposals.mjs"), "export const calendarProposalFormatVersion=1;\n");
  assert.throws(() => execFileSync(process.execPath, [script, root, previous], { stdio: "pipe" }), error => /不能自动回退/.test(String(error.stderr)));
  await fs.writeFile(path.join(previous, "server/personal-calendar-proposals.mjs"), "export const calendarProposalFormatVersion=2;\n");
  execFileSync(process.execPath, [script, root, previous], { stdio: "pipe" }); assert.equal(await fs.readFile(file, "utf8"), original);
});
