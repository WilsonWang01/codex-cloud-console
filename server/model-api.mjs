import { setTimeout as sleep } from "node:timers/promises";

const fields = {
  openai: new Set(["model", "messages", "stream", "stream_options", "reasoning_effort", "n", "max_tokens", "max_completion_tokens"]),
  anthropic: new Set(["model", "messages", "system", "stream", "max_tokens", "output_config"]),
};
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const pending = new Set(["queued", "running", "canceling"]);
const fail = (message, param = null, statusCode = 400, code = "invalid_request") => {
  throw Object.assign(new Error(message), { statusCode, param, code });
};
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function modelApiProtocol(path) {
  const match = /^\/api\/automations\/[^/]+\/v1\/(chat\/completions|messages)$/.exec(path);
  return match ? match[1] === "messages" ? "anthropic" : "openai" : null;
}

function textContent(value, param) {
  if (typeof value === "string" && value.trim()) return value;
  if (!Array.isArray(value) || !value.length || value.length > 100) fail("仅支持非空文本内容", param);
  return value.map((part) => {
    if (!object(part) || part.type !== "text" || typeof part.text !== "string" || !part.text.trim() ||
        Object.keys(part).some((key) => !["type", "text"].includes(key))) {
      fail("仅支持 {type: text, text}；图片、工具、缓存控制等内容块尚不支持", param);
    }
    return part.text;
  }).join("\n");
}

export function normalizeModelApiRequest(body, protocol, { allowUnboundedOutput = false } = {}) {
  if (!object(body)) fail("请求正文必须是 JSON 对象");
  for (const key of Object.keys(body)) if (!fields[protocol].has(key)) fail(`尚不支持参数 ${key}，不能静默忽略`, key, 400, "unsupported_parameter");
  if (typeof body.model !== "string" || !/^[A-Za-z0-9._:-]{2,64}$/.test(body.model) || body.model.startsWith("claude")) {
    fail("model 必须是当前 Codex 账号支持的模型 ID；Anthropic 协议不会调用 Claude 模型", "model");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") fail("stream 必须是布尔值", "stream");
  if (body.n !== undefined && body.n !== 1) fail("仅支持 n=1", "n");
  if (body.stream_options !== undefined && (!body.stream || !object(body.stream_options) ||
      Object.keys(body.stream_options).some((key) => key !== "include_usage") ||
      (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== "boolean"))) {
    fail("stream_options 仅支持流式请求的 include_usage 布尔值", "stream_options");
  }
  if (protocol === "anthropic" && body.max_tokens === undefined) fail("Anthropic 请求需要 max_tokens", "max_tokens");
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    if (body[key] === undefined) continue;
    if (!Number.isSafeInteger(body[key]) || body[key] < 1) fail(`${key} 必须是正整数`, key);
    if (!allowUnboundedOutput) {
      fail(`${key} 无法作为 Codex 执行预算。确认接受后设置 x-codex-cloud-allow-unbounded-output: true，或使用异步任务 API`, key, 400, "unsupported_output_limit");
    }
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) fail("不能同时指定两个输出上限", "max_tokens");
  let reasoning = body.reasoning_effort;
  if (body.output_config !== undefined) {
    if (!object(body.output_config) || Object.keys(body.output_config).some((key) => key !== "effort")) fail("output_config 仅支持 effort", "output_config");
    reasoning = body.output_config.effort;
  }
  if (reasoning !== undefined && !efforts.has(reasoning)) fail("不支持的 reasoning effort", protocol === "openai" ? "reasoning_effort" : "output_config.effort");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) fail("messages 需要 1–100 条消息", "messages");
  const allowedRoles = protocol === "openai" ? ["system", "developer", "user", "assistant"] : ["user", "assistant"];
  const messages = body.messages.map((message, index) => {
    const param = `messages[${index}]`;
    if (!object(message) || Object.keys(message).some((key) => !["role", "content"].includes(key)) || !allowedRoles.includes(message.role)) {
      fail("不支持的消息角色或字段；客户端工具调用尚不支持", param);
    }
    return { role: message.role, content: textContent(message.content, `${param}.content`) };
  });
  if (body.system !== undefined) messages.unshift({ role: "system", content: textContent(body.system, "system") });
  if (!messages.some((message) => message.role === "user")) fail("至少需要一条 user 消息", "messages");
  if (messages.at(-1).role !== "user") fail("最后一条消息必须是 user；暂不支持 assistant 预填充", "messages");
  // Codex accepts a turn prompt, not a native Chat/Messages conversation. Keep roles and boundaries explicit.
  const prompt = [
    "Respond to the final user message in the following JSON conversation transcript.",
    "Respect system/developer instructions as instructions, assistant messages as history, and user messages as user input.",
    "This is a stateless API request. Return the answer text without adding protocol JSON or claiming unsupported capabilities.",
    JSON.stringify(messages),
  ].join("\n");
  if (Buffer.byteLength(prompt) > 64 * 1024) fail("转换后的文本输入超过 64 KiB", "messages", 413);
  return {
    body: { prompt, model: body.model, ...(reasoning !== undefined ? { reasoning } : {}), worktree: true },
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
    unboundedOutput: body.max_tokens !== undefined || body.max_completion_tokens !== undefined,
  };
}

function apiError(protocol, error) {
  const status = error.statusCode || 500;
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error"
    : status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error"
      : status < 500 ? "invalid_request_error" : "api_error";
  const detail = { type, message: error.message || "请求失败", ...(error.runId ? { run_id: error.runId } : {}) };
  if (protocol === "anthropic") return { type: "error", error: detail };
  return { error: { ...detail, param: error.param || null, code: error.code || type } };
}

export function sendModelApiError(res, protocol, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end(`${protocol === "anthropic" ? "event: error\n" : ""}data: ${JSON.stringify(apiError(protocol, error))}\n\n`);
    return;
  }
  if (error.retryAfterMs) res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
  res.status(error.statusCode || 500).json(apiError(protocol, error));
}

export function modelApiUsage(run, protocol) {
  const usage = run.usage;
  if (usage?.status !== "complete") return protocol === "openai" ? null : { input_tokens: null, output_tokens: null };
  if (protocol === "anthropic") return {
    input_tokens: usage.inputTokens - (usage.cachedInputTokens || 0),
    output_tokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== null && usage.cachedInputTokens !== undefined ? { cache_read_input_tokens: usage.cachedInputTokens } : {}),
  };
  return {
    prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
    ...(usage.cachedInputTokens !== null && usage.cachedInputTokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } } : {}),
    ...(usage.reasoningOutputTokens !== null && usage.reasoningOutputTokens !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens } } : {}),
  };
}

export function modelApiTurnText(thread, turnId) {
  const turn = thread?.turns?.find((item) => item.id === turnId);
  if (!turn || !Array.isArray(turn.items)) fail("完整回合结果不可用，请在控制台核对", null, 502, "result_unavailable");
  return turn.items.filter((item) => item.type === "agentMessage").map((item) => {
    if (typeof item.text !== "string") fail("回合文本格式不可用", null, 502, "result_unavailable");
    return item.text;
  }).join("");
}

function responseBody(run, protocol) {
  const common = { id: `${protocol === "openai" ? "chatcmpl" : "msg"}_${run.id}`, model: run.model };
  if (protocol === "anthropic") return {
    ...common, type: "message", role: "assistant", content: [{ type: "text", text: run.summary || "" }],
    stop_reason: "end_turn", stop_sequence: null, usage: modelApiUsage(run, protocol),
  };
  return {
    ...common, object: "chat.completion", created: Math.floor(Date.parse(run.startedAt) / 1000),
    choices: [{ index: 0, message: { role: "assistant", content: run.summary || "", refusal: null }, finish_reason: "stop", logprobs: null }],
    usage: modelApiUsage(run, protocol),
  };
}

async function bounded(task, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([task, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function streamWriter(res, protocol, run, signal) {
  const common = responseBody(run, protocol);
  const write = async (event, data) => {
    signal.throwIfAborted();
    const frame = `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
    if (res.write(frame)) return;
    let onDrain;
    try {
      await bounded(new Promise((resolve) => { onDrain = resolve; res.once("drain", onDrain); }), signal);
    } finally { res.off("drain", onDrain); }
  };
  const chunk = (delta, finish_reason = null) => ({
    id: common.id, model: run.model, created: common.created, object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason, logprobs: null }], usage: null,
  });
  return {
    async start() {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      if (protocol === "openai") return write(null, chunk({ role: "assistant", content: "" }));
      await write("message_start", { type: "message_start", message: { ...common, content: [], stop_reason: null } });
      await write("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    },
    async delta(text) {
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 8192, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
        const part = text.slice(start, end);
        await (protocol === "openai" ? write(null, chunk({ content: part }))
          : write("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } }));
        start = end;
      }
    },
    ping: () => write(protocol === "anthropic" ? "ping" : null, protocol === "anthropic" ? { type: "ping" } : chunk({})),
    async finish(final, includeUsage) {
      if (protocol === "openai") {
        await write(null, chunk({}, "stop"));
        if (includeUsage) await write(null, { ...chunk({}), choices: [], usage: modelApiUsage(final, protocol) });
        await write(null, "[DONE]");
      } else {
        await write("content_block_stop", { type: "content_block_stop", index: 0 });
        await write("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: modelApiUsage(final, protocol) });
        await write("message_stop", { type: "message_stop" });
      }
      res.end();
    },
  };
}

export function createModelApiHandler({ authenticate, submit, snapshot, record, timeoutMs = 300_000, pollMs = 250 }) {
  const waitTimeout = Number.isFinite(timeoutMs) ? Math.min(900_000, Math.max(1000, timeoutMs)) : 300_000;
  const waiters = new Map();
  let total = 0;
  return async (req, res, protocol) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const signal = controller.signal;
    const onClose = () => controller.abort(Object.assign(new Error("调用方连接已断开；后台任务不会自动取消"), { statusCode: 499 }));
    res.on("close", onClose);
    const timer = setTimeout(() => controller.abort(Object.assign(new Error("等待结果超时；使用原 Idempotency-Key 重试或查询后台任务，不要创建新键"), { statusCode: 504, code: "result_timeout" })), waitTimeout);
    let reserved = false;
    let runId = null;
    let deduplicated = false;
    let metricStatus = 500;
    res.setHeader("Cache-Control", "no-store");
    try {
      const authorization = String(req.get("authorization") || "");
      const bearer = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
      const apiKey = protocol === "anthropic" ? String(req.get("x-api-key") || "").trim() : "";
      if ((authorization && !bearer) || (bearer && apiKey && bearer !== apiKey)) fail("无效或冲突的认证信息", null, 401);
      const token = bearer || apiKey;
      req.apiClient = token ? await bounded(authenticate(req, token), signal) : null;
      if (!req.apiClient) fail("需要有效且有此自动化权限的调用方令牌", null, 401);
      if (req.get("anthropic-beta")) fail("暂不支持 Anthropic beta 功能", "anthropic-beta");
      if (protocol === "anthropic" && req.get("anthropic-version") && req.get("anthropic-version") !== "2023-06-01") fail("仅支持 anthropic-version: 2023-06-01", "anthropic-version");
      const key = String(req.get("idempotency-key") || req.get("x-codex-idempotency-key") || "").trim();
      if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) fail("需要稳定的 Idempotency-Key（8–160 位 ASCII 字母、数字或 ._:-）", "Idempotency-Key");
      const normalized = normalizeModelApiRequest(req.body, protocol, { allowUnboundedOutput: req.get("x-codex-cloud-allow-unbounded-output") === "true" });
      const count = waiters.get(req.apiClient.id) || 0;
      if (count >= 4 || total >= 32) throw Object.assign(new Error("同步等待连接过多，请使用异步任务接口"), { statusCode: 429, retryAfterMs: 5000 });
      waiters.set(req.apiClient.id, count + 1);
      total += 1;
      reserved = true;
      const payload = await bounded(submit(req, normalized.body), signal);
      runId = payload.run.id;
      deduplicated = Boolean(payload.deduplicated);
      res.setHeader("x-codex-cloud-run-id", runId);
      res.setHeader("x-codex-cloud-result-path", payload.run.resultPath);
      res.setHeader("x-codex-cloud-output-limit", normalized.unboundedOutput ? "unsupported-acknowledged" : "backend-default");
      const writer = normalized.stream ? streamWriter(res, protocol, payload.run, signal) : null;
      if (writer) await writer.start();
      let emitted = "";
      let lastPing = Date.now();
      let lastAuth = Date.now();
      for (;;) {
        if (Date.now() - lastAuth >= 5000) {
          if (!await bounded(authenticate(req, token), signal)) fail("令牌已失效；后台任务仍可从控制台核对", null, 401);
          lastAuth = Date.now();
        }
        const current = await bounded(snapshot(runId), signal);
        if (!current) fail("运行记录不可用，请在控制台核对；不要用新键重复提交", null, 502, "run_unavailable");
        const text = current.summary || "";
        if (Buffer.byteLength(text) > 4 * 1024 * 1024) fail("结果超过 4 MiB，请从后台任务查询", null, 502, "output_too_large");
        if (writer && text !== emitted) {
          if (!text.startsWith(emitted)) fail("输出已修订，无法安全续接流；请查询最终结果", null, 502, "stream_revised");
          await writer.delta(text.slice(emitted.length));
          emitted = text;
        }
        if (!pending.has(current.status)) {
          if (current.status !== "completed") fail("Codex 任务未成功完成，请通过 result-path 查询错误及待核对状态", null, 502, "codex_run_failed");
          metricStatus = 200;
          if (writer) await writer.finish(current, normalized.includeUsage);
          else {
            res.setHeader("x-codex-cloud-usage-status", current.usage?.status || "unknown");
            res.json(responseBody(current, protocol));
          }
          return;
        }
        if (writer && Date.now() - lastPing >= 15000) { await writer.ping(); lastPing = Date.now(); }
        await sleep(pollMs, undefined, { signal });
      }
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error;
      metricStatus = failure.statusCode || 500;
      failure.runId = runId;
      sendModelApiError(res, protocol, failure);
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
      if (reserved) {
        const count = waiters.get(req.apiClient.id) - 1;
        if (count) waiters.set(req.apiClient.id, count); else waiters.delete(req.apiClient.id);
        total -= 1;
      }
      if (req.apiClient && metricStatus !== 429) {
        void record({ clientId: req.apiClient.id, automationId: req.params.id, trigger: protocol === "openai" ? "chat-completions" : "messages", status: metricStatus, runId, deduplicated, durationMs: Date.now() - startedAt })
          .catch((error) => console.error(`模型协议调用指标保存失败: ${error.message}`));
      }
    }
  };
}
