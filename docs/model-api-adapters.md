# OpenAI / Anthropic 协议接入

本项目提供 **OpenAI Chat Completions 和 Anthropic Messages 的文本子集适配**，可接入官方 SDK。底层始终是已有自动化中的 Codex Agent，不是 OpenAI 模型 API 的透明代理，也不会调用 Claude。长任务、恢复与取消仍推荐[异步任务 API](backend-integration.md)。

## 先明确边界

| 能力 | 当前支持 |
| --- | --- |
| 请求和响应 | OpenAI `messages → choices[0].message.content`；Anthropic `messages/system → content[text]` |
| 文本历史 | 保留角色和内容边界，转换成 Codex 单轮的 JSON 对话记录；不是原生模型消息通道 |
| 流式输出 | 真实 Agent 文本增量；OpenAI SSE chunks / `[DONE]`，Anthropic具名 SSE 事件 |
| 执行隔离 | 每个新事件使用独立会话和 Git 工作树；完整历史由调用方逐次传入 |
| 幂等、撤销与统计 | 复用独立调用方令牌、运行记录、并发及请求限制；两类调用进入“调用与用量” |
| 模型与推理 | `model` 使用实际 Codex 模型 ID；OpenAI `reasoning_effort` / Anthropic `output_config.effort` |
| 不支持 | Responses API、模型列表 API、图片/音频/文件内容块、客户端 `tools/tool_calls/tool_use/tool_result`、JSON Schema、采样参数、assistant 预填充、Anthropic beta/缓存控制 |

**重要：Codex 无法原生兑现请求级 `max_tokens/max_completion_tokens`。** 默认返回 400，而不是假装预算生效。Anthropic 的 SDK 必须提供 `max_tokens`，因此只有在调用方明确接受“不应用该输出上限”后，才可加 `x-codex-cloud-allow-unbounded-output: true`。这不限制推理或总 token 消耗，也不会截断输出。需要严格逐请求 token 预算的业务不能使用本适配器。

Codex 自身的仓库工具、联网和连接服务仍由服务器策略决定。API 令牌不是安全沙箱：不要把接口开放给不可信多租户，也不要把任意外部输入当作已审核的可执行指令。

## 地址和认证

先在控制台“调用与用量”创建独立令牌，只授权目标自动化。既有自动化需关联有 `HEAD` 的 Git 仓库。令牌在服务端秘密管理中保存，不放进浏览器、URL 或 Git。

| SDK | baseURL | 认证 |
| --- | --- | --- |
| OpenAI | `https://你的域名/api/automations/自动化ID/v1` | `Authorization: Bearer <调用方令牌>` |
| Anthropic | `https://你的域名/api/automations/自动化ID` | `x-api-key: <调用方令牌>`，SDK 自动追加 `/v1/messages` |

实际接口是 `POST /api/automations/:id/v1/chat/completions` 和 `POST /api/automations/:id/v1/messages`，不提供域名根目录的 `/v1`。Anthropic 也接受 Bearer，但两个认证头冲突时拒绝。支持 `anthropic-version: 2023-06-01`。

每次调用必须设置稳定的 `Idempotency-Key`：8–160 位 ASCII 字母、数字或 `._:-`。业务事件创建时保存该键，重试不能换键，同键变更文本/模型/推理强度返回 409。同键可以改用流式读取最终结果，不会重新执行模型。不要把示例中的事件 ID 作为所有用户请求的固定值。

## OpenAI SDK

以下调用会运行实际 Codex 任务并消耗模型额度；先确认自动化权限和预算。

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CODEX_CLOUD_API_TOKEN,
  baseURL: `${process.env.CODEX_CLOUD_URL}/api/automations/my-app-review/v1`,
  timeout: 330_000,
  maxRetries: 0,
});

async function reply(event) {
  const { data, response } = await client.chat.completions.create({
    model: "gpt-6-sol",
    reasoning_effort: "medium",
    messages: [
      { role: "system", content: "只用中文，输出简洁的调研结果。" },
      { role: "user", content: event.reviewedPrompt },
    ],
  }, { headers: { "Idempotency-Key": event.persistedId } }).withResponse();
  return { text: data.choices[0].message.content,
    runId: response.headers.get("x-codex-cloud-run-id"), usage: data.usage };
}
```

流式请求增加 `stream: true` 和可选 `stream_options: {include_usage: true}`，遍历 `chunk.choices[0]?.delta.content`。最后必须收到 `finish_reason: "stop"` 及正常结束；错误事件或异常断流不能当作完成。不要混用 Responses SDK。

## Anthropic SDK

这只是 Messages **协议**适配，模型仍使用 Codex ID，不能填写 `claude-*`。下面显式确认了不应用 `max_tokens`，不代表 1024 token 的执行预算。

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.CODEX_CLOUD_API_TOKEN,
  baseURL: `${process.env.CODEX_CLOUD_URL}/api/automations/my-app-review`,
  timeout: 330_000,
  maxRetries: 0,
  defaultHeaders: { "x-codex-cloud-allow-unbounded-output": "true" },
});

async function reply(event) {
  const stream = client.messages.stream({
    model: "gpt-6-sol",
    max_tokens: 1024,
    system: "只用中文，输出简洁的调研结果。",
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: event.reviewedPrompt }],
  }, { headers: { "Idempotency-Key": event.persistedId } });
  stream.on("text", (text) => process.stdout.write(text));
  return await stream.finalMessage();
}
```

`messages.create()` 也支持非流式。文本可为字符串或仅包含 `{type:"text",text:"..."}` 的数组。1–100 条消息，至少一条 user，最后一条必须是 user；转换后的输入不超过 64 KiB，HTTP 正文不超过 128 KiB。

## 结果、超时和计量

- 响应头 `x-codex-cloud-run-id`、`x-codex-cloud-result-path` 用于后台追踪；错误正文在已知时含 `run_id`。
- 同步等待默认最多 5 分钟；服务端 `CODEX_MODEL_API_WAIT_TIMEOUT_MS` 范围为 1 秒至 15 分钟。它只限制 HTTP 等待，**超时、SDK abort 和断网都不会自动取消或回滚后台任务**。
- 超时后用原键重试，或通过自定义结果接口查询；查询和显式取消仍使用 `x-codex-cloud-token`，不能把适配接口的 Bearer 契约误用于旧接口。
- 429 可按 `Retry-After` 重试原键。每个调用方最多 4 个同步等待连接，进程最多 32 个；实际执行还有更严格的既有并发和已知 token 日预算限制。长任务用异步接口。
- 流开始后发生执行失败、取消、重启中断、待核对状态，会发送协议错误事件，不发送成功终止标记。流中的中间文本只是进度，不是已验收的交付。
- `usage` 来自 Codex 当前 Agent 回合，可能包含内部工具循环与推理，不等于可见文本的计数。OpenAI 保留总输入/缓存输入；Anthropic 把缓存读取量单列。未知时 OpenAI `usage:null`；Anthropic计数为 `null`（明确的兼容扩展），绝不伪造为 0。流开始时通常未知，终态事件才提供实际计数；要求所有计数必为数字的第三方网关需适配这一差异。
- 运行成功仍会检查该自动化既有的完成契约。聊天型自动化不要配置只适用于开发交付的固定完成标记，否则普通答案会被判失败。
- 长答案在摘要达到保留上限时，从原 Codex thread 的精确 turn 读取，不扩大运行索引，也不复制一份结果缓存。原回合不可用时返回错误，不能拿截断摘要冒充完整答案。单次可见结果最多 4 MiB；超出时需从原任务交付文件获取。

## 反向代理和验收

新安装使用当前 `ops/Caddyfile`。已有 Caddy 承载多个站点时，不要整体覆盖；备份后运行：

```sh
node ops/extend-caddy-automation-routes.mjs \
  /etc/caddy/Caddyfile /tmp/codex-caddy-model-candidate --model-api
```

工具只增加两条 POST 路由的匹配器，开启即时流式刷新，并校验所有原路由语义不变；管理员再原子替换、reload 和健康检查。失败恢复原配置。不要打印含认证哈希的配置。

新版本机控制台代理也可使用同样的路径：会保留调用方的 Bearer / API key，不注入本机默认共享令牌或 Basic 登录。必须自行提供独立调用方令牌。非流式等待默认 330 秒，可用 `CODEX_CLOUD_CONSOLE_MODEL_API_TIMEOUT_MS` 与远端等待上限匹配。生产业务服务仍推荐直接使用 HTTPS 地址。

本地 `npm run verify:model-api` 使用两套官方 SDK 和内存执行器；`npm run verify:regressions` 验证真实 Express 路由、假 Codex app-server、隔离 Git 工作树、运行持久化、作用域、重放与撤销。这些测试不调用付费模型。

协议参考：[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[Anthropic SSE](https://platform.claude.com/docs/en/build-with-claude/streaming)。本项目只承诺上文列出的子集。
