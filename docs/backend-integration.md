# 作为后端服务接入

Codex Cloud 的核心是**既有自动化任务的异步执行接口**。适合 CI 检查、调研服务、个人 Agent 的后台任务：业务服务提交事件，保存运行 ID，查询进度及结果，需要时显式取消。

需要用官方 SDK 接入文本或内嵌图片请求时，另有 [OpenAI Chat / Responses / Images、Anthropic Messages 协议适配](model-api-adapters.md)，支持图文输入、文本 SSE 与原生生成图片结果。它不是完整的模型 API，尤其不保证请求级输出 token 上限；下文仍描述原有的异步任务契约，不新增异步 API 的图片字段。

## 接入前准备

1. 在控制台配置并验证自动化及其仓库，Git 仓库必须已有可解析的 `HEAD`。
2. 在“调用与用量”中为每个服务创建独立令牌，只授权必要的自动化；令牌只显示一次。
3. 将 HTTPS 地址和令牌注入服务的秘密管理，分别使用 `CODEX_CLOUD_URL`、`CODEX_CLOUD_API_TOKEN`。不要把令牌放进前端、URL、日志或 Git。
4. 确认任务可能产生的模型费用和外部影响。创建令牌不运行模型，提交任务会运行模型。

参考客户端仅依赖 Node.js 内置模块，可从仓库导入 [`runExternalClient`](../scripts/external-client-example.mjs)，或用任意语言按以下 HTTP 契约接入。推荐使用项目已有的 Node.js 22 或更新运行环境。

## HTTP 契约

所有接口使用 `x-codex-cloud-token`。提交接口另需 `Idempotency-Key` 和 JSON 正文。

| 接口 | 用途 |
| --- | --- |
| `POST /api/automations/:id/webhook` | 创建本调用方的新会话与隔离工作树 |
| `POST /api/automations/:id/heartbeat` | 续接本调用方、同一自动化最近已完成的会话；没有历史时新建 |
| `GET /api/automations/:id/runs/:runId?after=0` | 查询本调用方的运行及游标之后的近期事件 |
| `POST /api/automations/:id/runs/:runId/cancel` | 显式请求中断；不能撤销已发生的外部动作 |

提交成功目前返回 HTTP 200，取消处理中返回 202；**HTTP 成功只代表请求已接受，不代表业务任务已完成**。结果查询响应示例：

```json
{
  "ok": true,
  "run": {
    "id": "run-id",
    "automationId": "my-app-review",
    "status": "running",
    "model": "gpt-6-sol",
    "reasoning": "medium",
    "summary": "",
    "error": null,
    "eventCursor": 3,
    "resultPath": "/api/automations/my-app-review/runs/run-id"
  },
  "eventCursor": 3,
  "eventGap": false,
  "events": [{ "seq": 3, "time": "2026-10-04T00:00:00Z", "type": "status" }]
}
```

`queued`、`running`、`canceling` 是进行中状态。`completed` 是执行成功；`failed`、`canceled`、`interrupted`、`needs_reconciliation` 不能当作成功。任务是否真正交付还应结合 `completionContract`、`completionOutcome` 与业务验收，不以模型一句“完成了”为依据。

### 提交参数

所有参数均可省略；默认使用自动化的 prompt、模型和 thinking level。请求支持以下字段，独立调用方的未知字段或错误类型返回 400，不会静默忽略。

| 字段 | 限制与行为 |
| --- | --- |
| `prompt` | 非空字符串，最多 64 KiB；覆盖本次任务提示词，不能直接接受不可信的任意指令 |
| `model` | 模型 ID；实际传入 Codex，账号支持情况仍由 Codex 决定，返回的 `run.model` 是运行记录 |
| `reasoning` | `none/minimal/low/medium/high/xhigh/max/ultra`；具体模型不一定支持所有值 |
| `search` | 布尔值，默认 `true`；设置该线程的网页搜索配置，不是网络访问隔离 |
| `completionContract` | 声明式完成条件，可检查最终标记、工作区文件和可选哈希；见[配置说明](setup.md#自动化接入) |
| `sessionId` | 仅 Heartbeat 可用，必须能验证为本调用方、同一自动化的历史会话 |
| `runner` | 仅支持 `app-server`，无需显式设置 |
| `worktree` | 独立调用方只能省略或设为 `true` |

API 不允许覆盖 `sandbox`、`approval`；它们由控制台执行策略决定。旧共享令牌兼容既有会话和仓库目录用法，权限更宽，建议迁移到独立令牌。旧任务及其幂等重放仍返回原运行记录，不会为了应用新参数而重新执行。

## Node.js 集成

以下调用会运行真实任务；先确认自动化和预算。`event.id` 必须是业务侧持久化的稳定 ID，符合 8–160 位 ASCII 字母、数字或 `._:-`，不能在重试时重新生成。

```js
import { runExternalClient } from "./scripts/external-client-example.mjs";

const connection = {
  origin: process.env.CODEX_CLOUD_URL,
  token: process.env.CODEX_CLOUD_API_TOKEN,
  automationId: "my-app-review",
};

async function submitResearch(event) {
  const run = await runExternalClient({
    ...connection,
    command: "submit",
    eventId: event.id,
    input: {
      prompt: event.reviewedPrompt,
      model: "gpt-6-sol",
      reasoning: "medium",
    },
    timeoutMs: 30_000,
  });
  // 在业务数据库中保存 event.id、run.id、automationId 与令牌所属服务，之后按 ID 查询。
  return { eventId: event.id, runId: run.id, status: run.status };
}

async function waitForResearch(runId, signal) {
  return runExternalClient({
    ...connection,
    command: "status",
    runId,
    wait: true,
    signal,
    timeoutMs: 10 * 60_000,
    onProgress: async ({ run, eventCursor, eventGap, events = [] }) => {
      // 可持久化运行快照与游标；eventGap 为 true 时以 run 快照重新同步。
      console.log({ runId: run.id, status: run.status, eventCursor, eventGap, events });
    },
  });
}
```

建议业务 HTTP 请求仅完成提交和记录 ID，随后由后台 job 查询；不要让浏览器请求一直占用到模型完成。`onProgress` 在每次成功查询时调用，`onStatus` 仅在状态变化时调用，两者支持异步并等待完成；回调失败会停止本地等待并保留 `error.runId`。回调自行保证持久化幂等，超时无法撤销已经开始的回调操作。

### 恢复与错误处理

- `timeoutMs` 是提交、读取响应、重试、轮询和回调共同的总等待预算，默认一小时；单次请求默认最多 30 秒，轮询默认间隔 5 秒。
- 网络错误和 HTTP 429/502/503/504 默认最多重试两次，遵守秒数或 HTTP 日期形式的 `Retry-After`；POST 重试保持同一正文和事件键。401/403/404/409、无效成功响应和重定向不会重试。
- 客户端拒绝非 HTTPS 的远端地址及带账号密码的 URL，不跟随重定向，避免令牌被转发；本机 loopback HTTP 可用于测试。
- `ExternalClientError` 包含 `code`、可用时的 `statusCode/retryAfterMs`，以及 `runId/eventId`。`TIMEOUT`、`ABORTED` 只停止本地等待，不取消服务器任务。
- 有 `runId` 时恢复查询；提交响应丢失而没有 ID 时，使用原事件键和**相同输入**重试。不同输入复用同键返回 409，不能换新键来“修复”一次未知执行。
- 服务端幂等窗口默认 24 小时，可以由部署配置修改；超过窗口且结果未知时先人工核对，不保证再次提交仍去重。
- 结果查询每个令牌每分钟最多 60 次；游标只覆盖最近 80 条元数据事件，不是完整日志。`eventGap: true` 时重置到当前快照，不把缺失事件视为任务成功。

命令行也支持 `submit/heartbeat/status/cancel`。只有 `cancel` 会主动请求服务器中断；Ctrl+C 不会。用法见[独立调用方](setup.md#独立调用方)。

## 当前边界

独立令牌不能读取管理页面、其他服务的结果或批准任务；运行响应不泄漏工作目录、会话 ID 和原始工具内容。用量缺失时为“未知”，token 不是美元账单。

隔离工作树和调用方范围**不是操作系统沙箱**，当前工作执行器仍共用系统用户和 Codex 账号。仅向受信任服务开放，不能作为不可信多租户执行平台。当前没有外部任务创建/编排 API、完成回调推送、OpenAI 兼容流式聊天或隔离令牌文件下载接口；交付文件条件可以校验，但不能通过此结果接口直接下载文件。

本轮[验收与 review](acceptance/2026-10-04-backend-integration.md)记录测试证据及未覆盖边界。
