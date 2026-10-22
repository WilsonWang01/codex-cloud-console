# 私有结果与文件交付

先查询 `GET /api/automations/:id/v1/capabilities`，确认 `features.result_manifest` 和 `artifact_download` 为 true。这里是 Codex Cloud 的异步任务扩展，不是 OpenAI `/v1/files`，也不开放任意服务器路径。旧版本接收的任务不会补造交付副本。

## 请求生成文件

从“调用与用量”创建仅绑定所需自动化的调用方令牌，设置有效期。令牌放在请求头，不放在 URL、Git 或网页中。提交会运行模型、可能消耗额度；应先确认任务、工具和权限。

```bash
curl --fail-with-body "$CODEX_CLOUD_URL/api/automations/$AUTOMATION_ID/webhook" \
  -H "Authorization: Bearer $CODEX_CLOUD_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: report-20261023-event-001' \
  -d '{"prompt":"整理已知资料，生成 results/report.md，并给出简短结论。不要操作第三方服务。","worktree":true,"artifactPaths":["results/report.md"]}'
```

保存响应中的 `run.id` 和 `resultPath`。相同业务事件重试必须保持事件键和输入不变，换 `artifactPaths` 也会返回 409。不要为了绕过失败而生成新键。`completed` 才是任务完成；`delivery.ready` 表示副本已保存，`expiresAt` 是截止时间，过期的状态查询会显示 `expired`。

`artifactPaths` 最多四个普通相对文件路径，单项最多 500 字符、32 段。允许 txt/md/json/csv/html/pdf/png/jpg/jpeg/webp；拒绝绝对路径、越界、隐藏/系统目录、链接、管道等特殊文件。模型须在隔离工作树里新增文件或改变其内容；不能把未改变的旧文件当作本回合生成。类型按扩展名标记，不保证报告的业务质量或文件语法正确。

首批[内联文件输入](file-inputs.md)已提供 txt/md 和静态图片，先查部署能力。本接口允许交付 PDF 文件，不等于接受 PDF 输入；音视频、远程 URL 抓取及客户端工具协议仍不支持。

## 取回清单与副本

用同一调用方令牌读取响应里的 `outputPath`，或构造下方路径。支持 `Authorization: Bearer`、`x-api-key` 或 `x-codex-cloud-token`；同时给多种头时值必须相同。任务提交、查询、取消也支持这些头，认证方式不改变自动化或运行归属。

```bash
curl --fail-with-body "$CODEX_CLOUD_URL/api/automations/$AUTOMATION_ID/runs/$RUN_ID/output" \
  -H "Authorization: Bearer $CODEX_CLOUD_API_TOKEN"
```

清单包含完整文本、结构化验证结果、原回合 ID、保存/到期时间、来源及文件列表。文本最多 4 MiB，不拿 4,000 字符摘要冒充全文。来源只取原回合明确的原生网页打开/查找动作，最多 100 项，不从模型正文猜引用。图片只取同一回合成功的原生 imageGeneration 项。

每个产物有不透明 ID、文件名、MIME、字节数、SHA-256（内容摘要）、来源证明和鉴权下载路径。`requested-path-changed-during-run` 表示本轮请求路径的内容新增/变化；`native-image-item` 表示原生图片项，两者不是同一种证据。清单没有大段 Base64，也不含工作树、线程或主机文件路径。

下载是同源 `GET /api/automations/:id/runs/:runId/output/files/:fileId`，仍需相同调用方身份。不能读其他调用方/运行的文件，也不能用清单 ID 下载内部清单文件。令牌在读取后、发送前再次检查。文件只有附件响应，即使 HTML 也不会在此接口内联执行；用户自行打开下载文件仍需信任来源。服务不支持 Range 分段下载或匿名公开 URL。

服务端核对大小与 SHA-256，返回 `X-Content-SHA256`。调用方也应核对，确认后再保存到业务存储。到期或网络失败只重试读取，不因此启动新模型。原工作树文件删除不影响已保存的副本；副本本身丢失/被改动则报错，不静默取别的回合或重跑。

## Node 与 Python 示例

参考客户端不导入服务器模块，只用标准 HTTP。它们拒绝重定向，忽略服务器传入的外部下载 URL，按自身的自动化/运行/文件 ID 构造同源路径，验证字节数、响应哈希与清单哈希。CLI 下载要求明确目标，已有文件不会覆盖。

```bash
node scripts/external-client-example.mjs output "$AUTOMATION_ID" "$RUN_ID"
node scripts/external-client-example.mjs download "$AUTOMATION_ID" "$RUN_ID" "$FILE_ID" ./report.md

python3 scripts/external-client-example.py output "$AUTOMATION_ID" "$RUN_ID"
python3 scripts/external-client-example.py download "$AUTOMATION_ID" "$RUN_ID" \
  --file-id "$FILE_ID" --output ./report.md
```

Node 库调用 `runExternalClient({command:"download", automationId, runId, fileId, origin, token})` 返回 `{artifact, buffer}`，不自行写盘。继续使用总等待时限、有限重试和取消信号；本地超时不取消服务器任务。Python 客户端使用标准库和总时限检查，网络单次阻塞也受最长 15 秒的 socket 超时约束，退出可能略晚于总时限。生产严格时限优先用 Node 示例。

模型协议仍按原格式返回文本/图片。新接收的模型协议任务也保存副本，重放不依赖原生历史仍可读；从 `x-codex-cloud-run-id` / `x-codex-cloud-result-path` 响应头可继续查询清单。原生图片仍最多四张、解码总计 8 MiB，工具和账号不可用不会假装生成成功。

## 限额、保留与错误

- 每份文件最多 8 MiB，最多四份请求文件加四张原生图片；清单与文件总计最多 20 MiB。不是模型输出 token 或费用硬上限，超限不会截断后报告成功。
- 接收时在任务和幂等键的同一数据库事务内预留 20 MiB；保存成功后按副本实际字节占用。默认全局 256 MiB、每调用方 64 MiB；磁盘可用空间还须覆盖已有预留、本次预留及 128 MiB 余量。这里限制的是交付逻辑字节，不是整个服务器的磁盘配额；数据库、日志、备份和原始历史另占空间。
- 小结果也受记录数限制：默认全局最多 4,096 份、每调用方 1,024 份，包含尚未清理的到期记录。全局列表只取最近 200 份终态及所有活动/待核对任务；旧运行按 ID 查询、原事件键重放和按调用方续接不依赖该列表。裁剪列表前会核对终态计量，避免少算历史用量。
- 默认从结果开始保存起保留 24 小时，不短于幂等配置；原事件键延长到对应截止时间，失败/取消也保留已接受事件的重放凭据。截止时间以 `expiresAt` 为准；不能承诺窗口外重新 POST 同一键仍不会创建新任务。
- 每分钟及新接收前分批清理到期副本；到期立即拒绝新读取，实际删除可能延后。只删本模块创建的交付副本，不删原工作树、原生图片/历史或用户附件。未领取的取消可释放预留；待核对执行保留副本及其预留，需要管理员核对，不自动重跑或释放。过期清单元数据还可保留约一个保留周期，之后可能从 410 变为 404。
- 个人文件与 API 文件共用每进程最多两份缓冲下载，专用 worker 另算；慢响应两分钟关闭。结果轮询、发现与下载共用每调用方每分钟 60 次限制，忙时/限流应按 `Retry-After` 退避。

常见结果：401 令牌缺失/冲突/撤销/过期/范围不符；404 不存在或不属于本调用方/历史未保留；409 未成功交付；410 已到期；429 队列/容量/频率受限；503 存储、完整性或下载并发问题。新接口错误包含 `ok:false`、中文 `error` 和稳定 `code`。失败、缺失、到期都不等于允许重复外部动作；先查询已有运行。

可选服务器配置：`CODEX_RESULT_RETENTION_MS`（有效值至少等于幂等期，最长 32 天）、`CODEX_RESULT_MAX_BYTES`、`CODEX_RESULT_CLIENT_MAX_BYTES`、`CODEX_RESULT_MAX_RUNS`、`CODEX_RESULT_CLIENT_MAX_RUNS`。旧任务沿用接收时的保留期，改配置不自动延长旧副本。升级涉及新数据库表/任务格式；先确认空闲、备份 SQLite 和整个 state 目录并验证恢复。不要只复制活动 SQLite 主文件，也不要只备份元数据却漏掉交付目录。

已有 Caddy 部署需用 `ops/extend-caddy-automation-routes.mjs SOURCE CANDIDATE --artifacts` 生成并验证候选，再经安全发布切换；脚本本身不覆盖现有配置。它只扩展原 GET 结果匹配器，其他管理入口仍保留原认证。新部署模板已含该匹配器。本机代理也须同步升级，不能把外部令牌替换成管理员令牌。

隔离工作树、私有副本和调用方范围不是操作系统沙箱；执行器仍可能共用账号与系统用户。只向受信任服务开放。真实模型质量、真实图片工具可用性和生产文件生成闭环须另行验证，模拟测试通过不能替代这些证据。
