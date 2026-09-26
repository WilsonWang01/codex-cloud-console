# 部署、配置与外部接入

先阅读 [README](../README.md) 了解功能和基本使用。本指南面向需要部署或集成控制台的维护者；示例均为占位信息，不要照搬真实凭据到仓库。

还没有服务器，或不清楚账号注册、免费计划与配置如何选择？从 [AWS 从零部署指南](aws-getting-started.md)开始；也可使用仓库内的 [codex-cloud-setup Skill](../.agents/skills/codex-cloud-setup/SKILL.md)逐步引导。创建资源和实际安装是不同步骤，阅读指南不构成付费或影响现有服务的授权。

## 服务器部署

参考环境为 Ubuntu、`ubuntu` 服务用户、Node.js 22+、Git、Codex CLI 和 systemd。其他 Linux 主机也可按需调整；安装脚本不会创建 EC2、配置 DNS、安全组或自动安装 HTTPS 代理。

> [!WARNING]
> 云资源、模型和第三方工具可能产生费用。部署脚本会重启控制台，成功后默认清理旧发布目录。首次部署或更新前，先确认运行中任务、备份状态及工作区，不要将重要数据放在发布目录内。

### 1. 准备源码与服务账号

使用 `ubuntu` 用户在参考源码目录检出本项目：

```bash
git clone https://github.com/WilsonWang01/codex-cloud-console.git /home/ubuntu/codex-cloud/console
cd /home/ubuntu/codex-cloud/console
node --version
codex --version
codex login status
```

首次安装前，Codex 必须在该服务用户下完成登录；无桌面环境可参考 [Codex CLI 官方文档](https://learn.chatgpt.com/docs/codex/cli)中的设备授权方式。核对 [systemd 单元](../ops/codex-cloud-console.service) 中的 `User`、`ExecStart`、`PATH`、`HOME` 和 `CODEX_HOME`；交互式终端使用的 nvm 路径不一定对 systemd 可见。

### 2. 配置环境与真实项目

第一次部署时创建环境文件；文件已存在则**不要覆盖**：

```bash
sudo test -e /etc/codex-cloud-console.env || sudo install -m 600 ops/codex-cloud-console.env.example /etc/codex-cloud-console.env
sudoedit /etc/codex-cloud-console.env
```

至少设置以下内容：

- `CODEX_CLOUD_PUBLIC_ORIGIN`：实际 HTTPS 入口，例如 `https://console.example.com`。
- `CODEX_CLOUD_WEBHOOK_TOKEN`：随机、非示例的服务端令牌，至少 16 个字符；不要与网页登录密码混用。
- `CODEX_CLOUD_REPOS_CONFIG_B64`：主机上实际存在的项目列表，替换 `sample-*` 示例。配置方法见下一节。
- `CODEX_CLOUD_AUTOMATIONS_CONFIG_B64`：任务定义。暂不需要定时运行时，可使用下一节的手动任务示例，它不会自动执行。当前自动化页尚未处理空任务列表，请保留至少一个有效任务。

不使用外部站点桥接时，移除模板中的可选桥接占位配置。该环境文件由 systemd 读取；开发启动不会自动加载它，后端也没有 `.env` 自动加载逻辑。开发时需将服务端变量导出到启动进程，不要把秘密放入前端的 `VITE_*` 变量。

### 3. 安装并检查服务

在源码根目录运行，显式传入源码位置：

```bash
bash ops/install-systemd.sh "$PWD"
sudo systemctl status codex-cloud-console.service --no-pager
curl --fail http://127.0.0.1:8787/healthz
```

安装器需要 sudo 权限；新目录构建通过后切换版本，严格健康检查要求 `strictOk=true` 且 `partial=false`。未登录 Codex、app-server 启动失败或配置中的仓库不存在，都可能导致部署回滚。

参考目录结构：

```text
/home/ubuntu/codex-cloud/
  console/                 源码检出
  console-current          指向当前发布目录的符号链接
  releases/console/        可替换的程序版本
  workspace/               项目代码与附件
  worktrees/               自动化隔离工作区
  state/                   控制台持久状态
  logs/                    运行日志
```

Codex 数据另存于服务用户的 `CODEX_HOME`。代码回滚不等于数据备份；不要删除 `workspace`、`worktrees`、`state` 或 `~/.codex` 来释放发布包空间。

### 4. 配置远程访问

Node 服务保持监听 `127.0.0.1:8787`，公网前面放置有身份认证的 HTTPS 代理。参考 [ops/Caddyfile](../ops/Caddyfile)；域名、证书联系邮箱、Basic Auth 用户和密码哈希需要按实际环境配置。

Caddy 的环境变量需在 **Caddy 服务**中设置，不会自动继承控制台的 EnvironmentFile。参考配置让自动化 Webhook/Heartbeat，以及精确匹配的运行结果 GET、取消 POST 绕过网页登录；这四类请求仍必须携带专用令牌，其他页面和 API 保持入口认证。更改代理规则后需在测试环境校验路径匹配与认证。

不要开放公网 `5174` 或 `8787`。EC2 主机管理入口可参考 [SSM / SSH 指南](aws-instance-access.md)。

### 更新版本

先备份持久数据、检查任务状态及源码是否有本地修改，再在源码目录更新到目标提交，重新运行 `bash ops/install-systemd.sh "$PWD"`。不要直接在当前发布目录覆盖文件或删除正在使用的依赖。

安装器构建时安装开发依赖，构建后只保留生产依赖；失败时可回退到仍存在的前一版本。通过健康检查后默认只保留当前发布包；需要额外保留时，通过 `CODEX_CLOUD_KEEP_RELEASES` 指定正整数。此参数不负责备份业务数据。

## 项目与自动化配置

通过界面新建或克隆的项目会保存到状态目录。需要接入主机已有目录时，可通过 `CODEX_CLOUD_REPOS_CONFIG_B64` 提供项目数组；相对路径基于 `CODEX_WORKSPACE_ROOT`，绝对路径直接使用指定位置。

下面的命令只生成配置值，不会克隆仓库或运行任务；先把路径改成实际已存在的 Git 仓库：

```bash
node --input-type=module -e '
const repos = [{ id: "my-app", name: "my-app", path: "/home/ubuntu/codex-cloud/workspace/my-app", accent: "teal" }];
console.log("CODEX_CLOUD_REPOS_CONFIG_B64=" + Buffer.from(JSON.stringify(repos)).toString("base64"));
'
```

对应的手动自动化定义示例：

```bash
node --input-type=module -e '
const tasks = [{
  id: "my-app-review", name: "项目检查", repoId: "my-app",
  mode: "on-demand", timer: null, service: null, schedule: "手动运行",
  model: "gpt-5.6-terra", reasoning: "medium",
  prompt: "只分析项目和测试结果，列出需要关注的问题，不修改代码。"
}];
console.log("CODEX_CLOUD_AUTOMATIONS_CONFIG_B64=" + Buffer.from(JSON.stringify(tasks)).toString("base64"));
'
```

将所需输出写入服务器 EnvironmentFile，安排安全的服务重启后生效。Base64 只是为避免 systemd 的引号解析问题，**不是加密**，不要在提示词里放凭据。

定时运行另需配置 systemd `.service` / `.timer`，并在任务定义中填写对应名称；`schedule` 字段只是显示文案，不会自动创建日程。仓库提供 [API runner](../scripts/run-cloud-automation-via-api.mjs) 和[安装辅助脚本](../ops/install-automation-runner.sh)，但不自动为示例任务安装定时器。

## 自动化接入

先完成任务定义、HTTPS 和 `CODEX_CLOUD_WEBHOOK_TOKEN` 配置。下面请求会真正启动任务并消耗模型额度；替换 URL、任务 ID 和事件 ID 后再执行，令牌从本机安全的环境变量注入。

```bash
curl --fail-with-body -X POST "$CODEX_CLOUD_URL/api/automations/my-app-review/webhook" \
  -H "x-codex-cloud-token: $CODEX_CLOUD_WEBHOOK_TOKEN" \
  -H "Idempotency-Key: your-unique-event-id" \
  -H "Content-Type: application/json" \
  -d '{"runner":"app-server","worktree":true}'
```

同一业务事件重试时复用幂等键，新任务使用新键。工作区隔离依赖至少已有一次提交、能够解析 `HEAD` 的 Git 仓库；刚创建的空项目需先完成初始提交。不要把隔离工作区视为权限沙箱。结果可在“自动化”的运行历史、关联会话和日志中查看。

需要继续现有会话时，用 `/api/automations/my-app-review/heartbeat`。旧共享令牌请求可提供属于该项目的 `sessionId`；独立调用方默认选择**本调用方、此自动化**最近一条带会话的运行，仅在它已完成且原线程和隔离工作树仍可验证时继续。独立调用方若显式提供 `sessionId`，也必须属于自己的运行；没有历史运行时从新隔离工作树开始。前一运行失败或待核对时先人工检查，不能自动续跑。Heartbeat 只提交一次任务，周期由调用方负责。

可选 `completionContract` 示例：

```json
{
  "runner": "app-server",
  "worktree": true,
  "completionContract": {
    "version": 1,
    "type": "exact-final-line",
    "marker": "MAINTENANCE_RUN_COMPLETE"
  }
}
```

设置后，当前轮输出的最后一个非空行必须精确匹配 marker 才被判为完成。marker 需为 8–80 个字符的大写 ASCII 标记；不支持正则、脚本或可执行断言。缺失标记会记为失败并进入待关注事项；同一幂等键不会自动重跑。先检查结果，再决定是否用新键重试。

### 独立调用方

在已通过网页登录认证的控制台打开“调用与用量”，输入服务名、勾选它允许触发的自动化，再创建令牌。令牌只显示一次；服务端只保存 SHA-256 摘要，需在调用方自己的安全配置中保存明文。创建令牌不会运行模型，实际触发 Webhook/Heartbeat 会运行既有自动化，需先确认模型额度和任务影响。

调用方使用 `x-codex-cloud-token` 提交令牌，并为每个业务事件提供 8–160 字符的 `Idempotency-Key`。同一服务重试同一事件时复用该键；同键不同请求会返回 409，失败终态也不会被静默重跑。独立调用方不能指定 `worktree:false`；所授权仓库需要可解析 `HEAD` 的 Git 提交。令牌仅能触发创建时选择的自动化、读取和请求取消自己的运行，不能查看管理页面或批准自己的任务。旧共享令牌仍兼容，统计中标记为 `legacy-shared`，不会被当作某个新服务。

触发响应中的 `run.resultPath` 是只含任务 ID 的结果地址。调用方携带**同一令牌**向该路径发送 GET，读取状态、摘要、已知 token 用量及错误；向 `${resultPath}/cancel` 发送 POST 可请求取消。运行中的取消返回 202，只有模型确认中断后才进入 `canceled`，已发生的外部动作不能撤销。结果查询每个令牌每分钟最多 60 次，超限返回 429 和 `Retry-After`。跨调用方结果/取消返回 404，撤销令牌后返回 401；未认证查询不进入应用层请求曲线，避免公网请求撑大指标文件。

独立令牌的项目范围、隔离工作树和并发限制**不是操作系统沙箱**：当前执行器仍与控制台共用系统用户、Codex 进程和环境。不要把令牌给不受信任的服务，也不要让外部输入直接驱动有高权限的任意命令；对外开放前需要独立 worker、最小权限和出站边界验收。旧共享令牌权限更宽，应迁移为独立令牌并按需撤销。

调用明细按 UTC 日期追加到 `state/api-request-metrics/*.ndjson`，默认清理超过 30 天的**新增指标日志**；令牌元数据在 `state/api-clients.json`，自动化运行和旧任务仍在原状态文件中。用量仅在协议提供完整单轮快照时记账，缺失的运行显示“未知”，不据此估算费用。升级部署前备份整个状态目录；本次没有授权自动清理已有任务、会话或附件。

> [!WARNING]
> 真实审批已替换旧版会话级自动同意。无人值守任务遇到命令、文件或权限请求会暂停等待操作人，超时后拒绝；部署新版后端前检查任务与通知路径并安排验收。个人空间的 `CODEX_PERSONAL_PREVIEW=1` 仅供非生产开发。生产执行只有在专用 worker 安装并通过验收后才开启；旧工作执行器有 sudo，仍非双向隔离。

### 个人空间专用 worker

可选安装仅适用于 Linux/systemd 的单机部署。先备份控制台 `state`、当前发布目录与服务配置，确认没有运行中的对话和自动化。安装脚本只新建 `codex-personal` 系统用户、私有 `/var/lib/codex-personal` 和 Unix Socket 服务；不复制现有 `~/.codex`、工作目录或登录凭据，也不创建 AWS 资源。

```bash
sudo bash /home/ubuntu/codex-cloud/console-current/ops/install-personal-worker.sh
sudo systemctl status codex-personal-worker.service --no-pager
sudo systemctl restart codex-cloud-console.service
```

安装脚本为控制台添加 `CODEX_PERSONAL_WORKER=1` drop-in。个人 worker 的 `HOME/CODEX_HOME` 与工作账号分开，服务使用 `ProtectHome=yes`、只允许写自己的状态目录，阻断实例元数据地址与本机 TCP 管理端口。切到“个人”，在设置里为**个人空间**单独执行设备码登录；工作空间的登录保持不变。安装后先用无秘密夹具核对专用账号、Socket、工作目录不可读、元数据和本机管理端口不可达，再做一次可计费的最小模型任务。未登录时个人任务会明确失败，不会自动借用工作账号。

这只隔离个人执行器到工作数据的方向。现有 `ubuntu` 工作执行器有 sudo，能读取个人状态；在迁移工作执行器到低权限用户并验收前，不要把个人空间用于需要防范工作任务读取的秘密。服务重启会打断运行中任务，先检查任务再操作；回滚控制台时停用个人 drop-in 即可，**不删除** `/var/lib/codex-personal`。

## 本机便捷入口

已有认证 HTTPS 服务时，可以在自己的受信任电脑上保存入口凭据，由本机代理代为认证。这不是免认证后门，也不会让 Codex、AWS 或 MCP 的授权永不过期。

创建权限为 `600` 的 `~/.codex/cloud-console-https-credentials`，内容格式如下；这里使用的是**控制台 HTTPS Basic Auth 凭据**，不是 ChatGPT 或 AWS 密码：

```ini
https_url=https://console.example.com/
username=your-console-user
password=your-console-password
```

该文件含明文秘密，应限制系统用户访问，不能提交 Git。然后在本项目目录执行：

```bash
npm ci
npm run build
node scripts/local-cloud-console-proxy.mjs
```

打开 [http://127.0.0.1:18787](http://127.0.0.1:18787)。代理默认只监听本机，但本机能访问此端口的程序也能借用你的控制台权限；不要共享电脑上的这个入口或改成公网监听。

在 macOS 上，`npm run cloud:console:install` 可安装登录后自动运行的 LaunchAgent，随后用 `npm run cloud:console` 打开入口。安装脚本不会替你创建凭据或构建前端，且应避免与手动代理占用同一端口。

本机代理优先提供本地 `dist` 中的前端文件，API 连接远端服务；因此**本机前端与服务器后端应保持版本匹配**，尤其是涉及写操作的升级。

## 可选能力

| 配置 | 用途与注意事项 |
| --- | --- |
| `CODEX_CLOUD_ROOT` | 主机运行根目录，通常包含工作区、状态和日志 |
| `CODEX_WORKSPACE_ROOT` / `CODEX_STATE_ROOT` / `CODEX_WORKTREE_ROOT` / `CODEX_LOGS_ROOT` | 分别覆盖项目、状态、隔离工作区和日志目录 |
| `CODEX_HOME` | Codex 自身配置、登录和会话所在目录；服务用户必须有访问权限 |
| `CODEX_CLOUD_PUBLIC_ORIGIN` | 用于校验请求来源的正式入口地址 |
| `CODEX_CLOUD_WEBHOOK_TOKEN` | 外部自动化触发令牌，不能用来替代网页登录认证 |
| `CODEX_ENABLE_LOCAL_REVIEW_READ=1` | 启用本地 Git 变更读取及 PR 上下文查询；PR 查询还需主机安装并授权 GitHub CLI |
| `CODEX_ENABLE_LOCAL_REVIEW_MUTATION=1` | 启用本地暂存、还原、初始化 Git 和发布 PR 评论；会修改仓库或对外发布内容 |
| `CODEX_ENABLE_CLI_DEBUG=1` | 启用原始 CLI 调试，生产环境默认关闭 |
| `CODEX_ALLOW_LOCAL_FALLBACK=1` | 仅用于开发降级，生产环境不要开启 |
| `CODEX_PLUGIN_CATALOG_CACHE_TTL_MS` | 插件目录缓存时长，默认 5 分钟 |
| `CODEX_AUTOMATION_MAX_CONCURRENT` / `CODEX_AUTOMATION_MAX_CONCURRENT_PER_CLIENT` | app-server 自动化在单个控制台进程内的并发上限，默认全局 2、每调用方 1；超限返回 429，不是跨进程预算锁 |
| `CODEX_AUTOMATION_DAILY_KNOWN_TOKEN_LIMIT` | 可选 UTC 日已知 token 软门槛，默认关闭；已用量达阈值返回 429，用量未知返回 409，进行中返回 429。单次运行可超额，不能当作费用硬上限 |
| `CODEX_AUTOMATION_RECOVERY_ENABLED` | 默认启用旧版内部自动化的有限恢复；Webhook/Heartbeat 中断后转入待核对，不会靠提示词自动重放外部动作。设为 `0` 可关闭内部恢复 |
| `CODEX_AUTOMATION_RECOVERY_MAX_AGE_MS` | 恢复窗口默认 30 分钟 |
| `CODEX_AUTOMATION_RECOVERY_MAX_ATTEMPTS` | 每条恢复链默认最多 1 次自动续跑 |
| `CODEX_AUTOMATION_RECOVERY_STARTUP_DELAY_MS` | 恢复前启动等待，默认 1 秒 |
| `AWS_REGION`、`CODEX_PUBLIC_IP`、`CODEX_PRIVATE_IP` | 控制台显示的部署元信息，不是 AWS 授权配置 |

Review 本地操作开关、主机 GitHub 授权和当前 PR 状态都满足时，才可以使用对应 PR 功能。浏览器检查还需要主机可用的浏览器程序；MCP、Skills、插件和图片生成取决于 Codex 配置及账号能力。

## 验证

常规本地检查，不提交真实模型任务：

```bash
npm run verify:local
npm run verify:runtime
```

隔离浏览器验收需两个终端。第一个只启动前端，第二个使用模拟 API 执行验收；默认使用已安装的 Chrome：

```bash
npx vite --host 127.0.0.1 --port 5174 --strictPort
```

```bash
npm run verify:safety:ui
npm run verify:personal:ui
```

如端口被占用，前端改用其他端口，并为测试设置对应的 `CODEX_CLOUD_SAFETY_UI_URL`。截图保存在被 Git 忽略的 `docs/research/`。

只在有授权的受控测试实例上执行 `npm run verify:cloud` 或 `npm run verify:cloud:full`；它们不是生产环境的无副作用健康探针。真实模型验收需额外显式设置 `CODEX_CLOUD_E2E_REAL_TURN=1`，会消耗额度。浏览器烟雾测试可使用 `PLAYWRIGHT_CHROMIUM_CHANNEL=chrome` 或 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定浏览器。
