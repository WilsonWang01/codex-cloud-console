# Codex Cloud Console 端到端体验验收报告 - 2026-07-11

## 结论

Release Gate: **FAIL**

这版不能发布。独立且充分的发布门禁是：公网 HTTPS 正式入口完成 TLS 与 Basic Auth 后，`GET /healthz` 仍在 20 秒内无响应；本地 18787 入口也出现 20 秒健康检查超时。绕开代理启动的本地 18888 服务读取了指向云端 `/home/ubuntu/...` 的 repo 配置，并在当前 macOS 验收环境因 `mkdir '/home/ubuntu'` 失败；因此本轮 `chat/stream` 500、`uploads` 502、会话非权威等结果可以证明“当前版本加当前配置在此验收环境不可用”，但不能单独证明 EC2 上必然存在相同后端产品缺陷。可以独立确认的产品行为是：接口失败或数据非权威时，UI 仍可能显示“在线”，并把 500 HTML 错页直接写入对话。

## 测试时间

- 北京时间：2026-07-11 03:30:35 至 03:41:11 CST
- 对应 UTC：2026-07-10 19:30:35 至 19:41:11 UTC

## 环境与版本

- 工作区：`/Users/xiaoxin/Documents/codex_cloud`
- 操作系统：macOS 26.5.1 (`25F80`)
- Node.js：`v25.2.1`
- npm：`11.6.2`
- Playwright：仓库依赖 `1.60.0`
- 验收基线 commit：`3f733f09f7fff67e4adc5530bb518bc77b00b082`
- 代码状态：**dirty worktree**
- 验收开始时已存在的未提交修改：
  - `README.md`
  - `scripts/e2e-frontend.mjs`
  - `scripts/local-cloud-console-proxy.mjs`
  - `server/codex-app-server-client.mjs`
  - `server/index.mjs`
  - 未跟踪报告文件若干

## 证据边界与归因

- **基础设施 / 正式发布门禁**：公网 `https://13.231.3.21.sslip.io/healthz` 在 TLS 和 Basic Auth 成功后 20 秒无响应。该结果直接来自正式公网入口，不依赖本地 18888 的 repo 配置，是独立 Release Gate。
- **本地入口问题**：`127.0.0.1:18787/healthz` 建连后 20 秒无响应，证明本轮本地入口不可用于完整验收；它不等同于公网 EC2 根因。
- **环境配置问题**：本地 18888 的 `/healthz` 显示 repo 路径为 `/home/ubuntu/codex-cloud/workspace/...`，`chat/sessions` 明确报错 `ENOENT ... mkdir '/home/ubuntu'`。这说明本地进程读取了云端 repo 配置，而当前 macOS 环境不满足该路径前提。
- **18888 失败的可推断范围**：同一 18888 进程内复现的 `chat/stream` 500、`uploads` 502、会话空列表和非权威响应，是当前版本在此验收环境失败的有效证据；由于测试环境已被云端绝对路径配置污染，未在 EC2 上复现前，不能仅凭这些结果断言 EC2 必然存在相同后端缺陷。
- **可独立确认的产品行为**：无论 5xx 根因来自环境还是服务端，前端在非权威状态下仍显示“在线”、把 HTML 500 错页写入 transcript、缺少清晰降级说明，都是本轮直接观察到的错误处理和状态表达问题。
- **历史日志边界**：`~/.codex/cloud-console-local-proxy.err.log` 当前仍存在，修改时间为 `2026-05-30 17:24:46 CST`，包含 `ERR_HTTP_HEADERS_SENT` 栈；本轮没有记录到对应代理进程退出，因此它只能作为历史/现存日志证据，不能用于断言本轮 18787 代理因该错误崩溃，也不能据此解释本轮超时根因。

## 实际运行命令

```bash
git status --short
sed -n '1,240p' package.json
sed -n '1,260p' scripts/e2e-frontend.mjs
sed -n '1,260p' scripts/smoke-ui.mjs
sed -n '1,260p' scripts/smoke-api.mjs
sed -n '1,260p' docs/research/acceptance/e2e-experience-subagent-report-2026-07-10.md
curl -I --max-time 15 -k https://13.231.3.21.sslip.io/
curl -sv --max-time 20 http://127.0.0.1:18787/healthz
npm run build
npm run verify:api
npm run verify:ui
PORT=18888 HOST=127.0.0.1 npm run start
curl http://127.0.0.1:18888/healthz
curl http://127.0.0.1:18888/api/status
CODEX_CLOUD_SMOKE_URL=http://127.0.0.1:18888/ npm run verify:api
CODEX_CLOUD_SMOKE_URL=http://127.0.0.1:18888/ npm run verify:ui
CODEX_CLOUD_E2E_URL=http://127.0.0.1:18888/ CODEX_CLOUD_E2E_ARTIFACT_DIR=/tmp/codex-cloud-official-e2e-2026-07-11 npm run verify:e2e
node --input-type=module <<'EOF'
# 自定义 Playwright 交互脚本，覆盖发送/停止、会话恢复、上传、粘贴、网络失败、移动端 slash 菜单
EOF
set -a; source ~/.codex/cloud-console-https-credentials; set +a; curl -sv --max-time 20 -u "${username}:${password}" https://13.231.3.21.sslip.io/healthz
tail -n 80 ~/.codex/cloud-console-local-proxy.err.log
```

## 命令结果矩阵

| 命令 | 结果 | 关键结论 |
| --- | --- | --- |
| `npm run build` | 通过 | 当前代码可构建，产物为 `dist/assets/index-Ceea8fUV.js` 等。 |
| `curl -sv --max-time 20 http://127.0.0.1:18787/healthz` | 失败 | 127.0.0.1:18787 建连成功，但 20 秒无任何字节返回。 |
| `npm run verify:api` | 失败 | 基于默认 18787 入口，30 秒超时，API 验收无法启动。 |
| `npm run verify:ui` | 通过 | 默认 18787 入口可以渲染桌面/移动壳子，但仅表现为“同步中”壳层，不代表后端可用。 |
| `PORT=18888 HOST=127.0.0.1 npm run start` | 通过 | 临时本地服务可启动；本次验收结束前已关闭。 |
| `curl http://127.0.0.1:18888/healthz` | 通过但有告警 | `strictOk=true`，同时 `appServer.lastError="timeout after 2000ms"`。 |
| `curl http://127.0.0.1:18888/api/chat/sessions?repoId=invest-dashboard` | 失败 | 返回 `source=app-server-unavailable`、`authoritative=false`、错误为 `ENOENT ... mkdir '/home/ubuntu'`；确认云端 repo 路径配置不适用于当前 macOS 环境。 |
| `curl http://127.0.0.1:18888/api/chat/active?repoId=invest-dashboard` | 失败 | 在上述环境配置失败的同一进程内返回 `500 Internal Server Error`；未单独证明 EC2 同样失败。 |
| `CODEX_CLOUD_SMOKE_URL=http://127.0.0.1:18888/ npm run verify:api` | 失败 | `chat sessions` 10/10 失败，均为非权威降级响应。 |
| `CODEX_CLOUD_SMOKE_URL=http://127.0.0.1:18888/ npm run verify:ui` | 失败 | `inbox-desktop` 浏览器记录 `503 Service Unavailable`。 |
| `CODEX_CLOUD_E2E_URL=http://127.0.0.1:18888/ ... npm run verify:e2e` | 失败 | 桌面渲染、slash、面板通过；上传附件 30 秒超时；浏览器记录 `500`、`502`。这些是当前 18888 验收环境失败证据，不外推为 EC2 同缺陷。 |
| 自定义 Playwright 脚本 | 失败 | 当前 18888 环境中，发送后对话直接出现 500 HTML 错页，上传和粘贴失败，刷新后草稿未恢复；强制网络失败后显示“连接断开”。 |
| `curl -sv -u ... https://13.231.3.21.sslip.io/healthz` | 失败 | TLS 与 Basic Auth 成功，但 20 秒无响应。 |
| `tail -n 80 ~/.codex/cloud-console-local-proxy.err.log` | 历史/现存日志证据 | 日志修改时间为 2026-05-30，包含 `ERR_HTTP_HEADERS_SENT` 栈；本轮无对应进程退出证据，不能断言本轮代理因此崩溃。 |

## 通过/失败/阻塞矩阵

| 覆盖项 | 结果 | 说明 |
| --- | --- | --- |
| 构建 | 通过 | `npm run build` 通过。 |
| 启动 | 部分通过 | 本地 18888 可启动；默认 18787 代理监听存在但健康检查超时。 |
| 公网 EC2 入口 | 阻塞 | HTTPS 入口可握手，但带鉴权 `GET /healthz` 20 秒超时。 |
| 首次加载与空态 | 部分通过 | 桌面/移动可渲染空态；但“云端 Codex 在线”与真实会话不可用矛盾。 |
| 桌面核心流程 | 失败 | slash 菜单、模型/权限/推理面板可开；发送、上传在受云端路径配置影响的本地 18888 环境失败。 |
| 移动端核心流程 | 部分通过 | 移动端页面与 slash 菜单无明显溢出；未能完成真实发送。 |
| 会话切换与恢复 | 失败 | 会话面板显示“没有匹配的会话”；草稿刷新后丢失。 |
| 输入 / 发送 / 停止 | 失败 | 本地 18888 发送返回 500 HTML，未进入可停止的 busy 状态；EC2 成功路径未完成验收。 |
| 附件上传与粘贴 | 失败 | 受环境配置问题影响的 18888 中，官方 E2E 上传超时，自定义脚本上传/粘贴均失败；尚未证明 EC2 同样失败。 |
| slash 命令 / 模型选择 / 面板 | 通过 | 桌面与移动端 slash 菜单、状态/模型/推理/权限/会话面板可打开。 |
| 错误与降级状态 | 失败 | 后端非权威或 500 时，前端仍可显示“在线”。 |
| 网络 / 接口失败 | 失败 | 公网鉴权后 20 秒超时是独立门禁；18787 健康超时；18888 在云端路径配置不适配本机时出现 500 / 502 / 非权威。 |
| 明显可访问性 / 响应式 | 部分通过 | 自动脚本未发现横向溢出、未命名按钮；未做读屏器级审核。 |
| 控制台错误与请求失败 | 失败 | 当前验收环境复现到 `500 Internal Server Error`、`502 Bad Gateway`、`503 Service Unavailable`、`net::ERR_FAILED`；其中 18888 的 5xx 不单独外推到 EC2。 |

## 证据

- 官方 E2E 报告与 trace：
  - [report.json](/tmp/codex-cloud-official-e2e-2026-07-11/report.json)
  - [summary.md](/tmp/codex-cloud-official-e2e-2026-07-11/summary.md)
  - [trace.zip](/tmp/codex-cloud-official-e2e-2026-07-11/trace.zip)
- 官方 E2E 截图：
  - [01-desktop-project.png](/tmp/codex-cloud-official-e2e-2026-07-11/screenshots/01-desktop-project.png)
  - [02-desktop-slash-menu.png](/tmp/codex-cloud-official-e2e-2026-07-11/screenshots/02-desktop-slash-menu.png)
  - [03-desktop-status-panel.png](/tmp/codex-cloud-official-e2e-2026-07-11/screenshots/03-desktop-status-panel.png)
  - [04-desktop-model-panel.png](/tmp/codex-cloud-official-e2e-2026-07-11/screenshots/04-desktop-model-panel.png)
  - [05-desktop-reasoning-panel.png](/tmp/codex-cloud-official-e2e-2026-07-11/screenshots/05-desktop-reasoning-panel.png)
  - [06-desktop-permissions-panel.png](/tmp/codex-cloud-official-e2e-2026-07-11/screenshots/06-desktop-permissions-panel.png)
  - [07-desktop-sessions-panel.png](/tmp/codex-cloud-official-e2e-2026-07-11/screenshots/07-desktop-sessions-panel.png)
- 自定义交互证据：
  - [summary.json](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/summary.json)
  - [01-desktop-initial.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/01-desktop-initial.png)
  - [02-after-send.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/02-after-send.png)
  - [04-after-upload.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/04-after-upload.png)
  - [05-after-paste.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/05-after-paste.png)
  - [06-sessions-panel.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/06-sessions-panel.png)
  - [07-after-reload.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/07-after-reload.png)
  - [08-network-failure.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/08-network-failure.png)
  - [09-mobile-initial.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/09-mobile-initial.png)
  - [10-mobile-slash.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/10-mobile-slash.png)
- 接口与日志证据：
  - [18787-healthz-timeout.txt](/tmp/codex-cloud-18787-healthz.txt)
  - [public-healthz-auth-timeout-redacted.txt](/tmp/codex-cloud-public-healthz-auth-redacted.txt)
  - [18888-healthz.json](/tmp/codex-cloud-18888-healthz.json)
  - [18888-chat-sessions.json](/tmp/codex-cloud-18888-chat-sessions.json)
  - [18888-chat-active.txt](/tmp/codex-cloud-18888-chat-active.txt)
  - [cloud-console-local-proxy.err.log](/Users/xiaoxin/.codex/cloud-console-local-proxy.err.log)

## 主要发现

### P0 - 公网 HTTPS 鉴权后 20 秒无响应，构成独立发布门禁；本地 18787 同时超时

类型：**基础设施 / 发布门禁**

- 复现步骤
  - 执行 `curl -sv --max-time 20 http://127.0.0.1:18787/healthz`
  - 执行带已有凭据的 `curl -sv --max-time 20 -u ... https://13.231.3.21.sslip.io/healthz`
  - 查看本地代理错误日志 `~/.codex/cloud-console-local-proxy.err.log`
- 预期
  - 本地稳定入口 `127.0.0.1:18787` 与公网 HTTPS 正式入口都应在超时窗口内返回健康 JSON。
- 实际
  - `127.0.0.1:18787` TCP 建连成功，但 20 秒无任何响应字节。
  - `https://13.231.3.21.sslip.io/healthz` TLS 握手和 Basic Auth 成功后，20 秒仍无响应。
  - 本地代理错误日志当前仍存在，修改时间为 `2026-05-30 17:24:46 CST`，其中包含 `Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client`。本轮没有对应进程退出证据，故不把它认定为本轮 18787 超时的原因，也不声称本轮代理因它崩溃。
- 用户影响
  - 发布入口本身不可靠，用户可能在“能连上 TCP / 能打开壳层”的假象下卡死、超时或间歇失败，无法把当前版本当作可发布版本。
- 证据
  - [18787-healthz-timeout.txt](/tmp/codex-cloud-18787-healthz.txt)
  - [public-healthz-auth-timeout-redacted.txt](/tmp/codex-cloud-public-healthz-auth-redacted.txt)
  - [cloud-console-local-proxy.err.log](/Users/xiaoxin/.codex/cloud-console-local-proxy.err.log)
- 建议
  - 优先定位并修复公网正式入口和本地 18787 的健康检查超时；公网超时本身已经足以阻止发布。
  - 对历史 `ERR_HTTP_HEADERS_SENT` 单独做当前版本回归复现；只有取得本轮进程报错或退出证据后，才能把它升级为当前故障根因。
  - 发布门禁必须包含“正式入口 `GET /healthz` 在固定时间内返回可解析 JSON”，而不是仅验证首页能否握手或是否出现登录框。

### P1 - 本地云端路径配置失配时，会话事实源不可用，UI 仍显示“云端 Codex 在线”

类型：**环境配置问题 / 产品降级行为**

- 复现步骤
  - 启动本地服务：`PORT=18888 HOST=127.0.0.1 npm run start`
  - 执行 `curl http://127.0.0.1:18888/api/chat/sessions?repoId=invest-dashboard`
  - 执行 `curl -i http://127.0.0.1:18888/api/chat/active?repoId=invest-dashboard`
  - 打开项目页，观察标题区与会话区
- 预期
  - 只有在 `sessions/active/thread-state` 都是权威 app-server 数据时，页面才应显示正常在线态。
- 实际
  - 18888 `/healthz` 中 repo 路径为 `/home/ubuntu/codex-cloud/workspace/...`，说明本地进程读取了云端 repo 配置。
  - `chat/sessions` 返回 `source:"app-server-unavailable"`、`authoritative:false`，错误为 `ENOENT: no such file or directory, mkdir '/home/ubuntu'`。
  - `chat/active` 直接返回 `500 Internal Server Error`。
  - UI 仍呈现“云端 Codex 在线”“已登录”等正常态文案。
- 用户影响
  - 用户会错误相信当前会话可用，从而在错误线程上继续工作、误以为恢复成功，或者在失败后无法判断是“入口坏了”还是“会话数据坏了”。
- 证据
  - [18888-healthz.json](/tmp/codex-cloud-18888-healthz.json)
  - [18888-chat-sessions.json](/tmp/codex-cloud-18888-chat-sessions.json)
  - [18888-chat-active.txt](/tmp/codex-cloud-18888-chat-active.txt)
  - [01-desktop-initial.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/01-desktop-initial.png)
  - [report.json](/tmp/codex-cloud-official-e2e-2026-07-11/report.json)
- 建议
  - 把“在线”徽标绑定到权威会话与 thread state，而不是仅绑定登录态或 app-status。
  - 让 repo 路径配置按部署环境解析或在启动时显式拒绝不适配配置；本地起服不应静默沿用 `/home/ubuntu`。
  - 在路径配置匹配的 EC2 环境重新执行 sessions/active 验收；本 finding 不以本地 500 单独断言 EC2 后端同样失败。

### P1 - 18888 验收环境发送失败，前端把 500 HTML 错页直接写入对话

类型：**环境配置触发的链路失败 / 产品错误处理行为**

- 复现步骤
  - 在 18888 项目页输入 `验收发送测试 ...`
  - 点击发送按钮
  - 等待 6 秒
- 预期
  - 应进入可见运行态，必要时出现“打断当前回复”按钮；失败时也应给出结构化错误消息，而不是把服务端 HTML 错页写进对话。
- 实际
  - 输入被清空，但消息区紧接着出现一段 `<!DOCTYPE html> ... <pre>Internal Server Error</pre>`。
  - `.clear-chat[aria-label="打断当前回复"]` 未出现，说明没有进入可打断的忙碌态。
  - 网络层记录 `POST /api/chat/stream -> 500`。
  - 该请求来自已确认因 `/home/ubuntu` repo 配置失配而退化的同一 18888 进程；未在 EC2 正确配置环境复现，因此 500 根因及 EC2 成功路径均未完成判定。
- 用户影响
  - 当前验收环境的核心主路径不可用。即使 500 由环境配置触发，把后端 HTML 错页当正文回显仍是明确的产品错误处理问题；但本结果不能单独证明 EC2 上发送必然失败。
- 证据
  - [summary.json](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/summary.json)
  - [02-after-send.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/02-after-send.png)
- 建议
  - `api/chat/stream` 失败时必须统一映射成结构化应用错误，严禁把 HTML 错页混入 transcript。
  - 发送按钮状态、busy 状态、interrupt 状态必须与后端 turn 生命周期严格对齐。
  - 修正 repo 配置后，在 EC2 正式入口重跑发送、流式回复和停止流程，区分环境根因与后端产品缺陷。

### P1 - 18888 验收环境附件上传与粘贴失败，官方 E2E 在上传步骤超时

类型：**当前验收环境失败 / 待在 EC2 复核**

- 复现步骤
  - 官方 E2E：`CODEX_CLOUD_E2E_URL=http://127.0.0.1:18888/ CODEX_CLOUD_E2E_ARTIFACT_DIR=/tmp/codex-cloud-official-e2e-2026-07-11 npm run verify:e2e`
  - 手工：在项目页上传文本附件，再粘贴 PNG 图片
- 预期
  - 附件 chip 应在 composer 中可见，且不应产生 5xx。
- 实际
  - 官方 E2E 在 `upload and paste attachments` 步骤等待 30 秒超时。
  - 手工上传与粘贴均未出现 attachment chip。
  - 网络层记录 `POST /api/uploads -> 502` 两次，浏览器 console 同时记录 `500`、`502`。
  - 测试发生在已因云端 `/home/ubuntu` repo 配置失配而退化的 18888 进程内；该 502 足以判定当前验收环境失败，但未隔离出可外推至 EC2 的独立根因。
- 用户影响
  - 当前验收环境中多模态输入不可用，无法验收截图提问、文件上下文注入、移动端分享图等关键用法；尚不能据此断言 EC2 用户一定遇到同一 502。
- 证据
  - [report.json](/tmp/codex-cloud-official-e2e-2026-07-11/report.json)
  - [04-after-upload.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/04-after-upload.png)
  - [05-after-paste.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/05-after-paste.png)
  - [summary.json](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/summary.json)
- 建议
  - 先修正或隔离 repo 配置，再在 EC2 正式入口复跑上传文本、上传图片、粘贴图片三条路径；若仍为 502，再按产品缺陷定位 `/api/uploads` 根因。
  - 无论根因为何，上传失败都应给出可见、结构化且可重试的错误反馈。

### P2 - 会话切换与恢复不可用：会话面板无可切换对象，未发送草稿刷新后丢失

类型：**环境配置阻塞 / 产品体验行为**

- 复现步骤
  - 打开项目页，点击当前会话按钮
  - 输入一段未发送草稿
  - 刷新页面
- 预期
  - 会话面板应能列出当前 repo 的会话；未发送草稿至少需要有明确的恢复或丢弃策略。
- 实际
  - 会话面板显示 `没有匹配的会话`。
  - 初始会话始终是 `新对话 / 未选择`。
  - 未发送草稿刷新后 `recoveredComposerValue` 为空，草稿丢失。
  - 会话列表为空发生在 `/home/ubuntu` 配置失配且 sessions 非权威的环境中，不能据此证明 EC2 会话切换同样失败；草稿刷新后未恢复是本轮直接观察到的前端体验行为。
- 用户影响
  - 用户无法确认当前工作上下文，也无法恢复刚刚输入但尚未发送的内容，体验接近“伪单页壳层”。
- 证据
  - [06-sessions-panel.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/06-sessions-panel.png)
  - [07-after-reload.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/07-after-reload.png)
  - [summary.json](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/summary.json)
- 建议
  - 先在匹配 repo 路径的 EC2 环境验证权威 session list，再判断会话切换是否存在后端产品缺陷。
  - 明确草稿持久化策略；若承诺恢复，至少不应在刷新后悄悄丢草稿。

### P2 - 健康模型与降级提示不可信：`strictOk=true` 但 `appServer.lastError` 已存在，断网后 UI 才被动变成“连接断开”

类型：**环境配置触发 / 产品观测性行为**

- 复现步骤
  - 读取 `http://127.0.0.1:18888/healthz`
  - 在浏览器中人为阻断 `/api/status`、`/api/chat/sessions`、`/api/chat/active`、`/api/codex/thread-state` 后刷新页面
- 预期
  - 健康态和 UI 连接态应一致地反映“可工作 / 不可工作”，不能一边严格健康一边大量会话接口失败。
- 实际
  - `healthz` 返回 `strictOk:true`，同时 `appServer.lastError:"timeout after 2000ms"`。
  - 同一响应把 `/home/ubuntu/...` repo 标为 `ok:true`，但随后 sessions 因创建 `/home/ubuntu` 失败而退化，说明当前健康模型未暴露该环境配置不可用。
  - 阻断关键 API 后，页面最终只展示“连接断开”，没有更明确的降级解释；在此前正常页面上又长期显示“在线”。
- 用户影响
  - 用户和运维都难以判断系统到底是“慢”“降级”“假在线”还是“完全不可用”。
- 证据
  - [18888-healthz.json](/tmp/codex-cloud-18888-healthz.json)
  - [08-network-failure.png](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/screenshots/08-network-failure.png)
  - [summary.json](/tmp/codex-cloud-acceptance-2026-07-11-1783712194697/summary.json)
- 建议
  - 重新定义 `strictOk`，至少把会话核心接口的可用性纳入。
  - 降级 UI 需要明确说明是“会话服务不可用 / 仅壳层可用 / 可只读不可发送”，而不是笼统“在线”或“断开”。

## 正向观察

- `npm run build` 可稳定通过。
- 桌面与移动端基础布局、slash 菜单、状态/模型/推理/权限面板没有复现明显横向溢出。
- 自动脚本未发现未命名按钮或控制区按钮重叠。

## 未覆盖或部分覆盖

- 未执行真实成功的 Codex 回复，因此无法验收流式内容质量、停止成功率、主动压缩成功率。
- 未做屏幕阅读器、键盘焦点顺序、颜色对比度的完整无障碍审核，只覆盖了明显的 DOM/响应式问题。
- 未验证多标签页竞争、服务重启后的会话恢复、长期使用后的内存回收。

## 必须修复项

1. 修复公网正式入口鉴权后 `GET /healthz` 20 秒超时；这是不依赖 18888 的独立发布门禁。同时定位 18787 本地入口超时，但不要用 2026-05-30 的历史 `ERR_HTTP_HEADERS_SENT` 日志代替本轮根因证据。
2. 修正或隔离云端 `/home/ubuntu/...` repo 配置，使验收环境与部署环境一致；随后在 EC2 正式入口重跑 sessions、active、发送、停止和附件流程。
3. 修复已确认的产品错误处理行为：`/api/chat/stream` 失败时必须返回并展示结构化应用错误，不能把 HTML 错页写进对话。
4. 在正确 EC2 配置下确认 `/api/uploads`；确保上传文本、上传图片、粘贴图片通过，失败时提供可见且可重试的结构化反馈。
5. 收紧 UI 在线态与健康判定：非权威会话、app-server error 或 repo 配置不可用时，不得继续展示无条件“在线”。

## 最终判定

**FAIL**

Finding 数：**6**（P0：1，P1：3，P2：2，P3：0）。

公网正式入口鉴权后 20 秒超时已独立阻断发布。18888 结果进一步证明当前版本加当前云端 repo 配置在本地验收环境不可用，并暴露了错误处理与降级状态问题；这些本地 5xx 在 EC2 正确配置环境复现前，不单独定性为 EC2 必然存在的同源后端产品缺陷。只要以上 5 项中任意 1 项未解决，我都不会签字放行。
