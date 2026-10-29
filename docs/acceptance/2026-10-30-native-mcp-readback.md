# CLI 0.165 的 MCP 只读接入验收

## 范围与结论

基于主线 `1b2f64d`，补 M3/A04.2 的真实 Codex 客户端读取链路：**CLI 0.165.0 → 本地 stdio 适配器 → 隔离的真实控制台后端 → 原任务和私有产物**。不改产品运行时代码、依赖、页面或 EC2，不注册到用户现用 Codex 配置，不重复已消费的生产令牌和模型授权。

后端沿用已有文件交付夹具，只有推理响应是替身；适配器、鉴权、任务存储、结果与文件交付均使用实际实现。原工作树报告先删除、后端先重启，再验证私有副本，而非绕开后端读取本地原文件。CLI 使用新建的无登录私有 HOME，模型地址固定到本机拒绝服务，实际模型请求为 0。

## 检查项

| 项目 | 实际核对 |
| --- | --- |
| 连接与配置 | 固定 CLI 实际版本必须为 0.165.0；TOML/stdin-stdout 连接，两台测试 MCP 服务均 connected；主调用方使用 `env_vars` 转发令牌 |
| 默认权限 | 仅五项读取工具，均标注只读；不包含 submit/cancel；强行调用提交返回明确的 `-32602 / Tool ... not found` |
| 状态与结果 | 读取原运行 ID、完成状态和用量；正文、结构化 JSON、原回合 ID、来源逐项比对既有清单 |
| 文件与图片 | 报告原始字节和 SHA-256 一致；PNG 作为原生 image 内容块返回，解码后的完整指纹一致，不只检查“有图片字段” |
| 归属与撤销 | 同自动化的另一个测试调用方读取原结果返回 404；撤销该测试令牌后，已建立连接的能力请求仍返回 401，无共享登录回退 |
| 重启 | 停止原生 CLI，重新启动并创建新临时线程，原运行正文及报告仍可读取；没有重新提交任务 |
| 无意外执行 | 本次只发送 thread/start、mcpServerStatus/list、mcpServer/tool/call；拒绝服务收到的模型请求 0；后端替身回合仍为原来的 2 次；任务文件字节和用户共享 CLI 配置指纹不变 |

本地首次在能力断言误用了 `automation.id`，实际接口为 `automation_id`；第二次误认为“不存在工具”会作为工具内容错误返回，实际 CLI 使用 JSON-RPC `-32602`。两次均是验收脚本错误，不是新增产品缺陷，原始失败日志保留。修正后先完整通过，再复验最终的环境变量转发配置；最终结果以对应提交的 CI 和私有回执为准。

本地完整回归为 402 项：399 通过、3 项 Linux 专属跳过，18 组 HTTP 集成流程通过。Linux CI 另含子进程组清理，用例组数为 19；本机回执解析首次误按 19 组断言已纠正，没有因此重跑原本成功的测试。新增原生 MCP 选择用例单独执行，不抬高原单元测试计数。

## 可重复检查

需要先按锁文件安装仓库依赖，并提供已经取得的 **0.165.0 官方 CLI** 绝对路径；不自动切换用户全局版本：

```sh
CODEX_MCP_NATIVE_CLI_BINARY=/absolute/path/to/codex \
CODEX_CLOUD_REGRESSION_CASE="independent clients retrieve private exact-turn files and images after native history and process restart" \
node scripts/verify-regressions.mjs
```

脚本复用 `verify-regressions.mjs` 的实际后端、Node/Python/SDK 交付检查，只增加原生客户端步骤，不另造队列或模拟 MCP 协议。不传二进制变量时，原有回归行为保持；CI 额外固定 npm CLI 0.165.0 运行这一个用例。自动生成的本地原始日志位于私有验收目录 `~/.codex/acceptance/native-mcp-readback-20261030-r1/`，不提交令牌和临时配置。

协议依据：[官方 App Server 的 MCP 目录与直接工具调用](https://learn.chatgpt.com/docs/app-server)、[官方 MCP TOML 与环境变量转发](https://learn.chatgpt.com/docs/extend/mcp)。用户接入步骤见 [MCP 说明](../mcp-integration.md#codex-cli-配置)。

## Review 与未覆盖

只增加一个复用现有夹具的检查模块、一个明确启用的调用入口及独立 CI 步骤。版本精确匹配，环境只提供测试 HOME/路径和虚构令牌，不复制真实登录；额外权限请求一律拒绝，结束时停止自有子进程，原共享配置只核对、不自动恢复或清理。

这是协议和后端交付验收，**不是模型自主选择工具、Codex App 的图片界面渲染、生产 MCP 令牌或 Muse/Today/Grok Bot 实际账号接入**。本轮没有界面变更，不新增桌面/手机截图结论，也不把协议 image 内容块称为实际页面展示成功。

M2 当前 CLI 的完整 Linux 命令边界仍在草稿 [PR #44](https://github.com/WilsonWang01/codex-cloud-console/pull/44) 中受阻：安装系统 bubblewrap 后仍未能执行探针，不能合并、放宽安全门禁或称沙箱已经通过。新的 EC2 限额检查及单条生产测试信任项清理仍待具体批准，不复用旧授权。生产运行中取消、生产回调、完整个人场景、实体手机、七天真实观察和用户评价仍按原门槛推进，goal 保持 active。
