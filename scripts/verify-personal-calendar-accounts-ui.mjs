import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { calendarDayWindow, calendarSourceLimits, normalizeCalendarEvent } from "../server/personal-calendar.mjs";
import { personalFeedbackConsole } from "./fixtures/personal-feedback-console.mjs";

const fixture = await personalFeedbackConsole();
const out = process.env.CODEX_CLOUD_UI_EVIDENCE_DIR;
const timeZone = "Asia/Shanghai", now = Date.now(), window = calendarDayWindow(timeZone, now);
const account = { id: "calendar-one", label: "calendar@example.test" };
const items = [normalizeCalendarEvent({ id: "synthetic-calendar-item", summary: "合成日程：核对材料",
  start: new Date(Date.parse(window.from) + 3600000).toISOString(), end: new Date(Date.parse(window.from) + 7200000).toISOString() })];
const snapshot = { provider: "google-calendar", calendarId: "primary", account, window, complete: true, items,
  fetchedAt: new Date(now - 31000).toISOString(), expiresAt: new Date(now - 31000 + calendarSourceLimits.freshMs).toISOString(),
  version: createHash("sha256").update(JSON.stringify({ account: account.id, window, items, complete: true })).digest("hex") };
const file = path.join(fixture.state, "personal-calendar-source.json");
const observations = [], errors = [];
let browser;
try {
  if (out) await fs.mkdir(out, { recursive: true });
  const control = JSON.parse(await fs.readFile(fixture.control, "utf8"));
  const meta = { connector_id: "fixture-calendar", link_id: account.id, link_owner_profile: { email: account.label } };
  control.calendar = { tools: {
    "google_calendar.search": { name: "google_calendar.search", _meta: meta, annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { type: "object", properties: { calendar_id: { const: "primary" }, time_min: { type: "string" }, time_max: { type: "string" }, max_results: { const: 50 } }, required: ["time_min", "time_max"], additionalProperties: false } },
    "google_calendar.read_event": { _meta: { ...meta, link_accounts: [{ link_id: account.id }, { link_id: "calendar-two" }] } },
  } };
  await fs.writeFile(fixture.control, JSON.stringify(control));
  await fs.writeFile(file, JSON.stringify({ version: 1, snapshot, lastAttempt: { at: snapshot.fetchedAt, status: "success", code: null, error: null } }), { mode: 0o600 });
  const before = await fixture.request("/api/personal/calendar?timeZone=Asia%2FShanghai");
  assert.equal(before.status, 200); assert.equal(before.body.calendar.stale, false);
  const history = JSON.parse(await fs.readFile(path.join(fixture.state, "chat-history.json"), "utf8"));
  for (const [id, session] of Object.entries(history.sessions)) {
    const response = await fixture.request(`/api/chat/sessions/${id}/draft?repoId=${encodeURIComponent(session.repoId)}`);
    assert.equal(response.status, 200);
    session.draft = response.body.draft;
  }
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ url: fixture.base + "/#/project/_personal/today", stateDirectory: fixture.state,
      rpcCapture: fixture.rpcCapture, scenario: "合成新鲜缓存；同一日历连接的其他工具声明多个账号；手动刷新应在读取数据前拒绝", stop: "SIGTERM this process" }));
    await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  } else {
    browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
    const context = await browser.newContext({ timezoneId: timeZone });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(fixture.base + "/#/project/_personal/today");
    const region = page.getByRole("region", { name: "今日日程", exact: true });
    await region.getByRole("button", { name: "规划今天", exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: "规划今天", exact: true }).isEnabled(), true);
    await region.getByRole("button", { name: "刷新日程", exact: true }).click();
    await region.getByRole("alert").filter({ hasText: "连接了多个日历账号或来源无法确认" }).waitFor();
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await region.getByRole("alert").filter({ hasText: "连接了多个日历账号或来源无法确认" }).waitFor();
      assert.equal(await region.getByRole("button", { name: "规划今天", exact: true }).isDisabled(), true);
      await region.getByText(items[0].title, { exact: true }).waitFor();
      await region.getByRole("button", { name: "检查连接服务", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      observations.push({ width, text: await region.innerText() });
      if (out) await region.screenshot({ path: path.join(out, `accounts-${width}.png`) });
    }
    await fixture.restart();
  }
  const after = await fixture.request("/api/personal/calendar?timeZone=Asia%2FShanghai");
  assert.equal(after.status, 200); assert.equal(after.body.calendar.stale, true);
  assert.equal(after.body.calendar.lastAttempt.code, "calendar_account_ambiguous");
  assert.deepEqual(after.body.calendar.snapshot, snapshot);
  const afterHistory = JSON.parse(await fs.readFile(path.join(fixture.state, "chat-history.json"), "utf8"));
  for (const [id, session] of Object.entries(history.sessions)) {
    assert.deepEqual(afterHistory.sessions[id].draft, session.draft);
    for (const key of ["model", "reasoning", "sandbox", "approval"]) if (session[key] !== undefined) assert.equal(afterHistory.sessions[id][key], session[key]);
  }
  assert.equal((await fixture.request("/api/codex/app-host/status")).body.activeSourceReads, 0);
  const rpc = (await fs.readFile(fixture.rpcCapture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rpc.filter(item => ["mcpServer/tool/call", "turn/start", "turn/steer", "command/exec"].includes(item.method)).length, 0);
  assert.equal(rpc.filter(item => item.method === "thread/start").length, 1, "page reload and server restart cannot retry the source automatically");
  assert.deepEqual(errors, []);
  const result = { ok: true, cases: observations.length, observations, snapshotPreserved: true, draftsPreserved: true, sourceThreads: 1, dataReads: 0, modelTurns: 0 };
  if (out) await fs.writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await fixture.stop(); }
