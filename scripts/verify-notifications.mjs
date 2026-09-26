import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { notificationAttempt, pendingNotificationChannels } from "../server/notification-delivery.mjs";

test("failed destinations retry without resending successful destinations", async () => {
  const source = await fs.readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function notifyAttentionItems(");
  const end = source.indexOf("async function runExternalNotificationCheck(", start);
  assert.ok(start >= 0 && end > start);
  let state = { delivered: {}, push: { subscriptions: {} } };
  const sends = { webhook: 0, slack: 0 };
  const writes = [];
  const context = {
    Date,
    Object,
    serializeNotificationDelivery: (_key, task) => task(),
    readNotificationState: async () => structuredClone(state),
    writeNotificationState: async (next) => { state = structuredClone(next); writes.push(structuredClone(next)); },
    ensurePushState: async (value) => value,
    notificationChannels: () => [{ id: "webhook", enabled: true, type: "webhook" }, { id: "slack", enabled: true, type: "slack" }],
    pendingNotificationChannels,
    notificationAttempt,
    normalizeNotificationDelivery: (value) => value,
    sendNotificationToChannel: async (channel) => {
      sends[channel.id] += 1;
      if (channel.id === "slack" && sends.slack === 1) throw new Error("temporary outage");
      return { ok: true, status: 200 };
    },
    sendPushNotifications: async () => assert.fail("push is not configured"),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const item = { id: "approval-1", tone: "active", title: "Needs review" };
  const first = await context.notifyAttentionItems([item]);
  assert.equal(first.ok, false);
  assert.deepEqual(sends, { webhook: 1, slack: 1 });
  assert.equal(writes.length >= 2, true);
  assert.equal(state.delivered[item.id].channels.find((channel) => channel.channelId === "webhook").ok, true);
  assert.equal(state.delivered[item.id].channels.find((channel) => channel.channelId === "slack").ok, false);
  assert.equal(pendingNotificationChannels([{ id: "slack" }], state.delivered[item.id]).length, 0);

  state.delivered[item.id].channels.find((channel) => channel.channelId === "slack").nextAttemptAt = new Date(Date.now() - 1).toISOString();
  const second = await context.notifyAttentionItems([item]);
  assert.equal(second.ok, true);
  assert.deepEqual(sends, { webhook: 1, slack: 2 });
  assert.equal(state.delivered[item.id].channels.find((channel) => channel.channelId === "slack").ok, true);
  await context.notifyAttentionItems([item]);
  assert.deepEqual(sends, { webhook: 1, slack: 2 });
});

test("retry schedule is bounded and terminal failures remain inspectable", () => {
  const now = Date.parse("2026-09-26T08:00:00Z");
  let result = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    result = notificationAttempt(result, { ok: false, error: "unavailable" }, now);
    assert.equal(result.attempts, attempt);
  }
  assert.equal(result.nextAttemptAt, null);
  assert.equal(pendingNotificationChannels([{ id: "webhook" }], { channels: [{ channelId: "webhook", ...result }] }, now + 86_400_000).length, 0);
  assert.equal(pendingNotificationChannels([{ id: "webhook" }], { ok: true, channelId: "webhook" }, now).length, 0);
});
