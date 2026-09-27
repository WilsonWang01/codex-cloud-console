import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonalRoutinesStore, personalRoutineAutomation } from "../server/personal-routines.mjs";

test("personal routines persist, reject stale edits and never enable a timer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-routines-"));
  try {
    const file = path.join(root, "state", "routines.json");
    const store = createPersonalRoutinesStore(file);
    await assert.rejects(store.create({ name: "bad", prompt: "" }), { statusCode: 400 });
    const routine = await store.create({ name: "整理邮件", prompt: "只列出需要处理的邮件，不发送。" });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await createPersonalRoutinesStore(file).list())[0].id, routine.id);
    const automation = personalRoutineAutomation(routine);
    assert.equal(automation.repoId, "_personal");
    assert.equal(automation.mode, "on-demand");
    assert.equal(automation.timer, null);
    assert.equal(automation.model, "gpt-6-sol");
    await assert.rejects(store.update(routine.id, { revision: 0, name: "旧版", prompt: "覆盖" }), { statusCode: 409 });
    const updated = await store.update(routine.id, { revision: 1, name: "整理日程", prompt: "只读列出明天的安排" });
    assert.equal(updated.revision, 2);
    assert.equal((await store.list())[0].prompt, "只读列出明天的安排");
    const results = await Promise.allSettled([
      store.update(routine.id, { revision: 2, name: "A", prompt: "任务 A" }),
      store.update(routine.id, { revision: 2, name: "B", prompt: "任务 B" }),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected" && item.reason.statusCode === 409).length, 1);
    const current = (await store.list())[0];
    const archived = await store.archive(current.id, current.revision);
    assert.ok(archived.archivedAt);
    assert.equal((await createPersonalRoutinesStore(file).list())[0].archivedAt, archived.archivedAt);
    await assert.rejects(store.update(archived.id, { revision: archived.revision, name: "不能编辑", prompt: "请先恢复" }), { statusCode: 409 });
    const restored = await store.restore(archived.id, archived.revision);
    assert.equal(restored.archivedAt, null);
    await assert.rejects(store.restore(restored.id, restored.revision), { statusCode: 409 });
    await fs.writeFile(file, JSON.stringify({ version: 1, routines: [{ id: "other", name: "bad", prompt: "bad", revision: 1 }] }));
    await assert.rejects(store.list(), { statusCode: 500 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
