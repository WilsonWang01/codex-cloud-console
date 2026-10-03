import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";
import { normalizeModelApiRequest } from "../server/model-api.mjs";

// Real CLI serialization only: private fixture home, loopback provider, deliberate non-retryable rejection.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-image-wire-"));
const requests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "fixture rejection after image capture", type: "invalid_request_error", code: "fixture_capture_complete" } }));
});
let client;
try {
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "codex-home");
  const tmp = path.join(root, "tmp");
  await Promise.all([cwd, home, tmp].map((dir) => fs.mkdir(dir)));
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${mock.address().port}`;
  client = new CodexAppServerClient({
    cwd, command: process.env.CODEX_MODEL_API_TEST_CLI || "codex",
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, TMPDIR: tmp, CODEX_IMAGE_FIXTURE_KEY: "local-fixture-only" },
    args: ["app-server", "--listen", "stdio://", "-c", 'model_provider="image_fixture"',
      "-c", 'model_providers.image_fixture.name="Image fixture"',
      "-c", `model_providers.image_fixture.base_url="${origin}"`,
      "-c", 'model_providers.image_fixture.wire_api="responses"',
      "-c", 'model_providers.image_fixture.env_key="CODEX_IMAGE_FIXTURE_KEY"',
      "-c", "model_providers.image_fixture.requires_openai_auth=false",
      "-c", "model_providers.image_fixture.supports_websockets=false"],
    initializeTimeoutMs: 15_000,
  });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const normalized = normalizeModelApiRequest({ model: "gpt-6-sol", messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: `data:image/png;base64,${png}`, detail: "auto" } },
    { type: "text", text: "Describe this test image without tools." },
  ] }] }, "openai");
  const thread = await client.request("thread/start", {
    cwd, model: "gpt-6-sol", approvalPolicy: "never", sandbox: "read-only", config: { tools: { web_search: false } },
  }, 15_000);
  assert.equal(thread.modelProvider, "image_fixture");
  let onNotification;
  const terminal = new Promise((resolve) => {
    onNotification = (message) => { if (message.method === "turn/completed") resolve(message.params.turn); };
    client.on("notification", onNotification);
  });
  await client.request("turn/start", { threadId: thread.thread.id, model: "gpt-6-sol", effort: "medium",
    input: [{ type: "text", text: normalized.body.prompt, text_elements: [] }, ...normalized.imageInputs],
  }, 15_000);
  let timer;
  const turn = await Promise.race([terminal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Mock provider turn did not finish")), 15_000); })])
    .finally(() => { clearTimeout(timer); client.off("notification", onNotification); });
  assert.equal(turn.status, "failed");
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.path, "/responses");
    const images = request.body.input.flatMap((item) => item.content || []).filter((item) => item.type === "input_image");
    assert.equal(images.length, 1);
    assert.equal(images[0].image_url, `data:image/png;base64,${png}`);
    assert.ok(images[0].detail === undefined || images[0].detail === "auto");
  }
  console.log("真实 Codex CLI 图片序列化通过；仅访问本机模拟 provider，未调用付费模型。");
} finally {
  if (client) await client.stop({ waitForExit: true });
  await new Promise((resolve) => mock.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
