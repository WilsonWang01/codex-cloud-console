# M1 整体发布与数据核对

日期：2026-10-22。范围：F01-F05、配套本机代理，以及发布时发现的依赖安全补丁。部署和 GitHub/CI 沿用已批准权限；未创建 AWS 资源，未运行真实模型回合，未重置额度，未写邮件或日历。

## 发布记录

第一轮 EC2 已从 `20261008T021422Z-3002872` 切换到 `20261022T111144Z-3885359`，来源 `1aea535b085bea72b0f4d12a9307ca6b34742641`。独立 systemd 发布单元退出码 0，严格健康 `strictOk=true / partial=false`，版本接口返回该精确提交。HTTP 发起连接因重启中断后，查询同一发布单元确认结果，没有重复发起部署。

第一轮前后 10 项受保护状态条目及 4 份部署配置哈希一致，34 个会话、200 条运行记录保留。审计日志和能力缓存属于预期可变化数据，未用旧快照覆盖。个人工作区当时没有文件；未修改工作项目目录或 Codex 登录/历史。

最终 EC2 版本为 `20261022T112352Z-3887553`，精确来源 `a7caddeb7128e2ac72ba6a4fb7b2433550533aac`，包含安全补丁 `60df207` 与测试等待修复 `a7cadde`。独立发布单元退出码 0；2026-10-22 19:27:43 CST 再次严格健康通过，无活动任务或压缩任务。生产 `proxy-addr` 实装 2.0.8，生产依赖审计 0 项。

本机现有 LaunchAgent 已切换到 `~/.codex/cloud-console-runtime/m1-a7cadde/` 固定版本目录，PID 10812，仍只监听 `127.0.0.1:18787`，不依赖原 dirty checkout 的后续修改。`/api/local/release` 与 `/api/release` 返回同一提交，后端、代理、锁文件、页面入口四项哈希均一致；来源锁文件不再被裁剪修改。原 plist 保留可回退。临时 18788 验收进程已停止，两份本轮旧本机候选代码已移除。

最终真实页面验收通过个人今日 → 工作历史会话 → 调用与用量 → 个人切换，能读取原历史，已登录且云端在线；当前工作会话 `GPT-6-Sol / low` 的显式选择保留，未改成默认 medium。只读操作后再次核对 10 项状态和 4 份配置哈希均一致，仍为 34 会话、200 运行。

**尚未解决：** 发布后个人页仍显示邮箱连接待检查、日历状态待确认。实际 `/api/codex/apps?repoId=_personal` 返回 502「服务目录分页未完成，请稍后重试」；`/api/codex/app-status?repoId=_personal` 为 200、auth=true、gaps=[]。当前 `readConnectedApps` 遇循环游标/分页上限会直接抛错，导致后续 `app/installed` 已安装状态也不读取；尚未区分本次是哪一种上游分页原因。该问题纳入下一项 A01 优先处理，必须保留目录不完整提示、独立验证已安装状态，不能误判成需要重新登录。本轮没有重新授权、读取第三方业务数据或宣称连接器闭环通过。

实际 UI 截图保存在忽略目录 `docs/research/acceptance/m1-deploy-2026-10-22/` 的 `today-production.png`、`work-production.png`、`usage-production.png`，未把历史聊天截图推到公开仓库。无认证远程 `/api/release` 返回 401，未开放免认证管理接口。

## 备份与恢复验证

EC2 备份目录：`/home/ubuntu/codex-cloud/backups/pre-m1-20261022`，目录 0700，归档 0600。

- 状态、个人工作区、环境与服务配置归档 SHA-256：`5d2fb54d8a93ffe3ebaa536b61344c5fdf00e0af73e2d9154565538b1be16673`。
- 原代码归档 SHA-256：`11c2113f4a362f52c5b813531c19bd7fc8871d4607db04a846bb66f0f4d41825`。
- 实际解包到独立目录，核对 10 项状态和 4 份配置，不仅检查 tar 能否列出文件。
- 备份前后及切换前检查无活动模型任务、压缩任务、自动化任务或 `codex-auto-*` 服务。
- 原本机 LaunchAgent 已备份到 `~/.codex/cloud-console-backups/m1-20261022/original.plist`，未修改用户其他工作树。

备份在原实例磁盘上，只用于本次回退，不是异地容灾。新版本若产生数据，回退只切代码，不能恢复旧状态覆盖新数据。

安全补丁前另建 `pre-m1-security-20261022`，同样实际解包校验：状态配置归档 SHA-256 `b784e8e1779b0d87f5735ef7b4cafacd0c1f74f0595f56a199df2d0ea46094a5`，代码归档 `53f30db4892e43b3cf51fe4fff06daa7c1eb2b03e999508ad6a3df15886767b4`。最终健康、数据对账、归档哈希及无打开文件检查通过后，删除旧 M1 代码目录与初版暂存源码，共回收 43,564 KiB，运行目录只保留最终版本；两份已验证归档保留。

## 发布中发现并修复的依赖问题

初次依赖审计发现 5 项高危/严重记录，其中生产依赖仅 `proxy-addr`；其余属于开发工具链，不能据此宣称线上发生了攻击。

| 依赖 | 变更 | 风险与处理 |
| --- | --- | --- |
| proxy-addr | 2.0.7 → 2.0.8 | 特定错误配置的映射 IPv6 信任子网会扩大信任范围；本项目使用 `loopback`，不满足公告举例的配置，但仍更新并补回归 |
| concurrently / shell-quote | 9.2.4 → 9.2.5 / 1.9.0 → 1.12.0 | 开发命令参数引用漏洞；沿用父包修复，不强加 overrides |
| source-map-js | 1.2.1 → 1.2.2 | 恶意 source map 导致事件循环阻塞；构建依赖更新 |
| vite | 7.3.6 → 7.3.7 | 开发服务器及编辑器启动相关漏洞修复，不跨主版本 |

本地重新 `npm ci --ignore-scripts` 后审计为 0 项；这仅表示当前已知公告，不是永久安全保证。CI 和安装器增加 `npm audit --audit-level=high`，高危/严重或审计服务错误都会阻止本次候选发布，保留已运行版本；不自动 `audit fix`。

安装器 `npm prune` 原先会移除锁文件的部分 peer 标记，未改变依赖版本，但使运行锁文件哈希不同。增加 `--package-lock=false` 保留来源锁文件，仍裁剪实际开发依赖。

2026-10-23 更正：上述处理不足。后续逐包核对发现 `--package-lock=false` 会忽略锁文件、重新解析版本范围；仅比较锁文件哈希不能证明实际依赖一致。已在 `546cdd8` 改为构建后 `npm ci --omit=dev --ignore-scripts`，加入逐包版本核对和 CI 纯运行包检查。发现、修复及最终发布证据见 [PDF 与运行包验收](2026-10-23-pdf-inputs.md)；本节原记录保留为当时结论，不作为最终版本一致性证明。

测试补充：Express 实际使用的 `proxy-addr` 回环、非信任来源、伪造转发头和异常 IPv6 子网；安装器审计失败不切换、不删除原版本。`npm run verify:local` 全部通过；`verify:status:ui` 通过首屏、局部错误、超时、恢复及 30 次重载，84 次状态请求、0 次写入。

首次 CI [39769628624](https://github.com/WilsonWang01/codex-cloud-console/actions/runs/39769628624) 审计通过，但回归失败：测试只等待模型任务结束，没有等待自动化结果持久化与并发名额释放，下一提交得到 429。补充等待已有 `activeRunIds` 为空且模型任务为空，不修改生产并发上限，不跳过断言，不以无条件重试掩盖。修复后的本地回归及 [CI 39770031394](https://github.com/WilsonWang01/codex-cloud-console/actions/runs/39770031394) 全部通过，CI 使用 Linux / Node 22，包含全量 verify:local 和安全审计。

代码 review 结论：变更限定于五项依赖锁定版本、审计发布检查及对应回归；无跨主版本升级，无自动 audit fix，无新增执行权限。安装器审计错误停在切换前，删除候选而保留当前服务；保留锁文件不妨碍裁剪开发依赖。没有发现本轮改动遗留的 P0/P1，但这不是对整个项目未知问题的保证。

公告来源：[proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)、[shell-quote](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)、[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、[Vite/launch-editor](https://github.com/advisories/GHSA-587h-7wmj-h5pm)。

## 验收边界

F01 的大量当日记录、F03 并发写入和 F04 取消故障注入在隔离测试完成，不在生产伪造历史或取消用户任务。真实生产验收检查只读接口、版本、数据和页面；没有声称本轮重新验证了所有模型、图片或第三方动作。

M2-M5 尚未完成，个人 20 场景、真机、七天观察与用户评价仍需独立证据。构建入口约 505 kB 的体积警告仍保留，不把绿色回归表述成没有任何性能优化空间。
