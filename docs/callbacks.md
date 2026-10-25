# 外部任务完成回调

先用同一调用方令牌查询 `GET /api/automations/:id/v1/capabilities`。`features.callback.supported=true` 表示部署包含回调执行器，`configured=true` 才表示此调用方/自动化已经登记目标。旧部署可能仍返回 false。它是 Codex Cloud 自有通知协议，不是 OpenAI 或 Anthropic 官方 webhook 协议；三种模型请求格式不因此获得其全部官方 webhook 能力。

默认不发送任何回调。登记由服务器操作者完成，提交任务不能附带 callbackUrl 或覆盖地址/签名密钥。配置只影响之后接收的新任务；不会给旧任务补发历史通知。完整结果/文件仍须使用原调用方令牌轮询或下载，回调不包含访问令牌、prompt、材料、回答、用量或服务器路径。

## 登记流程

先确认接收方 URL、账号归属、具体调用方/自动化、可传送的运行元数据和可能产生的请求费用，再配置。不要在聊天、Git 或日志中提交实际密钥。不得借登记过程扩大原自动化的执行权限。

在服务可读取的绝对路径保存私有 JSON 文件（普通文件、权限 0600、上级目录不可由不可信用户改写），例如 `/etc/codex-cloud-callbacks.json`：

```json
[
  {
    "id": "research-completed",
    "clientId": "替换成已存在的独立调用方ID",
    "automationId": "my-research",
    "url": "https://your-receiver.example/codex/completed",
    "secretEnv": "CODEX_CLOUD_CALLBACK_SECRET_RESEARCH"
  }
]
```

以上 ID 占位文字不能直接用于配置，实际 id/clientId/automationId 仅允许字母、数字、下划线及短横线。单份配置最多 32 个目标、64 KiB；每个调用方/自动化只能登记一个目标，旧共享令牌及本地开发身份不支持。密钥使用独立随机值，UTF-8 32–256 字节，不复用 API 令牌或账号密码。

在既有服务私有环境中设置 `CODEX_CLOUD_CALLBACKS_FILE` 为上述绝对路径，及 `CODEX_CLOUD_CALLBACK_SECRET_RESEARCH` 的真实值。配置只在启动时读取，错误配置阻止启动；按原发布流程先检查空闲、备份验证，再重启。不要直接覆盖运行中的配置并假定立即生效，不要为此新开 EC2 端口。未设置文件路径等同空配置。

服务加载密钥后从子进程继承环境中移除 `CODEX_CLOUD_CALLBACK_SECRET_*`，仅由回调执行器保留使用；私有环境文件仍按原部署方式保护。这只避免无意继承，不是同用户进程或主机文件的安全沙箱。

目标只接受 HTTPS 默认 443、DNS 域名和无凭据/查询/片段的 URL。内网、回环、链路本地、云元数据、IPv4 映射/地址转换、组播及保留地址拒绝；IPv6 仅允许普通全球单播并排除特殊用途前缀。部分合法协议专用任播地址也被保守排除，不承诺任意网络拓扑可用。每次尝试重新检查全部 A/AAAA 答案，任何非公网答案均拒绝；连接固定到已检查 IP，保留原域名的 TLS 验证，不跟随重定向、不使用环境代理。DNS 不可用时保留失败原因并有限重试。

修改 URL、作用范围、ID 或密钥后，旧任务的绑定不自动转向新目标：旧事件会失败为 target_changed，仍可轮询结果。密钥轮换前应先排空旧投递或接受这些旧事件不再回调；没有“把旧事件改投新账号”的接口。

## 事件与验签

任务进入 completed、failed、canceled、interrupted 或 needs_reconciliation 时产生一个稳定事件。最后一种表示外部动作仍需人工核对，不能当成成功或自动重跑任务。示例：

```json
{
  "id": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  "type": "automation.run.terminal",
  "created_at": "2026-10-23T01:00:00.000Z",
  "data": {
    "run_id": "run-my-research-123",
    "automation_id": "my-research",
    "status": "completed",
    "result_path": "/api/automations/my-research/runs/run-my-research-123",
    "output_path": "/api/automations/my-research/runs/run-my-research-123/output"
  }
}
```

POST 的 Content-Type 为 application/json，正文最多 2048 字节。三个请求头：`x-codex-event-id`、`x-codex-timestamp`（本次发送的 Unix 秒）、`x-codex-signature`。签名为 `v1=` 加 `HMAC-SHA256(secret, timestamp + "." + 原始正文)` 的小写十六进制结果。不要先解析再重序列化 JSON 后验签。

[OpenAPI 契约](openapi.json)的 `webhooks.automationRunTerminal` 描述外部接收端及 CallbackEvent，不是服务器开放了一个匿名 webhook 路由；这一组织方式使用 [OpenAPI 3.1 的 webhooks 字段](https://spec.openapis.org/oas/v3.1.1.html#openapi-object)。

可直接复用独立的 [Node 验签函数](../scripts/callback-receiver-example.mjs)，仅依赖标准库、不导入服务器内部模块：

```js
import { verifyCallback } from "./callback-receiver-example.mjs";
const event = verifyCallback({
  headers: request.headers,
  rawBody: receivedBuffer,
  secret: process.env.MY_CALLBACK_SECRET,
});
// 在业务数据库事务中，以 event.id 为唯一键保存事件和后续工作。
// 事务提交后才响应 2xx；重复事件直接确认，不再次执行副作用。
```

接收端先限制正文大小，再用原始字节验证签名、时间差（示例为正负 5 分钟）、事件 ID 和同源查询路径。保持两端系统时钟正常。验签不是业务幂等：事件 ID 去重必须持久化，不能只放内存。返回 2xx 代表接收方已可靠接收，不代表后续业务动作已完成；需要发送邮件、发布等动作仍按接收方自己的具体授权执行。

## 可运行的持久接收端

[最小接收端](../scripts/callback-inbox-example.mjs)使用 Node 22.16+ 内置的 SQLite（本地数据库），不安装新依赖。按一组调用方/自动化绑定使用一个独立状态文件；先按上文确认接收方、密钥和费用，再手动配置。不要指向 Codex Cloud 生产账本或其他业务数据库。

```bash
# 使用新的独立目录；如果目录已存在，先核对用途，不要覆盖或删除。
mkdir -m 700 "$HOME/codex-callback-inbox"
export CODEX_CALLBACK_RECEIVER_STATE="$HOME/codex-callback-inbox/receipts.sqlite"
export CODEX_CALLBACK_RECEIVER_AUTOMATION_ID="my-research"
export CODEX_CALLBACK_RECEIVER_SECRET="${YOUR_PRIVATE_CALLBACK_SECRET:?请先通过私有环境注入独立回调密钥}"
export CODEX_CALLBACK_RECEIVER_PORT=8788
node scripts/callback-inbox-example.mjs
```

密钥须与登记目标使用的专用密钥相同，不复用 API 令牌、不写入 Git 或聊天。CLI 只监听 `127.0.0.1`；不设端口时使用随机端口，并在启动输出中给出真实地址。仅当前进程运行时接收，不安装常驻服务。需要公网接入时，由已经批准的 HTTPS 443 域名和反向代理转发 `/codex/completed`；不能直接把打印出的回环 HTTP 地址登记为云端回调目标。本示例不会自动改安全组、开放公网端口、建立隧道或创建 AWS 资源。

验签、自动化归属和原始正文哈希核对后，事件在 SQLite 事务提交成功后才返回 202；相同事件的相同原始正文返回 200，不增加记录或覆盖首次接收时间。同 ID 内容变化返回 409，签名/内容或归属无效返回 401，超大正文 413，不支持的类型/压缩 415，存储不可用或容量满返回 503。两种 2xx 都只确认通知可靠接收，不表示任务或后续业务成功。

同一私有环境下可只读查看，不启动 HTTP 服务，也不创建缺失的数据库：

```bash
node scripts/callback-inbox-example.mjs --list --limit 20
```

输出包含 `items` 和 `nextCursor`，后续使用实际返回值执行 `--list --after 下一游标 --limit 20`，不要把页码当游标。程序内可导入 `openCallbackInbox`，使用 `readOnly: true` 打开并分页读取；接收端只保存最少事件元数据，不保存密钥、prompt、回答或产物正文，不自动查询或重新运行 Codex。

收件箱固定最多 4096 条记录，每条原始正文最多 2048 字节，数据库仍有索引和日志开销，不是精确磁盘费用上限。记录只追加、不自动删旧；满时新事件不确认，旧重复事件仍可确认。不要通过删库、切换空库或旧备份覆盖新记录来清空间，否则会失去去重状态。较大业务应把验签与事件唯一键写入现有业务数据库的接收事务，并按自己的保留/归档规则处理。

这是有界通知收件箱，不是业务任务队列或业务动作的“恰好一次”保证。处理通知后，仍用固定服务地址和原调用方令牌查询原运行，核对 `completionOutcome`、结果和待核对状态；回调不可用时按[独立客户端说明](backend-integration.md)轮询，不能换业务事件键重新执行。处理游标、业务幂等和外部写入的具体确认由调用方保留。示例需要可信的私有状态路径，不是同用户进程或主机文件的安全沙箱。见[接收端验收与边界](acceptance/2026-10-26-durable-callback-inbox.md)。

## 重试、状态与保留

最多五次发送，失败后依次等待 30 秒、2 分钟、10 分钟、1 小时；每次 DNS/TLS/HTTP 总墙钟最多 10 秒，事件最多发送 24 小时。网络/认证存储暂时故障及 HTTP 408/429/5xx 重试，3xx 和其他非 2xx HTTP 结果不重试；不跟随 Location。撤销/过期/失去原作用范围的调用方，以及登记绑定变化，均停止发送。

任务终态和待投递事件在同一 SQLite 事务中保存，发送尝试在网络前持久登记。进程在接收方已经接受但本机尚未记成功时退出，可能再次发送同一事件；事件 ID 和原始正文保持，发送时间戳/签名可以变化。租约过期后的旧投递者不能覆盖新状态。回调不是“恰好一次”，重试只重发通知，不重新运行 Codex 或第三方业务动作。

原 `GET .../runs/:runId` 的 `run.callbackDelivery` 包含 eventId、status、attempts、lastCode、nextAttemptAt、deliveredAt。status 为 awaiting（任务尚未终态）、pending、sending、delivered 或 failed。字段仅在有登记记录时出现，不含目标地址或密钥。回调失败与任务结果分别判断，仍使用原查询路径和令牌取回结果；不要换业务事件键重新执行。

全局最多 4096 条回调记录，接收时连同任务事务预留；容量满时拒绝新回调任务，不丢弃旧投递。不配置回调的任务不占名额。已交付记录从交付时间、失败记录从投递窗口结束后保留 7 天，再由每分钟清理；等待执行的登记和未完成投递不会因裁剪运行列表而删除。相关任务和幂等记录遵循既有保留规则，不能把回调留存当作文件一定还在。

升级使用任务格式 6，旧 1–5 格式记录和执行归属保持；新数据产生后不能退到未实现回调事务的旧执行器或用旧备份覆盖。备份包含回调记录，发布门禁也会检查投递中状态。默认空登记上线不会向第三方发起通知。

地址策略依据 [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry)、[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry)、[OWASP SSRF 防护](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)；传输沿用 Node 标准 DNS/HTTPS。应用检查不是整机网络隔离，部署者仍应审核允许目标及网络出口策略，不能因此向不可信租户开放。
