import assert from "node:assert/strict";
import { test } from "node:test";
import { automationEventsSince, mergeAutomationEvents, normalizeAutomationEvents } from "../server/automation-events.mjs";
import { externalRunView } from "../server/external-automation.mjs";

test("legacy events gain stable sequence numbers and continue after a reload", () => {
  const legacy = normalizeAutomationEvents([
    { time: "2026-09-26T00:00:00Z", type: "queued", text: "queued" },
    { time: "2026-09-26T00:00:01Z", type: "running", text: "running" },
  ]);
  assert.deepEqual(legacy.events.map((event) => event.seq), [1, 2]);
  const updated = mergeAutomationEvents(legacy, [{ time: "2026-09-26T00:00:02Z", type: "done", text: "done" }]);
  assert.equal(updated.eventSeq, 3);
  assert.deepEqual(normalizeAutomationEvents(updated.events, updated.eventSeq), updated);
  assert.deepEqual(automationEventsSince(updated, 2).events, [{ seq: 3, time: "2026-09-26T00:00:02Z", type: "done" }]);
});

test("cursor survives bounded retention and flags a missing history segment", () => {
  let run = { events: [], eventSeq: 0 };
  for (let index = 1; index <= 90; index += 1) {
    run = mergeAutomationEvents(run, [{ time: `2026-09-26T00:00:${String(index).padStart(3, "0")}Z`, type: "status", text: `private-${index}` }]);
  }
  assert.equal(run.events.length, 80);
  assert.equal(run.events[0].seq, 11);
  assert.equal(run.eventSeq, 90);
  const oldCursor = automationEventsSince(run, 5);
  assert.equal(oldCursor.eventGap, true);
  assert.equal(oldCursor.eventCursor, 90);
  assert.equal(oldCursor.events[0].seq, 11);
  assert.equal(JSON.stringify(oldCursor).includes("private-"), false);
  assert.equal(automationEventsSince(run, 89).eventGap, false);
  assert.equal(automationEventsSince(run, 89).events.length, 1);
  assert.equal(automationEventsSince(run, 90).events.length, 0);
  assert.equal(automationEventsSince({ events: [], eventSeq: 90 }, 0).eventGap, true);
  assert.equal(externalRunView({ id: "run", eventSeq: 90 }, "automation").eventCursor, 90);
});

test("duplicate writes do not consume a cursor and malformed saved sequences are repaired", () => {
  const event = { time: "2026-09-26T00:00:00Z", type: "queued", text: "queued" };
  const first = mergeAutomationEvents(null, [event, event]);
  assert.equal(first.eventSeq, 1);
  const second = mergeAutomationEvents(first, [event]);
  assert.equal(second.eventSeq, 1);
  const repaired = normalizeAutomationEvents([{ ...event, seq: 4 }, { ...event, seq: 2 }], 9);
  assert.deepEqual(repaired.events.map((item) => item.seq), [4, 5]);
  assert.equal(repaired.eventSeq, 9);
  assert.equal(mergeAutomationEvents(repaired, [{ ...event, time: "2026-09-26T00:00:01Z" }]).eventSeq, 10);
});
