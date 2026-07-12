# 严格代码 Review 最终报告 - 2026-07-11

Release Gate：**REQUEST CHANGES**

最终 finding 数量：**5 项，全部为 P1**。本报告覆盖并取代此前同路径的所有版本。

证据标签：

- **已复现**：已针对当前工作树运行隔离复现，结果直接命中问题。
- **代码确定**：无需依赖外部环境即可从当前控制流确定。
- **需验证**：缺少目标 EC2、Caddy 或真实 Codex 状态证据，不作为已发生事实。

## Findings

### P1-1 [已复现] app-server 同步失败会删除刚创建的空草稿，并返回 HTTP 200 / `ok:true`

- 位置：`server/index.mjs:428-466`、`server/index.mjs:1075-1127`、`server/index.mjs:7657-7685`、`src/App.tsx:3702-3729`。
- 触发条件：当前 active session 是刚创建、尚未输入文字或附件的本地草稿；随后普通 `GET /api/chat/sessions` 遇到 `thread/list` 失败或 app-server 不可用。
- 当前代码机制：`chooseRepoActiveSessionId()` 在没有 `preserveLocalActive/allowLocalActive` 时不保留本地 active；`getRepoSessions()` 即使同步失败也继续调用 `compactEmptyDraftSessions()`。此时 `keepDraftId` 为空，空草稿被加入删除集合并写回 store。路由随后把该降级结果包装成 HTTP 200、`ok:true`、`authoritative:false`、`messages:[]`。
- 隔离复现结果：
  - 注入 `thread/list` JSON-RPC error。
  - 响应：`{"http":200,"ok":true,"source":"app-server-unavailable","authoritative":false,"activeSessionId":null,"sessionIds":[]}`。
  - 持久化结果：`{"activeSessionId":null,"sessionIds":[]}`，原空草稿已实际删除。
- 实际风险：用户点击“新对话”后，在开始输入前刷新、切换路由或重连，草稿会无提示消失。前端 `loadChatHistory()` 又不校验 `authoritative`，会把空 sessions/messages 采信为成功结果，进一步清空当前聊天状态。
- 为什么现有测试没挡住：`scripts/smoke-api.mjs:283-309` 只覆盖同步成功时“空草稿不压过 app-server active”，没有覆盖同步失败时 store 必须保持不变；没有 session store 失败注入测试。
- 可执行修复：同步失败时禁止 prune、compact 和 active 重写；把普通读取与权威同步成功后的 reconcile 分开。非权威主读取应返回 503 + `ok:false`，或返回显式 stale 数据且前端保留上一次权威状态，不能用空数组覆盖 UI。
- 应补测试：分别注入 initialize timeout、`thread/list` error 和子进程退出；断言 HTTP 契约、草稿 session、`activeByRepo` 和前端 composer/messages 均不丢失。

### P1-2 [已复现] 旧 app-server generation 的退出回调会清空新进程并打断新请求

- 位置：`server/codex-app-server-client.mjs:84-124`、`server/codex-app-server-client.mjs:127-138`、`server/codex-app-server-client.mjs:283-295`；服务层放大路径为 `server/index.mjs:2052-2059`。
- 触发条件：`restart()` 或 initialize 失败后旧子进程收到 SIGTERM，但延迟退出；250ms 后新子进程已经 ready 并开始处理请求，旧子进程随后才触发 `close`。
- 当前代码机制：所有 generation 共用 `this.child`、`this.readyPromise` 和 `this.pending`；`error/close` handler 没有携带 child identity。任意旧 child 调用 `handleExit()` 都会无条件拒绝当前全部 pending，并把当前 child/readyPromise 清空。
- 隔离复现结果：
  - fake app-server 捕获 SIGTERM 并延迟 700ms 退出；新 generation ready 后发起 2 秒 `slow` 请求。
  - 结果：约 420ms 即失败，错误为 `codex app-server exited with code 0`。
  - 状态：`{"running":false,"restartCount":1,"pending":0}`，说明旧 generation 的 close 已破坏新 generation。
- 实际风险：一次慢退出会让刚恢复的新 app-server 再次逻辑下线，拒绝所有并发 RPC；服务层收到 stale exit 后还会把当前 active turn/compact 标记失败。新 child 可能仍存活但引用丢失，形成孤儿进程。
- 为什么现有测试没挡住：仓库没有 `CodexAppServerClient` 生命周期单元测试；build、schema、normalizer 和 live smoke 都不能稳定制造旧 generation 晚退出的时序。
- 可执行修复：每次 `start()` 分配 generation token，事件 handler 必须传入 child/generation；只有 `this.child === child` 时才能清理当前状态。pending 按 generation 隔离；`restart()` 等待旧 child close，超时后 SIGKILL，再启动新 generation。服务层忽略 stale generation 的 exit。
- 应补测试：延迟 SIGTERM、`error` 后再 `close`、restart 中并发请求、initialize timeout 后立即重试、旧 generation late response/late exit。

### P1-3 [已复现 + 代码确定] 后端只接受自定义 token header，但产品内全部外部触发配置仍生成 Bearer

- 位置：`server/index.mjs:5482-5491`、`server/index.mjs:8521-8555`、`src/App.tsx:6954-7013`、`README.md:146-158`、`ops/Caddyfile:16-21`。
- 触发条件：用户从自动化页复制“独立运行”“继续会话”、systemd、GitHub Actions 或 Cloudflare Worker 配置并执行。
- 当前代码机制：服务端只读取 `x-codex-cloud-token`；README 已同步为该 header，但 `AutomationWebhookPanel` 的 curl、heartbeat、systemd、GitHub 和 Cloudflare 五类模板仍发送 `Authorization: Bearer ...`。
- 隔离复现结果：
  - production server 设置 `CODEX_CLOUD_WEBHOOK_TOKEN=review-secret`。
  - Bearer 请求返回 401：`Automation trigger token is required`。
  - 同一 token 经 `x-codex-cloud-token` 已通过鉴权并进入资源查找，返回预期的 unknown automation 404。
- 额外代码确定问题：`src/App.tsx:6959-6961` 使用 `window.location.origin` 生成外部 URL。按 README 推荐从 `http://127.0.0.1:18787` 打开时，GitHub/Cloudflare 配置会指向外部平台无法访问的 localhost；公网 Caddy 路径还需要 Basic Auth，而 UI 模板没有提供该层配置。
- 实际风险：界面显示“云端入口已就绪”，但所有复制配置都会因 header 契约不一致稳定失败；即使只修 header，本地代理 origin 和 Caddy 双层鉴权仍会使外部调用失败。
- 为什么现有测试没挡住：API/UI/E2E smoke 都没有展开并执行 webhook/heartbeat 模板；README 和 UI 没有共享鉴权契约或 snippet builder。
- 可执行修复：建立单一 webhook client/snippet builder，统一使用 `x-codex-cloud-token`；外部 URL 来自服务端配置的 public origin。Caddy 明确选择“webhook 路由只校验 webhook token”或“模板同时配置 Basic Auth + webhook token”，并让 readiness 反映真实配置。
- 应补测试：production 下缺 token、错 token、Bearer、正确自定义 header、Caddy 双层鉴权矩阵；从本地代理打开 UI 后执行实际生成的 curl，并验证 GitHub/Cloudflare 等价请求。

### P1-4 [代码确定 + 局部复现] E2E 上传会持久污染被测仓库，cleanup 无法可靠定位其创建的 session

- 位置：`scripts/e2e-frontend.mjs:125-139`、`scripts/e2e-frontend.mjs:384-403`、`scripts/e2e-frontend.mjs:556-564`、`server/index.mjs:7983-8038`、`server/index.mjs:428-446`。
- 触发条件：运行默认 `npm run verify:e2e` 的 upload/paste 步骤，且仓库已有 app-server session。
- 代码确定部分：
  - E2E 每次生成唯一文本和图片文件名，并通过产品上传接口发送。
  - 上传接口把文件写入真实 repo 的 `.codex-cloud/uploads/<date>/`。
  - E2E cleanup 只尝试 DELETE active local session，没有任何删除上传文件的逻辑。
  - 若主流程已有 fatal error，cleanup error 不会追加独立失败记录。
- cleanup 目标局部复现：
  - 隔离 store 中 active 是带 1 个附件的 `local-e2e` session，同时存在 app-server session。
  - 普通 session GET 返回 `activeSessionId=app-thread-remote`，cleanup 看到的目标为 `source=app-server/threadId=thread-remote`，因此按当前代码直接 return。
  - `localSessionStillPresent=true`、`localAttachmentCount=1`。
- 证据边界：本次没有对真实 EC2 执行完整 E2E，因此不声称已经观察到线上目录增量；“上传文件不会被 cleanup 删除”由当前代码确定，“cleanup 选错 active”已在隔离环境复现。
- 实际风险：每次验收都可能在真实仓库留下唯一上传文件和本地 session，污染 git status、review snapshot、Codex 上下文与用户会话列表。真实 turn 模式还会留下测试 app-server thread。
- 为什么现有测试没挡住：脚本不保存新建 session ID 和上传路径；没有 before/after repo diff；cleanup 不校验 upload 目录恢复，失败时还可能被主错误遮蔽。
- 可执行修复：在专用临时 repo/worktree 中运行 E2E；显式记录测试 session/thread ID 和每个上传路径；finally 删除 session、thread、上传文件并验证无净变化。cleanup 的任何失败都必须独立记录并使 gate 失败。
- 应补测试：成功、上传中断、页面崩溃、app-server 不可用、real turn、cleanup API 失败六条路径；每条断言 session store、thread list、git diff 和 upload 文件集合恢复原状。

### P1-5 [已复现] 一个畸形 percent-encoding URL 可直接终止本地代理进程

- 位置：`scripts/local-cloud-console-proxy.mjs:93-104`、`scripts/local-cloud-console-proxy.mjs:449-480`；同一解析函数也由 `scripts/local-cloud-console-proxy.mjs:420-446` 的 raw socket 路径调用。
- 触发条件：向本地代理发送 `GET /%E0%A4%A HTTP/1.1`。
- 当前代码机制：`localStaticPath()` 在任何 try/catch 之前直接调用 `decodeURIComponent()`；HTTP request handler 也没有顶层异常边界。
- 隔离复现结果：代理进程 `exited=true`、exit code `1`，stderr 为 `URIError: URI malformed`。
- 实际风险：本地页面、脚本或恶意网站可向 loopback 发起单个 no-cors 请求，导致 LaunchAgent 维护的代理重启；正在进行的聊天、流式响应和 MCP OAuth callback 会被中断。
- 为什么现有测试没挡住：只覆盖正常浏览器路径和静态资源，没有 raw HTTP、畸形编码或 URL fuzz 测试；`node --check` 无法发现运行时 URIError。
- 可执行修复：把 `decodeURIComponent/new URL` 完整包在错误边界内，非法编码返回 400；HTTP 与 raw socket 两条路径复用同一安全 parser，并增加 request handler 最后一层兜底。
- 应补测试：非法 `%`、截断 UTF-8、`%zz`、NUL、双重编码 traversal、超长 URL、GET/HEAD；断言返回 400/414、进程保持存活，后续正常请求仍为 200。

## 实际命令记录

### 本次一致性修订重新运行

| 命令/验证 | 结果 |
| --- | --- |
| `git status --short`、`git diff --stat`、目标文件 `git diff` 与行号读取 | 通过；当前仍是 5 个产品文件有未提交修改 |
| `node --check server/index.mjs` | 通过 |
| `node --check server/codex-app-server-client.mjs` | 通过 |
| `node --check scripts/local-cloud-console-proxy.mjs` | 通过 |
| `node --check scripts/e2e-frontend.mjs` | 通过 |
| `node --check scripts/smoke-api.mjs` | 通过 |
| `node --check scripts/smoke-ui.mjs` | 通过 |
| `git diff --check -- README.md scripts/e2e-frontend.mjs scripts/local-cloud-console-proxy.mjs server/codex-app-server-client.mjs server/index.mjs` | 通过 |
| 隔离 session failure harness | 已复现 P1-1；HTTP 200/`ok:true` 且持久化空草稿被删除 |
| delayed-SIGTERM fake app-server harness | 已复现 P1-2；旧 generation 退出打断新请求并令 `running=false` |
| production webhook auth harness | 已复现 P1-3；Bearer=401，自定义 header 通过鉴权 |
| hybrid session / E2E cleanup target harness | 已复现 P1-4 的 cleanup 选错目标；本地附件 session 保留 |
| isolated proxy raw HTTP harness | 已复现 P1-5；畸形 URL 令代理 exit code 1 |

所有 harness 只在 `/tmp` 使用临时 state、fake app-server 和随机 loopback 端口，结束后删除临时目录；未修改产品文件或真实云端状态。

### 同一工作树此前已实际运行，本次未重复

以下结果来自本会话前一轮、相同 HEAD 和相同 5 文件 diff；本次为遵守“只修改报告文件”没有重新生成 build/E2E artifact：

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过，`tsc -b && vite build` 成功 |
| `npm run verify:normalizers` | 通过，4 项检查全部成功 |
| `npm run codex:schema:check` | 通过，schema up to date |
| `CODEX_CLOUD_SMOKE_REPEAT=1 CODEX_CLOUD_SMOKE_TIMEOUT_MS=10000 npm run verify:api` | 失败；首个 `/healthz` 10 秒超时 |
| `npm run verify:ui` | 命令返回 0，但页面样本仍含“同步中/同步会话中”；仅证明静态 UI 可渲染，不作为线上健康证据 |
| `curl ... /manifest.webmanifest`、`curl ... /codex-cloud-sw.js` | 均返回 200 |

`npm run verify:e2e` 未运行：当前脚本会写报告 artifact，并且 P1-4 已确认会写被测仓库且 cleanup 不完整；在本轮文件约束下继续运行会扩大副作用。

## 需验证与非 finding

- 实际 EC2 是否通过 systemd drop-in 配置了 `CODEX_CLOUD_WEBHOOK_TOKEN`：**需验证**。仓库 service unit 没有该配置，但不能据此断言线上一定缺失。
- 当前公网/Caddy/本地代理到 EC2 的超时根因：**需验证**。此前 API smoke 的 `/healthz` 超时是环境阻塞证据，不单独归因为本次代码。
- `waitUntilReady(timeoutMs)` 应把 timeout 解释为“总预算”还是“仅业务 RPC 预算”：契约未文档化。当前实现可能先等待至 timeout，再给 RPC 一个完整 timeout；这是测试缺口，但本报告不把未定义契约单列为 finding。
- dist symlink 越界与静态文件 TOCTOU：当前 dist 没有 symlink，未做动态复现，本报告不将其表述为已发生漏洞。
- UI smoke 在“同步中”页面返回 0 是测试覆盖缺口；它不改变上述 5 项 finding 数量。

## 测试缺口

- 缺少 app-server client generation/lifecycle 单元测试。
- 缺少 session sync 失败时的 store 不变性测试。
- 缺少 webhook 服务端、README 和 UI snippet 的共享契约测试。
- 缺少 E2E 资源清单与可验证 cleanup。
- 缺少代理畸形 URL/fuzz 集成测试。
- 默认 E2E 不执行真实 Codex turn，且当前真实入口 API smoke 未通过。

## Release Gate

结论：**REQUEST CHANGES**。

最低放行条件：修复全部 5 项 P1；补齐对应自动化回归；让 E2E 在隔离工作区运行并证明无 session/thread/file 净污染；随后在目标 EC2 入口通过 API smoke、稳定态 UI smoke 和至少一个真实 turn E2E。
