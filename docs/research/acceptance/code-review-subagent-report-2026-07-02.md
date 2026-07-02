# Code Review Subagent Report - 2026-07-02

审查目标：独立静态审查当前工作树，重点核对“app-server 是唯一事实源”的验收要求。未修改业务代码，未启动服务，未运行 smoke。

严重程度：P0 阻断验收；P1 高风险回归或数据/权限不可靠；P2 中风险可靠性缺口；P3 文档、运维或可见性风险。

## Findings

### 1. 本地 chat store 仍保存并生成会话、消息、runtime、token、goal、draft

- 严重程度：P0
- 文件:行号：server/index.mjs:24, server/index.mjs:333, server/index.mjs:548, server/index.mjs:600, server/index.mjs:909, server/index.mjs:998, server/index.mjs:7149, server/index.mjs:7224
- 问题：`chat-history.json` 仍是完整的本地会话库；`ensureChatSession` 可以在没有 app-server thread 的情况下创建/选择 session，`upsertAppServerThreads` 还把 app-server thread 合并进已有本地 session，并保留本地 messages/runtime/goal/token/draft。
- 影响：app-server 不是唯一事实源。active session、message history、title、runtime、draft、goal、token usage 可以由本地文件决定；重启、代理缓存或并发同步后，UI 可能显示 app-server 中不存在或已过期的 thread/session。
- 建议：将本地 chat store 降级为只读迁移缓存或彻底移除；会话创建、active 选择、草稿、runtime、goal、token usage 均通过 app-server API 读写。读取失败时返回明确错误，不创建本地 session，不返回 local session 作为成功结果。

### 2. turn/compact/job event 依赖进程内 Map 和自建 SSE，无法从 app-server 恢复

- 严重程度：P0
- 文件:行号：server/index.mjs:65, server/index.mjs:2216, server/index.mjs:2275, server/index.mjs:2369, server/index.mjs:2439, server/index.mjs:2502, server/index.mjs:2534, server/index.mjs:2619, server/index.mjs:2663, server/index.mjs:2699, server/index.mjs:7324, src/App.tsx:3847, src/App.tsx:4300, src/App.tsx:4774
- 问题：运行中 turn、compact、owner routing 和 notification fan-out 依赖 `activeTurns`、`activeCompactions`、`threadOwners`、`turnOwners`、`itemOwners` 等进程内结构，并通过 `/api/chat/job-events`、`/api/chat/stream`、`/api/codex/thread-compact/stream` 自建 SSE 推送。大量 app-server notification 只有找到本地 job 才会落到 UI 或本地 runtime。
- 影响：页面刷新、Node 重启、代理断开或 notification 先于 owner 记录到达时，token usage、goal、compact、diff、MCP progress、model reroute/verification 等事件会丢失。UI 可能把 inactive job 当作完成，无法从 app-server 的真实 turn 状态恢复。
- 建议：把 UI 订阅改为 app-server thread/turn 事件流或可重放事件日志；本地 job id 只作为传输层 correlation，不作为事实源。重连时按 app-server threadId/turnId 查询最新 turn/items/token/goal/compact 状态并重放缺口。

### 3. app-server 失败时仍可走本地文件、shell、chat mock fallback 并返回 ok

- 严重程度：P0
- 文件:行号：server/index.mjs:6300, server/index.mjs:6333, server/index.mjs:7406, server/index.mjs:7454, server/index.mjs:7484, server/index.mjs:7509, server/index.mjs:7527, server/index.mjs:7584, server/index.mjs:7606, server/index.mjs:7615, src/App.tsx:4650, src/App.tsx:4712
- 问题：`runShellCommand` 在 app-server `command/exec` 失败后直接执行本机 `/bin/bash -lc`；file tree/read/blob/write 在 app-server fs 失败后读写本地文件；chat 和 stream 在 repo path 缺失时生成 mocked success。
- 影响：读写和命令执行绕过 app-server 权限、审计、review/guardian、workspace boundary 和 event stream。UI 还会把 local-fallback 写入显示为“已写入云端工作区”，造成真实执行环境和用户认知不一致。
- 建议：生产路径禁用所有 local-fallback mutation；app-server 调用失败时返回 502/424 和 `source:"app-server-unavailable"`。仅在显式 dev/mock 模式允许 fallback，并要求 smoke 在任何 `mocked:true`、`source:"local-fallback"` 出现时失败。

### 4. thread-state/app-status 返回 partial/stale/local 数据但仍标记 ok，前端直接采信

- 严重程度：P1
- 文件:行号：server/index.mjs:3257, server/index.mjs:3312, server/index.mjs:3595, server/index.mjs:3646, server/index.mjs:3695, server/index.mjs:6763, src/App.tsx:3461, src/App.tsx:3616
- 问题：app status 和 thread state 会在超时或无 app-server thread 时返回 `ok:true` 的 partial/stale/local fallback，并混入本地 session runtime/goal/tokenUsage。`loadCodexAppStatus`、`loadThreadState` 不检查 `partial`、`cached`、`refreshing`、`source`，直接写入 UI 状态。
- 影响：token/context/compact/goal/model/permission/MCP/plugin 能力面板可能显示旧值或本地默认值，用户无法区分真实 app-server 状态和缓存/降级状态。
- 建议：API 层将 partial/stale/local fallback 设为非成功状态或强制暴露 `source`、`freshness`、`authoritative:false`；前端必须阻断关键操作并显示不可忽略的 degraded banner，不能把 fallback 写入 runtime/goal/token 的主状态。

### 5. 自动化运行状态是本地 store，console 重启会把 app-server 中仍运行的任务标失败

- 严重程度：P1
- 文件:行号：server/index.mjs:27, server/index.mjs:67, server/index.mjs:3790, server/index.mjs:3823, server/index.mjs:3889, server/index.mjs:5281, server/index.mjs:7792, ops/codex-cloud-console.service:18
- 问题：automation run 保存在 `automation-runs.json`，运行中状态保存在 `activeAutomationRuns`。`reconcileStaleAutomationRuns` 在 console 重启后会把本地 queued/running 且不在内存 Map 的 run 标为 failed，即使 app-server automation 仍在执行。systemd 配置 `Restart=on-failure` 会放大这个场景。
- 影响：自动化 inbox/run history 与 app-server 真实状态分叉；用户可能误判失败、重复触发任务，或丢失真实 thread/turn 结果。
- 建议：automation run lifecycle 由 app-server 持久化并查询；console 重启后应按 app-server runId/threadId reconciliate，而不是本地推断失败。`automation-runs.json` 只能作为展示缓存且必须带 `authoritative:false`。

### 6. review/diff 仍大量使用本地 git helper，应用操作绕过 app-server

- 严重程度：P1
- 文件:行号：server/index.mjs:6800, server/index.mjs:6807, server/index.mjs:6833, server/review-git.mjs:838, server/review-git.mjs:901, server/review-git.mjs:921, src/App.tsx:7971, src/App.tsx:7984, src/App.tsx:8027
- 问题：只有 `/api/codex/git-diff-to-remote` 调 app-server；review summary/snapshot/action/pr-comment/git-init 均传 `cwd` 到本地 `review-git`。`review-git` 直接运行 `git apply`、`git add`、`git restore`、`git clean`。
- 影响：review snapshot 和 apply/revert/stage 操作不受 app-server permission、file-change stream、guardian/review state 约束，可能与 app-server 正在看的 diff 不一致，也可能绕过用户审批。
- 建议：review/diff 全部走 app-server review/git capability；本地 git helper 仅保留离线开发模式。apply/revert/stage 必须由 app-server 返回 authoritative file changes 和 review state。

### 7. CLI session 列表和 WebSocket terminal 绕过 app-server，并默认 danger-full-access/approval never

- 严重程度：P1
- 文件:行号：server/index.mjs:7639, server/index.mjs:7691, server/index.mjs:7721, server/index.mjs:7744
- 问题：`/api/cli/sessions` 直接读取 `~/.codex/state_5.sqlite`，`/api/cli/terminal` 直接 spawn `codex --no-alt-screen --search --dangerously-bypass-approvals-and-sandbox`，并向用户声明 `danger-full-access, approval never`。
- 影响：session/thread 列表、runtime、token usage 和权限模型来自本机 CLI，不是 app-server。用户可以在同一 UI 中运行一个不受 app-server source-of-truth、permission profile、MCP/plugin 状态约束的 Codex。
- 建议：移除生产 CLI bypass，或将其明确隔离为“本机 CLI 调试模式”并默认禁用。resume/fork/session list 必须通过 app-server thread APIs。

### 8. session/project 边界仍可通过本地 mention 和默认 danger runtime 串线

- 严重程度：P1
- 文件:行号：server/index.mjs:54, server/index.mjs:6123, server/index.mjs:6129, server/index.mjs:6142, server/index.mjs:6161, server/index.mjs:6168
- 问题：默认 runtime 是 `sandbox:"danger-full-access"`、`approval:"never"`；`resolveFileMentions` 允许 `@project:<repo>` 把另一个 repo 的绝对路径作为 mention 注入当前会话，并用本地 `fs.stat` 判定路径存在。
- 影响：当前 session 的 thread params 仍绑定当前 repo，但 prompt inputs 可以携带其他项目路径；在 danger-full-access 下容易造成跨项目上下文泄漏、错误修改或审计归属混乱。
- 建议：跨项目 mention 必须由 app-server workspace/project API 授权并显式创建 multi-root context；默认 runtime 不应是 danger/never。UI 和 API 应在 threadId 层绑定 allowed roots，并禁止本地 fs 判定跨项目路径。

### 9. 本地代理缓存了 app-server 事实源端点，并可优先返回缓存

- 严重程度：P1
- 文件:行号：scripts/local-cloud-console-proxy.mjs:100, scripts/local-cloud-console-proxy.mjs:119, scripts/local-cloud-console-proxy.mjs:442, scripts/local-cloud-console-proxy.mjs:493, scripts/local-cloud-console-proxy.mjs:527, README.md:66
- 问题：local proxy 将 `/api/chat/active`、`/api/chat/sessions`、`/api/codex/app-status`、`/api/codex/models`、`/api/codex/thread-state`、`/api/codex/threads`、automation runs/inbox 等端点列为 cacheable，并在 TTL 内直接返回缓存、后台刷新；上游错误或截断时还可发送 stale cache。
- 影响：浏览器默认访问路径可能先看到缓存的 session/thread-state/model/automation 状态，而不是 app-server 当前状态。README 将该行为描述为稳定路径，容易让 stale cache 进入验收。
- 建议：事实源端点默认 `Cache-Control: no-store`，代理不得 fresh-cache-first。仅健康检查、静态配置可缓存；stale cache 必须只用于只读诊断并在 UI 中标红，不得写入主状态。

### 10. model/MCP/plugin/permission/account 状态混合硬编码、探测结果和内存 live state

- 严重程度：P1
- 文件:行号：server/index.mjs:71, server/index.mjs:3237, server/index.mjs:3257, server/index.mjs:3576, server/index.mjs:6650, server/index.mjs:6653, src/App.tsx:500, src/App.tsx:521, src/App.tsx:3439, src/App.tsx:3567, src/App.tsx:3602
- 问题：MCP OAuth results、account login flows、MCP startup/live events 存在内存；app-status 由多次 probe 组装并允许 fallback；models 路由在 `model/list` 失败时仍以 HTTP 200 返回硬编码 GPT-5.x 模型；前端还有独立 fallback model/status。
- 影响：model/context/permission/MCP/plugins/account 能力并非 app-server 单一事实，重启或 app-server 失败后 UI 仍可能展示可选模型、登录状态或 plugin/MCP 能力，随后 turn 执行失败或 reroute。
- 建议：model list、permission profiles、MCP/plugin/account 状态只接受 app-server authoritative 响应；失败时禁用相关控件并显示错误。live event 需可从 app-server replay 或按状态 API 重建，不能只存在内存。

### 11. app-server client 超时只删除本地 pending，不取消上游请求

- 严重程度：P2
- 文件:行号：server/codex-app-server-client.mjs:136, server/codex-app-server-client.mjs:146, server/codex-app-server-client.mjs:233
- 问题：`sendRequest` 超时后仅 `pending.delete(id)` 并 reject；未向 app-server 发送 cancel，也没有记录 orphaned request。子进程退出时会清 pending，但 server/index 的 job/cache/owner Map 不随之统一清理。
- 影响：app-server 可能继续执行已被 console 视为失败或超时的操作；后续 notification 找不到本地 job 或被当作未知事件，造成文件变更、turn 状态和 UI 输出不一致。
- 建议：增加协议级 cancellation/reconcile：超时后发送 cancel 或将 request 标记为 orphaned，并按 threadId/turnId 从 app-server 拉取最终状态。app-server child exit 时统一 invalidate 相关 cache/job/owner state。

### 12. app-server normalizer 会静默丢弃未知 item，缺时间戳时用当前时间

- 严重程度：P2
- 文件:行号：server/app-server-normalizers.mjs:9, server/app-server-normalizers.mjs:352, server/app-server-normalizers.mjs:363, server/app-server-normalizers.mjs:583, server/app-server-normalizers.mjs:586, server/app-server-normalizers.mjs:590
- 问题：`toIso` 在缺失或非法时间戳时返回 `new Date().toISOString()`；`itemMessages` 对未识别 item type 返回空数组。当前已手写覆盖部分 command/MCP/review/compact item，但没有 exhaustive schema guard。
- 影响：app-server 新增或未覆盖的 permission、review、diff、MCP、tool、context item 会从聊天历史中消失；历史 turn 的时间可能随每次读取变化，影响审计、排序和 smoke 复现。
- 建议：未知 item 必须保留为 structured fallback message，包含 raw type/status/id；缺时间戳应使用 thread/turn 原始时间或 null，不应伪造当前时间。为 app-server schema 增加 normalizer exhaustiveness 测试。

### 13. 前端 API/types 没有强制处理 ok/source/partial，导致 fallback 被写入主状态

- 严重程度：P2
- 文件:行号：src/App.tsx:917, src/App.tsx:3439, src/App.tsx:3616, src/types.ts:75, src/types.ts:248, src/types.ts:317
- 问题：`api<T>` 只检查 HTTP status，不检查 JSON `ok:false`、`source:"local-fallback"`、`partial`、`cached`。`ActiveCodexJob`、`ConsoleStatus`、`ChatSessionRuntime` 类型也没有把 authoritative/freshness/source 建模为必填字段。
- 影响：服务端以 200 返回的 fallback、partial 或 ok:false payload 会通过类型检查并进入 UI 主状态；调用方需要靠人工记忆检查每个 payload，容易漏掉。
- 建议：统一 API wrapper 校验 `{ok:true, authoritative:true, source:"app-server"}` 或显式返回 Result；类型层把 `partial/cached/source/authoritative` 作为事实源端点的必填字段，UI reducer 不接受 degraded payload 覆盖主状态。

### 14. smoke 测试没有把 partial/stale/mock/local-fallback 当作失败

- 严重程度：P2
- 文件:行号：scripts/smoke-api.mjs:8, scripts/smoke-api.mjs:55, scripts/smoke-api.mjs:82, scripts/smoke-api.mjs:117, scripts/smoke-api.mjs:151, scripts/smoke-ui.mjs:7, scripts/smoke-ui.mjs:35, scripts/smoke-ui.mjs:163
- 问题：API smoke 只检查 HTTP 成功、少量 shape 和 bad text；`repeatEndpoint` 统计 stale fallback 但不失败；thread-state 不检查 `partial/cached/source/fallbackError`。UI smoke 只查可见文本、布局和 slash command，不断言网络响应是否 authoritative。
- 影响：当前最关键的验收要求“app-server 是唯一事实源”没有被自动化覆盖；local-fallback、mocked success、stale cache、partial thread-state 都可能通过 smoke。
- 建议：新增 source-of-truth smoke：对所有事实源端点断言 `ok:true && authoritative:true && source:"app-server"`，且不存在 `mocked:true`、`partial:true`、`fallbackError`、`local-fallback`、stale proxy header。UI smoke 捕获网络响应并失败于 degraded payload。

### 15. README/ops 仍把 mock、本地缓存和非 app-server 修复路径写成正常操作面

- 严重程度：P2
- 文件:行号：README.md:16, README.md:23, README.md:43, README.md:66, README.md:106, ops/install-automation-runner.sh:14, ops/install-automation-runner.sh:18, docs/aws-instance-access.md:203
- 问题：README 明确说明路径/命令不可用时使用 local mock snapshot，并推荐会缓存 status/session read 的本地代理；自动化 runner 默认打到 `http://127.0.0.1:8787`，没有体现 webhook token 或 app-server-only 约束；AWS 恢复手册建议用控制台 terminal 做临时修复。
- 影响：文档和运维脚本会把 fallback/cache/terminal bypass 合法化，和“app-server 唯一事实源”的验收目标冲突，也会导致后续维护者继续依赖本地路径与 CLI。
- 建议：更新 README/ops：生产模式禁止 mock/cache-first/local terminal 修复；任何 fallback 只允许显式 dev 模式。自动化 runner 和恢复流程应以 app-server automation/thread APIs 为唯一入口，并说明 token/auth 要求。

### 16. ops/public 暴露面和通知跳转缺少事实源/安全边界约束

- 严重程度：P3
- 文件:行号：ops/Caddyfile:5, ops/Caddyfile:7, ops/Caddyfile:18, ops/codex-cloud-console.service:11, public/codex-cloud-sw.js:8, public/codex-cloud-sw.js:30, public/codex-cloud-sw.js:40, docs/aws-instance-access.md:7, docs/aws-instance-access.md:84, docs/aws-instance-access.md:185
- 问题：Caddy 允许 HTTP public IP 上通过 header token 反代 console，systemd 监听 `0.0.0.0`；service worker 可根据 push payload 的 `url` 打开任意绝对 URL；AWS 文档记录了实例 ID、公网 IP、账号、私钥路径等敏感运维信息。
- 影响：虽然不是 app-server 事实源核心 bug，但扩大了控制台和通知入口的攻击面。若 token、push payload 或仓库访问被滥用，用户可能被带到非 console 页面或暴露基础设施定位信息。
- 建议：公共入口强制 HTTPS，HTTP 只服务健康探针或重定向；push URL 限制同源 hash/path；敏感基础设施文档移出公开仓库或脱敏，并在部署文档中明确 console 只面向受控网络。

## 未覆盖风险

- 本报告为静态审查，未运行 `npm run verify:cloud`、`scripts/smoke-api.mjs`、`scripts/smoke-ui.mjs`，也未启动 app-server 验证 runtime 行为。
- 没有逐项对照 app-server 最新 schema；normalizer 缺口可能多于本报告列出的未知 item 丢弃问题。
- `src/styles.css` 已做关键词与关键区域检查，未发现独立于 `src/App.tsx` 的事实源逻辑缺陷；后续若新增 degraded/source badge，需要再做视觉 QA。
