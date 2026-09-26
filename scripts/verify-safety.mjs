import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { createKeyedQueue, retainAutomationRuns, recoveryExecutionRepo, mapConcurrent } from "../server/run-safety.mjs";
import { handleReviewRoutes } from "../server/review-git.mjs";

const source = await fs.readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
const frontend = await fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const draftSource = await fs.readFile(new URL("../src/draft-persistence.ts", import.meta.url), "utf8");
const streamSource = await fs.readFile(new URL("../src/conversation-stream.ts", import.meta.url), "utf8");
const { ConversationStreamScope } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(streamSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);
const { DraftPersistence } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(draftSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test("紧凑状态写入无损保留字段、备份、权限及原子失败保护", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-state-storage-"));
  const file = path.join(root, "state.json");
  const previous = { sessions: [{ id: "保留的任务", draft: "第一行\n第二行" }], active: true };
  const next = { ...previous, output: "图片路径和完整消息", count: 0, empty: null };
  const context = { fs, path, process, Date, Math };
  vm.createContext(context);
  vm.runInContext(section(source, "function uniqueTempPath", "function processExists"), context);
  try {
    await fs.writeFile(file, JSON.stringify(previous, null, 2), { mode: 0o600 });
    await context.atomicWriteJson(file, next);
    const text = await fs.readFile(file, "utf8");
    assert.deepEqual(JSON.parse(text), next);
    assert.equal(text, `${JSON.stringify(next)}\n`);
    assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, "utf8")), previous);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(`${file}.bak`)).mode & 0o777, 0o600);
    context.fs = { ...fs, rename: async () => { throw new Error("simulated rename failure"); } };
    await assert.rejects(context.atomicWriteJson(file, { replacement: true }), /rename failure/);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), next);
    assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, "utf8")), next);
    assert.deepEqual((await fs.readdir(root)).sort(), ["state.json", "state.json.bak"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("浏览器检查的成功和失败路径均关闭浏览器", async () => {
  let closed = 0, failAt = "";
  const step = (name, result) => async () => {
    if (failAt === name) throw new Error(`failed ${name}`);
    return result;
  };
  const page = { on() {}, goto: step("goto", { ok: () => true, status: () => 200 }), waitForTimeout: step("wait"), title: step("title", "test"), screenshot: step("screenshot", Buffer.from("image")) };
  const browser = { newPage: step("newPage", page), close: async () => { closed += 1; } };
  const context = { chromium: { launch: step("launch", browser) }, findBrowserExecutable: async () => null };
  vm.createContext(context);
  const code = section(source, "async function runBrowserCheck", "function relayLoopbackHttp");
  assert(code.includes('const { chromium } = await import("playwright");'));
  vm.runInContext(code.replace('const { chromium } = await import("playwright");', ""), context);
  for (const failure of ["", "newPage", "goto", "wait", "title", "screenshot"]) {
    failAt = failure;
    const before = closed;
    const result = await context.runBrowserCheck("https://example.test/");
    assert.equal(result.ok, !failure);
    assert.equal(closed, before + 1);
  }
  failAt = "launch";
  const before = closed;
  assert.equal((await context.runBrowserCheck("https://example.test/")).ok, false);
  assert.equal(closed, before);
});

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

test("独立调用方按令牌身份限流，旧共享入口仍按 IP 限流", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(section(source, "function automationTriggerClientKey", "function consumeAutomationTriggerRate"), context);
  const client = { apiClient: { id: "client-a" }, ip: "203.0.113.1" };
  assert.equal(context.automationTriggerClientKey(client, "research"), "client:client-a:research");
  assert.equal(context.automationTriggerClientKey({ ...client, ip: "203.0.113.2" }, "research"), "client:client-a:research");
  assert.equal(context.automationTriggerClientKey({ apiClient: { id: "client-b" }, ip: client.ip }, "research"), "client:client-b:research");
  assert.equal(context.automationTriggerClientKey({ apiClient: { id: "legacy-shared" }, ip: client.ip }, "research"), "ip:203.0.113.1:research");
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
    activeSessionIdRef: { current: "b-1" }, detachConversationStream() {}, setReviewActivity() {},
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
    activeSessionIdRef: { current: "A-session" }, chatInputRef: { current: "draft" }, chatAttachmentsRef: { current: [] },
    selectedFile: { repoId: "A", path: "README.md", content: "original", contentHash: "hash" }, fileDraft: "edited",
    flushComposerDraftRef: { current: async () => { context.flushedDraft = { repoId: context.selectedRepoIdRef.current, sessionId: context.activeSessionIdRef.current, input: context.chatInputRef.current }; } }, chatLoadSeq: { current: 0 }, fileReadSeq: { current: 0 }, hydratedDraftRef: { current: null },
    useCallback: (fn) => fn, pushEvent() {}, window: { localStorage: storage() },
    detachConversationStream() {},
    chatHistoryController: { current: null },
    setSelectedRepoId: (id) => { context.selectedRepo = { id }; }, setSelectedFile: (file) => { context.selectedFile = file; }, setFileDraft: (draft) => { context.fileDraft = draft; }, setIsLoadingChatHistory: (value) => { context.historyLoading = value; },
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
  assert.deepEqual(context.flushedDraft, { repoId: "A", sessionId: "A-session", input: "draft" });
  assert.equal(context.historyLoading, true);
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

test("切换会话取消旧订阅，旧 finally 不能释放新订阅", () => {
  const scope = new ConversationStreamScope();
  const first = scope.begin();
  let disconnects = 0;
  first.signal.addEventListener("abort", () => disconnects++);
  assert.equal(first.isCurrent(), true);
  const second = scope.begin();
  assert.equal(disconnects, 1);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(first.finish(), false);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.finish(), true);
  assert.equal(second.finish(), false);
  assert.equal(scope.active, false);
  assert.equal(second.signal.aborted, true);
  assert.equal(scope.detach(), false);
});

test("重连失败采用有上限的指数等待，避免请求风暴", () => {
  const context = { useCallback: (fn) => fn, reconnectBackoff: { current: { failures: 0, after: 0 } }, Date: { now: () => 1000 } };
  vm.createContext(context);
  const code = section(frontend, "  const delayStreamReconnect =", "  useEffect(() => () =>");
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.retry = delayStreamReconnect", context);
  assert.deepEqual(Array.from({ length: 8 }, () => context.retry()), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(context.reconnectBackoff.current.after, 31000);
});

test("未修改的草稿及排队的相同草稿不重复写入", async () => {
  const calls = [];
  const writer = new DraftPersistence(async () => assert.fail("already seeded"), async (_repo, _session, draft, revision) => {
    calls.push(draft.input);
    return { draft: { ...draft, revision: revision + 1 } };
  }, storage());
  writer.seed("r", "s", { input: "saved", attachments: [], revision: 3 });
  await writer.save("r", "s", { input: "saved", attachments: [] });
  assert.equal(calls.length, 0);
  await Promise.all([writer.save("r", "s", { input: "changed", attachments: [] }), writer.save("r", "s", { input: "changed", attachments: [] })]);
  assert.deepEqual(calls, ["changed"]);
  await writer.save("r", "s", { input: "changed", attachments: [{ path: "a.txt" }] });
  assert.equal(calls.length, 2);
  assert.equal(writer.recover("r", "s"), null);
});

test("草稿回退也排在进行中的保存之后，写入冲突不会被确认缓存掩盖", async () => {
  let fail = false;
  const calls = [];
  const writer = new DraftPersistence(async () => assert.fail("already seeded"), async (_repo, _session, draft, revision) => {
    calls.push(draft.input);
    if (fail) throw new Error("conflict");
    return { draft: { ...draft, revision: revision + 1 } };
  }, storage());
  writer.seed("r", "s", { input: "saved", attachments: [], revision: 3 });
  await Promise.all([writer.save("r", "s", { input: "changed", attachments: [] }), writer.save("r", "s", { input: "saved", attachments: [] })]);
  assert.deepEqual(calls, ["changed", "saved"]);
  fail = true;
  await assert.rejects(writer.save("r", "s", { input: "conflicting", attachments: [] }), /conflict/);
  await assert.rejects(writer.save("r", "s", { input: "saved", attachments: [] }), /conflict/);
  assert.equal(calls.length, 4);
  assert.equal(writer.recover("r", "s").input, "saved");
});

test("本机未同步草稿的旧版本不能因内容相同跳过冲突校验", async () => {
  const local = storage();
  local.setItem("codex-cloud-draft:r:s", JSON.stringify({ input: "same", attachments: [], revision: 2 }));
  let expected;
  const writer = new DraftPersistence(async () => assert.fail("seeded"), async (_r, _s, _draft, revision) => {
    expected = revision;
    throw new Error("conflict");
  }, local);
  writer.seed("r", "s", { input: "same", attachments: [], revision: 7 });
  await assert.rejects(writer.save("r", "s", { input: "same", attachments: [] }), /conflict/);
  assert.equal(expected, 2);
});

test("页面离开时取消重试等待，不再发送旧页面请求", async () => {
  let calls = 0;
  const context = { api: async () => { calls += 1; throw new Error("offline"); }, window: { setTimeout, clearTimeout }, DOMException };
  vm.createContext(context);
  const code = section(frontend, "async function apiWithRetry", "function fileToDataUrl");
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const controller = new AbortController();
  const pending = context.apiWithRetry("/history", { signal: controller.signal }, 5);
  const rejected = assert.rejects(pending, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("cancelled"));
  await rejected;
  assert.equal(calls, 1);
  await assert.rejects(context.apiWithRetry("/history", { signal: controller.signal }, 5), /cancelled/);
  assert.equal(calls, 1);
});

test("请求超时同时支持外部取消，正确区分取消与超时并清理监听", async () => {
  let calls = 0;
  const timers = new Set();
  const context = {
    AbortController,
    api: async (_url, { signal }) => {
      calls += 1;
      signal.throwIfAborted();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    window: {
      setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timers.add(timer); return timer; },
      clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); },
    },
  };
  vm.createContext(context);
  const code = section(frontend, "async function apiWithDeadline", "async function apiWithRetry");
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const external = new AbortController();
  await assert.rejects(context.apiWithDeadline("/slow", { signal: external.signal }, 10), /请求超时/);
  assert.equal(external.signal.aborted, false);
  const pending = context.apiWithDeadline("/cancel", { signal: external.signal }, 1000);
  const cancelled = assert.rejects(pending, /主动取消/);
  external.abort(new Error("主动取消"));
  await cancelled;
  await assert.rejects(context.apiWithDeadline("/already-cancelled", { signal: external.signal }), /主动取消/);
  assert.equal(calls, 2);
  assert.equal(timers.size, 0);
  let listeners = 0;
  const completed = new AbortController();
  const add = completed.signal.addEventListener.bind(completed.signal);
  const remove = completed.signal.removeEventListener.bind(completed.signal);
  completed.signal.addEventListener = (...args) => { listeners += 1; add(...args); };
  completed.signal.removeEventListener = (...args) => { listeners -= 1; remove(...args); };
  context.api = async () => "ok";
  assert.equal(await context.apiWithDeadline("/success", { signal: completed.signal }), "ok");
  assert.equal(listeners, 0);
  assert.equal(timers.size, 0);
});

test("还原全部未暂存变更保留暂存区和暂存版本，兼容首次提交前及空暂存区", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-review-revert-"));
  const run = promisify(execFile);
  const git = async (cwd, ...args) => (await run("git", args, { cwd })).stdout;
  const revert = async (cwd) => {
    let result;
    const res = { setHeader() {}, end: (body) => { result = JSON.parse(body); } };
    await handleReviewRoutes({ method: "POST" }, res, new URL("http://fixture/codex-api/review/action"), {
      readJsonBody: async () => ({ cwd, scope: "workspace", workspaceView: "unstaged", action: "revert", level: "all" }),
    });
    assert.equal(res.statusCode, 200, result?.error);
    assert.equal(result.data.summary.fileCount, 0);
  };
  try {
    for (const committed of [true, false]) {
      const cwd = path.join(root, committed ? "committed" : "unborn");
      await fs.mkdir(cwd);
      await git(cwd, "init", "--initial-branch=main");
      if (committed) {
        await fs.writeFile(path.join(cwd, "tracked.txt"), "HEAD version\n");
        await git(cwd, "add", ".");
        await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--no-gpg-sign", "-m", "baseline");
      }
      await fs.writeFile(path.join(cwd, "tracked.txt"), "staged version\n");
      await fs.writeFile(path.join(cwd, "added.txt"), "staged addition\n");
      await fs.writeFile(path.join(cwd, ".gitignore"), "state.keep\n");
      await git(cwd, "add", ".");
      const before = await git(cwd, "diff", "--cached", "--binary");
      await fs.writeFile(path.join(cwd, "tracked.txt"), "unstaged edit\n");
      await fs.unlink(path.join(cwd, "added.txt"));
      await fs.writeFile(path.join(cwd, "untracked.txt"), "discard\n");
      await fs.writeFile(path.join(cwd, "state.keep"), "protected runtime data\n");
      await revert(cwd);
      assert.equal(await fs.readFile(path.join(cwd, "tracked.txt"), "utf8"), "staged version\n");
      assert.equal(await fs.readFile(path.join(cwd, "added.txt"), "utf8"), "staged addition\n");
      assert.equal(await git(cwd, "diff", "--cached", "--binary"), before);
      assert.equal(await fs.readFile(path.join(cwd, "state.keep"), "utf8"), "protected runtime data\n");
      await assert.rejects(fs.access(path.join(cwd, "untracked.txt")));
    }
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    await git(empty, "init", "--initial-branch=main");
    await fs.writeFile(path.join(empty, "untracked.txt"), "discard\n");
    await revert(empty);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
