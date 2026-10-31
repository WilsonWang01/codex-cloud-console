import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCalendarProposalStore, calendarProposalPayload, calendarProposalForm, calendarCreateArguments, calendarAvailabilityDigest, calendarContentDigest, calendarModelClientKey } from "../server/personal-calendar-proposals.mjs";
import { createPersonalCalendarActions, verifiedCalendarReceipt } from "../server/personal-calendar-actions.mjs";
import { createCalendarActionFixture } from "./fixtures/calendar-action-runtime.mjs";
import { createApprovalBroker } from "../server/approval-broker.mjs";

const start = Date.parse("2026-10-24T00:00:00Z");
const form = (extra = {}) => ({ title: "合成日程提案", timeZone: "Asia/Shanghai", startLocal: "2026-10-25T23:50", endLocal: "2026-10-25T23:55", ...extra });
const target = { connectorId: "fixture-calendar", linkId: "fixture-link", email: "calendar@example.test", calendarId: "primary", contract: "a".repeat(64) };
function fixture() {
  let state = null, clock = start, saved = 0, failSave = false;
  const runtime = createCalendarActionFixture({ now: () => clock });
  const options = { read: async () => structuredClone(state), write: async value => { if (failSave) throw new Error("Synthetic storage unavailable"); saved++; state = structuredClone(value); }, now: () => clock };
  const store = createCalendarProposalStore(options), actions = createPersonalCalendarActions({ store, request: runtime.request, context: () => ({ cwd: "/synthetic-personal", model: "gpt-6-sol" }), now: () => clock });
  return { store, actions, runtime, saved: () => saved, state: () => state, setState: value => { state = value; }, options, advance: ms => { clock += ms; }, failSave: () => { failSave = true; } };
}
const confirmation = item => ({ revision: item.revision, digest: item.preview.digest, confirm: true });
const availability = (payload, extra = {}) => ({ version: calendarAvailabilityDigest(target, payload, []), checkedAt: new Date(start).toISOString(), conflicts: [], complete: true, ...extra });
const draft = f => f.actions.create(crypto.randomUUID(), calendarProposalPayload(form()));

test("calendar actions reject ambiguous account lists on every used tool before reading a profile or saving a draft", async () => {
  for (const tool of ["search", "get_profile", "read_event", "create_event"]) {
    for (const links of [[], [{ link_id: "other-link" }], [{ link_id: "fixture-link" }, { link_id: "other-link" }], {}]) {
      const f = fixture();
      const actions = createPersonalCalendarActions({ store: f.store, context: () => ({ cwd: "/synthetic-personal" }), now: () => start,
        request: async (method, params) => {
          const result = await f.runtime.request(method, params);
          if (method === "mcpServerStatus/list") result.data[0].tools[`google_calendar.${tool}`]._meta.link_accounts = links;
          return result;
        },
      });
      await assert.rejects(actions.create(crypto.randomUUID(), calendarProposalPayload(form())), { code: "calendar_account_ambiguous" });
      assert.equal(f.runtime.calls.some(call => call.method === "mcpServer/tool/call"), false);
      assert.equal(f.runtime.writes(), 0); assert.deepEqual(await f.store.list(), []);
    }
  }
  const f = fixture();
  let boundLinks = [{ link_id: "fixture-link" }];
  const actions = createPersonalCalendarActions({ store: f.store, context: () => ({ cwd: "/synthetic-personal" }), now: () => start,
    request: async (method, params) => {
      const result = await f.runtime.request(method, params);
      if (method === "mcpServerStatus/list") for (const tool of Object.values(result.data[0].tools)) tool._meta.link_accounts = boundLinks;
      return result;
    },
  });
  const item = await actions.create(crypto.randomUUID(), calendarProposalPayload(form()));
  assert.equal(item.target.email, "calendar@example.test");
  const preview = await actions.preview(item.id, item.revision);
  boundLinks = [{ link_id: "fixture-link" }, { link_id: "other-link" }];
  await assert.rejects(actions.execute(item.id, confirmation(preview)), { code: "calendar_account_ambiguous" });
  assert.equal((await f.store.get(item.id)).attempted, false);
  assert.equal(f.runtime.writes(), 0);
});

test("calendar wall times reject gaps, require explicit repeated offsets and preserve all-day exclusive ends", () => {
  const p = calendarProposalPayload(form()); assert.equal(p.start, "2026-10-25T15:50:00.000Z"); assert.deepEqual(calendarProposalPayload(calendarProposalForm(p)), p);
  assert.throws(() => calendarProposalPayload(form({ timeZone: "America/New_York", startLocal: "2026-03-08T02:30", endLocal: "2026-03-08T04:00" })), { code: "calendar_time_invalid" });
  assert.throws(() => calendarProposalPayload(form({ timeZone: "America/New_York", startLocal: "2026-11-01T01:10", endLocal: "2026-11-01T01:30" })), error => error.code === "calendar_time_ambiguous" && error.details.offsets.length === 2);
  const repeated = calendarProposalPayload(form({ timeZone: "America/New_York", startLocal: "2026-11-01T01:10", endLocal: "2026-11-01T01:30", startOffset: -300, endOffset: -300 })); assert.equal(repeated.start, "2026-11-01T06:10:00.000Z"); assert.deepEqual(calendarProposalPayload(calendarProposalForm(repeated)), repeated);
  const all = calendarProposalPayload(form({ allDay: true, startLocal: "2026-10-25", endLocal: "2026-10-26" })); assert.equal(all.end, "2026-10-26"); assert.equal(calendarCreateArguments(all).end_date, all.end);
  for (const changes of [{ timeZone: "invalid" }, { title: "" }, { startLocal: "2026-02-30T10:00" }, { endLocal: "2026-10-25T23:40" }, { endLocal: "2026-11-15T23:55" }, { attendees: ["a@example.test", "A@example.test"] }, { autoSend: true }]) assert.throws(() => calendarProposalPayload(form(changes)));
});

test("draft creation retries use one original key and never call create or a model; edits are revision-bound", async () => {
  const f = fixture(), key = crypto.randomUUID(), payload = calendarProposalPayload(form());
  const one = await f.actions.create(key, payload), replay = await f.actions.create(key, payload);
  assert.equal(one.id, replay.id); assert.equal((await f.actions.list()).length, 1); assert.equal(f.runtime.writes(), 0);
  const edited = await f.actions.update(one.id, { revision: one.revision, payload: calendarProposalPayload(form({ title: "修改" })) });
  await assert.rejects(f.actions.update(one.id, { revision: one.revision, status: "deferred" }), { statusCode: 409 });
  assert.equal((await f.actions.create(key, payload)).payload.title, "修改");
  await assert.rejects(f.actions.create(key, edited.payload), { statusCode: 409 });
  assert.equal(f.runtime.calls.some(item => item.method === "turn/start"), false);
  assert.equal(f.runtime.calls.filter(item => item.method === "thread/start").every(item => item.params.ephemeral && item.params.sandbox === "read-only"), true);
});

test("preview and exact confirmation perform one create with explicit side effects and a verified receipt", async () => {
  const f = fixture(), item = await draft(f), preview = await f.actions.preview(item.id, item.revision), input = confirmation(preview);
  assert.equal(f.runtime.writes(), 0); assert.equal(preview.target.email, "calendar@example.test");
  const result = await f.actions.execute(item.id, input);
  assert.equal(result.status, "succeeded"); assert.equal(result.receipt.source, "google_calendar.read_event");
  assert.equal(f.runtime.calls.some(call => call.params?.tool === "google_calendar.fetch"), false);
  assert.equal(f.state().version, 3);
  assert.equal(f.runtime.writes(), 1); assert.equal(f.actions.jobs().length, 0);
  assert.equal((await f.actions.execute(item.id, input)).id, item.id); assert.equal(f.runtime.writes(), 1);
  await assert.rejects(f.actions.update(item.id, { revision: result.revision, payload: item.payload }), { code: "calendar_proposal_attempted" });
  await assert.rejects(f.actions.remove(item.id, result.revision), { code: "calendar_proposal_attempted" });
  const args = f.runtime.calls.find(call => call.params?.tool === "google_calendar.create_event").params.arguments;
  assert.equal(args.add_google_meet, false); assert.deepEqual(args.reminders, { use_default: false, overrides: [] }); assert.deepEqual(args.attendees, []); assert.equal(args.visibility, "private"); assert.equal(args.guests_can_modify, false);
  assert.equal(f.runtime.calls.at(-1).method, "thread/unsubscribe");
});

test("editing, account changes, expired preview and changed conflicts all invalidate confirmation before a write", async () => {
  for (const mode of ["edit", "account", "expired", "conflict", "incomplete", "missing-confirm"]) {
    const f = fixture(), item = await draft(f), preview = await f.actions.preview(item.id, item.revision), input = confirmation(preview);
    if (mode === "edit") await f.actions.update(item.id, { revision: preview.revision, payload: calendarProposalPayload(form({ title: "新内容" })) });
    if (mode === "account") f.runtime.setAccount("other@example.test", "other-link");
    if (mode === "expired") f.advance(300001);
    if (["conflict", "incomplete"].includes(mode)) f.runtime.setMode(mode);
    if (mode === "missing-confirm") input.confirm = false;
    await assert.rejects(f.actions.execute(item.id, input)); assert.equal(f.runtime.writes(), 0, mode);
    assert.equal((await f.actions.list())[0].attempted, false);
  }
});

test("full-detail contract is required before any calendar write; missing guest permissions stay uncertain", async () => {
  for (const mode of ["missing", "wrong-permissions"]) {
    const f = fixture();
    const actions = createPersonalCalendarActions({ store: f.store, context: () => ({}), now: () => start, request: async (method, params) => {
      const result = await f.runtime.request(method, params);
      if (method === "mcpServerStatus/list") {
        if (mode === "missing") delete result.data[0].tools["google_calendar.read_event"];
        else result.data[0].tools["google_calendar.read_event"].annotations.readOnlyHint = false;
      }
      return result;
    } });
    await assert.rejects(actions.create(crypto.randomUUID(), calendarProposalPayload(form())), { code: "calendar_contract_changed" });
    assert.equal(f.runtime.writes(), 0); assert.deepEqual(await f.store.list(), []);
  }
  const f = fixture(), item = await draft(f), preview = await f.actions.preview(item.id, item.revision);
  f.runtime.setMode("missing-guests");
  const result = await f.actions.execute(item.id, confirmation(preview));
  assert.equal(result.status, "needs_reconciliation"); assert.equal(result.receipt, null);
  assert.match(result.error, /未返回来宾修改权限/); assert.equal(f.runtime.writes(), 1);
  await assert.rejects(f.actions.check(item.id, result.revision), /未返回来宾修改权限/);
  await f.actions.execute(item.id, confirmation(preview)); assert.equal(f.runtime.writes(), 1);
});

test("connector receipt aliases are supported without treating absent settings as verified defaults", async () => {
  const f = fixture(), item = await draft(f), preview = await f.actions.preview(item.id, item.revision), input = confirmation(preview);
  f.runtime.setMode("connector-partial");
  const result = await f.actions.execute(item.id, input);
  assert.equal(result.status, "needs_reconciliation"); assert.equal(result.receipt, null); assert.equal(f.runtime.writes(), 1);
  assert.match(result.error, /内容匹配.*未返回忙闲设置、来宾修改权限/);
  assert.equal(f.actions.jobs().length, 1);
  await f.actions.execute(item.id, input); assert.equal(f.runtime.writes(), 1);
  await assert.rejects(f.actions.check(item.id, result.revision), /未返回忙闲设置、来宾修改权限/);
  assert.equal(f.runtime.writes(), 1);
  const event = f.runtime.events()[0];
  const { guestsCanModify, ...rest } = event;
  const snake = { ...rest, guests_can_modify: guestsCanModify, description: "\n\n", location: null, hangout_link: "", conference_id: null, reminders: { use_default: false, overrides: [] } };
  assert.equal(verifiedCalendarReceipt(snake, item.payload, event.id).eventId, event.id);
  for (const patch of [{ status: "cancelled" }, { guestsCanModify: true }, { reminders: { use_default: false, useDefault: true, overrides: [] } }, { hangout_link: "https://meet.google.com/synthetic" }, { conference_id: "synthetic-meet" }, { transparency: "transparent" }, { recurrence: {} }, { attendees: undefined }, { attendees: [{ email: "unapproved@example.test", self: true }] }, { summary: item.payload.title + " " }]) {
    assert.throws(() => verifiedCalendarReceipt({ ...snake, ...patch }, item.payload, event.id), { code: "calendar_receipt_unverified" });
  }
  f.runtime.setMode("ok"); assert.equal((await f.actions.check(item.id, result.revision)).status, "succeeded");
  assert.equal(f.runtime.writes(), 1);
});

test("conflicts require their own explicit approval; defer/reject/rebind clear previews", async () => {
  const f = fixture(); f.runtime.setMode("conflict");
  const item = await draft(f), preview = await f.actions.preview(item.id, item.revision);
  assert.equal(preview.preview.availability.conflicts.length, 1);
  await assert.rejects(f.actions.execute(item.id, confirmation(preview)), { code: "calendar_conflicts_unconfirmed" });
  assert.equal((await f.actions.execute(item.id, { ...confirmation(preview), confirmConflicts: true })).status, "succeeded");
  for (const status of ["deferred", "rejected"]) {
    const another = await draft(f), checked = await f.actions.preview(another.id, another.revision), changed = await f.actions.update(another.id, { revision: checked.revision, status });
    assert.equal(changed.preview, null); await assert.rejects(f.actions.execute(another.id, confirmation(checked)));
    const restored = await f.actions.update(another.id, { revision: changed.revision, status: "draft" });
    const bound = await f.actions.rebind(another.id, restored.revision); assert.equal(bound.preview, null);
  }
});

test("old uncertain records can read full details after contract upgrade but cannot switch accounts or replay creation", async () => {
  const f = fixture(), item = await draft(f), preview = await f.actions.preview(item.id, item.revision), input = confirmation(preview);
  f.runtime.setMode("connector-partial"); const uncertain = await f.actions.execute(item.id, input);
  const state = structuredClone(f.state()); state.proposals[0].target.contract = "b".repeat(64); f.setState(state);
  f.runtime.setMode("ok");
  f.runtime.setAccount("different@example.test", "different-link");
  await assert.rejects(f.actions.check(item.id, uncertain.revision), { code: "calendar_connection_changed" });
  assert.equal(f.runtime.calls.some(call => call.params?.tool === "google_calendar.read_event" && call.params.threadId === f.runtime.calls.at(-1).params.threadId), false);
  f.runtime.setAccount("calendar@example.test", "fixture-link");
  assert.equal((await f.actions.check(item.id, uncertain.revision)).receipt.source, "google_calendar.read_event");
  await f.actions.execute(item.id, input); assert.equal(f.runtime.writes(), 1);
  assert.equal(f.runtime.calls.some(call => call.params?.tool === "google_calendar.fetch"), false);
});

test("claimed write and lost receipt are never replayed; uncertainty blocks publication and survives restart", async () => {
  for (const mode of ["lost-receipt", "fetch-failed", "mismatch"]) {
    const f = fixture(), item = await draft(f), checked = await f.actions.preview(item.id, item.revision), input = confirmation(checked);
    f.runtime.setMode(mode); const result = await f.actions.execute(item.id, input);
    assert.equal(result.status, "needs_reconciliation"); assert.equal(f.runtime.writes(), 1); assert.equal(f.actions.jobs().length, 1);
    const restarted = createCalendarProposalStore(f.options); assert.equal((await restarted.list())[0].status, "needs_reconciliation");
    await f.actions.execute(item.id, input); assert.equal(f.runtime.writes(), 1);
    if (mode !== "lost-receipt") { f.runtime.setMode("ok"); const receipt = await f.actions.check(item.id, result.revision); assert.equal(receipt.status, "succeeded"); assert.equal(f.runtime.writes(), 1); }
    else { const reviewed = await f.actions.reconcile(item.id, result.revision, "合成：已在原日历找到日程"); assert.equal(reviewed.status, "reconciled"); assert.equal(reviewed.receipt, null); assert.equal(f.actions.jobs().length, 0); }
  }
});

test("restart after durable claim marks uncertain; failed claim persistence never calls the external write", async () => {
  const f = fixture(), payload = calendarProposalPayload(form());
  let item = await f.store.create(crypto.randomUUID(), payload, target);
  item = await f.store.preview(item.id, item.revision, target, availability(payload));
  await f.store.claim(item.id, confirmation(item), target, availability(payload));
  const reopened = createCalendarProposalStore(f.options), recovered = (await reopened.list())[0];
  assert.equal(recovered.status, "needs_reconciliation"); assert.match(recovered.error, /未自动重试/);
  const other = fixture(), draftItem = await draft(other), checked = await other.actions.preview(draftItem.id, draftItem.revision);
  other.failSave(); await assert.rejects(other.actions.execute(draftItem.id, confirmation(checked))); assert.equal(other.runtime.writes(), 0);
});

test("corrupt or forged state is not overwritten and unknown receipts cannot be marked successful", async () => {
  const f = fixture(), item = await draft(f), original = structuredClone(f.state());
  for (const corrupt of [false, { version: 99, proposals: [] }, { ...original, proposals: [{ ...original.proposals[0], payload: { ...item.payload, start: "bad" } }] }]) {
    f.setState(corrupt); const saved = f.saved(); await assert.rejects(f.actions.list()); assert.equal(f.saved(), saved); assert.equal(f.actions.jobs().some(job => job.id === "calendar:invalid"), true);
  }
  f.setState(original); await f.actions.list(); assert.equal(f.actions.jobs().length, 0);
  for (const mode of ["revoked", "bad-origin"]) { f.runtime.setMode(mode); await assert.rejects(f.actions.preview(item.id, item.revision)); assert.equal(f.runtime.writes(), 0); }
  assert.throws(() => verifiedCalendarReceipt({ id: "only-id" }, item.payload, "only-id"));
});

test("tampered availability and unsupported confirmation fields fail before a durable claim", async () => {
  const f = fixture(), payload = calendarProposalPayload(form()), item = await f.store.create(crypto.randomUUID(), payload, target);
  await assert.rejects(f.store.preview(item.id, item.revision, target, availability(payload, { version: "b".repeat(64) })));
  const checked = await f.store.preview(item.id, item.revision, target, availability(payload));
  await assert.rejects(f.store.claim(item.id, { ...confirmation(checked), autoRetry: true }, target, availability(payload)));
  assert.equal((await f.store.get(item.id)).attempted, false);
});

test("concurrent execution is serialized, the durable claim precedes the tool, and only this thread's manual form can be approved", async () => {
  const f = fixture(), broker = createApprovalBroker(), unrelated = broker.request("mcpServer/elicitation/request", { threadId: "unrelated", mode: "form" }, { repoId: "work" });
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let actions;
  actions = createPersonalCalendarActions({ store: f.store, context: () => ({ cwd: "/synthetic-personal" }), now: () => start,
    closeApprovals: id => broker.closeForThread(id),
    request: async (method, params) => {
      if (params?.tool === "google_calendar.create_event") {
        assert.equal(f.state().proposals[0].status, "executing");
        const approval = { threadId: params.threadId, serverName: "codex_apps", mode: "form", message: "合成确认", requestedSchema: { type: "object" } };
        assert.equal(actions.canApprove("mcpServer/elicitation/request", approval), true);
        for (const change of [{ serverName: "other" }, { mode: "url" }, { threadId: "unrelated" }]) assert.equal(actions.canApprove("mcpServer/elicitation/request", { ...approval, ...change }), false);
        assert.equal(actions.canApprove("item/permissions/requestApproval", approval), false);
        const pending = broker.request("mcpServer/elicitation/request", approval, { repoId: "_personal" });
        entered(); await gate;
        const one = broker.list().find(item => item.params.threadId === params.threadId);
        broker.decide(one.id, { digest: one.digest, decision: "accept", content: { confirm: true } }); await pending;
      }
      return f.runtime.request(method, params);
    },
  });
  const item = await actions.create(crypto.randomUUID(), calendarProposalPayload(form())), preview = await actions.preview(item.id, item.revision), pending = actions.execute(item.id, confirmation(preview));
  await enteredPromise;
  assert.equal(actions.jobs().length, 1);
  await assert.rejects(actions.preview(item.id, preview.revision), { code: "calendar_action_busy" });
  assert.equal((await actions.execute(item.id, confirmation(preview))).status, "executing");
  release(); assert.equal((await pending).status, "succeeded"); assert.equal(f.runtime.writes(), 1);
  assert.equal(broker.list().length, 1); assert.equal(broker.list()[0].params.threadId, "unrelated"); broker.closeAll(); await unrelated;
});

test("ending one calendar thread declines only its pending native approvals", async () => {
  const broker = createApprovalBroker();
  const one = broker.request("mcpServer/elicitation/request", { threadId: "one", mode: "form" }, { repoId: "_personal" });
  const two = broker.request("mcpServer/elicitation/request", { threadId: "two", mode: "form" }, { repoId: "_personal" });
  broker.closeForThread("one"); assert.equal((await one).action, "decline"); assert.equal(broker.list().length, 1);
  broker.closeForThread("two"); assert.equal((await two).action, "decline");
});

test("saved proposal records block incompatible rollback before any task database exists", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-calendar-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, "previous"), file = path.join(root, "personal-calendar-proposals.json");
  await fs.mkdir(path.join(previous, "server"), { recursive: true });
  const f = fixture(); await draft(f); const original = JSON.stringify(f.state()); await fs.writeFile(file, original);
  const script = new URL("../ops/check-task-rollback.mjs", import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [script, root, previous], { stdio: "pipe" }), error => /日程提案.*不能自动回退/.test(String(error.stderr)));
  assert.equal(await fs.readFile(file, "utf8"), original);
  await fs.writeFile(path.join(previous, "server/personal-calendar-proposals.mjs"), "export const calendarProposalFormatVersion = 1;\n");
  execFileSync(process.execPath, [script, root, previous], { stdio: "pipe" });
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("detail receipts retain truthful provenance across restart, legacy reads and rollback protection", async t => {
  const f = fixture(), item = await draft(f), preview = await f.actions.preview(item.id, item.revision);
  const result = await f.actions.execute(item.id, confirmation(preview));
  const saved = structuredClone(f.state());
  assert.equal(saved.version, 3);
  assert.deepEqual((await createCalendarProposalStore(f.options).list())[0], result);
  for (const version of [1, 2]) {
    const legacy = structuredClone(saved); legacy.version = version; legacy.proposals[0].receipt.source = "google_calendar.fetch";
    f.setState(legacy); const writes = f.saved();
    assert.deepEqual(await createCalendarProposalStore(f.options).list(), legacy.proposals);
    assert.equal(f.saved(), writes); assert.deepEqual(f.state(), legacy);
    legacy.proposals[0].receipt.source = "google_calendar.read_event";
    f.setState(legacy); await assert.rejects(createCalendarProposalStore(f.options).list(), { code: "calendar_proposal_invalid" });
    assert.equal(f.saved(), writes);
  }
  f.setState(saved);
  const origin = { sessionId: "session", threadId: "thread", turnId: "turn", callId: "call", reason: "合成提案", contentDigest: calendarContentDigest(item.payload) };
  await f.store.create(calendarModelClientKey(origin), item.payload, target, { origin });
  assert.equal(f.state().version, 3, "adding a model draft must not downgrade detail receipts");
  assert.equal((await createCalendarProposalStore(f.options).list()).length, 2);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-calendar-detail-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, "previous"); await fs.mkdir(path.join(previous, "server"), { recursive: true });
  const file = path.join(root, "personal-calendar-proposals.json"), original = JSON.stringify(f.state()); await fs.writeFile(file, original);
  const script = new URL("../ops/check-task-rollback.mjs", import.meta.url).pathname;
  const module = path.join(previous, "server/personal-calendar-proposals.mjs");
  await fs.writeFile(module, "export const calendarProposalFormatVersion = 2;\n");
  assert.throws(() => execFileSync(process.execPath, [script, root, previous], { stdio: "pipe" }), error => /日程提案.*不能自动回退/.test(String(error.stderr)));
  assert.equal(await fs.readFile(file, "utf8"), original);
  await fs.writeFile(module, "export const calendarProposalFormatVersion = 3;\n");
  execFileSync(process.execPath, [script, root, previous], { stdio: "pipe" });
  assert.equal(await fs.readFile(file, "utf8"), original);
});
