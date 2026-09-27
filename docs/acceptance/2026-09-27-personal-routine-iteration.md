# 个人流程与线上可靠性验收

日期：2026-09-27。范围：上一轮外部操作可靠性版本的 EC2 发布，以及本轮个人可复用流程的开发、review 和验收。

## 已完成

- EC2 发布前确认严格健康检查通过，活动会话、压缩和自动化均为 0；状态、个人目录、环境文件和 systemd 单元的新备份归档已校验，SHA-256 为 `3e934c848214976a40764e6b86a790ff6b76d396d825811c5bccfccaf94d8d87`。Codex 历史、工作区、worktrees 均未被部署脚本覆盖。
- 可靠性版本 `ad602b9` 已原子发布到 `/home/ubuntu/codex-cloud/releases/console/20260927T144633Z-1831374`，严格健康为 `strictOk: true, partial: false`；旧发布保留供回退。会话状态文件 74,363 字节、自动化运行状态文件 2,867,657 字节，运行记录 200 条，部署前后相同。一次独立个人会话以 `gpt-6-sol / low` 做限时只读模型检查，返回 `READ_ONLY_OK`，未使用工具或修改第三方数据。
- 本轮个人流程支持创建、修改、归档和恢复，保存不触发模型；默认 `gpt-6-sol / medium`，仅手动运行，运行时先确认模型额度。外部 Webhook 不能触发用户自建流程；归档保留定义及既有运行记录，进行中或待核对时拒绝归档。
- “今日”显示最近的可复用流程入口；个人计划详情去掉重复的空间/运行方式卡片，直接展示任务内容与运行记录。样例自动化默认模型统一为 `gpt-6-sol / medium`，不迁移线上已有显式模型。

## 本地验收

- `npm run verify:local`、`npm run verify:personal:ui` 和 `git diff --check`：通过。存储测试覆盖 0600 权限、重启读取、并发编辑冲突、归档/恢复和无定时器；API 回归覆盖创建、修改、无额度确认拒绝、外部入口拒绝、归档与恢复。
- 浏览器模拟覆盖 320px 创建/编辑/运行确认/归档/恢复与“今日”入口，整页无横向溢出。截图位于 `docs/research/acceptance/personal-usage-2026-09-26/`，包括 `personal-routine-create-320.png` 和 `personal-routine-edit-320.png`。
- 这些模拟测试没有创建真实计划或调用模型；个人流程本身的 EC2 增量发布与真实 API 验收结果见后续记录。

## 对标复评

对照 [Muse](https://introducing.muse.ai/)、[Today](https://today.ai/articles/blog/what-is-today) 与 [Grok Bot Routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) 的公开说明，本轮补上了“重复使用已写好的个人任务”及更明确的手机入口，但**没有达到完整竞品对等**。仍缺：带时区、预算和错过运行策略的用户定时 Routine；邮件/日历变化的主动发现；可信第三方业务回执；真实手机弱网、通知送达与连续使用验收。下一步应先完成可审计的定时领取和去重，再考虑默认开启主动任务；不能仅添加定时开关便声称可靠的长期助理。
