import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";

const command = process.env.CODEX_SCHEMA_CLI_BINARY || execFileSync("npx", ["--no-install", "--package=@openai/codex@0.157.1", "-c", "command -v codex"], { encoding: "utf8" }).trim();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-turn-events-"));
const home = path.join(root, "home"), cwd = path.join(root, "work");
let client, failure, outcome, rejectRequests = false;
const requests = [], events = [];
const provider = http.createServer(async (req, res) => {
  try {
    let bytes = 0; for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 1024 * 1024); }
    assert.ok(requests.length < 4); requests.push(req.url);
    assert.ok(["/v1/responses", "/v1/responses/compact"].includes(req.url));
    if (rejectRequests) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Deliberate synthetic compaction failure", type: "invalid_request_error" } })); return; }
    if (req.url.endsWith("/compact")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "cmp_synthetic", object: "response.compaction", created_at: 1, output: [{ type: "compaction", encrypted_content: "synthetic-local-content" }], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }));
      return;
    }
    const output = [{ id: "msg_synthetic_" + requests.length, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic offline task summary.", annotations: [] }] }];
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    for (const [type, response] of [["response.created", { id: "response_synthetic", status: "in_progress", output: [] }], ["response.completed", { id: "response_synthetic", status: "completed", output, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }]]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`);
    res.end();
  } catch (error) { failure = error.message; res.writeHead(400); res.end(JSON.stringify({ error: { message: "Synthetic request rejected" } })); }
});
async function until(predicate, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (failure) throw new Error(failure);
    const value = events.find(predicate); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Native synthetic event wait timed out");
}
try {
  for (const dir of [home, cwd]) await fs.mkdir(dir);
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${provider.address().port}/v1`;
  client = new CodexAppServerClient({ command, cwd, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home },
    args: ["app-server", "--listen", "stdio://", "-c", 'model_provider="event_fixture"', "-c", 'model_providers.event_fixture.name="Local synthetic event test"',
      "-c", `model_providers.event_fixture.base_url=${JSON.stringify(base)}`, "-c", 'model_providers.event_fixture.wire_api="responses"',
      "-c", "model_providers.event_fixture.requires_openai_auth=false", "-c", "model_providers.event_fixture.supports_websockets=false",
      "-c", "model_providers.event_fixture.request_max_retries=0", "-c", "model_providers.event_fixture.stream_max_retries=0",
      "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "-c", "features.apps=false", "-c", 'cli_auth_credentials_store="file"'],
    onServerRequest: () => { throw new Error("Synthetic check never grants permissions"); },
  });
  client.on("notification", message => {
    if (events.length >= 256) { failure = "native event check exceeded its event limit"; return; }
    events.push(message);
  });
  const thread = await client.request("thread/start", { cwd, model: "gpt-6-sol", approvalPolicy: "never", sandbox: "read-only" }, 20000);
  assert.equal(thread.modelProvider, "event_fixture");
  const turn = await client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Summarize this synthetic fixture briefly." }] }, 20000);
  await until(message => message.method === "turn/completed" && message.params.turn.id === turn.turn.id);
  assert.equal(events.find(message => message.method === "thread/tokenUsage/updated")?.params.turnId, turn.turn.id);
  const start = Date.now();
  await client.request("thread/compact/start", { threadId: thread.thread.id }, 20000);
  const item = await until(message => message.method === "item/started" && message.params.item.type === "contextCompaction");
  assert.equal(item.params.threadId, thread.thread.id);
  assert.ok(Number.isFinite(item.params.startedAtMs) && item.params.startedAtMs >= start);
  await until(message => message.method === "item/completed" && message.params.item.id === item.params.item.id);
  await until(message => message.method === "turn/completed" && message.params.turn.id === item.params.turnId);
  rejectRequests = true;
  const beforeFailure = events.length;
  await client.request("thread/compact/start", { threadId: thread.thread.id }, 20000);
  const failed = await until(message => events.indexOf(message) >= beforeFailure && message.method === "turn/completed" && message.params.turn.status === "failed");
  assert.notEqual(failed.params.turn.id, item.params.turnId);
  assert.equal(failure, undefined);
  outcome = { ok: true, cli: execFileSync(command, ["--version"], { encoding: "utf8" }).trim(), externalModelCalls: 0, syntheticProviderRequests: requests,
    compactTurnDiffersFromPrevious: item.params.turnId !== turn.turn.id,
    compactEvents: events.filter(message => message.params?.turnId === item.params.turnId || message.params?.turn?.id === item.params.turnId).map(message => message.method),
    failedCompactEvents: events.slice(beforeFailure).map(message => message.method),
  };
} catch (error) {
  console.error(JSON.stringify({ error: error.message, requests, providerError: failure, eventTypes: events.map(message => message.method), stderr: client?.status().stderrTail }));
  process.exitCode = 1;
} finally {
  await client?.stop({ waitForExit: true }); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
if (outcome && !process.exitCode) console.log(JSON.stringify({ ...outcome, cleanupVerified: true }));
