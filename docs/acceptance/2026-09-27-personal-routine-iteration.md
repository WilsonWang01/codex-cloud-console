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
- 个人流程版本 `112bf51` 已在第二次备份（`/home/ubuntu/codex-cloud/backups/pre-personal-routine-20260927T151218Z/state-personal-config.tar.gz`，SHA-256 `5ade2a8eefdfaaac66cf7f3e31980f1a81d84d2ec6edc6d0a78c16fb239653f9`）后发布到 `/home/ubuntu/codex-cloud/releases/console/20260927T151402Z-1836806`，严格健康通过。会话与自动化状态文件分别为 75,666 和 2,867,657 字节，自动化记录仍为 200，活动任务 0。
- 真实 EC2 的个人流程列表 API 返回空列表。非法创建请求返回 400，列表仍为空，未运行模型。经 SSH 本地转发的线上页面在 320px/1280px 均无横向溢出或页面异常；线上空列表截图暴露通用网格最小高度造成的大块空白，已补充移动端高度修正及模拟空态回归，待小版本复验。
- 浏览器/本地模拟测试没有创建真实业务计划或调用模型；线上尚未执行新流程的真实模型回合。

## 对标复评

对照 [Muse](https://introducing.muse.ai/)、[Today](https://today.ai/articles/blog/what-is-today) 与 [Grok Bot Routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) 的公开说明，本轮补上了“重复使用已写好的个人任务”及更明确的手机入口，但**没有达到完整竞品对等**。仍缺：带时区、预算和错过运行策略的用户定时 Routine；邮件/日历变化的主动发现；可信第三方业务回执；真实手机弱网、通知送达与连续使用验收。下一步应先完成可审计的定时领取和去重，再考虑默认开启主动任务；不能仅添加定时开关便声称可靠的长期助理。
