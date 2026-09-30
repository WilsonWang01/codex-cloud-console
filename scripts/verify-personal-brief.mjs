import assert from "node:assert/strict";
import test from "node:test";
import { buildPersonalBrief, inPersonalQuietHours, normalizePersonalReminderSettings, personalReminderItems } from "../server/personal-brief.mjs";

const now = new Date("2026-09-27T10:00:00.000Z");
const commitments = [
  { id: "due", title: "续签资料", nextStep: "核对", status: "active", dueAt: "2026-09-27T09:00:00.000Z", createdAt: "2026-09-25T09:00:00.000Z", updatedAt: "2026-09-25T09:00:00.000Z", sessionId: null },
  { id: "done", title: "准备材料", status: "done", dueAt: null, completedAt: "2026-09-27T08:00:00.000Z", createdAt: "2026-09-26T10:00:00.000Z", updatedAt: "2026-09-27T08:00:00.000Z", sessionId: "personal-1" },
  { id: "old", title: "旧事项", status: "active", dueAt: "2026-09-25T08:00:00.000Z", createdAt: "2026-09-25T08:00:00.000Z", updatedAt: "2026-09-25T08:00:00.000Z" },
  { id: "stale", title: "过期旧事项", status: "active", dueAt: "2026-09-18T08:00:00.000Z", createdAt: "2026-09-18T08:00:00.000Z", updatedAt: "2026-09-18T08:00:00.000Z" },
];

test("brief shows bounded, sourced changes after review without clearing newer events", () => {
  const runs = [
    { id: "personal-run", repoId: "_personal", name: "每日整理", status: "completed", finishedAt: "2026-09-27T09:30:00.000Z" },
    { id: "work-run", repoId: "sample-app", name: "工作任务", status: "failed", finishedAt: "2026-09-27T09:30:00.000Z" },
  ];
  const brief = buildPersonalBrief(commitments, runs, "2026-09-27T07:00:00.000Z", now);
  assert.equal(brief.total, 3);
  assert.deepEqual(brief.items.map((item) => item.title), ["每日整理", "续签资料", "准备材料"]);
  assert.equal(buildPersonalBrief(commitments, runs, brief.until, new Date(now.getTime() + 1000)).total, 0);
  assert.equal(buildPersonalBrief(commitments, [{ ...runs[0], id: "later", finishedAt: "2026-09-27T10:00:00.500Z" }], brief.until, new Date(now.getTime() + 1000)).total, 1);
});

test("reminders catch up after a short outage, exclude stale items, and hide private titles", () => {
  const reminders = personalReminderItems(commitments, now);
  assert.deepEqual(reminders.map((item) => item.id), [
    "personal-due:old:2026-09-25T08:00:00.000Z",
    "personal-due:due:2026-09-27T09:00:00.000Z",
  ]);
  assert.doesNotMatch(JSON.stringify(reminders), /续签资料|核对|旧事项|过期旧事项/);
  assert.equal(personalReminderItems([{ ...commitments[0], dueAt: "2026-09-20T10:00:00.000Z" }], now).length, 1);
  assert.equal(personalReminderItems([{ ...commitments[0], dueAt: "2026-09-20T09:59:59.999Z" }], now).length, 0);
  assert.equal(personalReminderItems(Array.from({ length: 7 }, (_, index) => ({ ...commitments[0], id: `due-${index}` })), now).length, 7);
});

test("quiet hours respect timezone, wrap midnight, and reject invalid settings", () => {
  const settings = normalizePersonalReminderSettings({ enabled: true, timeZone: "Asia/Shanghai", quietStart: "22:00", quietEnd: "08:00" });
  assert.equal(inPersonalQuietHours(settings, new Date("2026-09-27T15:00:00.000Z")), true);
  assert.equal(inPersonalQuietHours(settings, new Date("2026-09-27T01:00:00.000Z")), false);
  assert.equal(inPersonalQuietHours({ ...settings, quietStart: "09:00", quietEnd: "17:00" }, new Date("2026-09-27T02:00:00.000Z")), true);
  assert.equal(inPersonalQuietHours({ ...settings, quietStart: "08:00", quietEnd: "08:00" }, now), false);
  assert.throws(() => normalizePersonalReminderSettings({ timeZone: "Mars/Phobos" }), { statusCode: 400 });
  assert.throws(() => normalizePersonalReminderSettings({ enabled: "true" }), { statusCode: 400 });
  assert.throws(() => normalizePersonalReminderSettings({ quietStart: "25:00" }), { statusCode: 400 });
});
