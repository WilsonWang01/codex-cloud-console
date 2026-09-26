# 个人空间共享登录修复验收

日期：2026-09-26。需求澄清：复用已登录账号，仅按项目与会话区分个人和工作上下文。独立系统用户不是默认要求。

## 修复与 Review

- 原实现把上下文分离扩大为独立 `CODEX_HOME` 和 worker，导致个人空间需要再次登录。默认改为 `shared`，复用主 app-server；已有 `CODEX_PERSONAL_WORKER=1` 部署仍保留原语义，必须显式迁移，防止原个人历史突然不可见。
- 保留不同工作目录、threadId、repoId、草稿和搜索范围；个人线程关闭 Codex 自动 memories，不自动拼入工作会话。原个人只读与审批策略不变。
- 历史 stderr 中的失效令牌错误不再覆盖本次成功认证；本次请求真正发生认证失败仍如实显示。`account/read` 明确返回无账号时，不再以 CLI 的旧状态判定已登录。
- 设置页认证使用当前空间的账号；诊断按项目展示，切换运行模式后不复用旧专用 worker 的诊断或能力缓存。登录完成事件与流程查询在共享模式下共用作用域。
- 专用 worker 的插件列表回退明确路由到原 worker，避免读到工作账号状态。
- 新增实际后端模拟测试时发现 `/api/chat` 引用已删除的 `codexTurnTimeoutMs`，导致请求返回 500。改为等待已有带空闲和总时长上限的任务 promise，不再叠加第二套超时。

## 本地验收

| 项目 | 结果 |
| --- | --- |
| `npm run verify:local` | 通过：schema、normalizers、构建、9 组后端回归、25 项 safety，以及审批、调用方、用量、准入、通知、worker 和 Caddy 测试 |
| 共享运行时后端回归 | 使用模拟 Codex，不调用模型；两空间只初始化一次 app-server，无 `account/login/start`；账号相同但 cwd/threadId 不同，跨项目会话选择返回 404 |
| 旧登录错误回归 | 有历史 `token_invalidated` 时当前账号仍有效；本次 rate limit 请求返回认证错误时仍显示失效；旧专用状态缓存被丢弃 |
| `npm run verify:personal:ui` | 10 项通过：可发送、共享登录、独立草稿、诊断不串项目、授权链接回退、7 个视口及 390px 切换 |
| `npm run verify:safety:ui` | 35 项通过，既有跨项目、草稿、Review 与流式任务行为无回归 |
| 人工截图检查 | 390px 个人空间输入框、发送按钮、模式提示和底栏无重叠或横向溢出 |

## 线上迁移记录

代码提交 `f37ec3b` 已部署到 `/home/ubuntu/codex-cloud/releases/console/20260926T121233Z-1606989`。部署前无进行中对话、压缩、自动化或待审批；30 个原会话、200 条运行记录，个人目录和线程为空。部署后个人与工作账号读取一致且有效，模式 `shared`，个人执行可用，严格健康检查通过。闲置 `codex-personal-worker.service` 已停止并禁用自启，但 `/var/lib/codex-personal` 完整保留。

备份：`/home/ubuntu/codex-cloud/backups/pre-shared-auth-20260926T1220Z.tar.gz`，7,901,679 字节，权限 0600。SHA256：`6e4c890af31c112bb09c424a685c3f8db36b8b6a7d5f604f86564d5249885cc1`。包含控制台状态、旧发布、服务配置、专用 worker 数据及 Caddy 配置；同盘备份不是异地容灾。

首次备份遇到闲置 worker 的 SQLite WAL 正在写入，未将该归档视为成功。确认无个人任务后短暂停止该 worker 完成一致备份，再恢复；未停止工作执行器。没有复制或重置工作 Codex 凭据，没有创建云资源。

最终比对：会话 30 → 30，丢失会话 0，消息历史变动 0；自动化运行 200 → 200，缺失记录 0；Caddy 配置逐字节未变。公网控制台未认证返回 401，原 `catalystmemo.com` 返回 200。控制台和既有投资分析服务均正常运行。

通过本机代理对真实线上页面执行仅 GET 的浏览器检查，个人设置页显示“登录有效 · 与工作空间共用账号”，失效登录提示数量为 0。390px 真实页面也能显示共用账号，无横向溢出。未提交模型请求、未创建测试对话。截图留在本机 `/tmp/codex-personal-shared-live.png` 和 `/tmp/codex-personal-shared-live-mobile.png`，未将含真实账号信息的截图提交公开仓库。

线上诊断另发现 `/home/ubuntu/.npm/_npx` 属于 root，主服务无法创建协议检查缓存。只将 npm 缓存中 root 所有的文件恢复为 ubuntu 所有，不改任务文件或模型凭据；后续部署应使用正确的安装用户与 HOME，避免 root 向 ubuntu 的 npm 缓存写入文件。

最终个人空间诊断返回 HTTP 200：**5 项正常、1 项提醒、0 个问题**。账号、CLI、schema、能力探测和会话列表均通过；唯一提醒是底层尚未开启 Realtime voice/audio，与登录无关。

## 边界

默认是单用户可信部署的上下文分离，不是不同系统用户间的文件保密边界；全局 Codex 配置、Skills、MCP 与账号额度仍共用。未运行收费模型验收，不能据此声称所有个人工具或完整 Personal Agent 路线图已交付。专用模式的双向权限隔离、持久事务队列、硬预算、个人资料能力和外部产品真实接入仍各自跟踪。
