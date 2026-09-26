import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonalFactsStore } from "../server/personal-facts.mjs";
import { personalDeveloperInstructions } from "../server/personal-runtime.mjs";

test("explicit personal facts can be corrected and removed from new task context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-facts-"));
  try {
    const store = createPersonalFactsStore(path.join(root, "state", "facts.json"));
    const fact = await store.create({ label: "称呼", value: "小王" });
    assert.equal(fact.source, "user");
    assert.match(personalDeveloperInstructions({ sandbox: "read-only" }, await store.list()), /小王/);
    await store.update(fact.id, { label: "称呼", value: "小李" });
    const updated = personalDeveloperInstructions({ sandbox: "read-only" }, await store.list());
    assert.match(updated, /小李/);
    assert.doesNotMatch(updated, /小王/);
    await store.remove(fact.id);
    assert.doesNotMatch(personalDeveloperInstructions({ sandbox: "read-only" }, await store.list()), /小李/);
    await assert.rejects(store.create({ label: "", value: "bad" }));
    assert.deepEqual(await store.list(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
