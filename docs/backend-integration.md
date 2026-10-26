# 作为后端服务接入

Codex Cloud 的核心是**既有自动化任务的异步执行接口**。适合 CI 检查、调研服务、个人 Agent 的后台任务：业务服务提交事件，保存运行 ID，查询进度及结果，需要时显式取消。

需要用官方 SDK 接入文本或内嵌图片请求时，另有 [OpenAI Chat / Responses / Images、Anthropic Messages 协议适配](model-api-adapters.md)，支持图文输入、文本 SSE 与原生生成图片结果。它不是完整的模型 API，尤其不保证请求级输出 token 上限；下文仍描述原有的异步任务契约，不新增异步 API 的图片字段。

需要从支持本地 stdio 的 AI 客户端调用时，使用 [MCP 薄适配器](mcp-integration.md)：固定自动化与独立令牌，默认只读；明确启用后可提交/续接/取消，复用本文同一任务、隔离和计量，不新增公网端口或第二套执行引擎。

## 接入前准备

1. 在控制台配置并验证自动化及其仓库，Git 仓库必须已有可解析的 `HEAD`。
2. 在“调用与用量”中为每个服务创建独立令牌，只授权必要的自动化；令牌只显示一次。
3. 将 HTTPS 地址和令牌注入服务的秘密管理，分别使用 `CODEX_CLOUD_URL`、`CODEX_CLOUD_API_TOKEN`。不要把令牌放进前端、URL、日志或 Git。
4. 确认任务可能产生的模型费用和外部影响。创建令牌不运行模型，提交任务会运行模型。

参考客户端仅依赖 Node.js 内置模块，可从仓库导入 [`runExternalClient`](../scripts/external-client-example.mjs)，或用任意语言按以下 HTTP 契约接入。推荐使用项目已有的 Node.js 22 或更新运行环境。

调用方统计的任务用量由独立账本保留，历史结果明细裁剪后不会立即丢掉近期 token 统计；未知用量不按零计算。管理接口 `/api/clients/usage` 的 `usageLedger` 返回起始/同步时间、UTC 保留边界、精简记录数和数据库占用。账本保留最近 32 个完整 UTC 日及当天；首次接入前已删除的历史无法回填，不能用它推算完整账户账单。任务结果的保留边界仍以能力接口为准。

页面把提交、受理、同键重放、能力/结果查询和取消分开，提供任务结果分布、成功率分母、未知用量比例及带样本数的 P50/P95。请求错误不等于任务失败；统计只覆盖已记录的已认证调用，不是完整网关流量。口径、旧后端兼容及导出字段见[调用与用量说明](api-usage.md)。

调用方可以设置更严格的并发、每日已知 Token 上限与有效期；空值保留继承/不额外设限，服务器限制不能被绕过。接收和执行前都核对最新配置，未知/未结算用量不当作零；单次任务仍可能超出软阈值。配置入口、版本冲突和管理员接口见[调用方限制](api-usage.md#调用方限制)。

另有不依赖第三方包的 [Python 客户端](../scripts/external-client-example.py)（Python 3.9+）和 [OpenAPI 3.1 契约](openapi.json)。该 OpenAPI 覆盖发现与异步任务；推理适配的字段边界另见模型协议文档，不宣称全协议覆盖。

## 先查询能力

使用同一个独立调用方令牌，通过 `Authorization: Bearer` 或 `x-api-key` 查询下列接口。发现接口不运行模型，不接受 `refresh` 等查询参数；与结果轮询共用每调用方每分钟 60 次限流。过期、撤销、范围不符均拒绝，不接受旧全局共享令牌，也不回退到本机默认登录。

```sh
node scripts/external-client-example.mjs capabilities my-app-review
node scripts/external-client-example.mjs models my-app-review
python3 scripts/external-client-example.py capabilities my-app-review
python3 scripts/external-client-example.py models my-app-review
```

两种客户端均从环境读取 `CODEX_CLOUD_URL` 和 `CODEX_CLOUD_API_TOKEN`。不要把令牌直接写在命令行、Git 或浏览器代码中。

| 接口/字段 | 解释 |
| --- | --- |
| `GET /api/automations/:id/v1/models` | OpenAI 列表子集；返回可见模型及推理/输入类型元信息 |
| `GET /api/automations/:id/v1/capabilities` | 协议能力、自动化默认模型、CLI/协议版本、探测时间和保留边界 |
| `catalog.status` / `catalog_status` | `available` 有目录；`stale` 刷新失败或使用旧缓存；`unavailable` 当前无法取得目录 |
| `inference.status` | 只看此调用方、此自动化保留的记录：`not_verified`、`succeeded`、`failed`；失败不一定是模型权限问题，历史成功也不保证以后可用 |
| `structured_output` / `artifact_download` | 结构化输出见[受限 JSON Schema](structured-output.md)；支持文件交付的部署会将后者设为 `true`。详见[私有结果与文件交付](artifact-delivery.md)，不要把日志路径当下载地址 |
| `image_output` | 支持取回精确原回合的原生生成图片，仍依赖账号/工具及该回合真正成功，不代表所有模型一定能生成 |

目录缺失时 models 返回 503；capabilities 仍可返回 200 并显式标记 unavailable。上游没有提供创建日期和所有者，模型返回 `created: 0`、`owned_by: "unknown"`，不伪造元数据。运行记录为有界历史，没有承诺固定天数；调用方应及时持久保存结果。能力查询记入请求明细的 `discovery`，不计作模型任务受理或 token 使用。

Python 生命周期示例（提交会消耗模型额度；先审核输入和自动化权限）：

```sh
python3 scripts/external-client-example.py submit my-app-review business-event-20261022-001 --prompt '整理已审核资料' --wait --timeout 300
python3 scripts/external-client-example.py status my-app-review 已保存的运行ID
python3 scripts/external-client-example.py cancel my-app-review 已保存的运行ID
```

业务事件 ID 必须先在调用方保存。提交响应丢失时保持相同事件 ID 和输入重试；已拿到运行 ID 就查询它。示例有限重试，拒绝跳转转发令牌，本地等候超时不会自动取消。Python 使用网络超时和整体等待期限；不适合作为硬实时截止控制。更完整的事件游标、异步持久化进度回调可用 Node 参考客户端。

程序直接调用 Python `Client.execute(...)` 时，等待或请求失败的异常会保留 `run_id`、`event_id` 属性（没有格式有效的已知值为 `None`），不改变原有异常类型。先持久保存这两个编号、自动化 ID 与调用方身份：有 `run_id` 就续查；仅有 `event_id` 就以原编号和相同输入恢复提交，不新建业务编号。拒绝或不匹配的响应不会替换已确认的运行编号，下一次调用也不会沿用上一次的恢复信息。恢复字段和错误日志不回显无效编号；响应运行编号含空白/控制字符等异常内容时拒绝，不写入进度日志。命令行最后一条错误同样包含可用编号；Ctrl+C/超时都不代表云端任务已取消。

Python `Client` 的整体等待期限从初始化开始计算；期限耗尽后，恢复请求使用新的 `Client` 实例和保存的原编号，而非对已经过期的实例继续等待。底层 `request(...)` 不承担执行级编号跟踪；业务接入应使用 `execute(...)`。该客户端不建立持久任务队列，业务侧仍需自行保存恢复信息。

新任务支持受限产物清单和鉴权下载，须先查询部署能力；Node/Python 的 `output`、`download` 用法、20 MiB 结果包限额和保留策略见[文件交付](artifact-delivery.md)。异步任务的 `summary` 仍可能截断，不等于完整结果；旧任务不会补造副本。

支持[受限内联文件输入](file-inputs.md)：异步正文 `attachments` 或 Node/Python 的 `--attach`、`--input`，用于 txt/md、普通 PDF 和静态图片材料。先查 `features.file_input` 及 PDF 的运行时状态，不把文件名当服务器路径；同事件键的材料变化会冲突，正文、队列材料和接收缓冲均有上限。PDF 的文字和页面图片在模型前转换，失败和未识别文字层有明确状态。

## HTTP 契约

以下异步任务接口支持 `x-codex-cloud-token`、Bearer 或 `x-api-key`；多个头必须一致。提交另需 `Idempotency-Key` 和未压缩的 application/json 正文（最多 12 MiB），不是上传任意服务器路径。

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

对已结束的任务重复调用 `cancel` 返回 HTTP 200 和原记录，包括旧 JSON 格式的已中断任务；不会把 `interrupted` 或 `needs_reconciliation` 改成 `canceled`，也不会清零未知用量或撤销已发生的动作。仍以响应中的 `run.status` 判断结果，不能只按 HTTP 200 记为成功。旧部署可能对旧中断记录返回 409，见[兼容修复与验收](acceptance/2026-10-27-production-cancellation.md)。

当前源码对同一进程中的同一个运行回合复用一次中断命令：串行/并发重试、网页停止与后台清理不会重复发出原生中断；启动编号未确认时先保留取消意图，收到本次真实编号后才中断。中断请求得到受理或返回不明错误，都不等于已停止；继续查询原运行 ID，等待 `canceled` 或其他明确状态，不创建新事件来“重试取消”。这不是跨进程的全局恰好一次保证，重启后仍按持久状态核对、不自动重放。该修复的发布范围与证据见[取消去重验收](acceptance/2026-10-27-production-cancellation.md)，不要把源码能力当作旧部署已具备。

### 排队与服务重启

新外部请求先持久保存任务、原始执行输入和幂等摘要，再返回 `queued`。默认最多保留 32 个待执行请求；满时返回 429 和 `Retry-After`，应使用原事件键重试。app-server 自动化默认同时执行最多 2 个、同一调用方最多 1 个；按满足并发限制的接收顺序领取。控制台原有 app-server 自动化仍共享执行并发上限；此限制不覆盖直接聊天或 systemd 任务，不是账户总并发/费用上限。

- 未领取的任务在服务重启后继续排队；已领取但执行进程退出的任务标为 `needs_reconciliation`，**不会自动重新执行**。本服务不能保证第三方动作全局“恰好一次”。
- 真正启动前重新检查调用方是否过期、撤销或失去授权；排队不等于永久取得执行权限。
- 取消尚未领取的任务会立即终止，模型用量明确为零；已领取任务仍需中断和核对，不能撤销外部动作。
- `startedAt` 是接收时间；可选的 `executionStartedAt` 是开始执行时间。跨 UTC 日期排队的任务按执行开始日归入用量和日预算。模型适配接口的等待期限包含排队，不等于取消或费用上限。
- 发布期间短暂拒绝新接收，返回 503 和 `Retry-After`；保持原事件键重试，不要创建新键绕过。

新增外部任务以 SQLite 为准，原 JSON 保留兼容快照；控制台手动任务、原定时服务及 Codex 历史不迁移到这条队列。备份与回退必须按[部署说明](setup.md#更新版本)保护两者，不得只恢复旧 JSON 覆盖新任务。

### 提交参数

所有参数均可省略；默认使用自动化的 prompt、模型和 thinking level。请求支持以下字段，独立调用方的未知字段或错误类型返回 400，不会静默忽略。

| 字段 | 限制与行为 |
| --- | --- |
| `prompt` | 非空字符串，最多 64 KiB；覆盖本次任务提示词，不能直接接受不可信的任意指令 |
| `model` | 模型 ID；实际传入 Codex，账号支持情况仍由 Codex 决定，返回的 `run.model` 是运行记录 |
| `reasoning` | `none/minimal/low/medium/high/xhigh/max/ultra`；具体模型不一定支持所有值 |
| `search` | 布尔值，默认 `true`；设置该线程的网页搜索配置，不是网络访问隔离 |
| `completionContract` | 声明式完成条件，可检查最终标记、工作区文件和可选哈希；见[配置说明](setup.md#自动化接入) |
| `artifactPaths` | 最多四个隔离工作树内的相对文件路径；本轮新增/内容变化才可交付。单份 8 MiB，清单与所有产物总计 20 MiB；见[文件交付](artifact-delivery.md) |
| `outputSchema` | 受限 JSON Schema，原生传入 CLI 并校验精确原回合；成功从 `run.structuredOutput.data` 取完整对象，见[说明](structured-output.md) |
| `sessionId` | 仅 Heartbeat 可用，必须能验证为本调用方、同一自动化的历史会话 |
| `runner` | 仅支持 `app-server`，无需显式设置 |
| `worktree` | 独立调用方只能省略或设为 `true` |

API 不允许覆盖 `sandbox`、`approval`、`executionProfile`；它们由控制台执行策略决定。旧共享令牌兼容既有会话和仓库目录用法，权限更宽，建议迁移到独立令牌。旧任务及其幂等重放仍返回原运行记录，不会为了应用新参数而重新执行。

### 按需任务的受限执行

运营者可在 `CODEX_CLOUD_AUTOMATIONS_CONFIG_B64` 对应的自动化配置中显式增加 `"executionProfile":"workspace-restricted-v1"`。仅支持 `mode: "on-demand"`、没有 `timer/service` 的工作项目自动化；客户端不能选择、取消或覆盖策略。配置未知或与系统定时服务混用时拒绝启动，不静默降级。已有自动化不自动迁移，不修改已有任务、登录或显式模型选择。

该策略固定工作树写入、禁止命令联网、关闭网页搜索、连接器及插件，并禁止申请额外权限。每次模型启动前核对原生线程的实际目录、写权限和完整连接器状态；无法确认就以“未启动”失败，模型计量为零。文本、结构化 JSON、受限材料输入和工作树产物可用；图片生成接口在接收任务前拒绝。`capabilities.execution` 和 `run.execution` 返回策略及限制，图片输出能力同步返回不可用。

任务接收时同时保存策略和执行材料；排队、领取及恢复时再次比对。运营者变更或移除策略后，旧排队任务不会自动使用新权限执行；相同事件键仍找回原记录。继续会话只允许同一策略、已核对的原工作树，不把旧高权限会话直接改成受限会话。任务存储格式升级为 7；非空任务数据库不能自动退回不识别该格式的旧执行器，须先验证兼容版本，不能恢复旧数据库覆盖新任务。

这不是不可信多租户安全沙箱。执行器仍共用服务器系统用户；该策略未证明宿主文件读取隔离、阻止协作或模型费用硬上限。CLI 0.157.1 的本机/EC2 模拟服务实测中，`collaboration.spawn_agent` 不仅列出，还能实际派生子回合。不要把禁用标志或提示词当强制隔离；包含独立协作的运行在尚未完成归集前保持用量未知，而非只报父回合。合法配置名称含 `.`、`@` 的误拒绝已由 PR #21 修复，未知或损坏的配置仍拒绝启动；不能据此向陌生用户开放任意命令。参见[策略验收](acceptance/2026-10-25-automation-execution-profile.md)、[配置修复](acceptance/2026-10-25-personal-memory-quality.md)和 [F07 实际调用/计量验收](acceptance/2026-10-25-turn-usage-accounting.md)，以报告发布状态为准。

### 独立客户端与真实 CLI 自检

```bash
# 临时回环服务、真实 CLI 0.157.1、模拟模型，不读取现有登录或消耗模型额度。
npm run verify:external-client:codex
```

此检查用独立 Node 进程提交虚构 Markdown/PDF、校验 JSON 和报告文件，再由独立 Python 进程在服务重启后下载；同时检查原事件恢复、未领取任务取消、调用方用量和撤销拒绝。只监听 `127.0.0.1`，临时令牌限单一验收自动化、一小时到期，结束撤销并停止进程；私有证据路径在输出中给出。完整命令已在本机与 EC2 的隔离服务通过，不是生产 HTTPS、真实 EC2 模型或图片生成验收。GitHub 托管主机拒绝原生沙箱写入，CI 因此只运行显式的 `--guards-only`（三个真实模式入口拒绝检查），不宣称 CI 已完成原生文件链路；原有全量回归和运行包门禁保持。

真实模型模式必须另行得到额度授权，并由用户准备一个私有、已登录且不同于正常 Codex 目录的 `CODEX_EXTERNAL_LIVE_HOME`，再设置 `CODEX_EXTERNAL_LIVE_APPROVED=1` 运行 `npm run verify:external-client:codex -- --live`。脚本不会复制登录凭据、重新登录或自动新增模型回合，默认不进入此模式。CLI 会在该专用目录登记本轮虚构仓库的信任项并保留原生测试线程；这不是无状态调用。不得把普通 `~/.codex` 当测试目录，亦不自动恢复旧配置覆盖并行修改。首次共享目录实测和这一限制见[本轮验收](acceptance/2026-10-25-native-client-evidence.md)。

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
- 服务端幂等窗口默认 24 小时，可以由部署配置修改。新增持久任务仍在排队、执行或待核对时保留原键，不因到期重复启动；已结束且结果明确的任务到期后可接受新任务。旧 JSON 任务仍按原窗口；结果未知时先人工核对，不要换键重新提交。
- 结果查询每个令牌每分钟最多 60 次；游标只覆盖最近 80 条元数据事件，不是完整日志。`eventGap: true` 时重置到当前快照，不把缺失事件视为任务成功。

命令行也支持 `submit/heartbeat/status/cancel`。只有 `cancel` 会主动请求服务器中断；Ctrl+C 不会。用法见[独立调用方](setup.md#独立调用方)。

## 当前边界

上线前可以在已有 CLI 环境运行 `npm run verify:command-isolation:codex`，验证明确配置下的工作区写入、命令禁网和虚构 MCP 禁用。它只使用临时无登录目录和本机模拟模型服务；不是给生产自动化设置权限的接口，不会改变当前执行器的全权限默认值，也不能证明协作工具被禁用。完整步骤、EC2 实测与未覆盖限制见[原生隔离检查](acceptance/2026-10-25-native-command-isolation.md)。

独立令牌不能读取管理页面、其他服务的结果或批准任务；运行响应不泄漏工作目录、会话 ID 和原始工具内容。用量缺失时为“未知”，token 不是美元账单。

服务器操作者预先登记后，可使用[签名完成回调](callbacks.md)：稳定事件 ID、持久投递、有限重试和轮询兜底。先查 `features.callback.configured`，不要把 Node 客户端本地的 onProgress/onStatus 函数误当成服务器回调。回调不运行新的模型任务、不传正文或令牌，不接受请求中指定任意 URL。

隔离工作树和调用方范围**不是操作系统沙箱**，当前工作执行器仍共用系统用户和 Codex 账号。仅向受信任服务开放，不能作为不可信多租户执行平台。没有通用外部任务创建/编排 API；文件下载只对同一调用方的新运行私有副本开放，既有运行状态接口不接受任意文件路径。已有的 OpenAI/Anthropic SSE 和图文协议子集是另一组接口，见[模型协议适配](model-api-adapters.md)。代码、运行时和生产证据的区别见[版本与能力基线](release-baseline-2026-10-22.md)。

本轮[验收与 review](acceptance/2026-10-04-backend-integration.md)记录测试证据及未覆盖边界。
