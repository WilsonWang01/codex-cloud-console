import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";
import { handlePersonalMemoryCall, personalMemoryTool } from "../server/personal-memory.mjs";
import { createPersonalFactsStore } from "../server/personal-facts.mjs";
import { handlePersonalFactReferenceCall, personalFactReferenceTool, personalFactReferenceMessages } from "../server/personal-fact-references.mjs";
import { normalizeAppServerThreadMessages } from "../server/app-server-normalizers.mjs";
import { createPersonalMailDrafts, personalMailDraftTool, handlePersonalMailDraftCall } from "../server/personal-mail-drafts.mjs";

// Real CLI and a loopback-only synthetic Responses provider; no account, external inference or connectors.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-memory-protocol-"));
const home = path.join(root, "codex-home"); await fs.mkdir(home);
const references = process.argv.includes("--references");
const mailDrafts = process.argv.includes("--mail-drafts");
assert.ok(!(references && mailDrafts));
const tool = mailDrafts ? personalMailDraftTool : references ? personalFactReferenceTool : personalMemoryTool;
const mailRef = { accountId: "synthetic-account", messageId: "synthetic-mail", itemVersion: "a".repeat(64), snapshotVersion: "b".repeat(64) };
const mailArgs = { source: mailRef, timeZone: "Asia/Shanghai", form: { to: ["contact@example.test"], subject: "Re: 合成材料核对", body: "合成回复：会先核对材料，尚未作承诺。" } };
const mailState = path.join(root, "mail-drafts.json");
const store = mailDrafts ? createPersonalMailDrafts({
  read: async () => {
    try { return JSON.parse(await fs.readFile(mailState, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  },
  write: value => fs.writeFile(mailState, JSON.stringify(value), { mode: 0o600 }),
  mail: { snapshot: async () => ({ stale: false, reading: false, snapshot: {
    account: { id: mailRef.accountId, email: "owner@example.test" }, version: mailRef.snapshotVersion,
    window: { timeZone: "Asia/Shanghai" }, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(),
    items: [{ id: mailRef.messageId, threadId: "synthetic-mail-thread", title: "合成材料核对", from: "contact@example.test", version: mailRef.itemVersion, receivedAt: new Date(Date.now() - 3600000).toISOString() }],
  } }) },
}) : createPersonalFactsStore(path.join(root, "facts.json"));
const fact = references ? await store.create({ label: "合成出行偏好", value: "合成用户已确认：火车优先" }) : null;
const command = process.env.CODEX_SCHEMA_CLI_BINARY || execFileSync("npx", ["--no-install", "--package=@openai/codex@0.157.1", "-c", "command -v codex"], { encoding: "utf8" }).trim();
assert.match(execFileSync(command, ["--version"], { encoding: "utf8" }), /codex-cli 0\.157\.1/);
let requests = 0, calls = 0, providerError = null, registeredTools = null;
const notifications = [];
const provider = http.createServer(async (req, res) => {
  try {
  let body = ""; for await (const chunk of req) body += chunk;
  const data = JSON.parse(body); requests++;
  registeredTools = data.tools || data.input?.filter(item => item.type === "additional_tools");
  assert.equal(req.url, "/v1/responses"); assert.equal(data.stream, true);
  assert.ok(JSON.stringify(data).includes(tool.name), "native provider payload must expose the registered tool");
  assert.ok(requests <= 2);
  const output = requests === 1
    ? [{ id: "fc_memory", type: "function_call", call_id: "memory-call", name: tool.name, arguments: JSON.stringify(mailDrafts ? mailArgs : references ? { factIds: [fact.id] } : { label: "合成偏好", value: "仅本机协议验收", reason: "合成用户明确提出" }), status: "completed" }]
    : [{ id: "msg_memory", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: mailDrafts ? "本地回复草稿已保存，未发送。" : "候选已保存，等待确认。", annotations: [] }] }];
  res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "close" });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event("response.created", { response: { id: `resp_memory_${requests}`, status: "in_progress", output: [] } });
  for (const item of output) event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { id: `resp_memory_${requests}`, status: "completed", output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
  res.end();
  } catch (error) { providerError = error.message; res.writeHead(500); res.end("synthetic provider contract failed"); }
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${provider.address().port}/v1`;
const job = { kind: "turn", repo: { kind: "personal" }, sessionId: "synthetic-session", threadId: null, turnId: null };
if (references) job.personalFactSnapshot = await store.snapshot();
const client = new CodexAppServerClient({ cwd: root, command, args: ["app-server", "--listen", "stdio://", "-c", 'model_provider="memory_test"', "-c", 'model_providers.memory_test.name="Synthetic local test"', "-c", `model_providers.memory_test.base_url="${base}"`, "-c", 'model_providers.memory_test.wire_api="responses"', "-c", "model_providers.memory_test.requires_openai_auth=false", "-c", "model_providers.memory_test.supports_websockets=false"],
  env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, onServerRequest: (method, params) => {
    assert.equal(method, "item/tool/call"); calls++; return mailDrafts ? handlePersonalMailDraftCall(params, job, store) : references ? handlePersonalFactReferenceCall(params, job) : handlePersonalMemoryCall(params, job, store);
  } });
try {
  const started = await client.request("thread/start", { cwd: root, model: "gpt-6-sol", sandbox: "read-only", approvalPolicy: "on-request", dynamicTools: [tool] }, 30_000);
  assert.ok(started.thread?.id);
  job.threadId = started.thread.id;
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("synthetic native turn timed out")), 20_000);
    client.on("notification", message => {
      notifications.push({ method: message.method, ...(message.method === "error" ? { error: message.params.error } : {}), ...(message.method === "item/tool/call" ? { params: message.params, id: message.id } : {}) });
      if (message.method === "turn/started") job.turnId = message.params.turn.id;
      if (message.method === "turn/completed") { clearTimeout(timer); resolve(message.params.turn); }
    });
  });
  completed.catch(() => {});
  await client.request("turn/start", { threadId: job.threadId, input: [{ type: "text", text: mailDrafts ? "合成验收：仅保存这封合成邮件的本地未发送回复草稿" : "合成验收：提出一条记忆候选", text_elements: [] }] }, 30_000);
  assert.equal((await completed).status, "completed");
  assert.equal(calls, 1); assert.equal(requests, 2);
  if (!references && !mailDrafts) {
    assert.equal((await store.overview()).candidates[0].status, "pending");
    assert.deepEqual((await store.snapshot()).facts, []);
  }
  const files = [];
  const walk = async dir => { for (const item of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) await walk(file); else if (item.name.endsWith(".jsonl")) files.push(file); } };
  await walk(home);
  const metadata = (await fs.readFile(files.find(file => file.includes(started.thread.id)), "utf8")).trim().split("\n").map(JSON.parse).find(item => item.type === "session_meta");
  assert.ok(metadata);
  assert.ok(JSON.stringify(metadata).includes(tool.name));
  await client.stop({ waitForExit: true });
  const resumed = await client.request("thread/resume", { threadId: started.thread.id, cwd: root, excludeTurns: true }, 30_000);
  assert.equal(resumed.thread?.id, started.thread.id);
  assert.equal(resumed.thread.turns?.length || 0, 0);
  if (references) {
    const read = await client.request("thread/read", { threadId: job.threadId, includeTurns: true }, 30000);
    const messages = normalizeAppServerThreadMessages(read.thread);
    const projected = personalFactReferenceMessages(messages, job.threadId, await store.list());
    const source = projected.find(message => message.details?.personalFactReferences);
    assert.ok(source, JSON.stringify(messages));
    assert.equal(source.turnId, job.turnId);
    assert.equal(source.details.personalFactReferences.references[0].id, fact.id);
    assert.equal(source.details.personalFactReferences.references[0].state, "active");
    assert.equal(source.details.personalFactReferences.references[0].value, fact.value);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.includes("reference")), []);
    assert.equal(requests, 2, "history read and resume cannot start inference");
  }
  if (mailDrafts) {
    const saved = (await store.list())[0];
    assert.equal(saved.status, "draft"); assert.equal(saved.review, null); assert.deepEqual(saved.form, mailArgs.form);
    const read = await client.request("thread/read", { threadId: job.threadId, includeTurns: true }, 30000);
    const message = normalizeAppServerThreadMessages(read.thread).find(message => message.messageType === "dynamicToolCall" && message.details?.tool === tool.name);
    assert.equal(message.details.success, true);
    const receipt = JSON.parse(message.details.contentItems[0].text);
    assert.equal(receipt.draftId, saved.id); assert.equal(receipt.threadId, job.threadId); assert.equal(receipt.turnId, job.turnId); assert.equal(saved.origin.callId, receipt.callId);
    assert.equal(requests, 2, "readback must not start another model request");
  }
  console.log(JSON.stringify({ ok: true, cli: "0.157.1", dynamicToolPersisted: true, resumedAfterRestart: true, ...(mailDrafts ? { mailDraftSaved:true,sourceAndReceiptSurvivedRestart:true,realMailReads:0,realMailWrites:0 } : references ? { referenceResultSurvivedRestart: true, receiptSource: "native-thread", referenceCalls: calls } : { candidateCalls: calls }), syntheticProviderRequests: requests, externalModelCalls: 0, credentials: "disposable-uncredentialed-home" }));
} catch (error) { console.error(JSON.stringify({ error: error.message, providerError, requests, calls, registered: JSON.stringify(registeredTools).includes(tool.name), notifications: notifications.slice(-12), stderr: client.status().stderrTail })); process.exitCode = 1; }
finally { await client.stop({ waitForExit: true }); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
