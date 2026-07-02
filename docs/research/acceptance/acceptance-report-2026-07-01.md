# 云端 Codex CLI Web 控制台独立验收报告

验收日期：2026-07-01（Asia/Hong_Kong）
入口：http://127.0.0.1:18787/
项目路径：/Users/xiaoxin/Documents/codex_cloud

## 结论

不建议直接按“常驻、稳定、接近 Codex app session/thread/turn 体验”上线。当前不是花架子：健康检查、账号、thread/read、turn/start、goal、compact、模型/推理、上传入口和项目隔离都有真实 app-server 或云端链路证据。但稳定性、初始加载、session 摘要一致性和事实源架构仍有 P1 风险，需要继续优化后再作为主入口常驻使用。

P0：未发现。

P1 需要修复后再上线；P2/P3 可跟随优化。

## 验收范围与证据

- `npm run codex:schema:check`：通过，schema up to date。
- `npm run build`：通过，Vite production build 成功。
- `/healthz`：200，`localMode=false`，app-server running，Codex 账号为 ChatGPT subscription，仓库路径为 `/home/ubuntu/codex-cloud/workspace/*`。
- `/api/codex/app-status`：200，返回真实 account/rate limit/MCP/plugin/skills 状态。
- 自带 API smoke 20 轮：通过，但最大耗时 `chat/sessions` 10061ms、`thread-state` 6936ms。
- 自带 UI smoke：失败，原因是多个核心页面 3 秒后仍显示“正在读取/正在加载”。
- 扩展压力 30 轮：`chat/sessions`、`chat/history`、`thread-state` 0 失败；`/api/status` Node fetch 压测 5/30 timeout，curl 短测 10/10 成功但 3-13 秒。
- UI E2E：新会话、slash 菜单、模型/推理面板、上传芯片、Enter 发送、项目切换隔离通过；真实 thread-read 返回 `ACCEPTANCE_UI_PING_OK`。
- Goal/compact：goal set/read/clear 成功；主动 compact SSE 约 9.7 秒完成，包含 tokenUsage/status/done。

## P1 问题

### P1-1 `/api/status` 高尾延迟和间歇性 timeout，不适合作为常驻主轮询接口

复现步骤：
1. 对 `/api/status` 做 30 轮串行请求。
2. 观察失败率和耗时。
3. 再用 `/usr/bin/curl --max-time 20` 做 10 轮短测。

证据：
- `docs/research/acceptance/data/api-stress-2026-07-01.json`：30 轮中 5 次 timeout，failureRate 16.7%；异常样本显示 timeout。
- curl 短测 10/10 成功，但单次耗时 3-13 秒。
- 代码 [server/index.mjs](/Users/xiaoxin/Documents/codex_cloud/server/index.mjs:5357)：`getStatus()` 同时读取 repo/timer/log/automation/audit/notification/diagnostics，并发探测 `config/read`、`account/read`、`mcpServerStatus/list`，随后还执行 `hostname`、外部通知和 push 状态汇总。

影响：
常驻页面依赖 status 会出现长时间“连接中/读取中”，也容易把 app-server 或 MCP 的短暂慢响应放大成整页状态慢。

建议：
拆分 `/api/status` 为 fast shell 和 deep diagnostics；主 UI 轮询只读 fast status，深度 MCP/plugin/notification 用独立刷新和缓存。给每个子探测加可观测耗时字段和硬超时，不让某个子系统拖住整页。

### P1-2 桌面/移动核心页初始加载体验不稳定，自带 UI smoke 失败

复现步骤：
1. 运行 `CODEX_CLOUD_SMOKE_URL=http://127.0.0.1:18787/ CODEX_CLOUD_SMOKE_UI_WAIT_MS=3000 npm run verify:ui`。
2. 打开 `#/inbox`、`#/project/invest-dashboard`、`#/settings`、`#/automations/...`。

证据：
- 自带 smoke 输出 `ok:false`，多个页面 3 秒后仍有“正在读取/读取中/正在加载”。
- 截图 `screenshots/02-project-desktop.png`：桌面项目页仍显示“新对话 正在加载 / 正在加载会话...”，但输入框已可用。
- `screenshots/05-inbox-mobile.png`：移动收件箱仍显示“读取中 / 正在读取收件箱”。

影响：
用户会误以为会话丢失或未连接云端。对“常驻控制台”来说，初屏不应长期依赖重型状态接口。

建议：
分层渲染：先显示最近可用 session/thread 快照并标注刷新中，再异步补齐 token/goal/MCP/automation；对超过 5 秒的区域显示明确“仍在同步云端”而非泛化加载。

### P1-3 session 列表摘要与真实 app-server thread 内容不同步

复现步骤：
1. UI 新建会话。
2. 输入 `只回复 ACCEPTANCE_UI_PING_OK，不要执行命令。` 并按 Enter。
3. 查询 `/api/chat/history?repoId=invest-dashboard&sessionId=sess-mr2ct1mx-d0d48bca` 和 `/api/chat/sessions?repoId=invest-dashboard`。

证据：
- `/api/chat/history` 和 `/api/codex/thread-read` 均返回 user + assistant 两条真实消息，thread 有 1 turn。
- `/api/chat/sessions` 中该 session `messageCount:0`，`tokenUsage:null`。
- 代码 [server/index.mjs](/Users/xiaoxin/Documents/codex_cloud/server/index.mjs:866)：`messageCount` 取本地 `item.messages`；[server/index.mjs](/Users/xiaoxin/Documents/codex_cloud/server/index.mjs:919) 同步 app-server thread 时仍保留 `existing?.messages || []`，没有从 official turns 更新摘要。

影响：
会话列表、搜索、分组和“当前/历史”判断会与真实 thread 不一致，用户会看到刚发过消息的 thread 像空会话。

建议：
把 thread/list/thread/read 的 official metadata 作为 session 摘要事实源；至少在发送完成和 thread/read 后回写 messageCount、lastMessage、tokenUsage、updatedAt。避免列表只反映本地 cache。

### P1-4 app-server 不是唯一事实源，本地 store 仍负责 active session、draft、runtime、摘要

复现步骤：
1. 阅读 session 相关服务端实现。
2. 对照 UI 新建/选择/发送后的状态。

证据：
- [server/index.mjs](/Users/xiaoxin/Documents/codex_cloud/server/index.mjs:891) `upsertAppServerThreads()` 将 app-server thread 合并进本地 `chat-history.json`。
- [server/index.mjs](/Users/xiaoxin/Documents/codex_cloud/server/index.mjs:964) `getRepoSessions()` 先同步 app-server，再从本地 store 生成 active 和 session 列表。
- [server/index.mjs](/Users/xiaoxin/Documents/codex_cloud/server/index.mjs:6758) 新建 session 先创建本地 session；直到发送时才 `thread/start`。

影响：
当前已经能恢复/读取真实 thread，但还不是 Codex app 那种 app-server 主导的 session/thread/turn 模型。多客户端、重启、缓存落后时容易出现 activeByRepo、draft、runtime 和 official thread 状态分叉。

建议：
明确本地 store 只保存 UI 草稿和轻量偏好；active thread、title、message count、token、goal、compact、runtime 统一从 app-server 读。若必须缓存，要带版本、更新时间和 stale 标识。

## P2 问题

### P2-1 API 和 UI 仍泄露内部实现词/路径/mock 文案

复现步骤：
1. 请求 `/api/automations/runs`。
2. 查看 automation run payload 和 UI。
3. 阅读 fallback route。

证据：
- `/api/automations/runs` 返回 `worktreePath:/home/ubuntu/codex-cloud/worktrees/...`、`worktreePolicy:detached-worktree`。
- [server/index.mjs](/Users/xiaoxin/Documents/codex_cloud/server/index.mjs:6680) 缺失日志时仍返回 `mocked:true` 和 `Local mock mode...`。
- [server/index.mjs](/Users/xiaoxin/Documents/codex_cloud/server/index.mjs:6707) repo pull 在 repo 不存在时返回 mock pull。

影响：
用户验收时会看到“Local mock / detached-worktree / 绝对路径”这类底层词，降低对真实云端连接的信任，也可能泄露部署路径。

建议：
生产入口对外隐藏绝对路径和 mock 文案；fallback 要返回明确的“日志未找到/仓库未挂载”状态码和用户级说明，并在 debug details 中折叠技术字段。

### P2-2 设置页暴露 MCP OAuth 错误噪音，容易误判云端断连

复现步骤：
1. 请求 `/api/codex/app-host/status`。
2. 查看 `stderrTail`。

证据：
- `stderrTail` 多条 Notion/Cloudflare `invalid_token` / `AuthRequired`。
- `/api/codex/app-status` 同时显示 `cloudflare-api`、`notion` `authStatus:notLoggedIn`。

影响：
核心 Codex 已可用，但设置页/状态页会让用户以为整个云端能力异常。

建议：
按严重性归类 MCP 状态：未登录的可选 MCP 放入“需要登录的连接器”，不要污染 app-server host health；仅当必需 MCP 失败时进入全局告警。

### P2-3 上传/粘贴入口可用，但发送中附件状态不清楚

复现步骤：
1. UI 新建会话。
2. 通过 file input 上传 `upload-smoke.txt`。
3. 发送消息并观察 composer。

证据：
- `screenshots/14-e2e-enter-send-result.png`：附件芯片 `upload-smoke.txt` 仍显示在 composer 附近，页面同时处于生成/补充状态。
- 代码 [src/App.tsx](/Users/xiaoxin/Documents/codex_cloud/src/App.tsx:4678) 上传走 `/api/uploads`；[src/App.tsx](/Users/xiaoxin/Documents/codex_cloud/src/App.tsx:9181) 渲染 attachment chip；[src/App.tsx](/Users/xiaoxin/Documents/codex_cloud/src/App.tsx:9229) 粘贴图片文件会触发同一上传流程。

影响：
用户不容易判断附件已作为本轮消息发送，还是仍留在待发送队列。

建议：
发送后将附件移入用户消息 bubble，只在 composer 保留“本轮已发送附件”只读状态或清空；对上传失败/成功 toast 加入可回看记录。

### P2-4 控件 accessible name 不稳定，自动化/键盘定位容易误命中

复现步骤：
1. 自动化脚本使用 `getByRole('button', { name: '中' })` 打开推理深度。
2. Playwright strict mode 命中多个含“中”的会话按钮。

证据：
- 第一次交互脚本失败：`getByRole('button', { name: '中' }) resolved to 4 elements`。

影响：
屏幕阅读器和自动化测试都难以稳定定位模型/推理按钮；用户用键盘/辅助技术时上下文可能不清晰。

建议：
给 footer 控件添加明确 `aria-label`，例如 `aria-label="推理深度：中"`、`aria-label="模型：GPT-5.5"`；会话列表按钮避免把超长标题直接作为唯一可访问名。

## P3 问题

### P3-1 goal 状态语义需要确认

复现步骤：
1. `POST /api/codex/thread-goal` 设置 objective 和 tokenBudget。
2. 立即 `GET /api/codex/thread-state`。

证据：
- goal set 返回 `status:"active"`。
- 随后 thread-state 返回同一 goal `status:"complete"`，未显式调用 complete。

影响：
可能是 app-server 语义，也可能让 UI 中“目标 active/complete”的展示不符合用户预期。

建议：
明确 goal 状态由 app-server 驱动还是 Web 控制台驱动；UI 文案区分“已设置目标”和“目标完成”。

### P3-2 浏览器/通知能力状态可读性一般

证据：
- 设置页显示浏览器通知“后台通知可用 / 通知权限已拒绝 / 后台订阅创建”，但行动路径不够明确。

建议：
把“入口安全、浏览器能力、权限、后台订阅”拆成一步步状态和修复动作。

## 已验证可用能力

- 真实连接云端：`/healthz`、`/api/codex/app-status` 显示 app-server running、ChatGPT subscription 已登录、真实 repo 路径存在。
- 新建会话和发送：UI Enter 发送创建 app-server thread `019f1ebd-b272-78f0-a699-ea43601022a9`，thread-read 有 1 turn。
- 项目隔离：切换到 `macro-control-dashboard` 后未出现 invest 项目的 `ACCEPTANCE_UI_PING_OK`。
- slash 菜单、模型/推理面板：UI 可打开并显示选项。
- 上传/粘贴 UI：file input 和 paste handler 存在，上传后可见附件芯片。
- goal/compact：goal set/clear 成功，compact SSE 返回 status、tokenUsage 和 done。
- 响应式：验收截图未发现横向溢出。

## 产物路径

- 报告：`docs/research/acceptance/acceptance-report-2026-07-01.md`
- API 压力数据：`docs/research/acceptance/data/api-stress-2026-07-01.json`
- 浏览器截图摘要：`docs/research/acceptance/data/browser-captures-2026-07-01.json`
- UI 交互数据：`docs/research/acceptance/data/ui-interactions-2026-07-01.json`
- Goal/compact 数据：`docs/research/acceptance/data/goal-compact-2026-07-01.json`
- 截图目录：`docs/research/acceptance/screenshots/`

## 2026-07-02 修复复验记录

针对本报告的 P1/P2 问题已完成一轮代码修复并部署到云端 console。

已修复：

- `/api/status` 改为 stale-while-revalidate 快照读模型。主轮询先返回最近可信状态，深度诊断后台刷新；无缓存时最多等待短窗口后返回 partial fast status。
- `/api/codex/app-status` 改为并行 app-server 能力探测，并增加按仓库缓存，避免设置页被 account/MCP/plugin/skills 串行探测拖慢。
- `/api/chat/sessions` 默认不阻塞等待全量 `thread/list`，改为先返回当前 UI 快照并后台同步 app-server thread list。
- `thread/read` 成功后回写 session 摘要，包括 `messageCount`、最近消息、`tokenUsage`、`compactedAt`、title 和 updatedAt；读取超时时优先返回已缓存的官方消息快照。
- 新建、选择、runtime、draft、删除等高频会话接口不再隐式触发全量 app-server thread list。
- 前端首屏 loading 文案从“正在读取/正在加载”改为“同步中/后台同步”，避免可操作页面误显示为阻塞或断连。
- footer 的模型、推理深度、权限和上下文按钮增加稳定 `aria-label`。
- `/api/automations/runs` 和 `/api/audit/events` 改用用户级摘要映射，隐藏 raw worktree policy、绝对 worktree path 和 `app-server-command` source。
- 日志缺失 fallback 不再返回 `Local mock mode` 文案。
- `/api/codex/thread-state` 增加服务端 thread-state 快照缓存；本地 cloud-console proxy 对非流式只读 GET 增加短 TTL fresh cache 和后台刷新，避免用户侧状态面板被偶发 app-server 深读拖慢。

复验证据：

- `node --check server/index.mjs`：通过。
- `npm run build`：通过。
- 部署云端后 `/healthz`：200，app-server running，Codex ChatGPT subscription 已登录。
- `npm run verify:cloud`：通过，包括 schema check、production build、API smoke、desktop/mobile UI smoke。
- `CODEX_CLOUD_SMOKE_REPEAT=30 npm run verify:api`：通过。`/api/status` 约 468ms；`chat/sessions` 30 轮最高约 2035ms；无 stale proxy fallback。
- `CODEX_CLOUD_SMOKE_UI_WAIT_MS=3000 npm run verify:ui`：通过。桌面/移动核心页面均无 visible bad hits、DOM bad hits、横向溢出、loading dead state。
- 专项 `/api/status` 30 轮：0 失败，`fresh` 28 次、`stale` 2 次、`partial` 0 次；未复现 timeout。
- 专项 session 摘要：验收会话 `sess-mr2ct1mx-d0d48bca` 已显示 `messageCount: 4`，并带有 app-server `tokenUsage` 与 `compactedAt`。
- 本地 proxy SWR 后专项 `/api/codex/thread-state` 30 轮：0 失败，最高 1533ms，后续请求多数 1-8ms，`partial` 0 次；`npm run verify:api` 中 thread-state 最高 210ms。
- `git diff --check`：通过。

剩余边界：

- `cloudflare-api`、`notion` MCP 仍需要人工 OAuth 登录；这是外部凭证状态，不是当前 Web 控制台代码缺陷。
- app-server 尚未完全成为唯一事实源：本地 store 仍保留 active session、draft 和 UI 快照缓存。当前修复已将关键摘要回写到 app-server thread/read 结果；彻底移除本地事实源仍应作为后续架构阶段处理。
- App list、实时语音/音频等 Codex app 能力仍依赖当前底层 app-server 或运行环境是否暴露对应接口；Web 控制台只能在底层能力可用后接入。
