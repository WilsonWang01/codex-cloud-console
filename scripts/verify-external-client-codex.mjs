import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { inlinePdf } from "./fixtures/inline-pdf.mjs";

const live = process.argv.includes("--live");
const guardsOnly = process.argv.includes("--guards-only");
const faultsOnly = process.argv.includes("--faults-only");
assert.ok(process.argv.slice(2).every(arg => ["--live", "--guards-only", "--faults-only"].includes(arg)) && [live, guardsOnly, faultsOnly].filter(Boolean).length <= 1, "Use only one of --live, --guards-only or --faults-only");
if (live) assert.equal(process.env.CODEX_EXTERNAL_LIVE_APPROVED, "1", "Live inference requires explicit quota approval");
if (live) {
  assert.ok(process.env.CODEX_EXTERNAL_LIVE_HOME, "Live verification requires a dedicated, already authenticated CODEX_EXTERNAL_LIVE_HOME; shared Codex home is not used");
  const dedicated = await fs.realpath(process.env.CODEX_EXTERNAL_LIVE_HOME);
  const normalHome = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex");
  const shared = await fs.realpath(normalHome).catch(error => { if (error.code === "ENOENT") return path.resolve(normalHome); throw error; });
  const stat = await fs.stat(dedicated);
  assert.ok(dedicated !== shared && stat.isDirectory() && (stat.mode & 0o077) === 0, "The dedicated CLI home must be private and separate from the normal Codex home");
}

function verifyLiveGuards(home) {
  for (const [extra, message] of [[{}, "requires explicit quota approval"], [{ CODEX_EXTERNAL_LIVE_APPROVED: "1" }, "requires a dedicated"], [{ CODEX_EXTERNAL_LIVE_APPROVED: "1", CODEX_EXTERNAL_LIVE_HOME: home }, "must be private and separate"]]) {
    let denied;
    try { execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--live"], { env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, ...extra }, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { denied = error; }
    assert.equal(denied?.status, 1); assert.ok(denied.stderr.toString().includes(message), "Live verification must reject unsafe setup before starting CLI");
  }
  return 3;
}
if (guardsOnly) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-client-guards-"));
  try { console.log(JSON.stringify({ ok: true, mode: "live-guards-only", liveGuardChecks: verifyLiveGuards(home), nativeCliStarted: false, realModelTurns: 0 })); }
  finally { await fs.rm(home, { recursive: true }); }
  process.exit(0);
}
const project = fileURLToPath(new URL("..", import.meta.url));
const expectedVersion = process.env.CODEX_SCHEMA_CLI_VERSION || "0.157.1";
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "Expected an explicit stable CLI version");
const command = process.env.CODEX_SCHEMA_CLI_BINARY || execFileSync("npx", ["--no-install", `--package=@openai/codex@${expectedVersion}`, "-c", "command -v codex"], { encoding: "utf8" }).trim();
const version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
assert.equal(version, `codex-cli ${expectedVersion}`, "Native CLI must match the explicitly selected version");
const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "codex-external-native-")));
await fs.chmod(root, 0o700);
const cloud = path.join(root, "cloud"), state = path.join(root, "state"), bin = path.join(root, "bin"), home = path.join(root, "home");
const repo = path.join(cloud, "workspace/research"), gate = path.join(root, "release-turn"), journal = path.join(root, "turns.jsonl");
const interruptJournal = path.join(root, "interrupts.jsonl");
for (const directory of [repo, state, bin, home]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const cliHome = live ? await fs.realpath(process.env.CODEX_EXTERNAL_LIVE_HOME) : home;
const configDigest = async () => fs.readFile(path.join(cliHome, "config.toml")).then(bytes => createHash("sha256").update(bytes).digest("hex"))
  .catch(error => { if (error.code === "ENOENT") return null; throw error; });
const originalConfigDigest = await configDigest();
const nonce = randomUUID(), expected = { nonce, total: 42, report: "results/report.md" };
const reportBody = `# Synthetic client report\n\n${nonce}\n17 + 25 = 42\n`;
const schema = { type: "object", properties: { nonce: { type: "string" }, total: { type: "integer" }, report: { type: "string" } }, required: ["nonce", "total", "report"], additionalProperties: false };
const summary = { mode: live ? "live-inference-isolated-console" : faultsOnly ? "real-cli-inflight-faults" : "real-cli-loopback-provider", cli: version, model: "gpt-6-sol", effort: "medium", productionConsoleWrites: 0 };
let server, serverOutput = "", providerError, providerRequests = 0, origin, token, clientId;
const heldRequests = [];
const adminToken = randomBytes(32).toString("hex"), admin = { "content-type": "application/json", "x-codex-cloud-token": adminToken };
const children = new Map();

async function captured(program, args, options = {}) {
  const child = spawn(program, args, { timeout: 30000, killSignal: "SIGKILL", ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}
async function request(route, options = {}) {
  const response = await fetch(origin + route, { ...options, headers: { ...admin, ...options.headers }, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return data;
}
async function wait(predicate, ms = 15000) {
  const until = Date.now() + ms;
  do { const result = await predicate(); if (result) return result; await sleep(100); } while (Date.now() < until);
  throw new Error("Isolated client check exceeded its observation deadline; not retried");
}
async function stop({ crash = false } = {}) {
  if (!server) return;
  const child = server; server = null;
  await fs.writeFile(path.join(root, "server-last.log"), serverOutput, { mode: 0o600 });
  try { process.kill(-child.pid, crash ? "SIGKILL" : "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await Promise.race([children.get(child), sleep(1500)]);
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await children.get(child);
}
const provider = live ? null : http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/responses");
    let body = ""; for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 2 * 1024 * 1024); }
    const data = JSON.parse(body); providerRequests++; assert.ok(providerRequests <= 2);
    if (faultsOnly) {
      assert.ok(JSON.stringify(data.input).includes(nonce), "Only the owned in-flight fixture may reach the provider");
      const held = { request: providerRequests, closed: false };
      heldRequests.push(held); res.once("close", () => { held.closed = true; });
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `inflight-${providerRequests}`, status: "in_progress", output: [] } })}\n\n`);
      return;
    }
    assert.ok(JSON.stringify(data.input).includes(nonce), "Native input must contain the supplied attachment");
    assert.ok(JSON.stringify(data.input).includes("Beta: 25"), "Native input must contain the parsed PDF text");
    assert.deepEqual(data.text?.format?.schema, schema, "Native output schema must reach the provider");
    const flatten = (tools, namespace) => tools.flatMap(tool => tool.type === "namespace" ? flatten(tool.tools, tool.name) : [{ ...tool, namespace }]);
    const tools = flatten(data.tools || data.input?.find(item => item.type === "additional_tools")?.tools || [], undefined), exec = tools.find(tool => tool.name === "exec");
    assert.ok(exec, "Native tool execution is required for the report file");
    assert.equal(tools.some(tool => /gmail|calendar|web_search|image_generation|browser/i.test(tool.name || tool.type)), false);
    // Artifact delivery does not require shell access on restricted CI hosts.
    const patch = "*** Begin Patch\n*** Add File: results/report.md\n" + reportBody.trimEnd().split("\n").map(line => "+" + line).join("\n") + "\n*** End Patch";
    const output = providerRequests === 1
      ? [{ id: "fc_report", type: "custom_tool_call", call_id: "report-write", name: "exec", namespace: exec.namespace, status: "completed",
        input: `text(await tools.apply_patch(${JSON.stringify(patch)})); text("SYNTHETIC_REPORT_WRITTEN");` }]
      : [{ id: "msg_report", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(expected), annotations: [] }] }];
    if (providerRequests === 2) assert.match(JSON.stringify(data.input.find(item => item.call_id === "report-write" && item.type === "custom_tool_call_output")), /SYNTHETIC_REPORT_WRITTEN/);
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event("response.created", { response: { id: `external-${providerRequests}`, status: "in_progress", output: [] } });
    for (const item of output) event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { id: `external-${providerRequests}`, status: "completed", output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }); res.end();
  } catch (error) { providerError = error.message; res.writeHead(400); res.end(JSON.stringify({ error: { message: "Synthetic provider rejected the request", type: "invalid_request_error" } })); }
});

async function verifyRunningFaults({ nodeClient, automation, restart }) {
  const submit = (event, prompt) => nodeClient("submit", automation.id, event, "--prompt", prompt);
  const started = (id, index) => wait(async () => {
    const run = await nodeClient("status", automation.id, id);
    assert.ok(["queued", "running"].includes(run.status), `Native fixture stopped before the held response: ${run.status}`);
    return run.status === "running" && heldRequests[index] && !heldRequests[index].closed ? run : null;
  });
  const cancelEvent = "inflight-cancel-" + nonce, cancelPrompt = "Synthetic in-flight cancellation " + nonce;
  const accepted = await submit(cancelEvent, cancelPrompt);
  await started(accepted.id, 0);
  assert.equal((await nodeClient("cancel", automation.id, accepted.id)).run.status, "canceling");
  const canceled = await wait(async () => {
    const run = await nodeClient("status", automation.id, accepted.id);
    return run.status === "canceled" ? run : null;
  });
  assert.equal(canceled.usage.status, "unknown", "An interrupted provider response has no confirmed token count");
  await wait(() => heldRequests[0].closed);
  for (let repeat = 0; repeat < 3; repeat++) assert.equal((await nodeClient("cancel", automation.id, accepted.id)).run.status, "canceled");
  const saved = JSON.parse(await fs.readFile(path.join(state, "automation-runs.json"), "utf8")).runs.find(run => run.id === accepted.id);
  const native = await request(`/api/codex/thread-read?${new URLSearchParams({ repoId: "research", sessionId: saved.sessionId })}`);
  assert.equal(native.thread.turns.length, 1); assert.equal(native.thread.turns[0].status, "interrupted");
  const itemTypes = native.thread.turns[0].items.map(item => item.type);
  assert.ok(itemTypes.every(type => ["userMessage", "reasoning", "agentMessage"].includes(type)), "Fault checks must not invoke native tools");
  const sameCanceled = await submit(cancelEvent, cancelPrompt);
  assert.equal(sameCanceled.id, accepted.id); assert.equal(sameCanceled.status, "canceled");

  const crashEvent = "inflight-crash-" + nonce, crashPrompt = "Synthetic in-flight crash recovery " + nonce;
  const interrupted = await submit(crashEvent, crashPrompt);
  await started(interrupted.id, 1);
  await stop({ crash: true });
  await wait(() => heldRequests[1].closed);
  await restart();
  const recovered = await wait(async () => {
    const run = await nodeClient("status", automation.id, interrupted.id);
    return run.status === "needs_reconciliation" ? run : null;
  });
  assert.equal(recovered.usage.status, "unknown");
  const sameRecovered = await submit(crashEvent, crashPrompt);
  assert.equal(sameRecovered.id, interrupted.id, "Restart must recover the accepted event, not execute it again");
  assert.equal(sameRecovered.status, "needs_reconciliation");
  assert.equal((await nodeClient("cancel", automation.id, interrupted.id)).run.status, "needs_reconciliation");
  await sleep(1500);
  assert.equal((await nodeClient("status", automation.id, interrupted.id)).status, "needs_reconciliation");
  const turns = (await fs.readFile(journal, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const interrupts = (await fs.readFile(interruptJournal, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(turns.length, 2); assert.equal(providerRequests, 2); assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].threadId, native.thread.id); assert.equal(interrupts[0].turnId, native.thread.turns[0].id);
  assert.equal(providerError, undefined);
  const usage = await request("/api/clients/usage?clientId=" + encodeURIComponent(clientId));
  for (const run of [canceled, recovered]) assert.equal(usage.runs.find(item => item.id === run.id).usage.status, "unknown");
  await request(`/api/clients/${clientId}/revoke`, { method: "POST", body: "{}" });
  summary.tokenRevoked = true;
  const denied = await fetch(origin + `/api/automations/${automation.id}/runs/${recovered.id}`, { headers: { "x-codex-cloud-token": token } });
  assert.equal(denied.status, 401); await denied.arrayBuffer();
  Object.assign(summary, { ok: true, nativeTurns: turns.length, realModelTurns: 0, providerRequests, interruptRequests: interrupts.length,
    canceledRun: { id: canceled.id, status: canceled.status, usage: canceled.usage }, recoveredRun: { id: recovered.id, status: recovered.status, usage: recovered.usage }, nativeItemTypes: [...new Set(itemTypes)],
    checks: ["独立 Node 客户端提交后真实 CLI 进入受控模型请求", "运行中取消关闭原生响应并产生 interrupted 回执", "重复取消与同事件恢复不再发原生回合或中断", "仅本轮进程组被强制终止后恢复原任务为待核对", "未完成响应的用量保持未知且不自动重放", "撤销临时令牌后不能查询结果"] });
}

try {
  if (!live) summary.liveGuardChecks = verifyLiveGuards(home);
  await fs.writeFile(path.join(repo, "README.md"), "Synthetic repository. Work only on the supplied request; no connectors, network, delegation or external writes.\n");
  for (const args of [["init", "-q"], ["add", "README.md"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Synthetic client fixture"]]) {
    const result = await captured("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }); assert.equal(result.code, 0, result.stderr);
  }
  if (provider) await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const overrides = ["features.apps=false", "features.plugins=false", "features.remote_plugin=false", "features.multi_agent=false", "features.memories=false", 'web_search="disabled"'];
  if (provider) overrides.push('model_provider="external_fixture"', 'model_providers.external_fixture.name="Synthetic external client"',
    `model_providers.external_fixture.base_url="http://127.0.0.1:${provider.address().port}/v1"`, 'model_providers.external_fixture.wire_api="responses"',
    "model_providers.external_fixture.requires_openai_auth=false", "model_providers.external_fixture.supports_websockets=false");
  const wrapper = path.join(bin, "codex");
  await fs.writeFile(wrapper, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';import {spawn} from 'node:child_process';
const args=process.argv.slice(2),rpc=args[0]==='app-server';if(rpc)args.push(...${JSON.stringify(overrides)}.flatMap(v=>['-c',v]));
const child=spawn(${JSON.stringify(command)},args,{stdio:['pipe','pipe','inherit']});
if(!rpc){process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout)}else{
const requests=new Map();readline.createInterface({input:process.stdin}).on('line',async line=>{try{const m=JSON.parse(line);if(m.id!=null&&m.method)requests.set(m.id,m.method);
if(m.method==='turn/interrupt')fs.appendFileSync(${JSON.stringify(interruptJournal)},JSON.stringify({method:m.method,...m.params})+'\\n',{mode:0o600});
if(m.method==='turn/start'){const count=fs.existsSync(${JSON.stringify(journal)})?fs.readFileSync(${JSON.stringify(journal)},'utf8').trim().split('\\n').filter(Boolean).length:0;
fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({method:m.method,threadId:m.params.threadId,at:new Date().toISOString()})+'\\n',{mode:0o600});
if(count>=${faultsOnly ? 2 : 1}||m.params.model!=='gpt-6-sol'||m.params.approvalPolicy!=='never'||m.params.sandboxPolicy?.type!=='workspaceWrite'||m.params.sandboxPolicy.networkAccess!==false)throw Error('Native inference guard rejected the turn');
const end=Date.now()+20000;while(!${faultsOnly}&&!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>end)throw Error('Synthetic release gate expired');await new Promise(r=>setTimeout(r,50));}}
child.stdin.write(line+'\\n');}catch{process.stderr.write('Isolated native request guard failed\\n');child.kill('SIGTERM');process.exitCode=1;}});
readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(${live}&&requests.get(m.id)==='thread/start'&&m.result?.modelProvider!=='openai'){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32000,message:'Live check requires the existing OpenAI provider'}})+'\\n');return;}process.stdout.write(line+'\\n');});}
child.on('exit',code=>process.exit(code??1));process.stdin.on('end',()=>child.stdin.end());for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));\n`, { mode: 0o700 });
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  const automation = { id: "native-client", repoId: "research", name: "Isolated native client", mode: "on-demand", model: "gpt-6-sol", reasoning: "medium", executionProfile: "workspace-restricted-v1", prompt: "Follow only the synthetic client request. Do not use network, connectors, delegation or other user files." };
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: cliHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloud, CODEX_STATE_ROOT: state, CODEX_PERSONAL_MODE: "disabled", CODEX_PERSONAL_ROOT: path.join(cloud, "personal"),
    CODEX_CLOUD_REPOS_CONFIG_B64: Buffer.from(JSON.stringify([{ id: "research", name: "Synthetic research", path: repo }])).toString("base64"),
    CODEX_CLOUD_AUTOMATIONS_CONFIG_B64: Buffer.from(JSON.stringify([automation])).toString("base64"), CODEX_CLOUD_WEBHOOK_TOKEN: adminToken,
    CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0", CODEX_AUTOMATION_MAX_CONCURRENT: "1", CODEX_AUTOMATION_MAX_CONCURRENT_PER_CLIENT: "1", CODEX_TURN_TIMEOUT_MS: "120000" };
  const start = async () => {
    server = spawn(process.execPath, [path.join(project, "server/index.mjs")], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.set(server, new Promise((resolve, reject) => { server.once("close", resolve); server.once("error", reject); }));
    serverOutput = "";
    const record = chunk => { serverOutput = (serverOutput + chunk).slice(-512000); };
    server.stdout.on("data", record); server.stderr.on("data", record);
    await wait(() => /listening on/.test(serverOutput));
  };
  await start();
  const created = await request("/api/clients", { method: "POST", body: JSON.stringify({ name: "synthetic-native-only", automationIds: [automation.id] }) });
  token = created.token; clientId = created.client.id;
  await request(`/api/clients/${clientId}/policy`, { method: "PATCH", body: JSON.stringify({ expectedRevision: 0, expiresAt: new Date(Date.now() + 3600000).toISOString() }) });
  const clientEnv = { PATH: process.env.PATH, HOME: home, CODEX_CLOUD_URL: origin, CODEX_CLOUD_API_TOKEN: token, PYTHONDONTWRITEBYTECODE: "1" };
  const nodeClient = async (...args) => {
    const result = await captured(process.execPath, [path.join(project, "scripts/external-client-example.mjs"), ...args], { env: clientEnv });
    let value; try { value = JSON.parse(result.stdout); } catch {}
    const expectedCode = faultsOnly && ["status", "submit"].includes(args[0]) && ["canceled", "needs_reconciliation"].includes(value?.status) ? 1 : 0;
    assert.equal(result.code, expectedCode, `Independent Node client failed: ${result.stderr.slice(-1000)} ${value?.error || ""}`); return value;
  };
  if (faultsOnly) await verifyRunningFaults({ nodeClient, automation, restart: start });
  else {
    const inputFile = path.join(root, "request.json"), material = path.join(root, "material.md"), pdf = path.join(root, "material.pdf"), eventId = "native-client-" + nonce;
    await fs.writeFile(material, `Synthetic attachment, not real user data.\nNonce: ${nonce}\nAlpha: 17\n`);
    await fs.writeFile(pdf, inlinePdf({ text: "Beta: 25", commands: "" }));
    const input = { model: "gpt-6-sol", reasoning: "medium", outputSchema: schema, artifactPaths: ["results/report.md"],
      prompt: "Read the supplied Markdown and PDF attachments. Compute Alpha + Beta using their values. Create results/report.md with exactly four lines: '# Synthetic client report', a blank line, the Nonce from the Markdown, and the calculation in the form 'Alpha + Beta = total' with the actual numbers substituted, with a final newline. Reply only with the output-schema JSON containing nonce, total and report='results/report.md'. Do not access other files, connectors, network, delegation, schedules or third-party services." };
    await fs.writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
    const submitArgs = ["submit", automation.id, eventId, "--input", inputFile, "--attach", material, "--attach", pdf];
    const accepted = await nodeClient(...submitArgs); summary.runId = accepted.id;
    await wait(async () => (await fs.readFile(journal, "utf8").catch(() => "")).trim());
    const queued = await nodeClient("submit", automation.id, "queued-" + nonce, "--prompt", "Must be canceled before native inference");
    assert.equal(queued.status, "queued");
    const canceled = await nodeClient("cancel", automation.id, queued.id);
    assert.equal(canceled.run.status, "canceled"); assert.equal(canceled.run.usage.totalTokens, 0);
    await fs.writeFile(gate, "release only the owned test turn\n", { flag: "wx", mode: 0o600 });
    const terminal = await wait(async () => { await sleep(1000); const value = await nodeClient("status", automation.id, accepted.id); return ["completed", "failed", "needs_reconciliation", "canceled"].includes(value.status) ? value : null; }, 140000);
    assert.equal(terminal.status, "completed", `Native run failed: ${terminal.error || terminal.summary}`);
    assert.equal(terminal.usage.status, "complete"); assert.ok(terminal.usage.totalTokens > 0);
    assert.equal(terminal.delivery.status, "ready");
    const manifest = await nodeClient("output", automation.id, accepted.id);
    assert.deepEqual(manifest.structuredOutput.data, expected); assert.equal(manifest.artifacts.length, 1);
    const artifact = manifest.artifacts[0];
    assert.equal(artifact.sha256, createHash("sha256").update(reportBody).digest("hex"));
    const saved = JSON.parse(await fs.readFile(path.join(state, "automation-runs.json"), "utf8")).runs.find(run => run.id === accepted.id);
    const originalFile = await fs.realpath(path.join(saved.worktreePath, expected.report));
    assert.ok(originalFile.startsWith(root + path.sep), "Only the owned disposable output may be changed");
    await fs.writeFile(originalFile, "Synthetic original changed after delivery; the private result must remain unchanged.\n");
    await stop(); await start();
    assert.equal((await nodeClient(...submitArgs)).id, accepted.id, "Same event must recover the original run after restart");
    const downloaded = path.join(root, "downloaded.md");
    const python = await captured("python3", [path.join(project, "scripts/external-client-example.py"), "download", automation.id, accepted.id, "--file-id", artifact.id, "--output", downloaded], { env: clientEnv });
    assert.equal(python.code, 0, `Independent Python download failed: ${python.stderr.slice(-1000)}`);
    assert.equal(await fs.readFile(downloaded, "utf8"), reportBody);
    const usage = await request("/api/clients/usage?clientId=" + encodeURIComponent(clientId));
    assert.equal(usage.runs.find(run => run.id === accepted.id).usage.totalTokens, terminal.usage.totalTokens);
    const native = await request(`/api/codex/thread-read?${new URLSearchParams({ repoId: "research", sessionId: saved.sessionId })}`);
    assert.equal(native.thread.id, saved.threadId);
    assert.equal(native.thread.turns.length, 1); assert.equal(native.thread.turns[0].status, "completed");
    const itemTypes = native.thread.turns[0].items.map(item => item.type);
    assert.ok(itemTypes.every(type => ["userMessage", "reasoning", "agentMessage", "commandExecution", "fileChange"].includes(type)), "Unexpected native tool activity");
    assert.ok(itemTypes.some(type => type === "fileChange" || type === "commandExecution"), "Native history must prove the file write");
    summary.nativeItemTypes = [...new Set(itemTypes)];
    summary.observedConnectorCalls = 0;
    await request(`/api/clients/${clientId}/revoke`, { method: "POST", body: "{}" });
    summary.tokenRevoked = true;
    const denied = await fetch(origin + artifact.downloadPath, { headers: { "x-codex-cloud-token": token } });
    assert.equal(denied.status, 401); await denied.arrayBuffer();
    assert.equal(providerError, undefined);
    const turns = (await fs.readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(turns.length, 1, "Replay, restart, queued cancellation and download cannot start another native turn");
    if (provider) assert.equal(providerRequests, 2);
    Object.assign(summary, { ok: true, nativeTurns: turns.length, realModelTurns: live ? turns.length : 0, providerRequests, usage: terminal.usage,
      checks: ["独立 Node 进程提交 Markdown/PDF 与 JSON schema", "真实 CLI 受限工作树生成报告", "未领取任务取消且用量为零", "同事件与重启找回原运行", "原文件变化后独立 Python 仍取回并核对私有结果", "调用方用量保持一致", "撤销后不能下载"] });
  }
} catch (error) { summary.ok = false; summary.error = error.message; summary.providerError = providerError; process.exitCode = 1; }
finally {
  if (clientId && server && !summary.tokenRevoked) {
    try { await request(`/api/clients/${clientId}/revoke`, { method: "POST", body: "{}" }); summary.tokenRevoked = true; }
    catch { summary.tokenRevoked = false; }
  }
  await stop();
  summary.cliConfigUnchanged = await configDigest() === originalConfigDigest;
  const config = await fs.readFile(path.join(cliHome, "config.toml"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  const section = `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`;
  const sameOriginal = text => originalConfigDigest === null ? text === "" : createHash("sha256").update(text).digest("hex") === originalConfigDigest;
  summary.cliConfigOnlyOwnedTrustEntry = config.split(section).length === 2 && [section + "\n", section].some(block => sameOriginal(config.replace(block, "")));
  if (!summary.cliConfigUnchanged && !summary.cliConfigOnlyOwnedTrustEntry) { summary.ok = false; summary.error = "CLI configuration changed beyond the owned test trust entry; retained for review, never restored over concurrent changes"; process.exitCode = 1; }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  summary.evidencePath = path.join(root, "evidence.json");
  summary.nativeTurnAttempts = (await fs.readFile(journal, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
  await fs.writeFile(summary.evidencePath, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(summary));
}
