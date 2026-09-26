# GitHub Issue 开发工作流验收

## 本轮范围

- 工作项目按本地 Git `origin` 绑定 GitHub 仓库，核对主机 `gh` 登录、账号与仓库访问权限；个人空间无权进入工作项目的 Issue API。
- GitHub 页面可查看开放/已关闭 Issue、正文与评论。选择 Issue 后创建独立对话草稿，默认 `workspace-write` 与 `on-request`，不自动发送模型任务。
- PR 发布必须从匹配 Issue 编号的 `codex/issue-N` 分支发起；预览核对工作树、HEAD、默认分支、远端同名分支、提交摘要与文件清单，并颁发 5 分钟一次性确认凭据。发布时重新核对，不强推，失败后可重新预览。可能触发 GitHub Actions 的操作由用户在页面上明确确认。
- 账号授权在服务器的 GitHub CLI 中完成。网页不接收或保存 GitHub token；Codex 内的 GitHub App 连接不能替代主机 Git 授权。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run verify:local` | 通过，含构建、协议、安全、个人空间、自动化与 GitHub 单测 |
| `npm run verify:github-api` | 通过，伪造 `gh` 的真实 HTTP 路由验收；草稿持久化，错空间与无效发布被拒绝 |
| `npm run verify:github:ui` | 通过，桌面与 390px 移动端列表、详情、草稿、PR 确认、键盘焦点与无横向溢出；无真实模型调用 |
| `npm run verify:safety:ui` | 通过，原有跨项目、草稿、Review 与移动端回归 |
| `npm run verify:personal:ui` | 通过，原有个人/工作切换、审批、用量与移动端回归 |
| 真实 GitHub push / PR / Issue 修改 | 未执行，避免在验收中触发 CI、费用或修改远端仓库 |
| EC2 部署与已有任务迁移 | 未执行，需部署前备份并确认运行任务 |

## 边界

本轮支持用户选取 Issue 后让 Codex 完成分析、改代码、测试和本地 Git，再经预览确认发布 PR。它**不**会无人值守地扫描所有 Issue、自动发送模型任务、评论或关闭 Issue。GitHub Issue 正文被视作不可信资料；即使有提示词约束，仍应依靠工作区权限、审批和人工 Review 管控外部动作。现有工作项目共享本地 Git checkout；新建独立对话不是独立 worktree，启动前应确认没有其他任务或未提交改动。
