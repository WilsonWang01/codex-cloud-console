# 用 MCP 接入 Codex Cloud

MCP 是 AI 客户端调用工具的标准协议。本仓库提供本地 `stdio` 适配器（客户端启动一个子进程，通过标准输入输出通信），将既有 HTTP 任务接口包装成工具。**不新增公网端口或 `/mcp` 地址，不需要为了接入而重启 EC2。**只支持远程 MCP URL、不能启动本地进程的客户端，目前不能直接使用这个适配器。

适配器不执行模型、不维护第二套任务队列，也不替你申请新的账号权限。真正的执行、隔离、审批、幂等和计量仍在 Codex Cloud 后端。提交任务会消耗模型额度，并可能执行自动化配置允许的动作；读能力/状态和取回已有结果不发起模型运行。底层仍是 Codex，不会因为接到另一个客户端就变成 Claude 或其他模型 API。

## 配置

1. 按[后端接入准备](backend-integration.md#接入前准备)配置并验证自动化，创建一个**只授权该自动化**的独立调用方令牌；不要使用管理员凭据或旧共享令牌。
2. 在运行 MCP 客户端的机器上取得当前仓库源码，使用 Node.js 22.16+，在仓库根目录执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`。不用构建前端，不依赖开发用 MCP 客户端包。该命令安装已锁定的运行依赖，不启动任务。
3. 在支持自定义本地 stdio 的 MCP 客户端配置中，设置 Node 的绝对路径、适配脚本绝对路径和下列环境变量。路径相对于**客户端所在机器**，不是 EC2 路径。

| 环境变量 | 含义 |
| --- | --- |
| `CODEX_CLOUD_URL` | 最终 HTTPS 源站地址，不带账号密码、路径、查询或片段；只允许本机回环地址使用 HTTP |
| `CODEX_CLOUD_API_TOKEN` | 独立调用方令牌，从客户端秘密管理或私有配置注入，不放 URL、命令行参数、日志或 Git |
| `CODEX_CLOUD_AUTOMATION_ID` | 固定绑定的一条自动化 ID；工具参数不能切换自动化 |
| `CODEX_CLOUD_MCP_ALLOW_EXECUTION` | 默认省略或 `0`，只提供读取工具；明确启用 `1` 后才提供提交/取消 |

以下为采用 `mcpServers` JSON 的客户端示例，全部占位符都需替换；其他客户端请在其设置页填入同样的命令、参数和环境变量，不能假定都接受此 JSON：

```json
{
  "mcpServers": {
    "codex-cloud": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/codex-cloud-console/scripts/codex-cloud-mcp.mjs"],
      "env": {
        "CODEX_CLOUD_URL": "https://your-console.example.com",
        "CODEX_CLOUD_API_TOKEN": "<独立调用方令牌，仅填写在客户端私有配置或秘密管理中>",
        "CODEX_CLOUD_AUTOMATION_ID": "your-automation-id"
      }
    }
  }
}
```

客户端是否继承终端环境、是否展开 `${变量名}`，取决于客户端本身；不要假定占位符会自动取到秘密。需要把令牌写在私有配置时，限制该文件访问权限（例如当前用户可读写），不要提交这份配置。本轮没有自动改任何客户端配置、创建新令牌或授予工具权限。

连接后应能列出五个只读工具。先调用 `codex_cloud_capabilities` 和 `codex_cloud_models`，核对自动化默认模型、能力和保留期限；模型目录不是账号推理权限证明。认证过期或范围不符会被后端拒绝，不会回退借用本机控制台登录。

## 工具

| 工具 | 参数与结果 |
| --- | --- |
| `codex_cloud_capabilities` | 无参数；读取该自动化的实际能力与限制 |
| `codex_cloud_models` | 无参数；读取可见模型目录，不发起推理 |
| `codex_cloud_status` | `runId`；读取本调用方任务的状态、已知用量、交付状态等。摘要最多 4000 个 UTF-16 字符，`summaryTruncated` 明示裁剪；完整结果用下一个工具 |
| `codex_cloud_output` | `runId`，可选 `section:"text"/"structured"/"metadata"`、`offset`、`limit`；默认最多 16000 个 UTF-16 字符，返回 `nextOffset/done` 和产物清单。`structured` 分段拼接后是完整结构化结果的 JSON；`metadata` 则保留来源、原回合和捕获/到期信息 |
| `codex_cloud_read_artifact` | `runId/fileId`，可选字节 `offset/limit`（最多 65536）；先下载并验证完整文件大小与 SHA-256，再返回 Base64 分块。`asImage:true` 可直接返回 1 MiB 内 PNG/JPEG/WebP 图片内容块，不会生成图片 |
| `codex_cloud_submit` | **仅执行开关为 `1` 时存在**；`eventId`、可选 `trigger:"webhook"/"heartbeat"`、`input`。返回已接受的运行 ID/状态，不等待模型结束 |
| `codex_cloud_cancel` | **仅执行开关为 `1` 时存在**；`runId`。显式请求中断，不会撤销已经发生的外部动作；`canceling` 不代表最终已取消 |

UTF-16 是 JavaScript 的字符串计数方式，通常中文字符占 1、部分表情占 2；按返回的 `nextOffset` 继续，不自行换算字节。分段可跨表情的编码边界，拼接原字符串后再展示或解析。`done:true` 表示该段已到完整结果末尾，不是整个业务目标已完成。无结果、已过期、文件不匹配和读取超界都明确报错。

文件下载不接收路径或 URL，不跟随服务端提供的下载地址。适配器不会向本机文件系统写入下载内容。每次分块都重新验证完整文件，适合少量检查；批量/大文件应使用[HTTP 客户端下载](artifact-delivery.md)，避免反复下载 8 MiB 文件。直接图片展示是额外读取表示；其他类型或超过 1 MiB 的图片用分块/HTTP 下载。

SHA-256 是文件内容的指纹，用来验证下载内容与原产物一致，不是加密或对报告结论正确性的保证。来源元信息也是任务数据；适配器不会因为出现链接就自动访问它，更不据此授权第三方写入。

`asImage:true` 返回完整的小图片内容块，此时 `offset` 只能是 0，分块 `limit` 不适用；不是按输入 limit 返回一段残缺图片。

## 提交与恢复

只在用户明确同意该自动化的费用与具体动作后，才启用执行开关。MCP 的工具风险标注是提示，不是审批引擎；客户端仍须向用户确认，启用开关不等于授权发送邮件、改日历或任意第三方写入。后端配置的审批继续生效，工具不能覆盖 `sandbox/approval/worktree/runner`。

提交前在调用方保存稳定的 `eventId` 和原输入，例如：

```json
{
  "eventId": "review-report-20261023-001",
  "trigger": "webhook",
  "input": {
    "prompt": "整理已审核材料，生成 results/report.md。不要修改外部系统。",
    "artifactPaths": ["results/report.md"]
  }
}
```

`input` 支持既有契约的 prompt、model、reasoning、search、sessionId（仅 heartbeat）、completionContract、outputSchema、artifactPaths、attachments。省略模型/推理档位就使用后端自动化的默认值，不在适配器硬编码；附件格式与大小、PDF 条件见[材料输入](file-inputs.md)，JSON 格式边界见[结构化输出](structured-output.md)。产物必须是当前隔离工作树内本轮生成或变化的受支持文件。

拿到运行 ID 后保存它，用 `codex_cloud_status` 查询，建议间隔至少 5 秒；能力/状态/结果读取沿用后端每分钟 60 次的范围限制。终态完成后，分段取结果和文件。执行标记失败、待核对或取消不伪装成功；结果留存期限以能力和 `expiresAt` 为准。

提交响应丢失时，**仅用同一 `eventId` 与原输入恢复**，不要换新编号。既有 HTTP 客户端最多一次有限重试，提交始终保持同一键；后端持久记录负责去重。输入变化会冲突。MCP 进程关闭/重开不丢掉后端任务；没有本地队列需要恢复。

每个进程最多两个在途 HTTP 操作，单次 MCP 调用总等待 30 秒、单个 HTTP 尝试最多 10 秒，不在一个工具调用里持续轮询。客户端取消本地等候或断开不会自动调用云端取消；后台状态可能仍在运行，按运行 ID 或原事件编号核对。并发限制不是多个适配进程共享的模型配额，真正的并发/预算限制仍由后端执行。

错误以 `isError:true`、固定中文提示、错误代码和可用的 `httpStatus/runId/eventId` 返回；不透传原始异常、堆栈或鉴权信息。遇到 401/403 核对授权，409 核对原事件输入，410 说明交付过期；不要靠新建任务掩盖未知状态。

## 已验收与边界

采用固定官方 SDK `@modelcontextprotocol/server/client 2.3.1`，服务端和客户端为独立包；Zod 4.6.7 校验工具参数。实现依据：[官方 stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)、[工具与结果](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html)、[取消信号](https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation.html)。不自行实现 JSON-RPC 或协议握手。

测试使用真实 SDK 客户端和 stdio 子进程，并连接隔离的真实控制台后端核对持久任务、材料、完整结果、文件、跨调用方拒绝及原有模型调用次数。底层模型为替身，不消耗真实推理额度；这不证明生产令牌和真实模型业务闭环已验收。具体证据见[本轮验收](acceptance/2026-10-23-mcp-adapter.md)。

这不是远程 MCP HTTP/OAuth 服务、MCP 原生任务管理协议、资源订阅或文件系统工具；没有把适配器注册到当前 Codex 环境以免形成递归调用。Muse、Today、Grok Bot 的实际账号和 MCP 入口尚未核实，不能宣称已经接入这些产品。EC2 无需安装/启动新常驻服务，使用当前已兼容的 HTTP 后端即可。
