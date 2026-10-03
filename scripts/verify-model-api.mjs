import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createModelApiHandler, modelApiProtocol, modelApiTurnText, modelApiUsage, normalizeModelApiRequest } from "../server/model-api.mjs";
import { modelApiTurnResult } from "../server/model-api-output.mjs";

const input = { model: "gpt-6-sol", messages: [{ role: "user", content: "你好" }] };
const normalize = (body, protocol = "openai", options) => normalizeModelApiRequest(body, protocol, options);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const bluePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const imageBlock = (data = png, detail = "auto") => ({ type: "image_url", image_url: { url: `data:image/png;base64,${data}`, detail } });
const imageBody = (blocks) => ({ ...input, messages: [{ role: "user", content: blocks }] });

test("native images keep message order while persisted prompts contain only hashes", () => {
  const result = normalize({ ...input, messages: [
    { role: "user", content: [imageBlock(), { type: "text", text: "第一张" }] },
    { role: "assistant", content: "历史答复" },
    { role: "user", content: [{ type: "text", text: "比较图片" }, imageBlock(bluePng)] },
  ] });
  assert.equal(result.imageInputs.length, 4);
  assert.equal(result.imageInputs[0].text, "Conversation image 1");
  assert.deepEqual(result.imageInputs[1], { type: "image", url: `data:image/png;base64,${png}`, detail: "auto" });
  assert.equal(result.imageInputs[2].text, "Conversation image 2");
  assert.equal(result.imageInputs[3].url, `data:image/png;base64,${bluePng}`);
  assert.match(result.body.prompt, /"image":1/);
  assert.match(result.body.prompt, /"image":2/);
  assert.match(result.body.prompt, /"sha256":"[a-f0-9]{64}"/);
  assert.equal(result.body.prompt.includes(png), false);
  assert.equal(result.body.prompt.includes("data:image"), false);
  assert.notEqual(normalize(imageBody([imageBlock()])).body.prompt, normalize(imageBody([imageBlock(bluePng)])).body.prompt);
  for (const detail of ["low", "high", "original"]) assert.throws(() => normalize(imageBody([imageBlock(png, detail)])), { code: "unsupported_image_detail" });
});

test("image validation rejects external fetches, invalid encodings, roles, types and oversized inputs", () => {
  const badBlocks = [
    { type: "image_url", image_url: { url: "https://example.com/image.png" } },
    { type: "image_url", image_url: { url: "http://169.254.169.254/latest/meta-data" } },
    { type: "image_url", image_url: { url: "file:///etc/passwd" } },
    { type: "image_url", image_url: { url: `data:image/svg+xml;base64,${png}` } },
    { type: "image_url", image_url: { url: `data:image/gif;base64,${png}` } },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${png}` } },
    { type: "image_url", image_url: "invalid" }, imageBlock(""), imageBlock("a==="), imageBlock(png + "\n"),
    imageBlock(png, "invalid"), imageBlock(png, null), { ...imageBlock(), cache_control: {} },
    { type: "input_audio", input_audio: { data: "x", format: "wav" } },
    { type: "file", file: { file_data: "data:application/pdf;base64,eA==" } },
  ];
  for (const block of badBlocks) assert.throws(() => normalize(imageBody([block])), { statusCode: 400 });
  for (const role of ["system", "developer", "assistant"]) assert.throws(() => normalize({ ...input, messages: [{ role, content: [imageBlock()] }, ...input.messages] }), /user/);
  assert.throws(() => normalize(imageBody(Array(9).fill(imageBlock()))), { statusCode: 413 });
  const large = Buffer.alloc(4 * 1024 * 1024 + 1);
  Buffer.from(png, "base64").copy(large);
  assert.throws(() => normalize(imageBody([imageBlock(large.toString("base64"))])), { statusCode: 413 });
  const medium = large.subarray(0, 3 * 1024 * 1024).toString("base64");
  assert.throws(() => normalize(imageBody(Array(3).fill(imageBlock(medium)))), { statusCode: 413 });
  for (const source of [{ type: "url", url: "https://example.com/image.png" }, { type: "file", file_id: "file-x" },
    { type: "base64", media_type: "image/png", data: 1 }]) {
    assert.throws(() => normalize({ ...imageBody([{ type: "image", source }]), max_tokens: 1 }, "anthropic", { allowUnboundedOutput: true }), { statusCode: 400 });
  }
});

test("text conversion keeps role boundaries, blocks and reasoning without exposing runtime policy", () => {
  const result = normalize({ ...input, reasoning_effort: "medium", messages: [
    { role: "system", content: "只用中文" }, { role: "developer", content: "简短回答" },
    { role: "user", content: [{ type: "text", text: "问题一" }, { type: "text", text: "问题二" }] },
    { role: "assistant", content: "旧回答" }, { role: "user", content: "继续" },
  ] });
  assert.match(result.body.prompt, /"role":"system","content":"只用中文"/);
  assert.match(result.body.prompt, /问题一\\n问题二/);
  assert.equal(result.body.reasoning, "medium");
  assert.equal(result.body.worktree, true);
  assert.equal("sandbox" in result.body, false);
  const anthropic = normalize({ ...input, max_tokens: 1024, system: [{ type: "text", text: "系统指令" }], output_config: { effort: "high" } }, "anthropic", { allowUnboundedOutput: true });
  assert.match(anthropic.body.prompt, /"role":"system"/);
  assert.equal(anthropic.body.reasoning, "high");
});

test("unsupported features and malformed input fail closed before execution", () => {
  const cases = [null, [], {}, { ...input, model: "claude-sonnet" }, { ...input, model: " gpt-6-sol" },
    { ...input, stream: "true" }, { ...input, n: 2 }, { ...input, temperature: 0 },
    { ...input, tools: [] }, { ...input, response_format: { type: "json_object" } },
    { ...input, messages: [{ role: "tool", content: "result" }] },
    { ...input, messages: [{ role: "user", content: [{ type: "image_url", image_url: "x" }] }] },
    { ...input, messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: {} }] }] },
    { ...input, messages: [{ role: "user", content: "" }] },
    { ...input, messages: [{ role: "assistant", content: "prefill" }] },
    { ...input, messages: [{ role: "user", content: "x", name: "extra" }] },
    { ...input, reasoning_effort: "maximum" }, { ...input, stream_options: { include_usage: true } },
    { ...input, stream: true, stream_options: { include_usage: "true" } },
    { ...input, sandbox: "danger-full-access" }, { ...input, messages: Array(101).fill(input.messages[0]) },
  ];
  for (const body of cases) assert.throws(() => normalize(body), { statusCode: 400 });
  assert.throws(() => normalize({ ...input, messages: [{ role: "user", content: "x".repeat(65536) }] }), { statusCode: 413 });
  assert.throws(() => normalize(input, "anthropic"), /max_tokens/);
  assert.throws(() => normalize({ ...input, max_tokens: 1024 }), { code: "unsupported_output_limit" });
  assert.throws(() => normalize({ ...input, max_tokens: 1024, max_completion_tokens: 1024 }, "openai", { allowUnboundedOutput: true }), /同时/);
  assert.throws(() => normalize({ ...input, max_tokens: -1 }, "anthropic", { allowUnboundedOutput: true }), /正整数/);
  assert.throws(() => normalize({ ...input, max_tokens: 1, output_config: { format: {} } }, "anthropic", { allowUnboundedOutput: true }), /effort/);
});

test("routing and token usage do not invent models or unknown counts", () => {
  assert.equal(modelApiProtocol("/api/automations/demo/v1/messages"), "anthropic");
  assert.equal(modelApiProtocol("/api/automations/demo/v1/chat/completions"), "openai");
  assert.equal(modelApiProtocol("/api/automations/demo/v1/responses"), "responses");
  assert.equal(modelApiProtocol("/api/automations/demo/v1/images/generations"), "images");
  for (const url of ["/v1/messages", "/api/clients", "/api/automations/demo/v1/messages/other"]) assert.equal(modelApiProtocol(url), null);
  assert.equal(modelApiUsage({}, "openai"), null);
  assert.deepEqual(modelApiUsage({}, "anthropic"), { input_tokens: null, output_tokens: null });
  const usage = { status: "complete", inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedInputTokens: 20, reasoningOutputTokens: 5 };
  assert.deepEqual(modelApiUsage({ usage }, "openai"), { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } });
  assert.deepEqual(modelApiUsage({ usage }, "anthropic"), { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 20 });
});

test("complete output is selected by exact turn, not a truncated summary or later heartbeat", () => {
  const text = "完整长文本".repeat(2000);
  const thread = { turns: [
    { id: "original", items: [{ type: "agentMessage", text: "进度" }, { type: "commandExecution", text: "private tool output" }, { type: "agentMessage", text }] },
    { id: "later", items: [{ type: "agentMessage", text: "later response" }] },
  ] };
  assert.equal(modelApiTurnText(thread, "original"), "进度" + text);
  assert.throws(() => modelApiTurnText(thread, "missing"), { statusCode: 502 });
});

async function fixture(task, options = {}) {
  const runs = new Map();
  const keys = new Map();
  const metrics = [];
  let valid = true;
  let submits = 0;
  const app = express();
  app.use(express.json());
  const handler = createModelApiHandler({
    authenticate: async (req, token) => valid && token === "fixture-token" && req.params.id === "demo" ? { id: "fixture-client" } : null,
    submit: async (req, body, imageInputs) => {
      const key = req.get("idempotency-key");
      const saved = keys.get(key);
      if (saved && saved.body.prompt !== body.prompt) throw Object.assign(new Error("幂等键冲突"), { statusCode: 409 });
      if (saved) return { run: saved.run, deduplicated: true };
      submits += 1;
      const run = { id: `run-${submits}`, model: body.model, startedAt: new Date().toISOString(), status: "running", summary: "", resultPath: `/api/automations/demo/runs/run-${submits}` };
      runs.set(run.id, { run, body, imageInputs, checks: 0 });
      keys.set(key, { run, body });
      return { run };
    },
    snapshot: async (id) => {
      const saved = runs.get(id);
      saved.checks += 1;
      const waiting = saved.body.prompt.includes("wait forever");
      const failed = saved.body.prompt.includes("fail run");
      return { ...saved.run, summary: saved.checks === 1 ? "你好" : "你好，世界", status: waiting || saved.checks < 3 ? "running" : failed ? "failed" : "completed",
        usage: { status: "complete", inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedInputTokens: 20 } };
    },
    record: async (row) => metrics.push(row), timeoutMs: 1000, pollMs: 30, ...options,
  });
  app.post("/api/automations/:id/v1/chat/completions", (req, res) => handler(req, res, "openai"));
  app.post("/api/automations/:id/v1/messages", (req, res) => handler(req, res, "anthropic"));
  app.post("/api/automations/:id/v1/responses", (req, res) => handler(req, res, "responses"));
  app.post("/api/automations/:id/v1/images/generations", (req, res) => handler(req, res, "images"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await task({ origin, metrics, get submits() { return submits; }, get submissions() { return [...runs.values()]; }, revoke: () => { valid = false; } }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const headers = { authorization: "Bearer fixture-token", "idempotency-key": "fixture-event-0001", "content-type": "application/json" };
const post = (origin, body, extra = {}) => fetch(`${origin}/api/automations/demo/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), ...extra });

test("Responses and Images normalize supported fields and reject controls that cannot be enforced", () => {
  const response = normalize({ model: input.model, input: [{ role: "user", content: [{ type: "input_text", text: "编辑" }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] }],
    tools: [{ type: "image_generation" }], instructions: "简洁", reasoning: { effort: "medium" }, store: false }, "responses");
  assert.equal(response.imageInputs[1].url, `data:image/png;base64,${png}`);
  assert.equal(response.body.reasoning, "medium");
  assert.match(response.body.prompt, /native image generation tool/);
  assert.equal(normalize({ model: input.model, prompt: "生成图片", response_format: "b64_json", n: 1 }, "images").requireImages, true);
  for (const extra of [{ store: true }, { previous_response_id: "resp-1" }, { tools: [{ type: "image_generation", quality: "high" }] }, { tools: [] }, { reasoning: { summary: "auto" } }, { tool_choice: "required" }, { input: [{ type: "image_generation_call", result: png }] }, { input: [{ role: "user", content: [{ type: "input_file", file_id: "file-1" }] }] }]) {
    assert.throws(() => normalize({ model: input.model, input: "画图", ...extra }, "responses"), { statusCode: 400 });
  }
  assert.throws(() => normalize({ model: input.model, input: "画图", max_output_tokens: 100 }, "responses"), { code: "unsupported_output_limit" });
  for (const extra of [{ n: 2 }, { response_format: "url" }, { quality: "high" }, { size: "1024x1024" }, { stream: true }, { prompt: "" }]) {
    assert.throws(() => normalize({ model: input.model, prompt: "画图", ...extra }, "images"), { statusCode: 400 });
  }
});

test("image outputs are exact-turn, bounded native artifacts, not paths in text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-image-output-"));
  const generatedImagesRoot = path.join(root, "generated");
  await fs.mkdir(generatedImagesRoot);
  const image = { id: "ig-1", type: "imageGeneration", status: "completed", result: png, failure: null, revisedPrompt: "实际提示" };
  const thread = (items) => ({ turns: [{ id: "wanted", items }, { id: "other", items: [{ ...image, result: bluePng }] }] });
  try {
    const result = await modelApiTurnResult(thread([{ type: "agentMessage", text: "/etc/passwd" }, image]), "wanted");
    assert.equal(result.summary, "/etc/passwd");
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].b64_json, png);
    assert.equal(result.images[0].media_type, "image/png");
    const savedPath = path.join(generatedImagesRoot, "output.png");
    await fs.writeFile(savedPath, Buffer.from(png, "base64"));
    assert.equal((await modelApiTurnResult(thread([{ ...image, result: "", savedPath }]), "wanted", { generatedImagesRoot })).images[0].b64_json, png);
    const outside = path.join(root, "secret.png");
    await fs.writeFile(outside, Buffer.from(png, "base64"));
    const link = path.join(generatedImagesRoot, "linked.png");
    await fs.symlink(outside, link);
    for (const bad of [{ ...image, result: "https://example.com/image.png" }, { ...image, savedPath: outside }, { ...image, savedPath: link },
      { ...image, failure: { type: "usageLimitExceeded" } }, { ...image, status: "inProgress" }, { ...image, result: Buffer.from("<svg/>").toString("base64") },
      { ...image, result: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }]) {
      await assert.rejects(modelApiTurnResult(thread([bad]), "wanted", { generatedImagesRoot }), { statusCode: 502 });
    }
    await assert.rejects(modelApiTurnResult(thread(Array(5).fill(image)), "wanted"), { code: "image_output_too_large" });
    await assert.rejects(modelApiTurnResult(thread([image]), "missing"), { code: "result_unavailable" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const outputImages = [{ id: "ig-1", b64_json: png, media_type: "image/png", revised_prompt: "实际提示" }];
test("official OpenAI SDK gets image bytes from Images and Responses, including streaming and replay", async () => {
  await fixture(async (f) => {
    const client = new OpenAI({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo/v1`, maxRetries: 0 });
    const body = { model: input.model, prompt: "画图", response_format: "b64_json" };
    const opts = { headers: { "Idempotency-Key": "sdk-image-output-0001" } };
    const generated = await client.images.generate(body, opts);
    assert.equal(generated.data[0].b64_json, png);
    assert.equal(generated.output_format, "png");
    assert.deepEqual(await client.images.generate(body, opts), generated);
    assert.equal(f.submits, 1);
    const request = { model: input.model, input: "画图", tools: [{ type: "image_generation" }], store: false };
    const response = await client.responses.create(request, { headers: { "Idempotency-Key": "sdk-response-output-0001" } });
    assert.equal(response.output_text, "你好，世界");
    assert.equal(response.output.find((item) => item.type === "image_generation_call").result, png);
    assert.equal(response.output.find((item) => item.type === "image_generation_call").output_format, "png");
    assert.equal(response.usage.total_tokens, 130);
    const stream = client.responses.stream(request, { headers: { "Idempotency-Key": "sdk-response-output-0002" } });
    const events = [];
    stream.on("event", (event) => events.push(event));
    const final = await stream.finalResponse();
    assert.equal(final.output.find((item) => item.type === "image_generation_call").result, png);
    assert.equal(final.output_text, "你好，世界");
    assert.ok(events.some((event) => event.type === "response.output_item.done" && event.item.type === "image_generation_call"));
    assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
    assert.ok(f.metrics.some((row) => row.trigger === "image-generations"));
    assert.ok(f.metrics.some((row) => row.trigger === "responses"));
  }, { result: async () => ({ summary: "你好，世界", images: outputImages }) });
});

test("Chat and Messages expose explicitly nonstandard image extensions without inventing image content blocks", async () => {
  await fixture(async (f) => {
    const openai = new OpenAI({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo/v1`, maxRetries: 0 });
    const completion = await openai.chat.completions.create(input, { headers: { "Idempotency-Key": "sdk-output-extension-0001" } });
    assert.equal(completion.choices[0].message.content, "你好，世界");
    assert.equal(completion.codex_cloud.images[0].b64_json, png);
    const chunks = [];
    for await (const chunk of await openai.chat.completions.create({ ...input, stream: true }, { headers: { "Idempotency-Key": "sdk-output-extension-0002" } })) chunks.push(chunk);
    assert.equal(chunks.find((chunk) => chunk.codex_cloud)?.codex_cloud.images[0].b64_json, png);
    const anthropic = new Anthropic({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo`, maxRetries: 0, defaultHeaders: { "x-codex-cloud-allow-unbounded-output": "true" } });
    const message = await anthropic.messages.create({ ...input, max_tokens: 100 }, { headers: { "Idempotency-Key": "sdk-output-extension-0003" } });
    assert.deepEqual(message.content, [{ type: "text", text: "你好，世界" }]);
    assert.equal(message.codex_cloud.images[0].b64_json, png);
    const res = await fetch(`${f.origin}/api/automations/demo/v1/messages`, { method: "POST", headers: { ...headers, "x-codex-cloud-allow-unbounded-output": "true", "idempotency-key": "sdk-output-extension-0004" }, body: JSON.stringify({ ...input, max_tokens: 100, stream: true }) });
    assert.match(await res.text(), /"codex_cloud":\{"images":/);
  }, { result: async () => ({ summary: "你好，世界", images: outputImages }) });
});

test("image generation never reports success for an empty or unavailable image result", async () => {
  await fixture(async (f) => {
    const client = new OpenAI({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo/v1`, maxRetries: 0 });
    await assert.rejects(client.images.generate({ model: input.model, prompt: "画图" }, { headers: { "Idempotency-Key": "sdk-output-empty-0001" } }), (error) => error.status === 502 && error.code === "no_image_generated");
  });
  await fixture(async (f) => {
    const client = new OpenAI({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo/v1`, maxRetries: 0 });
    const stream = client.responses.stream({ model: input.model, input: "画图" }, { headers: { "Idempotency-Key": "sdk-output-failed-0001" } });
    await assert.rejects(stream.finalResponse());
  }, { result: async () => { throw Object.assign(new Error("图片不存在"), { statusCode: 502, code: "image_result_unavailable" }); } });
});

test("official OpenAI SDK can create, replay and stream text completions", async () => {
  await fixture(async (f) => {
    const client = new OpenAI({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo/v1`, maxRetries: 0 });
    const first = await client.chat.completions.create(input, { headers: { "Idempotency-Key": "sdk-openai-0001" } }).withResponse();
    assert.equal(first.data.choices[0].message.content, "你好，世界");
    assert.equal(first.data.model, "gpt-6-sol");
    assert.equal(first.data.usage.total_tokens, 130);
    assert.equal(first.response.headers.get("x-codex-cloud-run-id"), "run-1");
    const replay = await client.chat.completions.create(input, { headers: { "Idempotency-Key": "sdk-openai-0001" } });
    assert.equal(replay.id, first.data.id);
    assert.equal(f.submits, 1);
    const stream = await client.chat.completions.create({ ...input, stream: true, stream_options: { include_usage: true } }, { headers: { "Idempotency-Key": "sdk-openai-0002" } });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta.content || "").join(""), "你好，世界");
    assert.ok(chunks.some((chunk) => chunk.choices[0]?.finish_reason === "stop"));
    assert.equal(chunks.at(-1).usage.total_tokens, 130);
    assert.ok(f.metrics.some((row) => row.deduplicated));
  });
});

test("official Anthropic SDK accumulates text streams and final usage", async () => {
  await fixture(async (f) => {
    const client = new Anthropic({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo`, maxRetries: 0,
      defaultHeaders: { "x-codex-cloud-allow-unbounded-output": "true" } });
    const body = { ...input, max_tokens: 1024, system: "只用中文" };
    const first = await client.messages.create(body, { headers: { "Idempotency-Key": "sdk-anthropic-0001" } });
    assert.equal(first.content[0].text, "你好，世界");
    assert.equal(first.stop_reason, "end_turn");
    assert.equal(first.usage.input_tokens, 80);
    const stream = client.messages.stream(body, { headers: { "Idempotency-Key": "sdk-anthropic-0002" } });
    const text = [];
    stream.on("text", (delta) => text.push(delta));
    const final = await stream.finalMessage();
    assert.equal(text.join(""), "你好，世界");
    assert.equal(final.content[0].text, "你好，世界");
    assert.equal(final.usage.input_tokens, 80);
    assert.equal(final.usage.output_tokens, 30);
    assert.equal(final.usage.cache_read_input_tokens, 20);
  });
});

test("both official SDKs deliver inline images to native Codex inputs and reject changed-image replays", async () => {
  await fixture(async (f) => {
    const openai = new OpenAI({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo/v1`, maxRetries: 0 });
    const body = imageBody([{ type: "text", text: "看图" }, imageBlock()]);
    const key = { headers: { "Idempotency-Key": "sdk-image-openai-0001" } };
    const completion = await openai.chat.completions.create(body, key);
    assert.equal(completion.choices[0].message.content, "你好，世界");
    assert.equal(f.submissions[0].imageInputs[1].url, `data:image/png;base64,${png}`);
    assert.equal(f.submissions[0].body.prompt.includes(png), false);
    const replay = await openai.chat.completions.create(body, key);
    assert.equal(replay.id, completion.id);
    await assert.rejects(openai.chat.completions.create(imageBody([{ type: "text", text: "看图" }, imageBlock(bluePng)]), key), { status: 409 });
    const anthropic = new Anthropic({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo`, maxRetries: 0,
      defaultHeaders: { "x-codex-cloud-allow-unbounded-output": "true" } });
    const final = await anthropic.messages.stream({ ...input, max_tokens: 1024, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "看图" },
    ] }] }, { headers: { "Idempotency-Key": "sdk-image-anthropic-0001" } }).finalMessage();
    assert.equal(final.content[0].text, "你好，世界");
    assert.equal(f.submissions[1].imageInputs[1].type, "image");
    assert.equal(f.submissions[1].imageInputs[1].url, `data:image/png;base64,${png}`);
    assert.equal(f.submits, 2);
  });
});

test("SDK responses preserve unknown usage instead of reporting zero", async () => {
  await fixture(async (f) => {
    const openai = new OpenAI({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo/v1`, maxRetries: 0 });
    const completion = await openai.chat.completions.create(input, { headers: { "Idempotency-Key": "unknown-openai-0001" } });
    assert.equal(completion.usage, null);
    const anthropic = new Anthropic({ apiKey: "fixture-token", baseURL: `${f.origin}/api/automations/demo`, maxRetries: 0,
      defaultHeaders: { "x-codex-cloud-allow-unbounded-output": "true" } });
    const final = await anthropic.messages.stream({ ...input, max_tokens: 1024 }, { headers: { "Idempotency-Key": "unknown-anthropic-0001" } }).finalMessage();
    assert.equal(final.usage.input_tokens, null);
    assert.equal(final.usage.output_tokens, null);
  }, { snapshot: async (id) => ({ id, model: "gpt-6-sol", status: "completed", summary: "unknown usage", startedAt: new Date().toISOString() }) });
});

test("authentication, scope, unsupported output limits and idempotency conflicts never start extra tasks", async () => {
  await fixture(async (f) => {
    for (const extra of [{ headers: { ...headers, authorization: "" } }, { headers: { ...headers, "idempotency-key": "" } }]) {
      const res = await post(f.origin, input, extra);
      assert.ok([400, 401].includes(res.status));
      assert.ok((await res.json()).error.type);
    }
    assert.equal((await fetch(`${f.origin}/api/automations/other/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(input) })).status, 401);
    const limit = await post(f.origin, { ...input, max_completion_tokens: 10 });
    assert.equal(limit.status, 400);
    assert.equal((await limit.json()).error.code, "unsupported_output_limit");
    assert.equal(f.submits, 0);
    assert.equal((await post(f.origin, input)).status, 200);
    const conflict = await post(f.origin, { ...input, messages: [{ role: "user", content: "changed" }] });
    assert.equal(conflict.status, 409);
    f.revoke();
    assert.equal((await post(f.origin, input)).status, 401);
    assert.equal(f.submits, 1);
  });
});

test("timeouts and failed streams expose run IDs without emitting a success terminator", async () => {
  await fixture(async (f) => {
    const waiting = await post(f.origin, { ...input, messages: [{ role: "user", content: "wait forever" }] });
    assert.equal(waiting.status, 504);
    assert.equal((await waiting.json()).error.run_id, "run-1");
    const failed = await post(f.origin, { ...input, stream: true, messages: [{ role: "user", content: "fail run" }] }, { headers: { ...headers, "idempotency-key": "failed-event-0001" } });
    assert.equal(failed.status, 200);
    const raw = await failed.text();
    assert.match(raw, /codex_run_failed/);
    assert.equal(raw.includes("[DONE]"), false);
    assert.equal(raw.includes('"finish_reason":"stop"'), false);
    assert.ok(f.metrics.some((row) => row.status === 502));
  });
});

test("disconnect and waiter admission are bounded; remote tasks are not implicitly canceled", async () => {
  await fixture(async (f) => {
    const controller = new AbortController();
    const response = await post(f.origin, { ...input, stream: true, messages: [{ role: "user", content: "wait forever" }] }, { signal: controller.signal });
    assert.equal(response.headers.get("x-codex-cloud-run-id"), "run-1");
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(f.submits, 1);
    assert.ok(f.metrics.some((row) => row.status === 499));
    const requests = Array.from({ length: 4 }, (_, index) => post(f.origin, { ...input, messages: [{ role: "user", content: "wait forever" }] }, { headers: { ...headers, "idempotency-key": `waiter-event-${index}` } }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const blocked = await post(f.origin, input, { headers: { ...headers, "idempotency-key": "waiter-blocked-0001" } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "5");
    for (const response of await Promise.all(requests)) { assert.equal(response.status, 504); await response.text(); }
    const recovered = await post(f.origin, input, { headers: { ...headers, "idempotency-key": "waiter-recovered-0001" } });
    assert.equal(recovered.status, 200);
  });
});

test("revocation during an active stream closes it without a success receipt", async () => {
  await fixture(async (f) => {
    const response = await post(f.origin, { ...input, stream: true, messages: [{ role: "user", content: "wait forever" }] });
    f.revoke();
    const text = await response.text();
    assert.match(text, /令牌已失效/);
    assert.equal(text.includes("[DONE]"), false);
    assert.ok(f.metrics.some((row) => row.status === 401 && row.runId === "run-1"));
  }, { timeoutMs: 7000 });
});
