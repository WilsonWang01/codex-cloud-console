import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";
import { profileThreadConfig, profileSandbox, verifyProfileThread } from "../server/automation-execution-profile.mjs";
import { createTurnUsageMeter } from "../server/run-usage.mjs";

// Measures actual tool execution, not whether a feature flag is echoed back.
const command = process.env.CODEX_SCHEMA_CLI_BINARY || execFileSync("npx", ["--no-install", "--package=@openai/codex@0.157.1", "-c", "command -v codex"], { encoding: "utf8" }).trim();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-delegation-probe-"));
let client, active, providerError, requests = 0, outcome;
const provider = http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/responses"); assert.ok(active && ++requests <= 16);
    let body = ""; for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 2 * 1024 * 1024); }
    const data = JSON.parse(body), first = ++active.requests === 1;
    const flatten = (tools, namespace) => tools.flatMap(tool => tool.type === "namespace" ? flatten(tool.tools, tool.name) : [{ ...tool, namespace }]);
    const tools = flatten(data.tools || data.input?.find(item => item.type === "additional_tools")?.tools || []);
    const spawn = tools.find(tool => tool.name === "spawn_agent");
    if (first) {
      assert.equal(spawn?.type, "function");
      assert.deepEqual(spawn.parameters.required, ["task_name", "message"]);
      active.advertised = { name: spawn.name, namespace: spawn.namespace };
    }
    active.receipts.push(...(data.input || []).filter(item => item.type === "function_call_output" && item.call_id === "delegation-" + active.id).map(item => item.output));
    const output = first ? [{ type: "function_call", id: "fc_" + active.id, call_id: "delegation-" + active.id,
      name: spawn.name, namespace: spawn.namespace, arguments: JSON.stringify({ task_name: "synthetic_delegation_canary", message: "Reply with SYNTHETIC_CHILD only. Do not call tools." }), status: "completed" }]
      : [{ id: "msg_" + requests, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "SYNTHETIC_CHILD", annotations: [] }] }];
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit("response.created", { response: { id: "response_" + requests, status: "in_progress", output: [] } });
    for (const item of output) emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { id: "response_" + requests, status: "completed", output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }); res.end();
  } catch (error) { providerError = error.message; res.writeHead(400); res.end(JSON.stringify({ error: { message: "Synthetic delegation probe rejected", type: "invalid_request_error" } })); }
});
async function waitForTurn(events, threadId, turnId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (providerError) throw new Error(providerError);
    const completed = events.find(event => event.method === "turn/completed" && event.params.threadId === threadId && event.params.turn.id === turnId);
    if (completed) { assert.equal(completed.params.turn.status, "completed"); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic delegation turn timed out");
}
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${provider.address().port}/v1`, cases = [];
  for (const restricted of [false, true]) {
    const id = restricted ? "restricted" : "control", home = path.join(root, id), cwd = path.join(home, "work");
    await fs.mkdir(cwd, { recursive: true });
    active = { id, requests: 0, receipts: [] };
    client = new CodexAppServerClient({ cwd, command, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      args: ["app-server", "--listen", "stdio://", "-c", 'model_provider="delegation_fixture"', "-c", 'model_providers.delegation_fixture.name="Synthetic delegation test"',
        "-c", `model_providers.delegation_fixture.base_url=${JSON.stringify(base)}`, "-c", 'model_providers.delegation_fixture.wire_api="responses"',
        "-c", "model_providers.delegation_fixture.requires_openai_auth=false", "-c", "model_providers.delegation_fixture.supports_websockets=false",
        "-c", "model_providers.delegation_fixture.request_max_retries=0", "-c", "model_providers.delegation_fixture.stream_max_retries=0",
        "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "-c", "features.apps=false", "-c", 'cli_auth_credentials_store="file"'],
      onServerRequest: () => { throw new Error("Synthetic delegation probe never grants permissions"); },
    });
    const events = [];
    const observe = event => { if (events.length >= 256) providerError = "Synthetic native event limit exceeded"; else events.push(event); };
    client.on("notification", observe);
    const config = (await client.request("config/read", { cwd, includeLayers: false }, 15000)).config;
    const thread = await client.request("thread/start", { cwd, model: "gpt-6-sol", approvalPolicy: "never", sandbox: "workspace-write",
      ...(restricted ? { config: profileThreadConfig(config, cwd) } : {}) }, 20000);
    assert.equal(thread.modelProvider, "delegation_fixture");
    if (restricted) await verifyProfileThread((...args) => client.request(...args), thread, cwd);
    const started = await client.request("turn/start", { threadId: thread.thread.id, approvalPolicy: "never", sandboxPolicy: profileSandbox(cwd),
      input: [{ type: "text", text: "Run the synthetic delegation measurement. No external services or real data." }] }, 20000);
    await waitForTurn(events, thread.thread.id, started.turn.id);
    if (restricted) {
      const childDeadline = Date.now() + 5000;
      while (!events.some(event => event.method === "thread/tokenUsage/updated" && event.params.threadId !== thread.thread.id) && Date.now() < childDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(events.some(event => event.method === "thread/tokenUsage/updated" && event.params.threadId !== thread.thread.id), "Native child usage is required before restart");
      const restart = { cwd, command, args: client.args, env: client.env, onServerRequest: client.onServerRequest };
      await client.stop({ waitForExit: true });
      client = new CodexAppServerClient(restart); client.on("notification", observe);
      const count = requests;
      const resumed = await client.request("thread/resume", { threadId: thread.thread.id, cwd, model: "gpt-6-sol", approvalPolicy: "never", sandbox: "workspace-write",
        config: profileThreadConfig((await client.request("config/read", { cwd, includeLayers: false }, 15000)).config, cwd) }, 20000);
      await verifyProfileThread((...args) => client.request(...args), resumed, cwd, thread.thread.id);
      assert.equal(requests, count, "Resume must not invoke the model");
      active.cliRestarted = true;
    }
    const next = await client.request("turn/start", { threadId: thread.thread.id, approvalPolicy: "never", sandboxPolicy: profileSandbox(cwd),
      input: [{ type: "text", text: "Reply briefly without any tools." }] }, 20000);
    await waitForTurn(events, thread.thread.id, next.turn.id);
    const read = await client.request("thread/read", { threadId: thread.thread.id, includeTurns: true }, 15000);
    active.calls = read.thread.turns.find(turn => turn.id === started.turn.id)?.items.filter(item => ["collabAgentToolCall", "subAgentActivity"].includes(item.type)) || [];
    active.usage = events.filter(event => event.method === "thread/tokenUsage/updated").map(event => ({ threadId: event.params.threadId, turnId: event.params.turnId, usage: event.params.tokenUsage }));
    active.childUsageVerified = active.usage.some(event => event.threadId !== thread.thread.id && event.usage.total.totalTokens > 0);
    active.rootThreadId = thread.thread.id;
    active.firstTurnId = started.turn.id;
    active.nextTurnId = next.turn.id;
    const parent = createTurnUsageMeter(), following = createTurnUsageMeter(), full = createTurnUsageMeter();
    for (const item of active.calls) full.observeItem(item);
    for (const event of active.usage) {
      if (event.threadId !== thread.thread.id) continue;
      if (event.turnId === started.turn.id) { parent.observe(event.usage); full.observe(event.usage); }
      if (event.turnId === next.turn.id) following.observe(event.usage);
    }
    active.accounting = { parent: parent.snapshot(), following: following.snapshot(), includingDelegation: full.snapshot() };
    assert.equal(active.accounting.parent.totalTokens, 40);
    assert.equal(active.accounting.following.totalTokens, 20);
    assert.equal(active.accounting.includingDelegation.status, "unknown");
    assert.equal(providerError, undefined); assert.ok(active.receipts.length, "A real native tool receipt is required");
    cases.push(active);
    await client.stop({ waitForExit: true }); client = null;
  }
  assert.equal(JSON.parse(cases[0].receipts[0]).task_name, "/root/synthetic_delegation_canary", "Positive control must actually spawn");
  assert.equal(cases[0].childUsageVerified, true, "Positive control must include native child usage");
  outcome = { measurementComplete: true, cli: execFileSync(command, ["--version"], { encoding: "utf8" }).trim(),
    syntheticProviderRequests: requests, externalModelCalls: 0, cases };
} catch (error) { console.error(JSON.stringify({ error: error.message, providerError, requests, active, stderr: client?.status().stderrTail })); process.exitCode = 1; }
finally { await client?.stop({ waitForExit: true }); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
if (outcome && !process.exitCode) console.log(JSON.stringify({ ...outcome, cleanupVerified: true }));
