import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { calendarDayWindow, normalizeCalendarEvent } from "../server/personal-calendar.mjs";
import { personalFeedbackConsole } from "./fixtures/personal-feedback-console.mjs";

const fixture = await personalFeedbackConsole();
const out = process.env.CODEX_CLOUD_UI_EVIDENCE_DIR;
const account = { id: "synthetic-calendar", label: "calendar@example.test" };
const window = calendarDayWindow("America/New_York", Date.parse("2026-11-01T06:45:00Z"));
const timed = (id, title, start, end, zone = "America/New_York") => normalizeCalendarEvent({ id, summary: title,
  start: { dateTime: start, ...(zone ? { timeZone: zone } : {}) }, end: { dateTime: end, ...(zone ? { timeZone: zone } : {}) } });
const items = [
  normalizeCalendarEvent({ id: "all-day", summary: "全天事项", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }),
  timed("before", "回拨前", "2026-11-01T01:30:00-04:00", "2026-11-01T01:45:00-04:00"),
  timed("cross", "跨回拨", "2026-11-01T01:50:00-04:00", "2026-11-01T01:10:00-05:00"),
  timed("unknown", "原时区未提供", "2026-11-01T01:15:00-05:00", "2026-11-01T01:20:00-05:00", null),
  timed("utc", "UTC 来源", "2026-11-01T06:20:00Z", "2026-11-01T06:25:00Z", null),
  timed("after", "回拨后", "2026-11-01T01:30:00-05:00", "2026-11-01T01:45:00-05:00"),
];
const snapshot = { provider: "google-calendar", calendarId: "primary", account, window,
  fetchedAt: "2026-11-01T06:45:00.000Z", expiresAt: "2026-11-01T06:50:00.000Z", complete: true, items,
  version: createHash("sha256").update(JSON.stringify({ account: account.id, window, items, complete: true })).digest("hex") };
const file = path.join(fixture.state, "personal-calendar-source.json");
const stored = JSON.stringify({ version: 1, snapshot, lastAttempt: { at: snapshot.fetchedAt, status: "success", code: null, error: null } });
const observations = [], errors = [];
let browser;
try {
  if (out) await fs.mkdir(out, { recursive: true });
  await fs.writeFile(file, stored, { mode: 0o600 });
  const history = await fs.readFile(path.join(fixture.state, "chat-history.json"), "utf8");
  const response = await fixture.request("/api/personal/calendar?timeZone=Asia%2FShanghai");
  assert.equal(response.status, 200); assert.deepEqual(response.body.calendar.snapshot, snapshot);
  assert.equal(response.body.calendar.stale, true);
  if (process.argv.includes("--serve-fixture")) {
    console.log(JSON.stringify({ url: fixture.base + "/#/project/_personal/today", stateDirectory: fixture.state, rpcCapture: fixture.rpcCapture,
      source: "合成纽约回拨日缓存；实际控制台后端，缓存因日期/时区不同已过期", model: "refused", connectors: "refused", stop: "SIGINT this process" }));
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
    for (const zone of ["America/New_York", "Asia/Shanghai"]) {
      const context = await browser.newContext({ timezoneId: zone });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error));
      await page.clock.setFixedTime(new Date("2026-11-01T06:45:00Z"));
      for (const [width, height] of [[1280, 900], [768, 900], [390, 844], [320, 640]]) {
        await page.setViewportSize({ width, height });
        await page.goto(fixture.base + "/#/project/_personal/today");
        const calendar = page.getByRole("region", { name: "今日日程", exact: true });
        await calendar.getByText("跨回拨", { exact: true }).waitFor();
        await calendar.scrollIntoViewIfNeeded();
        const rows = calendar.locator(".personal-calendar-row");
        const observed = { zone, width, text: await calendar.innerText(), rows: await rows.allTextContents() };
        observations.push(observed);
        if (out) await calendar.screenshot({ path: path.join(out, `${zone.replaceAll("/", "-")}-${width}.png`) });
        try {
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "页面横向溢出");
          assert.deepEqual(await rows.locator("strong").allTextContents(), items.map(item => item.title));
          assert.match(observed.text, /全天 · 2026-11-01 至 2026-11-02（结束日不含）/);
          assert.match(observed.text, /来源偏移：-05:00；原日历时区未提供/);
          assert.match(observed.text, /来源偏移：UTC；原日历时区未提供/);
          assert.match(observed.text, /已过期或需核对/);
          assert.equal(await calendar.getByRole("button", { name: "规划今天", exact: true }).isDisabled(), true);
          for (const button of await calendar.getByRole("button").all()) {
            const box = await button.boundingBox();
            assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1, "操作区尺寸或边界无效");
          }
          const cross = rows.filter({ hasText: "跨回拨" });
          if (zone === "America/New_York") {
            assert.match(await cross.innerText(), /GMT-4 01:50.*GMT-5 01:10/);
            assert.match(await rows.filter({ hasText: "回拨前" }).innerText(), /GMT-4 01:30/);
            assert.match(await rows.filter({ hasText: "回拨后" }).innerText(), /GMT-5 01:30/);
            assert.equal(await calendar.getByText(/原日程时区/).count(), 0);
          } else {
            assert.match(await cross.innerText(), /GMT\+8 13:50.*GMT\+8 14:10/);
            assert.match(await cross.innerText(), /原日程时区：America\/New_York/);
            assert.match(observed.text, /Asia\/Shanghai · 读取于 .*GMT\+8 14:45/);
          }
        } catch (error) { errors.push(new Error(`${zone}/${width}: ${error.message}`)); }
      }
      await context.close();
    }
  }
  assert.equal(await fs.readFile(file, "utf8"), stored, "页面不得改写日历原记录");
  const afterHistory = JSON.parse(await fs.readFile(path.join(fixture.state, "chat-history.json"), "utf8"));
  for (const [id, session] of Object.entries(JSON.parse(history).sessions)) {
    for (const [key, value] of Object.entries(session.draft)) assert.deepEqual(afterHistory.sessions[id].draft[key], value, "原草稿必须保留");
  }
  const rpc = (await fs.readFile(fixture.rpcCapture, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const inference = rpc.filter(item => ["turn/start", "turn/steer", "mcpServer/tool/call", "command/exec"].includes(item.method));
  assert.equal(inference.length, 0);
  if (out) await fs.writeFile(path.join(out, "result.json"), JSON.stringify({ ok: errors.length === 0, observations, errors: errors.map(error => error.message), inference: inference.length, sourcePreserved: true, draftsPreserved: true }, null, 2));
  if (errors.length) throw new AggregateError(errors, `${errors.length} 个时区/尺寸场景失败`);
  console.log(JSON.stringify({ ok: true, cases: observations.length, inference: 0, sourcePreserved: true, draftsPreserved: true }));
} finally { await browser?.close(); await fixture.stop(); }
