# 个人计划无人值守审批验收（2026-09-28）

## 对标和边界

Muse 的官方安全说明把连接器动作交给独立权限裁决，并将具体授权直接交由用户处理；Codex app-server 官方文档确认应用工具可通过 `tool/requestUserInput` 请求批准。当前控制台没有 Muse 的独立连接器代理，不能把本轮改变称为同等级安全隔离。

- [Muse 安全设计](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [Codex app-server 审批流程](https://learn.chatgpt.com/docs/app-server)
- [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

## 本轮实现

- 个人定时运行的 app-server 请求在共享账号和专用 worker 两条路径进入同一审批入口后，立即拒绝命令、文件、MCP elicitation、权限扩大及工具输入请求，不进入人工待审批队列。
- 任何这类请求都会使该次定时运行失败；个人计划原有的失败暂停机制负责停止后续自动执行。交互式个人对话和人工试运行仍保留既有审批流程。
- 被拒绝的动作写入审计和会话进度。若同时检测到连接器写入，仍优先标记为待核对，而不是仅当作普通失败。

## 验收证据

- `npm run verify:approvals`：共享与专用回调均不进入待审批队列；命令请求立即拒绝，输入请求立即报错；普通交互会话仍走原审批代理。覆盖新版、旧版及 MCP elicitation 的拒绝响应形状。
- `npm run verify:local`：通过，包含 app-server 模拟回归、个人计划、自动化恢复及审批测试；未启动真实模型回合。
- `CODEX_CLOUD_SAFETY_UI_URL=http://127.0.0.1:5178/ npm run verify:personal:ui`：通过；`node --check server/index.mjs` 和 `git diff --check`：通过。
- 部署前与切换前均确认 EC2 没有活跃任务或运行。备份 `/home/ubuntu/codex-cloud/backups/pre-unattended-approval-20260928.tar.gz` 可列出内容，SHA-256 为 `9770464cf2ebf32ee91107bc6de2e5fc9c64bda1a870047b53067834707cfc48`。
- 发布 `e6fa827` 后，systemd 服务正常，严格健康检查为 `healthy: true`、`partial: false`、`appServer: true`；持久记录保持 200 条自动化运行、34 个会话，且没有活跃运行。此前的完整认证与会话备份仍保留。
- 通过只读 SSH 隧道检查线上 `#/automations/_personal`：320、390、1280 像素宽度下深链接和三个起步动作正常，无水平溢出、断线提示或浏览器报错。
- 本轮没有实际触发个人定时计划、模型回合或第三方动作；线上检查只证明部署健康和页面无明显回归，不证明真实审批回合的端到端行为。

## 未解决

- 这只拦截 app-server **主动请求批准**的工具动作。已被上游配置自动允许的连接器写入可能根本不发审批请求；现有 `readOnlyHint` 也只是工具提供的元数据。完整事前只读边界仍需在每个已启用工具的权限层验证，不能靠提示词、文件沙箱或事后检测代替。
- 不能仅凭模拟回归证明真实第三方服务的幂等性、动作回执或连续日常使用体验。当前没有 Muse、Today、Grok Bot 的登录态真实任务成功率对比。
