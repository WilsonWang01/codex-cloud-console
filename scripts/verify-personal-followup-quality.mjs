import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";
import { profileThreadConfig } from "../server/automation-execution-profile.mjs";
import { personalDeveloperInstructions } from "../server/personal-runtime.mjs";
import { personalReplySourceSchema, personalReplyDigest } from "../server/personal-reply-source.mjs";
import { createTurnUsageMeter } from "../server/run-usage.mjs";

const live = process.argv.includes("--live");
assert.ok(process.argv.slice(2).every(arg => arg === "--live"));
if (live) assert.equal(process.env.CODEX_PERSONAL_LIVE_APPROVED, "1", "真实模型检查需要额度授权");
const file = new URL("../docs/research/acceptance/result-references-20261026/followup-draft.json", import.meta.url);
const bytes = await fs.readFile(file); assert.ok(bytes.length <= 32768);
const input = JSON.parse(bytes); assert.equal(input.version, 1); assert.equal(input.origin, "actual-isolated-console-ui");
assert.ok(Date.now() - Date.parse(input.capturedAt) >= 0 && Date.now() - Date.parse(input.capturedAt) < 600000, "先运行结果 UI 验收，使用 10 分钟内实际生成的草稿");
const source = personalReplySourceSchema.parse(input.source);
assert.equal(personalReplyDigest(input.reply), source.contentDigest); assert.ok(input.prompt.includes(JSON.stringify({ source, reply: input.reply }, null, 2)));
assert.equal(input.commitment.title, "合成路线跟进"); assert.equal(input.commitment.waitingReason, "等家人确认日期");
assert.equal(input.commitment.milestones.length, 2); assert.equal(input.commitment.milestones[0].done, true); assert.equal(input.commitment.milestones[1].done, false);
const command = process.env.CODEX_SCHEMA_CLI_BINARY || execFileSync("npx", ["--no-install", "--package=@openai/codex@0.157.1", "-c", "command -v codex"], { encoding: "utf8" }).trim();
assert.equal(execFileSync(command, ["--version"], { encoding: "utf8" }).trim(), "codex-cli 0.157.1");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-followup-quality-")); await fs.chmod(root, 0o700);
const home = path.join(root, "home"); await fs.mkdir(home);
const cwd = live ? process.env.CODEX_PERSONAL_LIVE_CWD : root;
assert.ok(cwd && path.isAbsolute(cwd), "真实检查需要已有受信任工作目录，不新增信任配置");
const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
const configDigest = async () => crypto.createHash("sha256").update(await fs.readFile(configPath)).digest("hex");
const before = live ? await configDigest() : null;
const features = { apps: false, plugins: false, remote_plugin: false, multi_agent: false, shell_tool: false, hooks: false, memories: false,
  browser_use: false, browser_use_external: false, computer_use: false, image_generation: false, view_image: false, goals: false, sleep_tool: false, skip_host_skill_discovery: true };
const report = { mode: live ? "live-inference-synthetic-followup" : "loopback-synthetic-provider", model: "gpt-6-sol", effort: "medium",
  inputSha256: crypto.createHash("sha256").update(bytes).digest("hex"), source, prompt: input.prompt,
  modelTurnsStarted: 0, syntheticProviderRequests: 0, businessCalls: 0, humanRatings: 0, actualCrossDay: false };
let client, timer, finish, threadId, turnId, providerError;
const items = [], requests = [], meter = createTurnUsageMeter();
const provider = live ? null : http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/responses");
    let text = ""; for await (const chunk of req) { text += chunk; assert.ok(Buffer.byteLength(text) <= 1024 * 1024); }
    const body = JSON.parse(text); assert.equal(++report.syntheticProviderRequests, 1);
    const tools = body.tools || body.input?.find(item => item.type === "additional_tools")?.tools; assert.ok(Array.isArray(tools));
    const flatten = tools => tools.flatMap(tool => tool.type === "namespace" ? flatten(tool.tools) : [tool]);
    const names = flatten(tools).flatMap(tool => [tool.name || tool.type, ...[...(tool.description || "").matchAll(/declare const tools: \{ (\w+)/g)].map(match => match[1])]);
    const allowed = new Set(["exec", "wait", "request_user_input", "request_user_input_async", "apply_patch", "clock__curr_time"]);
    assert.deepEqual(names.filter(name => !allowed.has(name)), [], "不能提供终端、连接器、委派或其他执行工具"); report.toolNames = [...new Set(names)];
    assert.ok(JSON.stringify(body.input).includes("合成路线跟进"));
    const output = [{ type: "message", id: "followup-result", role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [], text: "已记录整理候选路线这一步完成，日期仍等家人确认。现在先确认出行日期，不重复预订；尚无预订或付款回执。请补充日期和人数。" }] }];
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    for (const [type, value] of [["response.created", { response: { id: "followup", status: "in_progress", output: [] } }], ["response.output_item.done", { output_index: 0, item: output[0] }],
      ["response.completed", { response: { id: "followup", status: "completed", output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }]]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    res.end();
  } catch (error) { providerError = error.message; res.writeHead(400); res.end("合成跟进契约拒绝"); }
});
try {
  if (provider) await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const overrides = { "agents.enabled": false, ...Object.fromEntries(Object.entries(features).map(([key, value]) => ["features." + key, value])), web_search: "disabled", "tools.web_search": false };
  const args = ["app-server", "--listen", "stdio://", ...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])];
  if (provider) args.push("-c", 'model_provider="followup_fixture"', "-c", 'model_providers.followup_fixture.name="Synthetic followup"', "-c", `model_providers.followup_fixture.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
    "-c", 'model_providers.followup_fixture.wire_api="responses"', "-c", "model_providers.followup_fixture.requires_openai_auth=false", "-c", "model_providers.followup_fixture.supports_websockets=false");
  client = new CodexAppServerClient({ cwd, command, args, env: live ? { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) } : { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    onServerRequest: async (method, params) => { requests.push({ method, tool: params.tool }); throw new Error("本次跟进验收不授予工具或额外权限"); } });
  client.on("notification", message => {
    if (message.params?.threadId !== threadId) return;
    if (message.method === "turn/started") turnId = message.params.turn.id;
    if (message.method === "thread/tokenUsage/updated") meter.observe(message.params.tokenUsage);
    if (message.method === "item/completed") { items.push(message.params.item); meter.observeItem(message.params.item); }
    if (message.method === "turn/completed") finish?.(message.params.turn);
  });
  if (live) assert.ok((await client.request("account/read", {}, 15000)).account, "原登录不可用，未启动模型");
  const config = (await client.request("config/read", { cwd, includeLayers: false }, 15000)).config;
  if (live) assert.equal(config.projects?.[cwd]?.trust_level, "trusted", "需要已受信任目录，不登记新目录");
  const profile = profileThreadConfig(config, cwd);
  const thread = await client.request("thread/start", { cwd, model: report.model, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
    config: { ...profile, features: { ...profile.features, ...features } }, developerInstructions: personalDeveloperInstructions({ sandbox: "read-only" }, [], [input.commitment]) + "\nThis is a bounded synthetic quality check. Use only the provided conversation, no tools. Reply briefly in Chinese." }, 20000);
  assert.equal(thread.model, report.model); assert.equal(thread.modelProvider, live ? "openai" : "followup_fixture"); assert.equal(thread.thread.ephemeral, true);
  assert.equal(thread.cwd, cwd); assert.equal(thread.approvalPolicy, "never"); assert.deepEqual(thread.sandbox, { type: "readOnly", networkAccess: false });
  threadId = thread.thread.id;
  const connectors = await client.request("mcpServerStatus/list", { threadId, cursor: null, limit: 100, detail: "toolsAndAuthOnly" }, 15000);
  assert.equal(connectors.nextCursor, null); assert.ok(Array.isArray(connectors.data) && connectors.data.length <= 100);
  const names = new Set(); for (const entry of connectors.data) { assert.ok(typeof entry.name === "string" && !names.has(entry.name)); names.add(entry.name); assert.equal(entry.runtimeStatus, "disabled"); assert.deepEqual(entry.tools, {}); }
  const completed = new Promise((resolve, reject) => { finish = resolve; timer = setTimeout(() => reject(new Error("跟进回合超过 120 秒，停止且不自动重试")), 120000); }); completed.catch(() => {});
  const startedAt = Date.now(); report.modelTurnsStarted++;
  const started = await client.request("turn/start", { threadId, model: report.model, effort: report.effort, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
    input: [{ type: "text", text: input.prompt }] }, 20000); turnId ||= started.turn.id;
  const terminal = await completed; clearTimeout(timer);
  Object.assign(report, { threadId, turnId, elapsedMs: Date.now() - startedAt, terminal: terminal.status, assistantText: items.filter(item => item.type === "agentMessage").map(item => item.text).join("\n"), requests, usage: meter.snapshot(), itemTypes: items.map(item => item.type) });
  assert.equal(providerError, undefined); assert.equal(terminal.id, turnId); assert.equal(terminal.status, "completed", JSON.stringify(terminal.error));
  assert.deepEqual(requests, []); assert.deepEqual(items.filter(item => !["reasoning", "agentMessage", "userMessage"].includes(item.type)), []); assert.equal(report.usage.status, "complete");
  assert.match(report.assistantText, /路线.*已整理|整理.*完成/); assert.match(report.assistantText, /家人|等待|等.*确认/); assert.match(report.assistantText, /日期/);
  assert.doesNotMatch(report.assistantText, /已经?预订成功|已经?付款|已经?发送|已经?创建(?:了)?日程/); report.ok = true;
} catch (error) { report.ok = false; report.error = error.message; report.incomplete = { threadId, turnId, requests, usage: meter.snapshot(), itemTypes: items.map(item => item.type) }; process.exitCode = 1; }
finally {
  clearTimeout(timer); if (!report.ok && threadId && turnId) await client?.request("turn/interrupt", { threadId, turnId }, 10000).catch(() => null);
  await client?.stop({ waitForExit: true }); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  if (live) { report.sharedConfigUnchanged = before === await configDigest(); if (!report.sharedConfigUnchanged) { report.ok = false; report.error = "共享配置发生变化，原样保留，不回滚整份配置"; process.exitCode = 1; } }
  const evidencePath = path.join(root, "evidence.json"); await fs.writeFile(evidencePath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, mode: report.mode, realModelTurnsStarted: live ? report.modelTurnsStarted : 0, syntheticProviderRequests: report.syntheticProviderRequests,
    elapsedMs: report.elapsedMs, usage: report.usage, businessCalls: 0, humanRatings: 0, actualCrossDay: false, error: report.error, evidencePath, ...(live ? { sharedConfigUnchanged: report.sharedConfigUnchanged } : {}) }));
}
