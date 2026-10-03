# OpenAI / Anthropic 协议适配验收与 Review

## 完成范围

- OpenAI Chat Completions 与 Anthropic Messages 文本子集；官方 SDK 的非流式和 SSE 文本消费。
- 独立调用方令牌作用域、稳定事件幂等、隔离 Git 工作树、真实模型与推理参数传递。
- 请求/等待连接/输出大小上限，HTTP 等待超时，断线释放等待，流中撤销令牌，失败终态不会发送成功收据。
- 原异步任务入口保持原认证契约；协议入口才支持 Bearer/API key；本机代理不注入默认登录令牌。
- 两条精确 POST 公网代理规则与配置候选工具，保留其他站点和控制台 Basic 认证。
- 接入文档、README、部署指南及配套 Skill 更新。

## Review 与修复

1. **长答案截断**：运行索引只保存 4000 字符。修复为保存精确 turn ID，并在需要时从原 Codex 回合读取完整文本；不扩张运行索引或新增结果文件缓存。5000 字符首次与幂等重放一致，选择原回合时不混入后续 Heartbeat。
2. **认证覆盖**：本机代理原先用默认 Basic/共享令牌覆盖外部调用。协议路径改为保留调用方身份，缺少独立令牌不能借本机默认登录运行模型。
3. **流式可靠性**：增量读取提供背压、有限等待和监听清理；超时、失败、取消、待核对不输出成功终止；4 个等待连接/调用方、32 个/进程。
4. **虚假预算兼容**：不静默接受无法应用的 `max_tokens`；默认 400，必须显式确认“不应用输出上限”。不声称限制了模型成本。
5. **虚假用量**：实际 Codex 用量按协议转换，未知为 null；官方两套 SDK 的未知用量行为已验证，不记作零。

结构上只有独立协议模块和既有提交函数的返回值抽离，复用原执行、持久化、权限和幂等逻辑。SDK 只用于开发验收，生产执行不新增 SDK 依赖。

## 本地证据

- `npm run verify:local`：通过（schema、构建、回归、安全、审批、客户计量、个人空间与 GitHub 工作流等全量检查）。
- `npm run verify:model-api`：11 组通过；官方 OpenAI SDK 7.27.0、Anthropic SDK 0.131.0，内存执行器，不访问官方模型 API。
- `npm run verify:regressions`：9 组通过；真实 Express 和假 Codex app-server，含两套协议、完整结果、持久化、隔离工作树、超长输入、非法 JSON、作用域与撤销。
- `npm run verify:caddy-extension`：4 组通过；新增规则精确、原站点不变。
- `git diff --check`：通过。
- 构建已有主 chunk 502.19 kB 提示仍在，本轮无前端视觉改动，不宣称做了新增手机/桌面布局验收。

## 发布状态

- 功能提交 `1d15d9e3780c416ec8823e17e99648f35ae1cc7f` 已推送 `main`；[GitHub CI](https://github.com/WilsonWang01/codex-cloud-console/actions/runs/37142141964) 通过。
- EC2 当前版本为 `/home/ubuntu/codex-cloud/releases/console/20261003T180139Z-2546303`；发布退出码为 0，服务端协议模块 SHA-256 与提交源码一致。
- 发布前检查无 queued/running/canceling 自动化、无运行中的定时服务，保存会话 34 个、运行记录 200 条。没有修改既有定时器、Codex 登录或个人 worker 配置。
- 发布前备份位于 `/home/ubuntu/codex-cloud/backups/pre-model-api-20261003T175432Z/state-personal-config-release.tar.gz`，大小 1,040,641 字节，SHA-256 为 `39a43e938129d2487b1571bfbbc9d12b01ac6c282c8db4ad573dc8cdb4906a0c`，已校验；包含状态、个人空间和原服务配置。
- 成功发布及清理后，`chat-history.json`、`automation-runs.json`、`personal-commitments.json` 的大小与 SHA-256 均与发布基线相同；原来不存在的个人事实/例行任务文件仍不存在。工作仓库、工作树和 Codex 会话数据未删除。
- 公网与本机代理 `/healthz` 均为 200，`strictOk:true`、`partial:false`。两条协议 POST 使用刻意无效的令牌均返回 401 和对应协议 JSON 错误，不出现浏览器 Basic 认证提示，不借用本机默认登录身份。
- 已刷新既有本机代理。确认旧代码没有进程占用后，只删除旧 release 和本次临时源码/安装包；保留已校验数据备份、配置备份、发布日志与清单。

第一次发布门禁把部署单元说明中的文字误识别为定时服务，应用代码尚未切换即停止；旧服务恢复后健康正常。检查改为只判断实际 systemd 单元名，并收紧回退条件，更新发布基线后第二次发布成功。两次日志均保留，不将第一次尝试记为成功。

部署验收只做健康、认证与数据完整性检查；协议成功/流式/重放由前述官方 SDK 和真实 HTTP 的假 Codex 测试覆盖，没有为了上线验收额外运行付费模型。

## 客观限制

不是完整 OpenAI/Anthropic 模型 API。未提供 Responses、模型列表、多模态、客户端工具回传、采样控制、JSON Schema 或原生输出 token 预算。角色文本转换为 Codex 对话记录，不是原生消息通道；Anthropic 未知用量 null 是明确的兼容扩展。默认权限由已有服务器策略决定，不是面向不可信租户的隔离沙箱。

未做新的付费模型回合，未发送邮件、改日历或第三方数据。真实模型的账号可用性、延迟与计费仍应在明确预算的业务试运行中验证。

另有既存小时任务引用旧代码绝对路径的问题，不属于协议适配：本轮未重启或改写该任务，避免未经确认恢复持续模型消耗。
