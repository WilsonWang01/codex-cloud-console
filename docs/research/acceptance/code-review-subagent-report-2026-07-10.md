# Code Review Subagent Report - 2026-07-10

结论：不通过代码质量验收。当前构建和基础 UI smoke 通过，但 `npm run verify:api` 在现有验收入口上失败，原因是 `/api/chat/sessions` 返回 `ok:true` 但 `source:"local-draft"`、`authoritative:false`。这不是纯测试抖动，而是当前本地 session cache 仍可压过 app-server active session 的实际行为。线上风险集中在：会话事实源混合、process-local job/event 生命周期、automation webhook 鉴权配置、automation run 本地持久化、以及健康状态缓存造成的错误信心。

## 审查范围

- 指定文件：`README.md`、`package.json`、`server/index.mjs`、`server/codex-app-server-client.mjs`、`server/app-server-normalizers.mjs`、`src/App.tsx`、`src/styles.css`、`scripts/smoke-api.mjs`、`scripts/e2e-frontend.mjs`、`ops/codex-cloud-console.service`、`ops/Caddyfile`。
- 补充读取：`scripts/local-cloud-console-proxy.mjs`，因为本次现场验证走 `http://127.0.0.1:18787/`，该代理直接影响健康状态可信度。
- 既有报告：`docs/research/acceptance/code-review-subagent-report-2026-07-02.md`、`docs/research/acceptance/e2e-subagent-report-2026-07-02.md`、`docs/research/acceptance/acceptance-synthesis-2026-07-02.md`、`docs/research/frontend-e2e-verification.md`。
- 当前 git diff：审查开始时工作树无 diff；审查结束后除本报告外无生产代码 diff。

## 执行命令

- `git status --short`：通过，初始无输出。
- `git diff --stat`、`git diff -- README.md package.json server/index.mjs server/codex-app-server-client.mjs server/app-server-normalizers.mjs src/App.tsx src/styles.css scripts/smoke-api.mjs scripts/e2e-frontend.mjs ops/codex-cloud-console.service ops/Caddyfile`：通过，无输出。
- `node --check server/index.mjs`：通过。
- `node --check server/codex-app-server-client.mjs && node --check server/app-server-normalizers.mjs && node --check scripts/smoke-api.mjs && node --check scripts/e2e-frontend.mjs`：通过。
- `npm run verify:normalizers`：通过，覆盖 `unknown-item-fallback`、`stable-null-time`、`known-item-time`、`upload-path-attachment`。
- `npm run codex:schema:check`：通过，schema up to date。
- `npm run build`：通过，`tsc -b && vite build` 成功。
- `git diff --check -- README.md package.json server/index.mjs server/codex-app-server-client.mjs server/app-server-normalizers.mjs src/App.tsx src/styles.css scripts/smoke-api.mjs scripts/e2e-frontend.mjs ops/codex-cloud-console.service ops/Caddyfile`：通过。
- `npm run verify:api`：失败。`chat sessions had 10/10 failed attempts`，命中 `"authoritative":false`。
- 现场探测 `http://127.0.0.1:18787/healthz`、`/api/status`、`/api/chat/sessions?repoId=invest-dashboard`、`/api/codex/app-status?repoId=invest-dashboard`、`/api/codex/thread-state?repoId=invest-dashboard`：`healthz/status` 为 fresh proxy cache；`app-status/thread-state` 为 app-server authoritative；`chat/sessions` 为 `source:"local-draft"`、`authoritative:false`。
- `npm run verify:ui`：通过，桌面/移动基础页面、slash menu、无横向溢出、无 unnamed button 检查通过。
- 未运行 `npm run verify:e2e`：该脚本会写 `docs/research/acceptance/frontend-e2e/<run-id>/` 下的 trace、截图和 JSON，违反本轮“只允许新增/更新一个报告文件”的约束。

## Findings

### P1-1 `/api/chat/sessions` 仍会被本地 active session 降级，且前端直接采信

- 文件:行号：`server/index.mjs:428`、`server/index.mjs:433`、`server/index.mjs:1075`、`server/index.mjs:1103`、`server/index.mjs:1118`、`server/index.mjs:1124`、`server/index.mjs:7661`、`server/index.mjs:7696`、`server/index.mjs:7702`、`server/index.mjs:7703`、`src/App.tsx:3708`、`src/App.tsx:3710`、`src/App.tsx:3725`、`src/App.tsx:3727`。
- 证据：`npm run verify:api` 在 `chat sessions` 重复检查中 10/10 失败，原因是响应包含 `"authoritative":false`。现场响应为 HTTP 200、`ok:true`、`sessionListSource:"app-server"`、`sessionListAuthoritative:true`，但整体 `source:"local-draft"`、`authoritative:false`，active session 是 `sess-mre9wxot-e507169c`，标题为 `Automation: 投资监控每日完成度检查`，没有 `codexSessionId`。
- 问题：`chooseRepoActiveSessionId` 会保留非空本地 active session；`getRepoSessions` 即使刚完成 app-server thread/list sync，仍从 `chat-history.json` 选择 active；`/api/chat/sessions` 因 active 没有 app-server thread，把整个响应降级为 `local-draft`。前端 `loadChatHistory` 不校验 `source`/`authoritative`，直接写入 `chatSessions`、`activeSessionId`、`chatMessages`。
- 影响：用户和自动化会看到一个本地 automation session 成为当前会话，即使 app-server 会话列表是权威的。后续 goal/compact/review/turn 控件可能针对一个没有 app-server thread 的本地 session 表现为不可用、隐式新建 thread，或显示与真实云端会话不一致的状态。最直接的线上结果是当前 `verify:api` 已失败。
- 建议：普通 session 列表读必须只返回 app-server authoritative active；本地 automation/draft session 只能在显式创建、编辑 draft、或带 `preserveLocalActive=1` 的内部写路径中保留。前端 `loadChatHistory` 应拒绝 `authoritative:false` 的正常读，显示 degraded banner，而不是写入主状态。

### P1-2 webhook token 在生产反代下是可选配置，且 token 支持 query/body 泄漏

- 文件:行号：`server/index.mjs:5486`、`server/index.mjs:5491`、`server/index.mjs:5493`、`server/index.mjs:5495`、`server/index.mjs:5498`、`server/index.mjs:5501`、`server/index.mjs:5504`、`server/index.mjs:5505`、`server/index.mjs:5514`、`server/index.mjs:5518`、`server/index.mjs:5519`、`ops/Caddyfile:16`、`ops/Caddyfile:18`、`ops/Caddyfile:21`。
- 问题：`validateAutomationTrigger` 在没有 `CODEX_CLOUD_WEBHOOK_TOKEN` 时，生产环境允许 loopback 请求。Caddy 反代到 `127.0.0.1:8787`，Node 侧看到的远端通常就是 loopback。因此一旦 webhook token 未配置，所有通过 Caddy Basic Auth 的请求都能触发 automation webhook/heartbeat。代码还接受 `?token=` 和 `body.token`，这些值容易进入代理日志、浏览器历史、错误报告或审计 dump。请求 body 还能覆盖 `prompt/model/reasoning/sandbox/approval`，默认 runtime 又是 `danger-full-access` + `never`。
- 影响：这是配置即安全边界的高风险设计。Basic Auth 凭据和 webhook token 的权限无法分离；误配 token 时，外部调用者可启动全权限、不询问的 Codex run。query token 还会扩大泄漏面。
- 建议：生产环境强制要求 `CODEX_CLOUD_WEBHOOK_TOKEN`，缺失时 webhook/heartbeat 必须 503 fail closed。只接受 `x-codex-cloud-token`，移除 query/body token 和 README 中的 Bearer 推荐。对 webhook 加 idempotency key、速率限制、最小权限 runtime allowlist，并默认拒绝外部覆盖 `sandbox/approval`。

### P1-3 turn/compact/job event replay 仍是 process-local，app-server 超时后无取消/恢复闭环

- 文件:行号：`server/index.mjs:73`、`server/index.mjs:76`、`server/index.mjs:2149`、`server/index.mjs:2162`、`server/index.mjs:2388`、`server/index.mjs:2397`、`server/index.mjs:2459`、`server/index.mjs:2482`、`server/index.mjs:2487`、`server/index.mjs:7589`、`server/index.mjs:7593`、`server/index.mjs:7915`、`server/index.mjs:7921`、`server/index.mjs:7933`、`server/codex-app-server-client.mjs:153`、`server/codex-app-server-client.mjs:156`、`server/codex-app-server-client.mjs:164`、`server/codex-app-server-client.mjs:225`。
- 问题：运行中 turn/compact、owner routing、SSE event history 都存在进程内 `Map`/`EventEmitter`。`/api/chat/job-events` 找不到本地 job 时明确返回 `source:"process-local"`、`eventReplay:false`。`turn-interrupt` 只查 `activeTurns`。app-server client 请求超时只删除 pending 并记录 orphan，未向 app-server 发 cancel，也没有强制重启、按 thread/turn reconcile，late response 只标记 orphan。
- 影响：Node 重启、app-server 卡住、页面重连、或者 notification 在 owner map 记录前到达时，UI 无法恢复真实 running turn 的事件、token/goal 更新和打断能力。app-server 可能继续执行已被 console 判失败/超时的操作；用户看到“无运行任务”，但后端实际仍在改文件或跑命令。
- 建议：事件流应改为 app-server durable/replayable turn state；本地 job id 只做传输 correlation。超时要么调用协议级 cancel，要么把 threadId/turnId 标记为 orphaned 并轮询 app-server 最终状态。`turn/interrupt`、`turn/steer` 应能按 app-server active turn 查询，而不是只依赖 process map。

### P1-4 automation run 生命周期仍是本地 JSON，不是可恢复的 app-server run 状态

- 文件:行号：`server/index.mjs:29`、`server/index.mjs:75`、`server/index.mjs:4053`、`server/index.mjs:4063`、`server/index.mjs:4088`、`server/index.mjs:4119`、`server/index.mjs:4122`、`server/index.mjs:4128`、`server/index.mjs:5512`、`server/index.mjs:5562`、`server/index.mjs:5564`、`server/index.mjs:5576`、`server/index.mjs:8497`、`server/index.mjs:8506`。
- 问题：automation run 存在 `automation-runs.json`，运行中状态存在 `activeAutomationRuns`。重启后本地 queued/running 且不在内存 Map 的 app-server run 被标成 `interrupted`，只是比旧版 `failed` 更诚实，但仍不是从 app-server run 状态恢复。`/api/automations/runs` 声明 source 为 `local-run-store+app-server-thread-verification`，验证的是 recent thread 可读，不是 automation lifecycle 权威。
- 影响：外部系统把 webhook 当作任务队列时，无法可靠区分 running、completed、interrupted、unknown。重启或 app-server 子进程卡住时，任务可能实际仍在执行，但 API 已显示 interrupted；调用方可能重复触发，造成重复 worktree、重复提交、重复通知。
- 建议：引入 durable run record 和 idempotency key；run 状态以 app-server thread/turn 最终状态为准，console 重启后按 runId/threadId/turnId rehydrate。`interrupted` 只能作为 `unknownNeedsReconcile`，不能作为终态。

### P2-1 `/healthz` 和本地代理缓存会制造“云端在线”的错误信心

- 文件:行号：`server/index.mjs:6994`、`server/index.mjs:6999`、`server/index.mjs:7003`、`server/index.mjs:7007`、`server/index.mjs:7008`、`scripts/local-cloud-console-proxy.mjs:129`、`scripts/local-cloud-console-proxy.mjs:138`、`scripts/local-cloud-console-proxy.mjs:143`、`scripts/local-cloud-console-proxy.mjs:165`、`scripts/local-cloud-console-proxy.mjs:171`、`scripts/local-cloud-console-proxy.mjs:495`、`src/App.tsx:3185`、`src/App.tsx:3191`。
- 证据：现场 `/healthz` 和 `/api/status` 返回 `x-codex-cloud-cache: fresh-proxy; saved-at=2026-07-10T10:53:10...`，UI smoke 也显示“云端 Codex 在线”。但这两个端点允许代理在 8 秒 TTL 内先回缓存并后台刷新；服务端 `/healthz` 在 partial reachable 时也会返回 HTTP 200，并把 `ok` 改为 true、另加 `strictOk/partial`。
- 影响：EC2 停机、app-server 卡住、或者上游刚断开时，用户可能先看到“在线”。运维判断会偏乐观；smoke 如果只看 HTTP 200 或 `ok:true` 会漏掉 partial/stale。
- 建议：部署验收和 UI 刷新使用 `?force=1` 或 `sync=1` 绕过代理缓存；`/healthz` 保留 `health.ok` 原义，不要把 partial 改成 ok true。UI 顶层状态必须显示 `strictOk:false`、`partial:true` 和 proxy cache age。

### P2-2 README 的外部 webhook 示例和 Caddy Basic Auth 冲突

- 文件:行号：`README.md:146`、`README.md:151`、`README.md:152`、`ops/Caddyfile:18`、`ops/Caddyfile:21`、`server/index.mjs:5493`。
- 问题：README 推荐 `Authorization: Bearer $CODEX_CLOUD_WEBHOOK_TOKEN`，但生产入口被 Caddy Basic Auth 包住，外部调用通常还需要 `Authorization: Basic ...`。同一个请求无法同时用一个 Authorization header 承载 Basic 和 Bearer；虽然服务端支持 `x-codex-cloud-token`，README 没把它写成主路径。
- 影响：第三方服务照 README 接入会 401 或 webhook 401；为排查问题可能改用 `?token=`，进一步放大 token 泄漏风险。
- 建议：README 示例改为 `curl -u "$CODEX_CLOUD_BASIC_USER:$CODEX_CLOUD_BASIC_PASSWORD" -H "x-codex-cloud-token: $CODEX_CLOUD_WEBHOOK_TOKEN"`，并明确不要使用 query token。

### P2-3 app-status 对非关键能力失败仍可返回 authoritative，权限列表有硬编码 fallback

- 文件:行号：`server/index.mjs:3301`、`server/index.mjs:3304`、`server/index.mjs:3310`、`server/index.mjs:3312`、`server/index.mjs:3315`、`server/index.mjs:3318`、`server/index.mjs:3319`、`server/index.mjs:3320`、`server/index.mjs:3323`、`src/App.tsx:8866`、`src/App.tsx:8912`。
- 问题：`permissionProfile/list` 属于 capability warning，不在 failed critical keys 里；失败时会返回硬编码 `read-only/workspace-write/danger-full-access`，整体仍可能 `source:"app-server"`、`authoritative:true`。现场 app-status 也有 `capabilityWarnings`，但 UI 仍把能力面板当作可用能力展示。
- 影响：用户看到的 permission/profile 选项可能不是 app-server 实际支持面。对一个远程控制台来说，权限模式是安全边界，不应当在 provider/permission API 失败时硬编码成“权威”。
- 建议：permission profiles 失败应使 `partial:true` 或至少为 permission 子树单独标 `authoritative:false`，UI 禁用权限切换并显示原因。

### P2-4 `verify:ui` 无法覆盖数据权威性，导致“绿 UI / 红 API”的验收分裂

- 文件:行号：`scripts/smoke-api.mjs:163`、`scripts/smoke-api.mjs:235`、`scripts/smoke-api.mjs:239`、`scripts/smoke-api.mjs:252`、`src/App.tsx:3708`、`src/App.tsx:3710`、`src/App.tsx:3725`、`src/App.tsx:3727`。
- 证据：本轮 `npm run verify:api` 失败；`npm run verify:ui` 同时通过，并且 UI 样本文案仍显示正常会话与“云端 Codex 在线”。UI smoke 主要检查可见文案、布局、slash menu 和基础坏词，不校验 `/api/chat/sessions` 的 `authoritative/source`。
- 影响：上线前如果只看 UI smoke 或手工页面可打开，会放过本轮最严重的数据可信度失败。
- 建议：UI smoke 捕获关键网络响应并断言 `chat/sessions`、`chat/active`、`thread-state`、`app-status` 是 app-server authoritative；或者把 API smoke 失败设为 `verify:cloud` 阻断项并在 UI 顶部显示同一错误。

## 测试缺口

- 缺少单元/集成测试覆盖：本地 non-draft session 不应覆盖 app-server active session。
- 缺少 webhook misconfiguration 测试：production + Caddy loopback + missing `CODEX_CLOUD_WEBHOOK_TOKEN` 必须 fail closed。
- 缺少 app-server timeout/orphan reconcile 测试：超时后是否取消、late response 如何恢复、UI 是否能按 threadId/turnId 重建。
- 缺少 automation restart 测试：console 重启后 queued/running run 应进入 explicit unknown/reconcile，而不是被调用方误认为终态。
- 缺少 proxy cache/health 测试：`/healthz` partial、proxy fresh cache、stale fallback、`strictOk` 应被 smoke 和 UI 区分。
- `verify:e2e` 默认不跑真实 turn；本轮未运行，因为会写额外 artifact，和本轮文件约束冲突。

## 建议修复顺序

1. 先修 P1-1：让普通 `/api/chat/sessions` 永远返回 app-server authoritative active，或者 HTTP 503/409；前端拒绝非权威会话主状态。
2. 修 P1-2：生产 webhook token fail closed，移除 query/body token，限制 runtime override，补 idempotency/rate limit。
3. 修 P1-3：用 app-server durable state 替代 process-local job replay；补 timeout cancel/reconcile。
4. 修 P1-4：automation run 状态从本地 JSON 迁移到可恢复状态模型；重启后 rehydrate 而不是推断终态。
5. 修 P2-1/P2-4：让健康状态和 UI smoke 一起校验 `strictOk`、`partial`、`source`、`authoritative`，避免绿灯误判。
6. 更新 README webhook 示例，避免外部接入继续踩 Basic Auth/Bearer 冲突。

## 残余风险

- app-server schema 和 normalizer 当前通过 smoke，但新的 app-server item/notification 类型仍可能只以 unknown fallback 展示；需要持续同步 schema。
- 文件/命令 local fallback 仍存在于 `CODEX_ALLOW_LOCAL_FALLBACK=1` 后门中；默认关闭是正确的，但生产环境需要启动时显式审计该环境变量。
- 默认 runtime 仍是 `danger-full-access` + `approval never`。如果这是产品选择，需要在 webhook、automation、UI 权限切换上用更强的操作边界抵消风险。
