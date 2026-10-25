import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await fs.readFile(new URL("../src/personal-source-freshness.ts", import.meta.url), "utf8");
const { personalSourceFresh } = await import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString("base64"));

test("邮件和日历共用实际时刻的过期边界，不依赖页面定时器", () => {
  const expiry = Date.parse("2026-10-25T08:05:00.000Z");
  const snapshot = { expiresAt: new Date(expiry).toISOString(), window: { date: "2026-10-25", timeZone: "Asia/Shanghai" } };
  assert.equal(personalSourceFresh(snapshot, "Asia/Shanghai", expiry - 1), true);
  for (const at of [expiry, expiry + 1, NaN, Infinity]) assert.equal(personalSourceFresh(snapshot, "Asia/Shanghai", at), false);
  for (const missing of [null, undefined, { ...snapshot, expiresAt: "invalid" }]) assert.equal(personalSourceFresh(missing, "Asia/Shanghai", expiry - 1), false);
  assert.equal(personalSourceFresh(snapshot, "UTC", expiry - 1), false);
});

test("来源仍在有效时长内也不能越过其当地日期或使用无效时区", () => {
  const midnight = Date.parse("2026-10-25T16:00:00.000Z");
  const snapshot = { expiresAt: new Date(midnight + 60000).toISOString(), window: { date: "2026-10-25", timeZone: "Asia/Shanghai" } };
  assert.equal(personalSourceFresh(snapshot, "Asia/Shanghai", midnight - 1), true);
  assert.equal(personalSourceFresh(snapshot, "Asia/Shanghai", midnight), false);
  assert.equal(personalSourceFresh({ ...snapshot, window: { ...snapshot.window, timeZone: "Invalid/Zone" } }, "Invalid/Zone", midnight - 1), false);
});
