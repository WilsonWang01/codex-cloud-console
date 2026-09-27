import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonalCommitmentsStore } from "../server/personal-commitments.mjs";
import { personalDeveloperInstructions } from "../server/personal-runtime.mjs";

test("personal commitments persist, reject stale edits and only expose active bounded context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-commitments-"));
  try {
    const file = path.join(root, "state", "commitments.json");
    const store = createPersonalCommitmentsStore(file);
    const later = await store.create({ title: "准备旅行", nextStep: "核对路线", dueAt: "2026-10-02T09:00:00.000Z" });
    const sooner = await store.create({ title: "提交资料", nextStep: "检查材料", dueAt: "2026-09-28T09:00:00.000Z" });
    const undated = await store.create({ title: "不设到期时间" });
    assert.equal(undated.dueAt, null);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await createPersonalCommitmentsStore(file).list()).length, 3);
    const instructions = personalDeveloperInstructions({ sandbox: "read-only" }, [], await store.list());
    assert.ok(instructions.indexOf("提交资料") < instructions.indexOf("准备旅行"));
    await assert.rejects(store.update(sooner.id, { revision: 0, title: "错误覆盖" }), { statusCode: 409 });
    await assert.rejects(store.create({ title: "非法日期", dueAt: "2026-02-30T00:00:00.000Z" }), { statusCode: 400 });
    const linked = await store.update(later.id, { revision: later.revision, sessionId: "personal-session" });
    assert.equal(linked.sessionId, "personal-session");
    const completed = await store.update(sooner.id, { revision: sooner.revision, status: "done" });
    assert.equal(completed.completedAt !== null, true);
    assert.doesNotMatch(personalDeveloperInstructions({ sandbox: "read-only" }, [], await store.list()), /提交资料/);
    await assert.rejects(store.remove(later.id, later.revision), { statusCode: 409 });
    await store.remove(later.id, linked.revision);
    assert.deepEqual((await store.list()).map((item) => item.id), [sooner.id, undated.id]);
    assert.equal((await store.list())[0].status, "done");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
