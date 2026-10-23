import assert from "node:assert/strict";
import test from "node:test";
import { calendarDayWindow, calendarSourceLimits, createPersonalCalendarSource, normalizeCalendarEvent, readTodayCalendar } from "../server/personal-calendar.mjs";

const now = Date.parse("2026-10-23T09:00:00Z");
const window = calendarDayWindow("Asia/Shanghai", now);
const event = (id = "event-1", extra = {}) => ({ id, summary: "核对申请材料", status: "confirmed", htmlLink: "https://calendar.google.com/calendar/event?eid=test",
  updated: "2026-10-23T08:00:00Z", start: { dateTime: "2026-10-23T23:50:00+08:00", timeZone: "Asia/Shanghai" }, end: { dateTime: "2026-10-23T23:55:00+08:00", timeZone: "Asia/Shanghai" }, ...extra });
const catalog = () => ({ data: [{ name: "codex_apps", httpOrigin: "https://chatgpt.com", tools: { "google_calendar.search": {
  name: "google_calendar.search", annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { type: "object", properties: { calendar_id: { const: "primary" }, time_min: { type: "string" }, time_max: { type: "string" }, max_results: { const: 50 }, next_page_token: { type: "string" } }, required: ["time_min", "time_max"], additionalProperties: false },
  _meta: { connector_id: "calendar", link_id: "account-1", link_owner_profile: { email: "calendar@example.test" } },
} } }], nextCursor: null });
function fixture() {
  let clock = now, value = { version: 1, snapshot: null, lastAttempt: null }, reads = 0, writes = 0, gate = null;
  const calls = [], payloads = [{ events: [event()], next_page_token: null }];
  const tools = catalog();
  let installed = true, resultError = null;
  const request = async (method, params, timeout) => {
    calls.push({ method, params, timeout });
    assert.ok(timeout > 0 && timeout <= calendarSourceLimits.timeoutMs);
    if (method === "thread/start") return { thread: { id: "temporary-thread", ephemeral: true } };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "mcpServerStatus/list") return structuredClone(tools);
    if (method === "app/installed") return { apps: [{ id: "calendar", enabled: installed, callable: installed }] };
    if (method === "mcpServer/tool/call") {
      reads++;
      if (gate) await gate;
      if (resultError) return resultError;
      return { structuredContent: payloads.shift() || { events: [event()], next_page_token: null }, content: [] };
    }
    throw new Error("Unexpected native operation: " + method);
  };
  const read = async () => structuredClone(value), write = async next => { writes++; value = structuredClone(next); };
  const options = { read, write, request, context: () => ({ cwd: "/personal", model: "gpt-6-sol" }), now: () => clock };
  const source = createPersonalCalendarSource(options);
  return { source, options, calls, tools, payloads, request, setInstalled: next => { installed = next; }, setResultError: next => { resultError = next; },
    setValue: next => { value = next; }, value: () => value, advance: ms => { clock += ms; }, setGate: next => { gate = next; }, reads: () => reads, writes: () => writes };
}

test("calendar day uses the actual 23/25-hour local day and validates the requested zone", () => {
  assert.equal(window.from, "2026-10-22T16:00:00.000Z"); assert.equal(window.to, "2026-10-23T16:00:00.000Z");
  for (const [at, hours] of [["2026-03-08T12:00:00Z", 23], ["2026-11-01T12:00:00Z", 25]]) {
    const day = calendarDayWindow("America/New_York", Date.parse(at));
    assert.equal((Date.parse(day.to) - Date.parse(day.from)) / 3600000, hours);
  }
  for (const zone of [undefined, "", "Bad/Zone", "x".repeat(81), {}]) assert.throws(() => calendarDayWindow(zone, now), { code: "invalid_time_zone" });
});

test("event normalization preserves original time, source identity and stable version without private extras", () => {
  const raw = event("one", { description: "private full description", attendees: [{ email: "private@example.test" }] });
  const item = normalizeCalendarEvent(raw);
  assert.equal(item.start.dateTime, raw.start.dateTime); assert.equal(item.start.timeZone, "Asia/Shanghai");
  assert.equal(item.url, raw.htmlLink); assert.equal(item.id, raw.id); assert.equal(item.title, raw.summary);
  assert.equal(JSON.stringify(item).includes("private"), false);
  assert.equal(normalizeCalendarEvent(raw).version, item.version);
  assert.notEqual(normalizeCalendarEvent({ ...raw, summary: "变更" }).version, item.version);
  const allDay = normalizeCalendarEvent(event("all-day", { start: { date: "2026-10-23" }, end: { date: "2026-10-24" } }));
  assert.equal(allDay.start.date, "2026-10-23"); assert.equal(allDay.start.dateTime, null);
  assert.equal(normalizeCalendarEvent({ id: "cancelled", status: "cancelled" }), null);
  for (const link of ["javascript:alert(1)", "https://calendar.google.com.evil.test/", "https://user:secret@calendar.google.com/", "https://calendar.google.com:444/"]) assert.equal(normalizeCalendarEvent(event("unsafe", { htmlLink: link })).url, null);
  for (const invalid of [null, event("bad\n"), event("bad-time", { start: { dateTime: "2026-10-23T10:00:00" } }), event("bad-day", { start: { date: "2026-02-30" } }), event("mixed", { end: { date: "2026-10-24" } })]) assert.throws(() => normalizeCalendarEvent(invalid), { code: "calendar_shape_changed" });
});

test("explicit native reading is ephemeral, policy-bound and never starts a model or changes a calendar", async () => {
  const f = fixture();
  const before = await f.source.snapshot("Asia/Shanghai");
  assert.equal(before.snapshot, null); assert.equal(before.stale, true); assert.equal(f.calls.length, 0); assert.equal(f.writes(), 0);
  const result = await f.source.refresh("Asia/Shanghai");
  assert.equal(result.stale, false); assert.equal(result.reading, false); assert.equal(result.snapshot.items.length, 1);
  assert.equal(result.snapshot.account.label, "calendar@example.test"); assert.equal(result.snapshot.complete, true);
  assert.equal(f.calls[0].params.ephemeral, true); assert.equal(f.calls[0].params.sandbox, "read-only");
  assert.deepEqual(f.calls.map(call => call.method), ["thread/start", "mcpServerStatus/list", "app/installed", "mcpServer/tool/call", "thread/unsubscribe"]);
  const query = f.calls.find(call => call.method === "mcpServer/tool/call");
  assert.deepEqual(query.params.arguments, { calendar_id: "primary", time_min: window.from, time_max: window.to, max_results: 50 });
  assert.equal(query.params.tool, "google_calendar.search"); assert.equal(f.reads(), 1); assert.equal(f.writes(), 1);
  assert.equal(f.source.ownsThread("temporary-thread"), true);
  f.source.closedThread("temporary-thread"); assert.equal(f.source.ownsThread("temporary-thread"), false);
  const reopened = createPersonalCalendarSource(f.options);
  assert.deepEqual((await reopened.snapshot("Asia/Shanghai")).snapshot, result.snapshot);
  assert.equal(f.reads(), 1);
});

test("failed and revoked sources preserve the last successful snapshot without presenting it as fresh or empty", async () => {
  const f = fixture();
  const original = await f.source.refresh("Asia/Shanghai");
  f.advance(31000); f.setResultError({ isError: true, content: [{ type: "text", text: "FORBIDDEN PRIVATE_BACKEND_DETAIL" }] });
  const failed = await f.source.refresh("Asia/Shanghai");
  assert.equal(failed.stale, true); assert.equal(failed.lastAttempt.code, "calendar_authorization_required");
  assert.deepEqual(failed.snapshot, original.snapshot); assert.equal(JSON.stringify(failed).includes("PRIVATE_BACKEND_DETAIL"), false);
  f.advance(31000); f.setInstalled(false);
  const revoked = await f.source.refresh("Asia/Shanghai");
  assert.equal(revoked.lastAttempt.code, "calendar_not_connected"); assert.equal(f.reads(), 2);
  assert.deepEqual(revoked.snapshot, original.snapshot);
  f.advance(calendarSourceLimits.freshMs);
  assert.equal((await f.source.snapshot("Asia/Shanghai")).stale, true);
  assert.equal((await f.source.snapshot("America/New_York")).stale, true);
});

test("unsafe catalogs, unknown input fields and non-ephemeral runtimes never read account data", async () => {
  for (const change of [
    f => { f.tools.data[0].httpOrigin = "https://not-openai.test"; },
    f => { f.tools.data[0].tools["google_calendar.search"].annotations.readOnlyHint = false; },
    f => { f.tools.data[0].tools["google_calendar.search"].annotations.destructiveHint = true; },
    f => { f.tools.data[0].tools["google_calendar.search"].inputSchema.required.push("new-required-field"); },
  ]) {
    const f = fixture(); change(f);
    const result = await f.source.refresh("Asia/Shanghai");
    assert.equal(result.stale, true); assert.equal(result.snapshot, null); assert.equal(result.lastAttempt.status, "error"); assert.equal(f.reads(), 0);
  }
  const f = fixture();
  await assert.rejects(readTodayCalendar({ cwd: "/personal", window, now: () => now, request: async (method, params) => method === "thread/start" ? { thread: { id: "bad", ephemeral: false } } : f.request(method, params) }), { code: "calendar_runtime_unsupported" });
  assert.equal(f.reads(), 0);
});

test("calendar pagination deduplicates a stable source, rejects changes and marks truncated results incomplete", async () => {
  const f = fixture();
  f.payloads.splice(0, 1, { events: [event()], next_page_token: "page-2" }, { events: [event(), event("two")], next_page_token: null });
  const result = await f.source.refresh("Asia/Shanghai");
  assert.equal(result.snapshot.items.length, 2); assert.equal(result.snapshot.complete, true); assert.equal(f.reads(), 2);
  const different = fixture();
  different.payloads.splice(0, 1, { events: [event()], next_page_token: "page-2" }, { events: [event("event-1", { summary: "edited" })], next_page_token: null });
  assert.equal((await different.source.refresh("Asia/Shanghai")).lastAttempt.code, "calendar_changed_during_read");
  const incomplete = fixture();
  incomplete.payloads.splice(0, 1, { events: [event()], next_page_token: "page-2" }, { events: [event("two")], next_page_token: "page-3" });
  assert.equal((await incomplete.source.refresh("Asia/Shanghai")).snapshot.complete, false); assert.equal(incomplete.reads(), 2);
  const repeated = fixture();
  repeated.payloads.splice(0, 1, { events: [], next_page_token: "same" }, { events: [], next_page_token: "same" });
  assert.equal((await repeated.source.refresh("Asia/Shanghai")).lastAttempt.code, "calendar_pagination_invalid");
});

test("unsupported event data is a read failure, not an empty or freshly complete calendar", async () => {
  for (const payload of [{ events: [{ id: "missing-time" }] }, { events: [event("past", { start: { dateTime: "2026-10-22T01:00:00Z" }, end: { dateTime: "2026-10-22T02:00:00Z" } })] }, { unexpected: [] }, { events: [], next_page_token: 123 }]) {
    const f = fixture(); f.payloads[0] = payload;
    const result = await f.source.refresh("Asia/Shanghai");
    assert.equal(result.snapshot, null); assert.equal(result.stale, true); assert.equal(result.lastAttempt.status, "error");
  }
  const f = fixture(); f.payloads[0] = { events: [], next_page_token: null };
  const result = await f.source.refresh("Asia/Shanghai");
  assert.equal(result.snapshot.items.length, 0); assert.equal(result.snapshot.complete, true); assert.equal(result.stale, false);
});

test("concurrent refreshes coalesce, different windows conflict, and corrupt storage is not replaced", async () => {
  const f = fixture(); let release;
  f.setGate(new Promise(resolve => { release = resolve; }));
  const first = f.source.refresh("Asia/Shanghai"), same = f.source.refresh("Asia/Shanghai");
  await assert.rejects(f.source.refresh("UTC"), { code: "calendar_refresh_busy" });
  assert.equal(f.source.activeCount(), 1);
  release(); assert.deepEqual(await same, await first); assert.equal(f.reads(), 1); assert.equal(f.source.activeCount(), 0);
  await assert.rejects(f.source.refresh("Asia/Shanghai"), { code: "calendar_refresh_throttled" }); assert.equal(f.reads(), 1);
  f.setValue({ version: 99, private: "preserve-me" });
  await assert.rejects(f.source.snapshot("UTC"), { code: "calendar_cache_invalid" });
  await assert.rejects(f.source.refresh("UTC"), { code: "calendar_cache_invalid" });
  assert.equal(f.value().private, "preserve-me"); assert.equal(f.reads(), 1);
});

test("fall-back clock sorting follows actual instants and successful repeated reads keep stable versions", async () => {
  const f = fixture(), fall = Date.parse("2026-11-01T12:00:00Z"), day = calendarDayWindow("America/New_York", fall);
  f.payloads[0] = { events: [event("later", { start: { dateTime: "2026-11-01T01:15:00-05:00" }, end: { dateTime: "2026-11-01T01:30:00-05:00" } }), event("earlier", { start: { dateTime: "2026-11-01T01:45:00-04:00" }, end: { dateTime: "2026-11-01T01:55:00-04:00" } })] };
  const read = await readTodayCalendar({ request: f.request, cwd: "/personal", window: day, now: () => fall });
  assert.deepEqual(read.items.map(item => item.id), ["earlier", "later"]);
  const original = await f.source.refresh("Asia/Shanghai"); f.advance(31000);
  assert.equal((await f.source.refresh("Asia/Shanghai")).snapshot.version, original.snapshot.version);
});

test("corrupt event content, account and snapshot versions never become trusted cached sources", async () => {
  for (const corrupt of [
    s => { s.items[0].title = "silently edited"; }, s => { s.items[0].end = s.items[0].start; },
    s => { s.account.id = {}; }, s => { s.version = "0".repeat(64); },
    s => { s.items[0].extra = "unexpected private field"; },
  ]) {
    const f = fixture(); await f.source.refresh("Asia/Shanghai");
    corrupt(f.value().snapshot); const previous = structuredClone(f.value()); f.advance(31000);
    await assert.rejects(f.source.snapshot("Asia/Shanghai"), { code: "calendar_cache_invalid" });
    await assert.rejects(f.source.refresh("Asia/Shanghai"), { code: "calendar_cache_invalid" });
    assert.deepEqual(f.value(), previous); assert.equal(f.reads(), 1);
  }
  for (const bad of ["2026-02-30T10:00:00Z", "Oct 23 2026 10:00:00Z", "2026-10-23T24:00:00Z"]) assert.throws(() => normalizeCalendarEvent(event("bad", { start: { dateTime: bad } })), { code: "calendar_shape_changed" });
  assert.equal(normalizeCalendarEvent(event("long-url", { htmlLink: "https://calendar.google.com/" + "x".repeat(2048) })).url, null);
});

test("timeouts release read admission, sanitize errors and retain the old source without retrying data", async () => {
  const f = fixture(); await f.source.refresh("Asia/Shanghai"); f.advance(31000);
  let dataCalls = 0, cleanupCalls = 0;
  const request = async (method, params, timeout) => {
    if (method === "mcpServer/tool/call") { dataCalls++; throw new Error("RPC timeout PRIVATE_CONTEXT"); }
    if (method === "thread/unsubscribe") cleanupCalls++;
    return f.request(method, params, timeout);
  };
  const source = createPersonalCalendarSource({ ...f.options, request });
  const result = await source.refresh("Asia/Shanghai");
  assert.equal(result.stale, true); assert.equal(result.snapshot.items.length, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE_CONTEXT"), false);
  assert.equal(dataCalls, 1); assert.equal(cleanupCalls, 1); assert.equal(source.activeCount(), 0);
});

test("multiple linked calendars or invalid source identifiers require an explicit source choice before reading", async () => {
  const f = fixture();
  f.tools.data[0].tools["another_calendar.search"] = { _meta: { connector_id: "calendar", link_id: "other-account" } };
  const result = await f.source.refresh("Asia/Shanghai");
  assert.equal(result.lastAttempt.code, "calendar_account_ambiguous"); assert.equal(f.reads(), 0);
  const invalid = fixture(); invalid.tools.data[0].tools["google_calendar.search"]._meta.link_id = {};
  assert.equal((await invalid.source.refresh("Asia/Shanghai")).lastAttempt.code, "calendar_not_connected");
  assert.equal(invalid.reads(), 0);
  const consolidated = fixture();
  consolidated.tools.data[0].tools["google_calendar.search"]._meta.link_accounts = [{ link_id: "account-1" }, { link_id: "account-2" }];
  assert.equal((await consolidated.source.refresh("Asia/Shanghai")).lastAttempt.code, "calendar_account_ambiguous");
  assert.equal(consolidated.reads(), 0);
});

test("observed Calendar connector strings and web_link become verifiable sources without inventing an original time zone", async () => {
  const f = fixture();
  const observed = { id: "synthetic-observed-event", summary: "Codex Cloud 验收测试（自动清理）", status: "confirmed", start: "2026-10-23T15:50:00Z", end: "2026-10-23T15:55:00Z",
    web_link: "https://www.google.com/calendar/event?eid=synthetic", description: "untrusted description is not copied", organizer: { email: "not-copied@example.test" }, attendees: null, reminders: null };
  f.payloads[0] = { events: [observed], next_page_token: null };
  const result = await f.source.refresh("Asia/Shanghai"), item = result.snapshot.items[0];
  assert.equal(result.stale, false); assert.equal(item.start.dateTime, observed.start); assert.equal(item.start.timeZone, null);
  assert.equal(item.url, observed.web_link); assert.equal(JSON.stringify(item).includes("not-copied"), false);
  assert.deepEqual((await f.source.snapshot("Asia/Shanghai")).snapshot.items[0], item);
  assert.deepEqual(normalizeCalendarEvent(event("string-all-day", { start: "2026-10-23", end: "2026-10-24" })).start, { date: "2026-10-23", dateTime: null, timeZone: null });
  for (const start of ["2026-02-30", "2026-10-23T15:50:00", "2026-10-23T24:00:00Z", "tomorrow"]) assert.throws(() => normalizeCalendarEvent({ ...observed, start }), { code: "calendar_shape_changed" });
});
