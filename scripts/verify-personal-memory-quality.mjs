import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";
import { profileThreadConfig, verifyProfileThread, profileSandbox } from "../server/automation-execution-profile.mjs";
import { personalDeveloperInstructions } from "../server/personal-runtime.mjs";
import { createPersonalFactsStore, personalFactContextIssue } from "../server/personal-facts.mjs";
import { personalMemoryTool, handlePersonalMemoryCall } from "../server/personal-memory.mjs";
import { personalFactReferenceTool, handlePersonalFactReferenceCall } from "../server/personal-fact-references.mjs";
import { createTurnUsageMeter } from "../server/run-usage.mjs";

const live = process.argv.includes("--live");
assert.ok(process.argv.slice(2).every(arg => arg === "--live"), "Only --live is supported");
if (live) assert.equal(process.env.CODEX_PERSONAL_LIVE_APPROVED, "1", "Live inference requires an explicit quota approval");
const command = process.env.CODEX_SCHEMA_CLI_BINARY || execFileSync("npx", ["--no-install", "--package=@openai/codex@0.157.1", "-c", "command -v codex"], { encoding: "utf8" }).trim();
const version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /^codex-cli 0\.157\.1$/);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-quality-"));
await fs.chmod(root, 0o700);
const cwd = path.join(root, "workspace"), home = path.join(root, "home");
await fs.mkdir(cwd); await fs.mkdir(home);
const store = createPersonalFactsStore(path.join(root, "synthetic-facts.json"));
const report = { mode: live ? "live-inference-synthetic-data" : "loopback-synthetic-provider", cli: version,
  model: "gpt-6-sol", effort: "medium", cases: [], modelTurnsStarted: 0, syntheticProviderRequests: 0,
  thirdPartyBusinessCalls: 0, productionFactsWritten: 0, humanRatings: 0 };
let client, active, providerError, timer;
const provider = live ? null : http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/responses");
    let body = ""; for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 1024 * 1024); }
    const data = JSON.parse(body); report.syntheticProviderRequests++;
    assert.ok(active && ++active.providerRequests <= 2);
    const tool = active.kind === "candidate" ? personalMemoryTool : personalFactReferenceTool;
    assert.ok(JSON.stringify(data.tools || data.input).includes(tool.name));
    if (active.providerRequests === 2) assert.ok(data.input.some(item => item.type === "function_call_output" && item.call_id === active.callId));
    const output = active.providerRequests === 1
      ? [{ id: "fc_quality", type: "function_call", call_id: active.callId, name: tool.name, status: "completed",
        arguments: JSON.stringify(active.kind === "candidate" ? { label: "虚构饮品偏好", value: "虚构用户偏好无糖红茶", reason: "虚构用户明确提出长期偏好" } : { factIds: [active.snapshot.facts[0].id] }) }]
      : [{ id: "msg_quality", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [],
        text: active.kind === "candidate" ? "偏好候选已保存，请到个人设置确认，尚未生效。" : `按你的偏好，建议${active.expected}。这只是建议，没有订票。` }] }];
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit("response.created", { response: { id: "quality-" + report.syntheticProviderRequests, status: "in_progress", output: [] } });
    for (const item of output) emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { id: "quality-" + report.syntheticProviderRequests, status: "completed", output,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    res.end();
  } catch (error) { providerError = error.message; res.writeHead(400); res.end("Synthetic contract rejected"); }
});

async function runCase(kind, prompt, expected = null) {
  const snapshot = await store.snapshot();
  const job = { kind: "turn", repo: { kind: "personal" }, sessionId: "synthetic-session", personalFactSnapshot: snapshot };
  active = { kind, snapshot, expected, callId: "quality-" + report.cases.length, providerRequests: 0, calls: [], meter: createTurnUsageMeter(), job, items: [] };
  const config = (await client.request("config/read", { cwd, includeLayers: false }, 15000)).config;
  const thread = await client.request("thread/start", { cwd, model: report.model, ephemeral: true, approvalPolicy: "never", sandbox: "workspace-write",
    config: profileThreadConfig(config, cwd), dynamicTools: [personalMemoryTool, personalFactReferenceTool],
    developerInstructions: personalDeveloperInstructions({ sandbox: "read-only" }, snapshot.facts) +
      "\nThis is a synthetic personal-assistant quality check. Use only the supplied conversation and personal tools. Do not call shell, files, network, search, delegation, scheduling, connectors or administration tools. Reply briefly in Chinese." }, 20000);
  assert.equal(thread.model, report.model);
  assert.equal(thread.thread.ephemeral, true, "Synthetic evidence must not be added to stored thread history");
  assert.equal(thread.modelProvider, live ? "openai" : "quality_fixture");
  await verifyProfileThread((...args) => client.request(...args), thread, cwd);
  job.threadId = thread.thread.id;
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Personal quality turn exceeded 120 seconds; no retry")), 120000);
    active.finish = resolve;
  }); completed.catch(() => {});
  const started = Date.now();
  report.modelTurnsStarted++;
  const turn = await client.request("turn/start", { threadId: job.threadId, model: report.model, effort: report.effort,
    approvalPolicy: "never", sandboxPolicy: profileSandbox(cwd), input: [{ type: "text", text: prompt }] }, 20000);
  job.turnId ||= turn.turn.id;
  const terminal = await completed; clearTimeout(timer); timer = null;
  assert.equal(terminal.id, job.turnId); assert.equal(terminal.status, "completed", JSON.stringify(terminal.error));
  const assistantText = active.items.filter(item => item.type === "agentMessage").map(item => item.text).join("\n");
  const forbidden = active.items.filter(item => !["reasoning", "agentMessage", "userMessage", "dynamicToolCall"].includes(item.type));
  const result = { kind, threadId: job.threadId, turnId: job.turnId, elapsedMs: Date.now() - started,
    assistantText, calls: active.calls, unexpectedItemTypes: forbidden.map(item => item.type), usage: active.meter.snapshot() };
  report.cases.push(result);
  assert.equal(providerError, undefined); assert.deepEqual(result.unexpectedItemTypes, []);
  assert.equal(result.usage.status, "complete", JSON.stringify(result.usage));
  assert.ok(assistantText.trim());
  assert.equal(active.calls.length, 1, "Exactly one relevant personal tool call is expected");
  assert.equal(active.calls[0].success, true);
  assert.equal(active.calls[0].tool, kind === "candidate" ? personalMemoryTool.name : personalFactReferenceTool.name);
  if (kind === "candidate") {
    const overview = await store.overview();
    assert.equal(overview.candidates.length, 1); assert.equal(overview.candidates[0].status, "pending");
    assert.match(overview.candidates[0].value, /无糖.*红茶|红茶.*无糖/);
    assert.deepEqual(snapshot.facts, []); assert.deepEqual((await store.snapshot()).facts, []);
    assert.match(assistantText, /候选|确认|接受|审核/);
  } else {
    assert.deepEqual(active.calls[0].arguments.factIds, [snapshot.facts[0].id]);
    assert.match(assistantText, new RegExp(expected));
  }
  return { snapshot, threadId: job.threadId, result };
}

try {
  if (provider) await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const args = ["app-server", "--listen", "stdio://", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "-c", "features.apps=false"];
  if (provider) args.push("-c", 'model_provider="quality_fixture"', "-c", 'model_providers.quality_fixture.name="Synthetic quality fixture"',
    "-c", `model_providers.quality_fixture.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
    "-c", 'model_providers.quality_fixture.wire_api="responses"', "-c", "model_providers.quality_fixture.requires_openai_auth=false",
    "-c", "model_providers.quality_fixture.supports_websockets=false");
  client = new CodexAppServerClient({ cwd, command, args,
    env: live ? { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) }
      : { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    onServerRequest: async (method, params) => {
      if (method !== "item/tool/call") throw new Error("Quality check never approves permissions");
      const allowed = [personalMemoryTool.name, personalFactReferenceTool.name];
      assert.ok(allowed.includes(params.tool), "Unexpected dynamic tool");
      const result = params.tool === personalMemoryTool.name ? await handlePersonalMemoryCall(params, active?.job, store)
        : handlePersonalFactReferenceCall(params, active?.job);
      active.calls.push({ tool: params.tool, arguments: params.arguments, success: result.success });
      return result;
    } });
  client.on("notification", message => {
    if (!active || message.params?.threadId !== active.job.threadId) return;
    if (message.method === "turn/started") active.job.turnId = message.params.turn.id;
    if (message.method === "thread/tokenUsage/updated") active.meter.observe(message.params.tokenUsage);
    if (message.method === "item/completed") { active.items.push(message.params.item); active.meter.observeItem(message.params.item); }
    if (message.method === "turn/completed") active.finish?.(message.params.turn);
  });
  if (live) assert.ok((await client.request("account/read", {}, 15000)).account, "No existing login; no inference attempted");
  await runCase("candidate", "这是虚构验收资料，不代表真实用户：我长期喜欢无糖红茶。请为这个偏好提出记忆候选，不要当作已经确认或记住，也不要调用其他工具。");
  const candidate = (await store.overview()).candidates[0];
  await store.reviewCandidate(candidate.id, { revision: candidate.revision, decision: "reject" });
  assert.equal((await store.overview()).candidates[0].status, "rejected");
  assert.deepEqual((await store.snapshot()).facts, []);
  report.rejectedCandidateNotActive = true;
  const fact = await store.create({ label: "虚构出行偏好", value: "虚构用户在市内短途交通中优先选择地铁。" });
  const prompt = "只依据我已确认的个人资料，建议一种市内短途交通方式。不要查询线路、文件或外部服务，不要订票。";
  const old = await runCase("original-fact", prompt, "地铁");
  await store.update(fact.id, { revision: fact.revision, label: fact.label, value: "虚构用户已更正：市内短途交通优先选择公交车。" });
  assert.match(personalFactContextIssue({ codexSessionId: old.threadId, personalFactContext: { ...old.snapshot.context, threadId: old.threadId } }, await store.snapshot()), /开启新上下文/);
  report.oldContextRequiresRenewal = true;
  const corrected = await runCase("corrected-fact-new-context", prompt, "公交");
  assert.notEqual(corrected.threadId, old.threadId);
  assert.deepEqual((await store.overview()).candidates.map(item => item.status), ["rejected"]);
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.message;
  if (active && !report.cases.some(item => item.turnId === active.job.turnId)) report.incompleteTurn = {
    kind: active.kind, threadId: active.job.threadId, turnId: active.job.turnId, calls: active.calls,
    usage: active.meter.snapshot(), itemTypes: active.items.map(item => item.type) };
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (!report.ok && active?.job.threadId && active?.job.turnId) await client?.request("turn/interrupt", { threadId: active.job.threadId, turnId: active.job.turnId }, 10000).catch(() => null);
  await client?.stop({ waitForExit: true });
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  const evidencePath = path.join(root, "evidence.json");
  await fs.writeFile(evidencePath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, mode: report.mode, modelTurnsStarted: report.modelTurnsStarted,
    realModelTurnsStarted: live ? report.modelTurnsStarted : 0,
    cases: report.cases.map(({ kind, elapsedMs, usage }) => ({ kind, elapsedMs, usage })), error: report.error, evidencePath,
    thirdPartyBusinessCalls: 0, productionFactsWritten: 0, humanRatings: 0 }));
}
