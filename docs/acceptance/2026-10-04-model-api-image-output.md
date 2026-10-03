# 图片输出与 Responses / Images 接入验收

## 完成范围

- 新增 `/api/automations/:id/v1/responses` 和 `/api/automations/:id/v1/images/generations`，复用既有调用方令牌、隔离会话/工作树、幂等、恢复、限流及用量记录。
- Responses 支持图文 input、instructions、reasoning.effort、store:false 和 image_generation 请求；提供原生 image_generation_call Base64 结果及官方 SSE 终态事件。不是完整 Responses 参数透传，也不是实时图片预览。
- Images 返回第一张原生图片的 b64_json、revised_prompt 和实际 output_format；没有图片则 502，不把文字或文件路径冒充交付。
- Chat / Messages 保持原有文本字段，附带明确标为非标准的 codex_cloud.images 扩展。Anthropic 高级流累积器可能丢弃扩展，接入文档推荐原始事件或 Responses。
- 图片导出独立于运行索引，不新增 Base64 持久化缓存；从原 thread 的精确 turn 获取原生图片生成项，不扫描消息文本或其他回合。
- 更新 README、接入说明、部署指南与 Skill；Caddy 仅扩展既有模型 POST 匹配器，本机代理自动复用同一协议路由判断。

## Review 与修复

1. 图片生成权限和费用属于实际 Codex 工具与账号。适配器不自动启用服务、不选新图片模型；size/quality/background/action 等无法兑现的控制明确拒绝。Images 的 model 使用 Codex 主模型 ID，拒绝 gpt-image-* 冒充可独立选择的工具模型。
2. 图片仅来自成功的原生 imageGeneration 项；失败、缺失、未知格式和越界路径返回错误。限制最多 4 张、解码总计 8 MiB；只接受 PNG/JPEG/WebP，拒绝远程 URL、任意文件与符号链接逃逸。
3. 磁盘图片先检查目录边界及 realpath，再用 O_NOFOLLOW 打开、校验普通文件及大小、有限长度读取并复查文件变化。不复制既有生成目录或读取登录凭据。
4. 每个终态读取完整原回合，不再因短文本而漏掉图片。并发读取共享进行中的 Promise，完成后释放，不扩大运行索引。原产物失效时重试报错，不重新执行模型。
5. 返回终态前重新校验令牌，避免读取大结果期间撤销后仍返回内容；断流/超时仍不自动取消后台任务。
6. Responses 流明确只在最终回合完成时输出文本与图片，不伪造 partial image 或模型级 token 预算。Images 的 n=1 只返回第一张，不声称能够限制底层工具生成数量或图片独立费用。
7. 全量回归首次暴露既有限时任务的资源释放时序，独立重跑通过；随后把测试的固定等待补为检查前一个任务已释放 admission，不放宽生产限流。
8. 安装器增加可选的可信本机可执行预切换门禁，在构建后、切换 symlink 前再次检查任务与受保护状态；门禁失败不重启服务、不切换版本，并删除本次未启用的代码目录。失败路径已加入回归。

结构上复用既有任务入口及协议处理器，图片文件与响应转换独立在 model-api-output.mjs；不引入生产依赖、队列、文件存储服务或状态 schema。

## 验收证据

- `npm run verify:local` 最终版本通过，包括构建、schema、安全、个人空间、GitHub 与恢复等全量回归。
- `verify:model-api` 19 组通过：两套官方 SDK；OpenAI Images、Responses create/stream/finalResponse、幂等重放、图片输出与错误终态；Chat/Messages 扩展及原文本行为。
- `verify:regressions` 9 组通过：真实 Express、假 Codex、真实隔离工作树；图片生成结果、空图片错误、精确原 turn、索引不复制 Base64、四条路由预先认证/超大 JSON、本机代理不注入默认共享令牌。
- `verify:caddy-extension` 4 组通过：四条 POST 路由、旧匹配器升级及其他站点/认证路径保留。
- 文件输出检查：直接原生 Base64、已有 generated_images 文件、越界及符号链接、错误状态、格式与体积限制。
- `git diff --check` 通过。既有 502.19 kB chunk 提示不在本轮改动范围；没有前端布局改动，不声称新增手机/桌面视觉验收。

## 发布状态

本地验收完成。预检：34 个保存会话、200 条运行记录，控制台无活动 turn/compaction，无运行中的自动化及定时服务；服务器磁盘可用约 6.7 GiB。GitHub CI、EC2 备份与线上发布结果待补记。

## 客观限制

尚未运行实际付费图片生成，本轮 SDK/协议测试使用模拟图片及假执行器，不证明现有服务器账号的图片额度、工具可用性或生成质量。真实图片验收已另行请求对应授权，未收到确认前不调用图片工具。

尚未提供官方 Images Edits multipart、mask、精确 size/quality、匿名下载 URL、Responses 持久化查询/previous_response_id、文件上传、音视频/PDF和客户端工具闭环。usage 是已有 Codex 回合计量，不保证覆盖图片工具的独立费用。既有 Codex 历史和生成文件仍会保留。
