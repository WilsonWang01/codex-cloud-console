# A03.1 结构化 JSON 输出验收

日期：2026-10-23，Asia/Shanghai。代码 `e72f36cb623fd041ba5e753eef5ed70326828d06` 已推送 main；[CI 39849914760](https://github.com/WilsonWang01/codex-cloud-console/actions/runs/39849914760) 全量通过。EC2 与本机代理已发布该提交。这里只交付 A03 的 JSON 部分，受限文件输入、产物清单/下载及 M2 独立客户端完整闭环尚未完成。

## 交付范围

异步 Webhook/Heartbeat 增加 `outputSchema`；OpenAI Chat `response_format.json_schema`、Responses `text.format` 和 Anthropic 协议 `output_config.format` 映射到同一原生字段。请求格式先校验，再原生传入 CLI；回合结束后读取精确原回合的最终消息，用 Ajv 验证真实 JSON，不能拿截断摘要或评论拼接冒充结果。

成功结果随运行保存为 `structuredOutput.status=validated`、格式哈希和完整 `data`。同键换 Schema 返回 409；原 Schema 在执行期间不可变。格式错误、字段不符、结果过大或无法定位原回合都不报告结构化成功，不自动再运行模型修复。

- 格式限制：16 KiB、8 层、128 节点、根对象；所有对象声明完整 required 与 additionalProperties:false。支持基础类型、可空类型、标量 enum/const 和有限上下界；引用、组合、正则/format 等明确拒绝。
- 结果上限 64 KiB，不转换类型、不补字段、不剥离围栏；编译缓存最多 32 项。加入 Ajv 8.20.0 及其必要依赖，不手写 JSON Schema 验证器。
- 结构化 SSE 缓冲至完整验证后发送，错误不发送正常成功结束标记。普通文本和已有图片协议保持；结构化格式暂不能与 Responses 图片生成工具组合。
- Token 上限仍不能兑现；结果大小限制不是模型费用上限。Anthropic max_tokens 仍需要原有显式确认头。
- 任务格式标记 1 -> 2，不改变原行、ID、归属或领取代次。有任务数据时拒绝退回不理解格式的旧执行器；只有任务/幂等表均为空的 2 -> 1 才可在发布锁内恢复标记，不清空或覆盖数据。
- 能力发现增加结构化限制、持久队列及实际并发配置、待核对键的保留边界；文件下载仍明确 false。

用法及 SDK 字段见[结构化结果](../structured-output.md)、[后端接入](../backend-integration.md)和 [OpenAPI](../openapi.json)。没有新增公网路由、AWS 资源或业务权限。

## 自动化与 Review

本地 verify:local 全量通过；最后的回退保护/轻量代理拆分另复跑接收与完整回归。最终 CI 在 Node 22/Linux 上全量通过。

- 模型协议/发现/Schema 套件 29 项通过；官方固定版本 SDK 的 Chat、Responses、Messages create/parse 路径通过，结构化流没有泄漏未验证的进度文本。
- 真实 Express + 模拟 Codex 验证 native outputSchema 实际收到、完整 JSON 超过原摘要长度仍返回、原键重放、换 Schema 冲突、无效结果失败及错误 SSE 不发 DONE。异步客户端直接取得完整结构化对象。
- 存储/预算/接收套件本机 25 通过、2 项 Linux 跳过；EC2 Node 22.22.1 上全部 27 项通过、0 跳过。覆盖格式升级不改旧行、原 Schema 不可变、结果重开、空表受控回退、非空或未知格式拒绝回退。
- 本机与 EC2 运行真实 CLI、私有空白 HOME、loopback 模拟 provider，实际捕获图片和 JSON Schema 请求；验证 text.format.schema/strict 已序列化。模拟 provider 故意返回 400，不把它算作真实推理成功或付费模型调用。
- 独立运行时包安装/加载通过，依赖占用 26,393,928 字节；生产依赖审计 0 项。本机轻量代理不含 node_modules，实际临时启动并读取正确版本后关闭。

Review 修正并保留测试：新 Schema 必须加入幂等摘要；已接收格式不可被迟到更新修改；结构化流必须先验证；原回合只选唯一 final_answer、不能拼接评论；Schema 格式迁移须防旧执行器忽略字段；轻量代理只引入无依赖的路由识别模块，不能间接加载服务端 Ajv。

## 真实账号实测

在 EC2 空白测试目录启动独立 CLI，复用原账号但不复制认证文件，不修改全局配置。只读、工具禁网，搜索关闭，逐项检查连接服务禁用，再开始一次固定 JSON 回合。

前 3 次准备检查均在模型启动前停止：空连接表覆盖并未去掉合并配置、带引号的覆盖键无法启动，以及把配置清单数量误当成活动服务数量。修正测试方法后，同时确认有效配置为 disabled、具体线程的 runtimeStatus 为 disabled；配置中仍列出 1 项，但活动连接服务为 0。没有为通过测试扩大权限或改动全局配置。

第 4 次检查后仅启动 **1 次模型回合**：请求 `gpt-6-sol / medium`，约 6.5 秒完成，精确最终 JSON 为固定验收对象。没有工具活动或第三方写入。CLI 单回合计量：输入 14,450、输出 17、合计 14,467 tokens；不是美元账单，也不是整个账号的计量。前 3 次均 modelAttempted=false，不把它们说成失败的模型推理。

原生测试线程 `01a16551-f60f-76b0-b703-16cc2402616a` 与回合 `01a16551-f6f2-7153-9131-c5c115e216d2` 的证据保存在私有 staging JSON，线程历史保留，未删除原会话。这只证明当前账号这一次指定模型请求成功，不推广为所有目录模型可用。测试通过原生 CLI，不是生产独立令牌的完整 HTTP 链路；后者仍需单独验收。

## 发布与数据

EC2 发布目录 `20261022T203949Z-3935682`，来源精确且干净，独立发布单元退出码 0。发布前及停旧服务后确认空闲和状态未变化，严格健康 strictOk=true / partial=false，活动任务及压缩任务均为 0。

备份 `/home/ubuntu/codex-cloud/backups/pre-a03-structured-20261023` 实际解包并打开一致性 SQLite 恢复核对：10 项受保护状态、4 份配置和个人目录不变，34 会话、200 旧运行保持。SQLite 任务格式标记升级为 2，任务/键/近期用量仍各 0，修订仍为 0。原生实测在自动化账本范围之外，页面的近期外部任务 0 不能理解为账号没有刚才那次消耗。

- 升级前 SQLite SHA-256：`9d0a0a08f6703cc4979eadc63d13c6d5bc267a9a6e4121648821579476318dbe`。
- 状态/个人/配置归档 SHA-256：`e3b48ead6e2b0c9fd34f054a627a2e0f557aead8447871d4fb10ceb0fdd6ede9`。
- 原代码归档 SHA-256：`f37a3936fab84f23c8fce1b5a366b9f1f41a8a489f076d1808f1088f4ee5213c`。
- 上线后 state-after-release.sqlite 一致性备份再次通过；备份同盘，不是异地容灾。

本机复用原 LaunchAgent，正确重新加载到 `~/.codex/cloud-console-runtime/a031-e72f36c/`；仍是 127.0.0.1:18787。原 plist 保存在 `~/.codex/cloud-console-backups/a031-structured-20261023/before.plist`。本机与 EC2 提交及后端、代理、锁文件、HTML 四项哈希完全一致，HTML 200，没有新装常驻服务。

核对备份哈希、严格健康和无打开文件后，删除旧发布代码 `20261022T195119Z-3926323`，回收 36,944 KiB；移除本轮候选目录临时安装的 node_modules，再回收 30,996 KiB。原业务数据、官方历史、配置及备份保留。

## 未完成

尚未运行生产独立令牌的 JSON/文件闭环；上一枚只读验收令牌已撤销，已另行请求最多两个单自动化短期令牌的受限验收授权，未创建新令牌。受限文件输入、产物清单/下载、真实图片输出链路及 M3-M5 继续推进。

本轮无新前端控件。内置浏览器刷新后实际读取到在线、原账本起始与 UTC/覆盖提示，以及旧测试令牌已撤销状态；同步期间暂有默认示例自动化标签，记入 A05 优化，不当成真实配置。页面内容读取和 HTTP 可用性与生产视觉截图不同；本次截图仍返回 Cannot take screenshot with 0 width，不能说已完成生产视觉、真机或七天验收。原上游服务目录 403 仍未消失。总体 goal 保持 active。

私有脚本与证据在忽略目录 docs/research/acceptance/a03-structured-2026-10-23/ 及 EC2 staging/backups，不上传凭据、备份或私人状态。
