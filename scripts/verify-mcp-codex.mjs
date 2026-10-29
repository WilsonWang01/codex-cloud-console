import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";

// Reuse the real isolated console fixture; only its inference engine is simulated.
export async function verifyNativeMcpReadback({ root, projectRoot, origin, token, run, manifest, report, reportBytes, crossToken, revokeCross }) {
  const command = process.env.CODEX_MCP_NATIVE_CLI_BINARY;
  assert.ok(path.isAbsolute(command), "Provide an absolute CODEX_MCP_NATIVE_CLI_BINARY");
  assert.equal(execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10000 }).trim(), "codex-cli 0.165.0");
  const base = path.join(root, "native-mcp"), home = path.join(base, "home"), cwd = path.join(base, "workspace"), tmp = path.join(base, "tmp");
  for (const dir of [base, home, cwd, tmp]) await fs.mkdir(dir, { mode: 0o700 });
  const sharedConfig = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "config.toml");
  const fingerprint = async file => {
    try { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const sharedBefore = await fingerprint(sharedConfig);
  let modelRequests = 0, client;
  const methods = [];
  const provider = http.createServer((_req, res) => { modelRequests++; res.writeHead(503); res.end("Model execution is forbidden in this fixture"); });
  try {
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const config = [
      'model_provider="mcp_readback_fixture"', 'cli_auth_credentials_store="file"', 'web_search="disabled"',
      "[features]", "apps=false", "plugins=false", "remote_plugin=false", "memories=false", "multi_agent=false",
      "[agents]", "enabled=false", "[model_providers.mcp_readback_fixture]", 'name="No-inference MCP acceptance"',
      `base_url="http://127.0.0.1:${provider.address().port}/v1"`, 'wire_api="responses"', "requires_openai_auth=false", "supports_websockets=false",
      ...["cloud", "cross"].flatMap(name => [
        `[mcp_servers.${name}]`, `command=${JSON.stringify(process.execPath)}`,
        `args=${JSON.stringify([path.join(projectRoot, "scripts/codex-cloud-mcp.mjs")])}`,
        ...(name === "cloud" ? ['env_vars=["CODEX_CLOUD_API_TOKEN"]'] : []),
        `[mcp_servers.${name}.env]`, `CODEX_CLOUD_URL=${JSON.stringify(origin)}`, 'CODEX_CLOUD_AUTOMATION_ID="sample-research"',
        ...(name === "cross" ? [`CODEX_CLOUD_API_TOKEN=${JSON.stringify(crossToken)}`] : []),
      ]),
    ].join("\n") + "\n";
    await fs.writeFile(path.join(home, "config.toml"), config, { mode: 0o600, flag: "wx" });
    const createClient = () => new CodexAppServerClient({ cwd, command,
      env: { PATH: process.env.PATH, HOME: base, CODEX_HOME: home, TMPDIR: tmp, CODEX_CLOUD_API_TOKEN: token }, initializeTimeoutMs: 20000,
      onServerRequest: () => { throw new Error("MCP readback never grants permissions or approves actions"); } });
    const request = async (method, params) => {
      assert.ok(["thread/start", "mcpServerStatus/list", "mcpServer/tool/call"].includes(method));
      methods.push(method);
      return client.request(method, params, 20000);
    };
    const readNames = ["capabilities", "models", "status", "output", "read_artifact"].map(name => `codex_cloud_${name}`).sort();
    const connect = async () => {
      client = createClient();
      const started = await request("thread/start", { cwd, model: "gpt-6-sol", ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
      assert.equal(started.modelProvider, "mcp_readback_fixture");
      const threadId = started.thread.id, deadline = Date.now() + 20000;
      let listing;
      do {
        listing = await request("mcpServerStatus/list", { threadId, limit: 100, detail: "toolsAndAuthOnly" });
        if (["cloud", "cross"].every(name => listing.data.find(server => server.name === name)?.runtimeStatus === "connected")) break;
        assert.ok(Date.now() < deadline, "Both native MCP servers must connect");
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (true);
      assert.deepEqual(listing.data.map(server => server.name).sort(), ["cloud", "cross"]);
      for (const server of listing.data) {
        assert.equal(server.toolsError, null);
        assert.deepEqual(Object.values(server.tools).map(tool => tool.name).sort(), readNames);
        assert.ok(Object.values(server.tools).every(tool => tool.annotations?.readOnlyHint === true));
      }
      return threadId;
    };
    const call = async (threadId, server, name, args = {}, expectedStatus) => {
      const result = await request("mcpServer/tool/call", { threadId, server, tool: `codex_cloud_${name}`, arguments: args });
      const data = result.structuredContent || JSON.parse(result.content.find(item => item.type === "text").text);
      assert.equal(Boolean(result.isError), Boolean(expectedStatus), "Native MCP tool error status");
      if (expectedStatus) assert.equal(data.httpStatus, expectedStatus);
      else assert.equal(data.ok, true);
      return { data, content: result.content };
    };
    const threadId = await connect();
    assert.equal((await call(threadId, "cloud", "capabilities")).data.capabilities.automation_id, "sample-research");
    assert.ok(JSON.stringify((await call(threadId, "cloud", "models")).data.models).includes("gpt-6-sol"));
    const status = (await call(threadId, "cloud", "status", { runId: run.id })).data.run;
    assert.equal(status.id, run.id); assert.equal(status.status, "completed"); assert.deepEqual(status.usage, run.usage);
    assert.equal((await call(threadId, "cloud", "output", { runId: run.id })).data.content, manifest.text);
    assert.deepEqual(JSON.parse((await call(threadId, "cloud", "output", { runId: run.id, section: "structured" })).data.content), manifest.structuredOutput);
    const metadata = JSON.parse((await call(threadId, "cloud", "output", { runId: run.id, section: "metadata" })).data.content);
    assert.equal(metadata.turnId, manifest.turnId); assert.deepEqual(metadata.sources, manifest.sources);
    const file = (await call(threadId, "cloud", "read_artifact", { runId: run.id, fileId: report.id })).data;
    assert.equal(file.artifact.sha256, report.sha256);
    assert.deepEqual(Buffer.from(file.dataBase64, "base64"), reportBytes);
    const image = manifest.artifacts.find(file => file.mimeType === "image/png");
    const shown = await call(threadId, "cloud", "read_artifact", { runId: run.id, fileId: image.id, asImage: true });
    const bitmap = shown.content.find(item => item.type === "image");
    assert.equal(bitmap.mimeType, image.mimeType);
    assert.equal(crypto.createHash("sha256").update(Buffer.from(bitmap.data, "base64")).digest("hex"), image.sha256);
    await call(threadId, "cross", "output", { runId: run.id }, 404);
    await revokeCross();
    await call(threadId, "cross", "capabilities", {}, 401);
    await assert.rejects(request("mcpServer/tool/call", { threadId, server: "cloud", tool: "codex_cloud_submit", arguments: { eventId: "must-not-run-0001" } }),
      error => error.appServerError?.code === -32602 && error.message === "Tool codex_cloud_submit not found");
    await client.stop({ waitForExit: true });
    const restarted = await connect();
    assert.notEqual(restarted, threadId);
    assert.equal((await call(restarted, "cloud", "output", { runId: run.id })).data.content, manifest.text);
    const restored = (await call(restarted, "cloud", "read_artifact", { runId: run.id, fileId: report.id })).data;
    assert.deepEqual(Buffer.from(restored.dataBase64, "base64"), reportBytes);
    assert.equal(modelRequests, 0, "Direct MCP calls must not invoke a model");
    return { ok: true, cli: "0.165.0", backend: "isolated real console with simulated inference", readOnlyTools: readNames.length,
      restartedReadback: true, crossClientStatus: 404, revokedStatus: 401, imageSha256: image.sha256, nativeModelTurns: 0, modelRequests,
      rpcMethods: [...new Set(methods)] };
  } finally {
    await client?.stop({ waitForExit: true });
    await new Promise(resolve => provider.close(resolve));
    assert.equal(await fingerprint(sharedConfig), sharedBefore, "Shared Codex configuration must remain unchanged");
    assert.equal(modelRequests, 0);
  }
}
