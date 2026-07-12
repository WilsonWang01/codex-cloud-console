# Codex Cloud Console 整改与复验报告 - 2026-07-11

## 当前结论

- 本地隔离发布门禁：**PASS**。
- 非计费浏览器 E2E：**PASS**，桌面、移动端、命令面板、附件上传/粘贴与清理均通过。
- EC2 正式入口：**DEPLOYED / PASS**，严格健康、API、UI、非计费 E2E、鉴权边界和旁路站点均已在线复验。
- 真实 Codex turn：**BLOCKED BY EXTERNAL QUOTA**，前置检查在创建测试 session 前返回 `rate_limit_reached`。

本报告覆盖代码修复后的状态，不修改此前的原始缺陷报告；原报告保留为问题发现证据。

## 缺陷关闭情况

| 原 finding | 修复 | 自动化证据 |
| --- | --- | --- |
| P1-1 同步失败删除空草稿并返回伪成功 | 同步失败不再 prune/compact/改写 active；普通非权威读取返回 503，显式本地草稿返回可识别的 degraded 数据；前端保留既有状态并显示会话降级 | fake `thread/list` failure 回归验证 store、active 和 draft 均保留 |
| P1-2 旧 app-server generation 退出破坏新进程 | child、generation 与 pending 请求绑定；stale exit 被忽略；restart 等待旧进程并隔离总超时预算 | delayed SIGTERM + 新 generation slow request 回归通过 |
| P1-3 webhook header/origin/Caddy 契约不一致 | UI、README、systemd、GitHub、Cloudflare 统一使用 `x-codex-cloud-token`；URL 使用服务端 public origin；Caddy 只豁免 token 保护的 webhook/heartbeat；加入幂等与速率限制 | Bearer=401、自定义 header 进入路由、snippet 静态契约回归通过 |
| P1-4 E2E 污染 session/thread/upload | 测试显式创建并记录唯一 session；记录上传路径；finally 精确删除 session、归档 thread、删除附件并校验错误 | E2E cleanup 删除 2 个附件且无净 session 残留 |
| P1-5 畸形 URL 终止本地代理 | URL 解码与顶层请求增加错误边界；静态路径 realpath/lstat 防越界；client error 返回 400 | 畸形 URL=400、symlink=404、后续请求仍成功 |
| P0/P2 本地入口无响应或错误显示在线 | 健康状态改为严格判定；health/status 不再使用代理缓存；健康请求 8 秒单次 deadline；UI 非权威时显示降级 | 上游不回头部时代理按 deadline 返回 JSON 502 且保持存活；稳定 UI smoke 通过 |
| 本地启动沿用 `/home/ubuntu` | 非 Linux production 默认使用项目内 `.codex-cloud-local`，生产与显式 env 保持原路径 | macOS 隔离生产配置使用临时 workspace 完整通过 API/UI/E2E |
| HTML 500 被写入 transcript | 所有流式入口统一解析 JSON 错误并净化 HTML；未知 API 和 Express error 统一返回 JSON | build/typecheck 与 JSON 404 回归通过 |
| GET 空仓库制造 draft | active/history/thread-state 无 hint 时纯读取；app-server 权威空列表返回稳定空状态 | 连续读取空仓库后 store 中无新增 session |
| smoke 文件残留 | 新增受 `.codex-cloud/uploads` 目录约束的删除接口；API smoke 在 `try/finally` 清理上传与写入文件 | API smoke 的 `smoke file cleanup` 通过 |
| 实例规格显示与 AWS 不一致 | region、public/private IP、instance type 纳入受保护部署 env；目标实例回退值修正为实际 `t3.micro` | AWS `describe-instances` 与状态字段一致 |
| 断链日志阻塞完整 status refresh | 日志 symlink 先做 realpath containment；断链、越界和非文件条目跳过，不再让可选日志阻断核心健康状态 | EC2 隔离 release 在保留断链日志时转为严格健康 |
| 历史审计原因泄漏内部重启文案 | API 展示层把旧原因映射为已归档说明，原始审计文件不改写 | 真实线上审计数据与 seeded regression 均不再暴露旧文案 |
| 自动化运行核验契约与 200 条历史数据不匹配 | 明确返回核验窗口、线程总数、已核验数和 complete；未核验项带显式本地状态 | 线上最近 12 条 thread/read 权威核验通过，完整 API smoke 通过 |
| 收件箱把正常退出与进度文本当作告警 | 正常 SIGTERM/退出码 0 和重复 MCP 登录事件降噪；同类审计只保留最新；worktree/reconnect 进度改为可行动说明 | 线上待处理噪声从 13 条降至 6 条，真实错误、仓库改动、MCP 与诊断提醒保留 |
| 已加载旧线程无法手动切换模型 | 显式模型/推理选择保存为下一回合覆盖，直到 `turn/start` 成功才清除；runtime PATCH 同步失效 thread-state 缓存并阻止旧异步读取覆盖新选择 | 线上浏览器完成 `GPT-5.5 -> GPT-5.4-Mini -> GPT-5.5` 往返，PATCH、按钮标签和权威 thread-state 全程一致 |

## 已执行验证

| 验证 | 结果 |
| --- | --- |
| `npm run verify:cloud` | PASS：schema、4 项 normalizer、TypeScript/Vite build、5 组 regression、31 项 API 检查、UI smoke 全部通过 |
| `CODEX_CLOUD_E2E_REAL_TURN=0 npm run verify:e2e` | PASS：无 console error、无 failed response、无布局溢出/重叠；session 和 2 个附件清理成功 |
| `CODEX_CLOUD_E2E_REAL_TURN=1 npm run verify:e2e` | 外部阻塞：27ms 在 preflight 检出 Codex 额度上限；未创建 session，cleanup 显示 skipped |
| `npm audit --omit=dev --audit-level=high` | PASS：补丁升级后 0 vulnerabilities |
| `bash -n` 运维脚本 | PASS |
| `git diff --check` | PASS |
| 本机 18787 上游失联检查 | 8.01s 返回结构化 HTTP 502，不再无限等待 |
| 线上 `npm run verify:api` | PASS：31 项检查，10 次重复会话/状态读取无 stale fallback，测试文件已清理 |
| 线上 `npm run verify:ui` | PASS：6 个桌面/移动页面无错误、溢出、未命名按钮、加载残留或内部噪声 |
| 线上 `npm run verify:e2e` | PASS：10 张截图，命令面板、上传、粘贴、移动端与精确 cleanup 通过；0 console error、0 failed response |
| 已加载线程模型切换 | PASS：当前会话最终为 `gpt-5.5 / low`；旧 settings 通知和 10 秒 thread-state 缓存不再回滚 UI |
| 公网/Caddy 契约 | PASS：普通入口无 Basic Auth 返回 401；webhook 无 token=401、Bearer=401、正确 header+未知任务=404；`catalystmemo.com`=200 |
| 线上服务 | PASS：`codex-cloud-console`、Caddy、独立 `investor-watcher-codex-analyzer` 均 active |

## E2E 证据

- 通过：[summary.md](frontend-e2e/2026-07-11T00-09-52-266Z/summary.md)
- 通过：[report.json](frontend-e2e/2026-07-11T00-09-52-266Z/report.json)
- 额度阻塞：[summary.md](frontend-e2e/2026-07-11T00-10-26-664Z/summary.md)
- 额度阻塞：[report.json](frontend-e2e/2026-07-11T00-10-26-664Z/report.json)
- 线上最终 E2E：`/tmp/codex-cloud-online-e2e-20260711-final`（10 张截图、trace、summary 与 report）

## 上线与数据保护

- 实例：`i-0ef9c3f3745c1b665`，`ap-northeast-1`，`t3.micro`，弹性公网 IP `13.231.3.21`。
- EBS 快照：`snap-0c65bba4a7a9b39d8`，30 GiB，状态 `completed` / `100%`。
- 实例内完整备份：`/home/ubuntu/codex-cloud/backups/console-predeploy-20260711-133107.tar.gz`，包含发布前源码、完整 state、systemd 和 Caddy。
- 原控制台保留于 `/home/ubuntu/codex-cloud/console.predeploy.20260711-134752`；失败发布副本、systemd/Caddy 备份和每次热修复前文件均保留。
- 数据核对：自动化运行 `200 -> 200`，会话 `28 -> 29`，审计 `300 -> 300`；E2E session `sess-mrg6r9hj-cdfc9275` 与两个 fixture 附件无残留。
- 任务核对：5 个 `codex-auto-*` timer 全部存在，线上 active job 与 active automation run 均为 0；独立分析服务未在部署中停止。

## 剩余外部项

- Codex 当前无可用 credits，真实 turn 和 2026-07-11 13:55 的 memory export 定时运行被额度限制阻塞；失败记录已保留，代码和部署门禁不受影响。
- `cloudflare-api` MCP 当前未登录，控制台保留一条可行动提醒；不影响核心 Codex、仓库、会话和其他 MCP 状态。
- 额度恢复后补跑一次真实 turn，即可补齐计费链路的最终功能证据。
