import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";

// Real CLI, disposable uncredentialed HOME and a loopback synthetic provider only.
const command = process.env.CODEX_SCHEMA_CLI_BINARY || execFileSync("npx", ["--no-install", "--package=@openai/codex@0.157.1", "-c", "command -v codex"], { encoding: "utf8" }).trim();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-offline-policy-"));
const cwd = path.join(root, "workspace"), home = path.join(root, "codex-home"), tmp = path.join(root, "tmp");
const outside = path.join(root, "outside.txt"), marker = path.join(root, "mcp-started.txt");
const q = value => "'" + value.replaceAll("'", "'\\''") + "'";
let client, requests = 0, networkReceived = false, providerError = null, advertisedNames = [], execSpec, outcome;
const provider = http.createServer(async (req, res) => {
  if (req.url === "/blocked-probe") { networkReceived = true; res.end("canary"); return; }
  try {
    let body = ""; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); requests++;
    assert.equal(req.url, "/v1/responses"); assert.ok(requests <= 2);
    const advertised = data.tools || data.input?.find(item => item.type === "additional_tools")?.tools || [];
    const flatten = (tools, namespace) => tools.flatMap(tool => tool.type === "namespace" ? flatten(tool.tools, tool.name) : [{ ...tool, namespace }]);
    const tools = flatten(advertised), names = tools.map(tool => tool.name || tool.type);
    advertisedNames = names;
    execSpec = tools.find(tool => tool.name === "exec");
    assert.equal(names.some(name => /fixture|web_search|image_generation|browser|computer/i.test(name)), false);
    assert.equal(execSpec?.type, "custom");
    if (requests === 2) {
      const receipt = data.input?.find(item => item.type === "custom_tool_call_output" && item.call_id === "offline-call");
      assert.ok(receipt, "native command completion receipt is required");
      assert.match(JSON.stringify(receipt.output), /OFFLINE_PROBE_FINISHED/);
    }
    const probe = `import fs from 'node:fs';fs.writeFileSync('inside.txt','synthetic');try{fs.writeFileSync(${JSON.stringify(outside)},'should-be-blocked')}catch{}try{await fetch(${JSON.stringify(base + "/blocked-probe")},{signal:AbortSignal.timeout(1000)})}catch{}console.log('OFFLINE_PROBE_FINISHED');`;
    const output = requests === 1
      ? [{ id: "fc_offline", type: "custom_tool_call", call_id: "offline-call", name: "exec", namespace: execSpec.namespace,
        input: `const result = await tools.exec_command(${JSON.stringify({ cmd: q(process.execPath) + " --input-type=module -e " + q(probe), workdir: cwd, yield_time_ms: 10000, max_output_tokens: 1000 })}); if (result.session_id) throw new Error("Synthetic command did not finish"); text(result);`, status: "completed" }]
      : [{ id: "msg_offline", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic probe complete.", annotations: [] }] }];
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event("response.created", { response: { id: `offline-${requests}`, status: "in_progress", output: [] } });
    for (const item of output) event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { id: `offline-${requests}`, status: "completed", output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }); res.end();
  } catch (error) { providerError = error.message; res.writeHead(400); res.end(JSON.stringify({ error: { message: "Synthetic probe rejected", type: "invalid_request_error" } })); }
});
let base;
try {
  for (const dir of [cwd, home, tmp]) await fs.mkdir(dir);
  await fs.writeFile(path.join(root, "mcp.mjs"), `import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(marker)},'started\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'fixture_canary',description:'Synthetic only',inputSchema:{type:'object',properties:{}}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${provider.address().port}`;
  const args = ["app-server", "--listen", "stdio://", "-c", 'model_provider="offline_fixture"', "-c", 'model_providers.offline_fixture.name="Synthetic offline test"',
    "-c", `model_providers.offline_fixture.base_url="${base}/v1"`, "-c", 'model_providers.offline_fixture.wire_api="responses"', "-c", "model_providers.offline_fixture.requires_openai_auth=false", "-c", "model_providers.offline_fixture.supports_websockets=false",
    "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "-c", "features.apps=false", "-c", 'cli_auth_credentials_store="file"',
    "-c", `mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.fixture.args=${JSON.stringify([path.join(root, "mcp.mjs")])}`, "-c", "mcp_servers.fixture.enabled=true"];
  const createClient = () => new CodexAppServerClient({ cwd, command, args, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, TMPDIR: tmp }, onServerRequest: () => { throw new Error("Synthetic offline profile never grants extra permissions"); } });
  client = createClient();
  const baseline = await client.request("thread/start", { cwd, model: "gpt-6-sol", ephemeral: true, approvalPolicy: "never", sandbox: "workspace-write" }, 20000);
  assert.equal(baseline.modelProvider, "offline_fixture");
  const connectionDeadline = Date.now() + 15000;
  let before, delay = 100;
  do {
    const remaining = connectionDeadline - Date.now(); if (remaining <= 0) break;
    before = await client.request("mcpServerStatus/list", { threadId: baseline.thread.id, limit: 100, detail: "toolsAndAuthOnly" }, remaining);
    if (!["starting", "notStarted"].includes(before.data.find(server => server.name === "fixture")?.runtimeStatus)) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, connectionDeadline - Date.now())))); delay = Math.min(delay * 2, 1000);
  } while (Date.now() < connectionDeadline);
  assert.equal(before.data.find(server => server.name === "fixture")?.runtimeStatus, "connected");
  assert.equal(requests, 0); await client.stop({ waitForExit: true });
  const startedCount = await fs.readFile(marker, "utf8");
  client = createClient();
  const restricted = await client.request("thread/start", { cwd, model: "gpt-6-sol", ephemeral: true, approvalPolicy: "never", sandbox: "workspace-write", config: {
    "mcp_servers.fixture.enabled": false, "features.apps": false, "apps._default.enabled": false, "features.multi_agent": false,
    "sandbox_workspace_write.network_access": false, "sandbox_workspace_write.exclude_tmpdir_env_var": true, "sandbox_workspace_write.exclude_slash_tmp": true,
    tools: { web_search: false },
  } }, 20000);
  assert.equal(restricted.modelProvider, "offline_fixture");
  assert.equal(restricted.approvalPolicy, "never"); assert.equal(restricted.sandbox.type, "workspaceWrite"); assert.equal(restricted.sandbox.networkAccess, false);
  const status = await client.request("mcpServerStatus/list", { threadId: restricted.thread.id, limit: 100, detail: "toolsAndAuthOnly" }, 15000);
  assert.equal(status.nextCursor, null);
  assert.equal(status.data.find(server => server.name === "fixture")?.runtimeStatus, "disabled");
  assert.equal(status.data.every(server => server.runtimeStatus === "disabled" && Object.keys(server.tools).length === 0), true);
  assert.equal(await fs.readFile(marker, "utf8"), startedCount);
  let timer, listener;
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Synthetic offline turn timed out")), 30000);
    listener = message => { if (message.method === "turn/completed") resolve(message.params.turn); };
    client.on("notification", listener);
  }); completed.catch(() => {});
  try {
    await client.request("turn/start", { threadId: restricted.thread.id, input: [{ type: "text", text: "Run the synthetic offline probe." }], sandboxPolicy: {
      type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    }, approvalPolicy: "never" }, 15000);
    assert.equal((await completed).status, "completed");
  } finally { clearTimeout(timer); client.off("notification", listener); }
  assert.equal(providerError, null); assert.equal(requests, 2);
  assert.equal(await fs.readFile(path.join(cwd, "inside.txt"), "utf8"), "synthetic");
  await assert.rejects(fs.stat(outside), { code: "ENOENT" }); assert.equal(networkReceived, false);
  outcome = { ok: true, cli: execFileSync(command, ["--version"], { encoding: "utf8" }).trim(), syntheticProviderRequests: requests, externalModelCalls: 0,
    delegationToolsAdvertised: advertisedNames.some(name => /spawn_agent|followup_task/.test(name)),
    checks: ["已启用连接器按线程禁用且未启动", "模型工具目录不含连接器与网页搜索", "工作区内写入成功", "工作区外写入与命令联网拒绝"] };
} catch (error) { console.error(JSON.stringify({ error: error.message, providerError, syntheticProviderRequests: requests, advertisedNames, stderr: client?.status().stderrTail })); process.exitCode = 1; }
finally { await client?.stop({ waitForExit: true }); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
if (outcome && !process.exitCode) console.log(JSON.stringify({ ...outcome, cleanupVerified: true }));
