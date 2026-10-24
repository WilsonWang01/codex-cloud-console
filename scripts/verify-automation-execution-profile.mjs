import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restrictedExecutionProfile as profile, normalizeExecutionProfile, assertExecutionProfile, automationExecutionProfile,
  assertProfileSource, profileRuntime, profileThreadConfig, profileSandbox, verifyProfileThread, executionProfileView } from "../server/automation-execution-profile.mjs";
import { discoveryCapabilities } from "../server/api-discovery.mjs";
import { validateExternalTriggerInput, externalRunView } from "../server/external-automation.mjs";

test("operator-only profile preserves models and legacy runtime; unknown or unsupported configuration fails closed", () => {
  const runtime = { model: "explicit-model", reasoning: "ultra", search: true, sandbox: "danger-full-access", approval: "on-request" };
  assert.equal(normalizeExecutionProfile(), null);
  assert.equal(profileRuntime(runtime, null), runtime);
  assert.deepEqual(profileRuntime(runtime, profile), { ...runtime, search: false, sandbox: "workspace-write", approval: "never" });
  assert.equal(automationExecutionProfile({ mode: "on-demand", executionProfile: profile }), profile);
  for (const value of ["", false, {}, "future-profile"]) assert.throws(() => normalizeExecutionProfile(value), { code: "execution_profile_unavailable" });
  for (const changes of [{ mode: "scheduled" }, { timer: "scheduled.timer" }, { service: "scheduled.service" }, { personalRoutine: {} }]) {
    assert.throws(() => automationExecutionProfile({ mode: "on-demand", executionProfile: profile, ...changes }), { statusCode: 503 });
  }
  for (const accepted of [null, profile]) assertExecutionProfile(accepted, accepted);
  assert.throws(() => assertExecutionProfile(null, profile), { statusCode: 409 });
  assert.throws(() => assertExecutionProfile(profile, null), { statusCode: 409 });
  for (const scoped of [false, true]) assert.throws(() => validateExternalTriggerInput({ executionProfile: profile }, { scoped }), { statusCode: 400 });
  assert.equal(externalRunView({ executionProfile: profile }, "a").execution.profile, profile);
  assert.equal(executionProfileView(null).mode, "legacy_console_defaults");
  const args = { automationId: "a", defaults: { executionProfile: profile }, cli: {}, catalog: {}, resultStorage: null };
  assert.equal(discoveryCapabilities(args).features.image_output.supported, false);
  assert.equal(discoveryCapabilities({ ...args, defaults: {} }).features.image_output.supported, true);
});

test("only previously restricted detached threads can continue; configuration does not mutate", () => {
  const source = { executionProfile: profile, threadId: "thread", worktreePolicy: "detached-worktree", worktreePath: "/worktree" };
  assertProfileSource(profile, source);
  for (const changes of [{ executionProfile: null }, { threadId: null }, { worktreePolicy: "existing-thread" }, { worktreePath: null }]) {
    assert.throws(() => assertProfileSource(profile, { ...source, ...changes }), { statusCode: 409 });
  }
  const effective = { mcp_servers: { fixture: { command: "node", tool_timeout_sec: "" } }, plugins: {}, apps: { connected: {} } };
  const before = structuredClone(effective), config = profileThreadConfig(effective, "/worktree");
  assert.equal(config["mcp_servers.fixture.enabled"], false);
  assert.equal(config["apps.connected.enabled"], false);
  assert.equal(config["apps._default.enabled"], false);
  assert.equal(config.features.memories, false);
  assert.equal(config.features.plugins, false);
  assert.equal(config.sandbox_workspace_write.network_access, false);
  assert.deepEqual(effective, before);
  for (const value of [null, [], { mcp_servers: [] }, { mcp_servers: { "ambiguous.name": {} } }, { plugins: { "plugin@host": {} } }]) {
    assert.throws(() => profileThreadConfig(value, "/worktree"), { statusCode: 503 });
  }
});

test("native permission confirmation, canonical roots and complete connector pagination are mandatory before inference", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-check-")), cwd = path.join(root, "work");
  await fs.mkdir(cwd); await fs.symlink(root, path.join(cwd, "escape"));
  const good = { thread: { id: "thread" }, cwd, approvalPolicy: "never", sandbox: profileSandbox(cwd) };
  const disabled = { name: "fixture", runtimeStatus: "disabled", tools: {} };
  const request = async (method, params) => {
    assert.equal(method, "mcpServerStatus/list"); assert.equal(params.threadId, "thread");
    return { data: [disabled], nextCursor: null };
  };
  try {
    await verifyProfileThread(request, good, cwd);
    for (const response of [{ ...good, cwd: root }, { ...good, approvalPolicy: "on-request" }, { ...good, sandbox: { ...good.sandbox, networkAccess: true } },
      { ...good, sandbox: { ...good.sandbox, excludeSlashTmp: false } }, { ...good, sandbox: { ...good.sandbox, writableRoots: [root] } },
      { ...good, sandbox: { ...good.sandbox, writableRoots: [path.join(cwd, "escape")] } }]) {
      await assert.rejects(() => verifyProfileThread(request, response, cwd), { statusCode: 503 });
    }
    for (const page of [{ data: [disabled] }, { data: [disabled, disabled], nextCursor: null },
      { data: [{ ...disabled, runtimeStatus: "starting" }], nextCursor: null }, { data: [{ ...disabled, tools: { active: {} } }], nextCursor: null }]) {
      await assert.rejects(() => verifyProfileThread(async () => page, good, cwd), { statusCode: 503 });
    }
    let calls = 0;
    await verifyProfileThread(async () => ({ data: [{ ...disabled, name: "fixture-" + ++calls }], nextCursor: calls === 2 ? null : "second" }), good, cwd);
    assert.equal(calls, 2);
    await assert.rejects(() => verifyProfileThread(async () => ({ data: [], nextCursor: "cycle" }), good, cwd), { statusCode: 503 });
    calls = 0;
    await assert.rejects(() => verifyProfileThread(async () => ({ data: [], nextCursor: String(++calls) }), good, cwd), { statusCode: 503 });
    assert.equal(calls, 4);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
