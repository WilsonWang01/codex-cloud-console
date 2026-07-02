# 云端 Codex CLI / Codex App 对齐控制台 E2E 验收报告

验收日期：2026-07-02（Asia/Hong_Kong；云端 API 时间戳多为 UTC 2026-07-01）
入口：http://127.0.0.1:18787/
工作目录：`/Users/xiaoxin/Documents/codex_cloud`
验收方式：只读代码/文档检查、启动态 API 探测、自带 smoke/build、Playwright 黑盒 UI、少量真实 app-server turn/goal/compact 操作。

## 总结

结论：不算花架子，核心云端 Codex app-server 链路真实可用；但还不能称为完全对齐 Codex App 的稳定 session/thread 控制台。主要风险集中在会话身份和 active session 事实源：UI 新建草稿 session、app-server canonical thread、`activeByRepo`、读接口 fallback 之间仍有短暂或隐式错位。

P0：未发现。

P1：1 个核心问题，需要优先修。

P2：4 个可用性/一致性问题，建议后续修。

## 已运行验证

- 读取项目文档和验收资料：
  - `README.md`
  - `docs/research/codex-cloud-gap-plan.md`
  - `docs/research/acceptance/acceptance-report-2026-07-01.md`
  - `scripts/smoke-api.mjs`
  - `scripts/smoke-ui.mjs`
  - 未找到 `docs/codex-cloud-plan.md` 或根目录 `codex-cloud-plan.md`。
- `curl http://127.0.0.1:18787/healthz`：200，app-server running，Codex ChatGPT subscription 已登录，4 个 repo health 可读。
- `npm run verify:api`：通过，10 轮重复 endpoint 无失败。
- `npm run verify:ui`：通过，桌面/移动核心页无 loading dead state、无横向溢出、slash 菜单可打开。
- `npm run codex:schema:check && npm run build`：通过，schema up to date，Vite build 成功。
- `CODEX_CLOUD_SMOKE_REPEAT=30 npm run verify:api`：通过；`chat sessions` 30 轮最高 28ms，`chat active` 最高 1521ms，`thread state` 最高 43ms，无 stale fallback。
- `CODEX_CLOUD_SMOKE_UI_WAIT_MS=3000 npm run verify:ui`：通过；3 秒等待下桌面/移动核心页均无加载死态。
- 追加稳定性 20 轮：
  - `/healthz`、`/api/status`、invest/macro sessions、active、thread-state 均 0 失败。
  - macro sessions 最高 1894ms；未复现 E2E 中一次 502。
- Playwright E2E：
  - 打开 project、session 空状态、slash menu、status/model/reasoning/permissions 面板。
  - 上传小文件。
  - 真实发送短消息到云端 Codex。
  - 验证 official `thread/read` 返回 `ACCEPTANCE_E2E_20260702_OK`。
  - 设置/读取/清除 goal。
  - 主动 compact 成功并返回 token usage。
  - 切换到 macro project 验证不显示 invest 验收 marker。
  - 验证 390px 移动端项目页和 slash menu。

## 关键证据

- 真实 app-server thread：`019f1f09-efba-7951-9423-a002c1aa51e9`
- 对应 session：`app-019f1f09-efba-7951-9423-a002c1aa51e9`
- 验收消息：
  - user：`只回复 ACCEPTANCE_E2E_20260702_OK，不要执行命令，不要读取附件。`
  - assistant：`ACCEPTANCE_E2E_20260702_OK`
- 上传文件已进入云端 repo path：
  - `.codex-cloud/uploads/2026-07-01/1782932172357-eedc1c-e2e-subagent-upload-2026-07-02.txt`
- compact 后 token usage：
  - `18071 / 258400`，UI 显示约 `7% ctx`
- Goal：
  - `thread/goal/set` 返回 `status:"active"`，随后 `thread-state` 可读，`thread/goal/clear` 成功。

证据文件：

- `docs/research/acceptance/data/e2e-subagent-evidence-2026-07-02.json`
- `docs/research/acceptance/data/e2e-subagent-api-supplement-2026-07-02.json`
- `docs/research/acceptance/data/e2e-subagent-stability-2026-07-02.json`
- `docs/research/acceptance/data/e2e-subagent-final-thread-2026-07-02.json`

## 截图

- `docs/research/acceptance/screenshots/2026-07-02-01-invest-project-desktop.png`
- `docs/research/acceptance/screenshots/2026-07-02-02-session-search-empty-state.png`
- `docs/research/acceptance/screenshots/2026-07-02-03-slash-command-menu.png`
- `docs/research/acceptance/screenshots/2026-07-02-04-status-token-goal-compact-panel.png`
- `docs/research/acceptance/screenshots/2026-07-02-05-model-panel.png`
- `docs/research/acceptance/screenshots/2026-07-02-06-reasoning-panel.png`
- `docs/research/acceptance/screenshots/2026-07-02-07-permissions-panel.png`
- `docs/research/acceptance/screenshots/2026-07-02-08-new-session-before-send.png`
- `docs/research/acceptance/screenshots/2026-07-02-09-upload-chip.png`
- `docs/research/acceptance/screenshots/2026-07-02-10-turn-running-or-queued.png`
- `docs/research/acceptance/screenshots/2026-07-02-12-status-after-goal-clear-compact.png`
- `docs/research/acceptance/screenshots/2026-07-02-13-macro-project-isolation.png`
- `docs/research/acceptance/screenshots/2026-07-02-14-mobile-project.png`
- `docs/research/acceptance/screenshots/2026-07-02-15-mobile-slash-menu.png`
- `docs/research/acceptance/screenshots/2026-07-02-16-active-e2e-thread-complete.png`

备注：`2026-07-02-11-turn-complete.png` 拍早了，只能证明 turn 已启动，不作为最终完成证据；最终完成以 `16-active-e2e-thread-complete.png` 和 `thread/read` 为准。

## P0 Findings

无。

## P1 Findings

### P1-1 会话身份与 active session 仍会错位，读接口会静默回落到别的 session

复现步骤：

1. 打开 `#/project/invest-dashboard`。
2. 点击当前项目会话栏的“新会话”。
3. 上传 `e2e-subagent-upload-2026-07-02.txt`。
4. 发送 `只回复 ACCEPTANCE_E2E_20260702_OK，不要执行命令，不要读取附件。`
5. UI 路由进入草稿 session：`/thread/sess-mr2fs4n1-3c86d97d`。
6. 直接请求：
   - `/api/chat/history?repoId=invest-dashboard&sessionId=sess-mr2fs4n1-3c86d97d`
   - `/api/codex/thread-read?repoId=invest-dashboard&sessionId=sess-mr2fs4n1-3c86d97d`
   - `/api/chat/active?repoId=invest-dashboard&sessionId=missing-session-id-for-e2e`

证据：

- UI 发送时草稿 session id 是 `sess-mr2fs4n1-3c86d97d`，见 `2026-07-02-10-turn-running-or-queued.png`。
- official app-server thread 后来变成 `app-019f1f09-efba-7951-9423-a002c1aa51e9`。
- 在 E2E 初次补查时，用草稿 session id 读 history/thread-state/thread-read，接口返回了旧 active thread `019f1ebd-b272-78f0-a699-ea43601022a9`，不是报错，也不是新 thread。
- 稍后状态收敛后，同一个草稿 session id 又会解析到 canonical app thread；这说明行为依赖当前 active/cache 状态。
- 请求明显不存在的 `missing-session-id-for-e2e` 也返回 200，而不是 404。

影响：

这是高风险的一致性问题。用户或自动化脚本带着一个 session id 读/写时，可能被静默导向另一个 thread；goal、compact、archive、runtime 修改都有可能落在错误会话。对云端常驻 agent 来说，这比单纯 UI 显示错更危险。

建议修复方向：

- `sessionId` 显式传入时必须 exact match；找不到就返回 404/409，不要 fallback 到 active session。
- 草稿 session id 发送成功后，服务端返回 canonical `app-*` session id 和 thread id；前端立即替换 URL、active session 和本地列表项。
- 如需兼容草稿 id，建立明确 alias 表：`draftSessionId -> appSessionId`，响应中返回 `canonicalSessionId`，并禁止 alias 指向 unrelated active thread。
- 将 `activeByRepo` 更新与 `turn/start` 创建 official thread 放在同一事务/同一状态更新路径。

## P2 Findings

### P2-1 上传入口真实可用，但持久化后的附件退化成路径文本

复现步骤：

1. 新建会话并通过上传按钮选择 `e2e-subagent-upload-2026-07-02.txt`。
2. 发送消息。
3. 刷新并读取 official thread。

证据：

- 上传前 UI chip 可见：`2026-07-02-09-upload-chip.png`。
- 发送后的 official user message 只包含：
  - `上传文件路径:`
  - `.codex-cloud/uploads/.../e2e-subagent-upload-2026-07-02.txt`
- `thread/read` 归一化消息的 `attachments` 为空。
- 完整截图：`2026-07-02-16-active-e2e-thread-complete.png`。

影响：

上传不是假按钮，文件确实进入云端工作区；但刷新后缺少 Codex App 风格的持久附件对象、缩略图、文件大小和下载/预览入口。截图/图片上传在长会话里容易变成不可视的路径文本。

建议修复方向：

- 将上传 metadata 和 app-server input 关联保存到 session/thread item。
- 刷新历史时从本地 upload store 或 official item metadata 恢复 `MessageAttachments`。
- 图片附件应保留缩略图；普通文件保留文件名、大小、路径和下载/打开入口。

### P2-2 token usage 在普通 turn 后不一定立即可用，compact 后才收敛

复现步骤：

1. 新建会话并发送一条短消息。
2. 请求 `/api/codex/thread-state?repoId=invest-dashboard&sessionId=app-019f1f09-...`。
3. 再执行 `/api/codex/thread-compact` 后重复读取。

证据：

- 新 thread 普通 turn 后 `thread-state.tokenUsage` 曾为 `null`。
- compact 后 token usage 变为：
  - `totalTokens: 18071`
  - `modelContextWindow: 258400`
- UI 最终显示 `7% ctx`。

影响：

context/token 状态是真能力，但普通 turn 完成后可能有窗口期显示空值或旧值。用户刚发完消息时看到的上下文比例可能不可信。

建议修复方向：

- 从 `turn/completed.tokenUsage` 或 `thread/tokenUsage/updated` 事件即时更新 thread-state cache。
- 若没有 token usage，UI 应显示“等待 token 更新”而不是沿用别的 thread 或空状态。

### P2-3 MCP/插件展示是真实状态，但部分能力当前不可用

复现步骤：

1. 打开设置页或请求 `/api/codex/app-status?repoId=invest-dashboard`。
2. 查看 MCP server auth 状态。

证据：

- `cloudflare-api`：`authStatus:"notLoggedIn"`。
- `notion`：`authStatus:"notLoggedIn"`。
- `codex_apps`：`authStatus:"bearerToken"`，`toolCount:167`。
- appHost `stderrTail` 仍有 Cloudflare/Notion OAuth `invalid_token` 错误。
- UI 收件箱显示 2 条 MCP 需要登录。

影响：

MCP/插件列表不是花架子，它读取了真实 app-server 能力；但“插件 7 已启用 / 180 可用”不等于所有工具可用。Cloudflare、Notion 相关工作流会卡在登录前。

建议修复方向：

- 在能力面板里把“已安装/已启用”和“可实际调用”分开。
- optional MCP 登录失败应保留在 attention/inbox，不应污染全局“云端 Codex 在线”判断。
- 对每个 MCP 展示 authStatus、toolCount 和下一步登录动作。

### P2-4 连接稳定性总体合格，但曾观察到一次 session 502，应补请求级诊断

复现步骤：

1. Playwright E2E 中切到 `macro-control-dashboard` 后请求 `/api/chat/sessions?repoId=macro-control-dashboard`。
2. 随后重复稳定性测试。

证据：

- E2E 过程中出现一次 `macro-control-dashboard` sessions 502，body 为空。
- 后续 20 轮 macro sessions 0 失败，最高 1894ms。
- `CODEX_CLOUD_SMOKE_REPEAT=30 npm run verify:api` 通过。

影响：

这次 502 不稳定复现，不能判定为 blocker；但空 body 502 对用户和验收脚本都很难定位是本地代理、EC2、app-server 还是 repo sync 抖动。

建议修复方向：

- 对所有 5xx 返回 JSON `{ok:false,error,layer,requestId}`。
- 在 session sync/read 路径加入 request id、repo id、app-server method、cache/fallback 标记。
- 前端对一次性读取失败保留旧 session 列表并显示“同步失败，可重试”，不要清空。

## 真实可用能力

- 本地 18787 入口可达，代理和云端 app-server 在线。
- Codex 登录是真实 ChatGPT subscription。
- project 列表真实来自云端 workspace，repo health 可读。
- session 列表按 repo 隔离；macro 页面没有显示 invest 的 E2E marker。
- 新建会话、发送消息、app-server `thread/read`、turn 完成真实可用。
- `/` 指令菜单真实可打开，包含状态、会话、模型、推理、权限、MCP、插件、goal、compact、review、diff。
- 模型/推理/权限展示真实来自配置：`gpt-5.5`、`medium`、`danger-full-access + approval never`。
- goal set/read/clear 可用。
- compact 可用，并会产生 context compaction timeline item。
- 文件上传入口可用，文件真实保存到云端 repo upload 目录。
- 移动端 390px 响应可用，无横向溢出。
- session 搜索空状态、上传错误 400 等基础错误/空状态存在。

## 花架子或半成品感较强的能力

- “新会话”在 UI 上先是草稿 id，app-server canonical id 后置替换；这个过程还会让 API active/sessionId 解析混乱。
- 显式传错 session id 不报错，而是 fallback 到当前 active/canonical session；这是最不像 Codex App session model 的地方。
- 上传后的 rich attachment 只在 composer/chip 阶段完整，刷新后的 official timeline 主要是路径文本。
- token/context 在普通 turn 后可能为空，compact 后才稳定。
- MCP/插件数量展示很完整，但 Cloudflare/Notion 等未登录前不能实际使用。

## 其他观察

- UI 视觉整体已经比普通仪表盘更接近 Codex App：左侧 project/session rail、主对话、底部 composer、footer runtime chips 都能工作。
- 自动化/inbox/settings 页面通过 smoke；本轮未触发真实自动化 run，避免改远端工作区。
- 本轮没有修改源码；只新增验收报告、evidence JSON、截图和一个本地验收上传文本文件。真实 UI 上传会在云端 `invest-dashboard` 工作区留下 `.codex-cloud/uploads/...` 验收文件。
