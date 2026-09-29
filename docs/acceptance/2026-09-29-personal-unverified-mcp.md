# 个人流程未声明只读的连接器动作验收（2026-09-29）

## 对标与范围

Muse 将连接器动作交给独立于 agent 的权限裁决；Today 强调外部发送、日历修改前由用户确认；Grok Bot 建议试运行、明确审批边界并在来源异常时停止。当前控制台还没有同等级的事前连接器权限层，本轮只处理一个可确定的漏洞：个人试运行和无人值守计划不能把缺少 `readOnlyHint` 的 MCP 调用当作已证实只读，并在后续继续自动运行。

- [Muse 安全设计](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [Today 个人助理](https://today.ai/articles/blog/what-is-today)
- [Grok Bot Skills 与 Routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)

## 实现与审查

- 工作会话保持原规则：仅明确 `readOnlyHint: false` 的 MCP 调用进入外部写入核对。个人试运行和无人值守计划额外将缺失或未知只读标记的 MCP 调用纳入待核对；明确 `true` 的调用仍视作只读。
- 个人流程发现需核对的调用开始时，记录动作并尝试中断回合。即使工具先于中断完成，终态仍为 `needs_reconciliation`，不能批准本次试运行或自动继续后续计划。已知写入与未知只读分别使用准确的错误描述。
- 没有新增连接器权限或自动执行入口；不改变普通交互式个人对话与工作会话的审批策略。Darwin 下安装器模拟测试的 `tar` 管道兼容仅限测试夹具，生产安装脚本未改变。

## 验收

- `npm run verify:local`、`npm run verify:external-action-review`、`npm run verify:personal-schedule`、`npm run verify:approvals`、`node --check server/index.mjs`、`git diff --check` 均通过。
- 模拟 app-server 回归覆盖无只读标记的个人试运行：记录 `turn/interrupt`、运行进入 `needs_reconciliation`、错误说明未知只读、人工批准试运行返回 409；原有明确写入回归保持通过。没有运行真实模型或第三方动作。
- `CODEX_CLOUD_SAFETY_UI_URL=http://127.0.0.1:18787/ npm run verify:personal:ui` 通过，覆盖个人/工作切换和移动端流程。只读打开实际本地代理的个人今日页，320、390、1280 像素均显示云端在线且无水平溢出；未点击会产生外部写入的控件。
- 发布前只读预检：EC2 严格健康 `strictOk: true`、`partial: false`，没有活跃任务或自动化运行；没有个人计划。此项不代表本轮后端已部署。

## 未解决

- `item/started` 是工具开始通知，不是独立的事前授权点。中断可能晚于外部动作，因此必须核对结果；不能宣称已阻止第三方写入。
- `readOnlyHint: true` 来自上游工具元数据，不是控制台独立验证的权限承诺。完整只读边界仍需可信连接器代理、凭据隔离及请求级策略；没有 Muse、Today、Grok Bot 的登录态真实任务成功率对比。
- 本轮尚未推送 GitHub 或更新 EC2。上线前仍须确认任务空闲、备份并校验、严格健康检查与失败回退。
