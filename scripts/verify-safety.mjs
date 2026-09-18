import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createKeyedQueue, retainAutomationRuns, recoveryExecutionRepo, mapConcurrent } from "../server/run-safety.mjs";

const source = await fs.readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
const frontend = await fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const draftSource = await fs.readFile(new URL("../src/draft-persistence.ts", import.meta.url), "utf8");
const { DraftPersistence } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(draftSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test("同一幂等键的检查和创建串行执行，失败后可重试", async () => {
  const serialize = createKeyedQueue();
  const gate = deferred();
  let stored, starts = 0;
  const trigger = () => serialize("same", async () => {
    const existing = stored;
    await gate.promise;
    if (!existing) stored = ++starts;
    return stored;
  });
  const pending = [trigger(), trigger(), trigger()];
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), [1, 1, 1]);
  assert.equal(starts, 1);
  await assert.rejects(serialize("failed", () => { throw new Error("failure"); }));
  assert.equal(await serialize("failed", () => "retried"), "retried");
});

test("历史裁剪保留运行任务、TTL 内的幂等凭据和可恢复记录", () => {
  const now = Date.now();
  const recent = new Date(now - 1000).toISOString();
  const old = new Date(now - 100000).toISOString();
  const rows = [
    { id: "active", status: "running", updatedAt: old },
    { id: "key", status: "completed", updatedAt: old, startedAt: recent, triggerIdempotencyHash: "hash" },
    { id: "recovery", status: "interrupted", updatedAt: recent },
    ...Array.from({ length: 220 }, (_, i) => ({ id: `history-${i}`, status: "completed", updatedAt: recent })),
  ];
  const retained = retainAutomationRuns(rows, { now, idempotencyTtlMs: 60000, recoveryMaxAgeMs: 60000 });
  for (const id of ["active", "key", "recovery"]) assert.ok(retained.some((row) => row.id === id));
  assert.equal(retained.filter((row) => row.id.startsWith("history-")).length, 200);
});

test("恢复原 worktree，缺失或越界目录不会回退主仓库", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-safety-"));
  try {
    const repo = { id: "r", path: path.join(root, "repo") };
    const trees = path.join(root, "worktrees");
    const original = path.join(trees, "original");
    await fs.mkdir(repo.path); await fs.mkdir(original, { recursive: true });
    const restored = await recoveryExecutionRepo(repo, { worktreePolicy: "detached-worktree", worktreePath: original }, trees);
    assert.equal(restored.path, await fs.realpath(original));
    await assert.rejects(recoveryExecutionRepo(repo, { worktreePolicy: "detached-worktree" }, trees));
    await assert.rejects(recoveryExecutionRepo(repo, { worktreePath: path.join(trees, "missing") }, trees));
    await assert.rejects(recoveryExecutionRepo(repo, { worktreePath: root }, trees));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("恢复超时保留原线程且不会新建线程", async () => {
  const calls = [];
  const context = { getAppServerClient: () => ({ request: async (method) => { calls.push(method); throw new Error("timeout"); } }), appServerThreadParams: () => ({}), emitJobEvent() {}, rememberOwner() {}, updateSessionRuntime: async () => assert.fail("must not replace thread") };
  vm.createContext(context);
  vm.runInContext(section(source, "async function resolveThreadForJob(", "async function startTurnJob("), context);
  const job = { threadId: "original", repo: {}, runtime: {} };
  await assert.rejects(context.resolveThreadForJob(job), /已保留原会话/);
  assert.equal(job.threadId, "original");
  assert.deepEqual(calls, ["thread/resume"]);
});

test("草稿串行写入版本递增，跨页面冲突保留本机文本", async () => {
  const gate = deferred();
  const started = deferred();
  const local = storage();
  const writes = [];
  let revision = 5;
  const writer = new DraftPersistence(async () => ({ draft: { input: "", attachments: [], revision } }), async (_repo, _session, draft, expected) => {
    writes.push({ input: draft.input, expected });
    if (writes.length === 1) { started.resolve(); await gate.promise; }
    if (expected !== revision) throw new Error("conflict");
    return { draft: { ...draft, revision: ++revision } };
  }, local);
  writer.seed("r", "s", { input: "", attachments: [], revision });
  const first = writer.save("r", "s", { input: "old", attachments: [] });
  const second = writer.save("r", "s", { input: "latest", attachments: [] });
  await started.promise;
  assert.equal(writes.length, 1);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(writes, [{ input: "old", expected: 5 }, { input: "latest", expected: 6 }]);
  assert.equal(writer.recover("r", "s"), null);
  revision += 1;
  await assert.rejects(writer.save("r", "s", { input: "keep locally", attachments: [] }), /conflict/);
  assert.equal(writer.recover("r", "s").input, "keep locally");
});

test("重新载入草稿采用最新版本，但保留未同步输入的冲突基线", async () => {
  const local = storage();
  const revisions = [];
  const writer = new DraftPersistence(async () => assert.fail("seeded"), async (_repo, _session, draft, revision) => {
    revisions.push(revision);
    return { draft: { ...draft, revision: revision + 1 } };
  }, local);
  writer.seed("r", "s", { input: "", attachments: [], revision: 1 });
  writer.seed("r", "s", { input: "remote", attachments: [], revision: 7 });
  await writer.save("r", "s", { input: "edited", attachments: [] });
  assert.deepEqual(revisions, [7]);
  writer.remember("r", "s", { input: "unsaved", attachments: [] });
  writer.seed("r", "s", { input: "other edit", attachments: [], revision: 12 });
  await writer.save("r", "s", { input: "unsaved", attachments: [] });
  assert.deepEqual(revisions, [7, 8]);
});

test("首次写入先获取版本，进行中的写入不会被再次载入改变基线", async () => {
  const gate = deferred();
  const started = deferred();
  const revisions = [];
  const writer = new DraftPersistence(async () => ({ draft: { input: "", attachments: [], revision: 4 } }), async (_r, _s, draft, revision) => {
    revisions.push(revision); started.resolve(); await gate.promise;
    return { draft: { ...draft, revision: revision + 1 } };
  }, storage());
  const first = writer.save("r", "s", { input: "first", attachments: [] });
  await started.promise;
  writer.seed("r", "s", { input: "remote", attachments: [], revision: 20 });
  const next = writer.save("r", "s", { input: "next", attachments: [] });
  gate.resolve(); await Promise.all([first, next]);
  assert.deepEqual(revisions, [4, 5]);
});

test("会话回写拒绝旧项目、旧请求及错误项目响应", () => {
  const updates = [];
  const context = {
    useCallback: (fn) => fn,
    chatLoadSeq: { current: 5 }, selectedRepoIdRef: { current: "B" },
    hydratedDraftRef: { current: null },
    composerDrafts: { recover: () => null },
    hydrateChatDraft: (_repo, draft) => draft || { input: "", attachments: [] },
    draftStorageKey: (repo, session) => `${repo}:${session}`, draftSnapshot: JSON.stringify,
  };
  for (const name of ["setChatSessions", "setActiveSessionId", "setChatMessages", "setChatInput", "setChatAttachments"]) {
    context[name] = (value) => updates.push([name, value]);
  }
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(section(frontend, "  const applyChatHistory =", "  const loadChatHistory ="), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.apply = applyChatHistory", context);
  const result = { repoId: "B", activeSessionId: "b-1", sessions: [], messages: [] };
  assert.equal(context.apply(result, { id: "A" }, 5), false);
  assert.equal(context.apply(result, { id: "B" }, 4), false);
  assert.equal(context.apply({ ...result, repoId: "A" }, { id: "B" }, 5), false);
  assert.deepEqual(updates, []);
  assert.equal(context.apply(result, { id: "B" }, 5), true);
  assert.equal(updates.length, 5);
});

test("项目切换清空编辑器且旧文件不能写入新项目", async () => {
  const context = {
    selectedRepo: { id: "A" }, selectedRepoIdRef: { current: "A" },
    selectedFile: { repoId: "A", path: "README.md", content: "original", contentHash: "hash" }, fileDraft: "edited",
    flushComposerDraftRef: { current: async () => {} }, chatLoadSeq: { current: 0 }, fileReadSeq: { current: 0 }, hydratedDraftRef: { current: null },
    useCallback: (fn) => fn, pushEvent() {}, window: { localStorage: storage() },
    setSelectedRepoId: (id) => { context.selectedRepo = { id }; }, setSelectedFile: (file) => { context.selectedFile = file; }, setFileDraft: (draft) => { context.fileDraft = draft; },
    api: async () => assert.fail("stale file must not be written"),
  };
  context.editorRef = { current: { file: context.selectedFile, draft: context.fileDraft } };
  for (const name of ["setChatSessions", "setActiveSessionId", "setChatMessages", "setThreadGoal", "setThreadTokenUsage", "setCompactStatus", "setReviewPrContext", "setChatInput", "setChatAttachments", "setChatHistoryError"]) context[name] = () => {};
  const code = section(frontend, "  const switchRepoConversation =", "\n  useEffect(() => {\n    if (!statusReady") + section(frontend, "  const saveAgentFile =", "  const runTerminalCommand =");
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  vm.runInContext("switchRepoConversation('B')", context);
  assert.equal(context.selectedFile, null);
  assert.equal(context.fileDraft, "");
  assert.match(context.window.localStorage.getItem("codex-cloud-editor:A:README.md"), /edited/);
  context.selectedFile = { repoId: "A", path: "README.md" };
  await vm.runInContext("saveAgentFile()", context);
});

test("目录元数据并发有上限且结果顺序稳定", async () => {
  let active = 0, peak = 0;
  const items = Array.from({ length: 40 }, (_, i) => i);
  const result = await mapConcurrent(items, 4, async (item) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1; return item * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(result, items.map((item) => item * 2));
});
