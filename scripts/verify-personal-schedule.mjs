import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonalRoutinesStore, personalRoutineAutomation } from "../server/personal-routines.mjs";
import { createPersonalRoutineScheduler } from "../server/personal-scheduler.mjs";
import { nextPersonalOccurrence, personalScheduleLocalDate, validatePersonalSchedule } from "../server/personal-schedule.mjs";

const shanghai = { cadence: "daily", time: "09:00", timeZone: "Asia/Shanghai" };

test("personal schedule validates timezones and handles DST without a duplicate local day", () => {
  assert.throws(() => validatePersonalSchedule({ ...shanghai, timeZone: "Mars/Olympus" }), { statusCode: 400 });
  assert.throws(() => validatePersonalSchedule({ ...shanghai, time: "25:00" }), { statusCode: 400 });
  assert.equal(nextPersonalOccurrence(shanghai, "2026-09-28T00:00:00Z"), "2026-09-28T01:00:00.000Z");
  const spring = { cadence: "daily", time: "02:30", timeZone: "America/New_York" };
  assert.equal(nextPersonalOccurrence(spring, "2026-03-08T06:00:00Z"), "2026-03-08T07:30:00.000Z");
  const fall = { cadence: "daily", time: "01:30", timeZone: "America/New_York" };
  const first = nextPersonalOccurrence(fall, "2026-11-01T04:00:00Z");
  const second = nextPersonalOccurrence(fall, first);
  assert.equal(first, "2026-11-01T05:30:00.000Z");
  assert.notEqual(personalScheduleLocalDate(first, fall.timeZone), personalScheduleLocalDate(second, fall.timeZone));
});

test("schedule is opt-in, claims at most once, survives restart and pauses on failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-schedule-"));
  try {
    const file = path.join(root, "state", "routines.json");
    const store = createPersonalRoutinesStore(file);
    const routine = await store.create({ name: "简报", prompt: "只读整理今日资料" });
    assert.equal(personalRoutineAutomation(routine).personalSchedule, null);
    const enabled = await store.configureSchedule(routine.id, { revision: 1, enabled: true, ...shanghai }, Date.parse("2026-09-27T23:00:00Z"));
    assert.equal(enabled.personalSchedule.nextRunAt, "2026-09-28T01:00:00.000Z");
    assert.equal(await store.claimDue(Date.parse("2026-09-28T00:59:59Z")), null);
    const now = Date.parse("2026-09-28T01:00:15Z");
    const claims = await Promise.all([store.claimDue(now), store.claimDue(now)]);
    assert.equal(claims.filter((item) => item?.claim).length, 1);
    const claim = claims.find((item) => item?.claim).claim;
    assert.equal((await createPersonalRoutinesStore(file).claims())[0].runId, claim.runId);
    assert.equal(await store.claimDue(now), null);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await assert.rejects(store.archive(routine.id, enabled.revision), { statusCode: 409 });
    const failed = await store.settleClaim(claim.runId, "failed", "auth unavailable");
    assert.equal(failed.personalSchedule.enabled, false);
    assert.equal(failed.personalSchedule.lastResult.status, "failed");
    assert.equal(await store.claimDue(Date.parse("2026-09-29T01:00:15Z")), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missed windows are skipped and old version-one state remains readable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-schedule-migrate-"));
  try {
    const file = path.join(root, "routines.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, routines: [] }));
    const store = createPersonalRoutinesStore(file);
    assert.deepEqual(await store.claims(), []);
    const routine = await store.create({ name: "晨报", prompt: "读取资料" });
    await store.configureSchedule(routine.id, { revision: 1, enabled: true, ...shanghai }, Date.parse("2026-09-27T23:00:00Z"));
    const due = await store.claimDue(Date.parse("2026-09-28T02:00:00Z"));
    assert.equal(due.skipped, true);
    assert.equal(due.routine.personalSchedule.lastResult.status, "skipped");
    assert.equal(due.routine.personalSchedule.nextRunAt, "2026-09-29T01:00:00.000Z");
    assert.deepEqual(await store.claims(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("only three enabled schedules and three daily claims are allowed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-schedule-cap-"));
  try {
    const store = createPersonalRoutinesStore(path.join(root, "routines.json"));
    const routines = [];
    for (let index = 0; index < 4; index += 1) routines.push(await store.create({ name: `任务 ${index}`, prompt: "只读整理" }));
    for (const routine of routines.slice(0, 3)) {
      await store.configureSchedule(routine.id, { revision: 1, enabled: true, ...shanghai }, Date.parse("2026-09-27T23:00:00Z"));
    }
    await assert.rejects(store.configureSchedule(routines[3].id, { revision: 1, enabled: true, ...shanghai }, Date.parse("2026-09-27T23:00:00Z")), { statusCode: 409 });
    for (let index = 0; index < 3; index += 1) {
      const due = await store.claimDue(Date.parse("2026-09-28T01:00:05Z"));
      assert.ok(due.claim);
      await store.settleClaim(due.claim.runId, "completed");
    }
    assert.equal(await store.claimDue(Date.parse("2026-09-28T01:00:05Z")), null);
    const disabled = await store.configureSchedule(routines[0].id, { revision: 2, enabled: false });
    assert.equal(disabled.personalSchedule.enabled, false);
    const fourth = await store.configureSchedule(routines[3].id, { revision: 1, enabled: true, ...shanghai, time: "10:30" }, Date.parse("2026-09-28T01:00:05Z"));
    assert.equal(fourth.personalSchedule.nextRunAt, "2026-09-28T02:30:00.000Z");
    const capped = await store.claimDue(Date.parse("2026-09-28T02:30:05Z"));
    assert.equal(capped.skipped, true);
    assert.match(capped.routine.personalSchedule.lastResult.detail, /上限/);
    assert.equal((await store.claims()).length, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("scheduler starts a claimed occurrence once and does not overlap another app-server run", async () => {
  const routine = { id: "routine-1", revision: 1, archivedAt: null, personalSchedule: { enabled: true } };
  const claim = { id: "routine-1:today", routineId: routine.id, revision: 1, runId: "run-1", claimedAt: new Date().toISOString(), status: "claimed" };
  let due = { claim, routine };
  let runs = [{ id: "work-run", runner: "app-server", status: "running" }];
  let starts = 0;
  let claims = [];
  const tick = createPersonalRoutineScheduler({
    store: {
      claims: async () => claims,
      claimDue: async () => { const current = due; due = null; if (current) claims.push(claim); return current; },
      list: async () => [routine],
      settleClaim: async (_, status) => { claim.status = status; return routine; },
    },
    automations: () => [{ id: routine.id, personalRoutine: true, personalSchedule: routine.personalSchedule }],
    readRuns: async () => runs,
    startRun: async () => { starts += 1; },
    sync: () => {},
    warn: () => {},
  });
  await tick();
  assert.equal(starts, 0);
  runs = [];
  await tick();
  assert.equal(starts, 1);
  assert.equal(claim.status, "running");
  await tick();
  assert.equal(starts, 1);
});

test("scheduler does not replay ambiguous claims or run an outdated routine", async () => {
  const routine = { id: "routine-2", revision: 2, archivedAt: null, personalSchedule: { enabled: true } };
  const stale = { id: "old", routineId: routine.id, revision: 1, runId: "run-old", claimedAt: new Date().toISOString(), status: "claimed" };
  const ambiguous = { id: "ambiguous", routineId: routine.id, revision: 2, runId: "run-unknown", claimedAt: new Date(Date.now() - 120_000).toISOString(), status: "claimed" };
  let starts = 0;
  const settled = [];
  const tick = createPersonalRoutineScheduler({
    store: {
      claims: async () => [ambiguous],
      claimDue: async () => ({ claim: stale, routine }),
      list: async () => [routine],
      settleClaim: async (runId, status) => { settled.push({ runId, status }); return routine; },
    },
    automations: () => [{ id: routine.id, personalRoutine: true, personalSchedule: routine.personalSchedule }],
    readRuns: async () => [],
    startRun: async () => { starts += 1; },
    sync: () => {},
    warn: () => {},
  });
  await tick();
  assert.equal(starts, 0);
  assert.deepEqual(settled, [{ runId: "run-unknown", status: "needs_reconciliation" }, { runId: "run-old", status: "canceled" }]);
});
