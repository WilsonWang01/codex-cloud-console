# 从注册 AWS 到运行 Codex Cloud Console

适合第一次使用 AWS、准备自托管本项目的个人用户。资料核对日期：2026-09-26。配置是本项目的起步建议，不是经过所有负载验证的性能承诺；价格、可用实例和免费资格以你账号、区域与 AWS 当前页面为准。

**已有 EC2：先盘点并复用，不重新注册或重建。只想体验：先按 [README](../README.md#快速开始) 本地运行，无需 AWS。** 服务器只运行控制台、Codex CLI 和工具，模型推理在配置的服务端完成，一般不需要 GPU。

导航：[费用与计划](#费用与计划) · [注册账号](#注册账号) · [推荐配置](#推荐配置) · [创建前确认](#创建前确认) · [创建与连接](#创建与连接) · [安装与验收](#安装与验收) · [日常维护](#日常维护)

## 费用与计划

> [!WARNING]
> 不要为了“减少登录”创建或加入 AWS Organizations、配置 Control Tower 或自动启用组织级 Identity Center。普通单账号 EC2 部署不需要这些功能。传统账号创建/加入组织可能触发免费计划自动升级与 Free Tier credits 失效；付费计划不能再降回免费计划。具体规则见 [AWS Free Tier FAQ](https://aws.amazon.com/free/free-tier-faqs/) 与[计划说明](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)。

- **Free plan 不是永久免费服务器。** 当前新免费计划有时间和赠金限制，到期或额度耗尽会影响服务与数据访问，应在到期前备份并决定迁移或升级。不要把旧教程里的“12 个月免费”套到所有新账号上。[免费计划条款](https://aws.amazon.com/free/terms/)
- **Paid plan 是按使用付费。** 可抵扣赠金耗尽、过期或不适用后，资源继续运行就可能产生应付款项；不要假设会自动停机。实际剩余额度以 Billing 的 Credits 页面为准，不假设人人都有固定赠金额度。[计划说明](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)
- **移除银行卡不是止损方案。** 它不终止运行资源或免除已产生费用，也可能造成服务风险。停止实例、关账号或删除资源都必须先确认数据与服务影响。
- **预算提醒不是实时硬限额。** AWS Budgets 依赖更新后的账单数据；先创建通知型预算并确认收件地址，不默认启用自动停机动作。[预算实践](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html)

### 先看完整费用构成

用 [AWS Pricing Calculator](https://calculator.aws/) 按实际区域估算，保存日期、配置与估算链接。不要直接使用实例介绍页其他区域的美元单价作为自己的报价。

| 费用项 | 需要检查 |
| --- | --- |
| EC2 | 类型、Linux 按需价格、每天运行多久；空闲但仍运行也计费 |
| CPU credits | T 系列突发实例的 Standard/Unlimited 模式及持续高 CPU 风险 |
| EBS | 分配的总容量、额外 IOPS/吞吐、快照，而非只算当前文件大小 |
| 网络 | 公网 IPv4、Elastic IP、出站流量；NAT Gateway、私有端点另算 |
| 配套服务 | 域名/DNS、日志、监控、备份和任何付费 AMI/支持计划 |
| Codex 与工具 | 模型账号/API、联网工具、第三方服务单独核算，不包含在 EC2 价格里 |

月估算由以上各项相加，赠金抵扣单列，不用抵扣后可能为零的数字掩盖正常运行成本。价格来源：[EC2](https://aws.amazon.com/ec2/pricing/on-demand/)、[EBS](https://aws.amazon.com/ebs/pricing/)、[VPC/IPv4](https://aws.amazon.com/vpc/pricing/)。未确认预算与费用项前，不点击“启动实例”。

## 注册账号

### 1. 选择合适入口

从 [AWS 官网](https://aws.amazon.com/) 进入注册，先阅读[注册方式比较](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html)。本指南按 **Sign up for AWS (advanced) 的独立账号路径**说明，便于明确选择区域、IAM 和网络配置；“advanced”不是付费支持套餐。

AWS 正逐步推出另一种 new/project 注册体验，会预配置组织和访问管理，区域与功能也有不同约束。已经走了该入口不要重建账号、删除组织或自行“转换”；先核实该账号计划、额度与功能。本指南不能把传统账号组织升级规则机械套用到另一种注册流程。

### 2. 由账号所有者完成注册

准备可长期访问的邮箱、电话、真实联系与账单信息；依页面完成邮箱验证、密码、计划选择、付款验证、身份验证及支持计划选择，再等待激活。优先选择满足需求且不另收费的支持选项，不误选付费支持。具体顺序和地区差异参考[官方注册步骤](https://docs.aws.amazon.com/accounts/latest/reference/getting-started.html)。

密码、银行卡、短信验证码和 MFA 由本人在 AWS 页面填写，不发送到聊天、Issue 或 Git 仓库。若界面只允许 Paid plan，而你只授权免费体验，应停下确认，不代替你升级。

**成功标志：** 可以进入控制台，并在 Billing 中确认当前计划、可用赠金/到期日和通知邮箱。注册成功不代表已经创建 EC2，也不代表所有资源免费。

### 3. 先完成安全和费用准备

为账号启用 MFA，保护恢复方式；root 仅用于必要的账号级操作，日常使用受限管理身份，不为 root 创建长期访问密钥。已有组织账号使用其管理员批准的访问方式；个人独立账号不为这一步额外创建组织。

在 Billing → Budgets 配置月度成本告警，金额由你根据完整估算决定，例如在预算的 50%、80%、100% 提醒。只做通知，不默认添加停机或拒绝服务动作；检查预算是否包含/排除了赠金，以免只看到抵扣后的数字。步骤见[创建成本预算](https://docs.aws.amazon.com/cost-management/latest/userguide/create-cost-budget.html)。

## 推荐配置

以下容量为工程建议，首版按单用户、低并发、远程模型推理考虑。CPU/内存规格依据 [AWS T3 规格](https://aws.amazon.com/ec2/instance-types/t3/)，不保证账号免费计划允许选用这些类型。

| 场景 | 实例参考 | vCPU / 内存 | EBS gp3 起步容量 | 取舍 |
| --- | --- | --- | --- | --- |
| 短期轻量试用 | `t3.small` | 2 / 2 GiB | 30 GiB | 单任务、少量附件；构建/浏览器可能内存不足，不作为长期稳定承诺 |
| 默认个人部署 | `t3.medium` | 2 / 4 GiB | 40 GiB | 控制台、CLI、少量项目的起点，初期尽量串行运行重任务 |
| 较多浏览器/构建或独立个人 worker | `t3.large` | 2 / 8 GiB | 60 GiB | 主要增加内存，不代表 CPU 吞吐翻倍；需实际压测后定并发 |

- 操作系统建议 Canonical 官方 **Ubuntu Server 24.04 LTS、x86_64、EBS-backed**，确认不是另收费的 Marketplace 镜像；使用前验证 Node.js 22+、Codex CLI 和所需浏览器依赖。现有健康的 Ubuntu 部署不为对齐示例重装。
- 不推荐 1 GiB 内存的 `t3.micro` 承担完整持续工作负载。模型在云端推理不代表本机浏览器、构建和文件索引不吃内存。
- 区域根据用户延迟、模型服务可达性、数据要求和报价选择，不能为了示例默认把所有人部署到东京。不要为规避服务地区限制选区。
- T3/T3a/T4g 通常默认 Unlimited；持续超基线可能另收 CPU credits。预算敏感的轻负载可先评估 Standard，但积分耗尽后性能会受限。长期重 CPU 负载应比较非突发机型，而不是无限加大突发预算。[突发模式说明](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode-concepts.html)
- T3a 或 ARM/T4g 可作为成本比较项，必须先核实区域价格及 Node、Codex、浏览器和本地工具兼容性；不要只为单价便宜直接更换已有实例架构。
- 使用加密 gp3，先用基础 IOPS/吞吐，不预配额外性能。容量需覆盖系统、构建临时空间、发布包、工作区、Codex 历史与附件；观察实际增长再调整。[EBS 类型](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
- 单机起步不默认引入 RDS、Redis、EKS、负载均衡器、NAT Gateway 或付费高级监控。需要私网部署时，先单独估算出口与端点成本。

## 创建前确认

代理或人工操作都先填写这份变更摘要。没有填完且明确同意，不执行创建、升级套餐、启动已停止实例或购买操作。

```text
目标：新建实例 / 复用现有实例
账号计划、注册路径及额度：已核实 / 尚未核实
区域、实例类型、架构、系统镜像：
EBS 总容量、加密、随实例终止删除策略：
网络：公网或私网、IP 类型、管理入口、HTTPS 入口
完整费用估算：计算日期、区域、运行时长、各项费用、估算链接
CPU credits 模式、预算与告警接收方式：
是否影响现有服务和任务、影响窗口：
已有数据备份/恢复方法、新数据存放位置：
本次授权范围及不做的操作：
```

存在预算、套餐提示或网络成本不明时先停下；不能把“继续”理解成对新增收费项和删除数据的无限授权。使用工具自动操作前，应再次确认当前账号、区域和资源，而不是按文档占位值执行。

## 创建与连接

### 1. 创建单台 EC2

确认上述方案后，在 EC2 → Instances → Launch instances 填写名称、已核验的 AMI、实例类型及 EBS。添加用途标签便于识别；开启终止保护，确认磁盘的 `DeleteOnTermination` 设置。应用数据若放根卷，默认终止行为可能删掉它，必须有可恢复备份。

小型公网 HTTPS 方案可以使用已有合适的 VPC/公共子网加认证反向代理。公网入站仅开放所需 `443`；自动签证书若使用 HTTP challenge，还需相应 `80`，否则选择经验证的证书方式。`5174`、`8787` 不对公网开放。默认不开放 `22`，确需 SSH 时只放行你的固定源 IP/CIDR，不能 `0.0.0.0/0`。

需要外部设备和 Webhook 稳定访问时，评估稳定公网地址与域名；普通自动分配公网 IP 在停止/启动后可能变化，Elastic IP 也有费用。私网实例仍需访问模型服务、包源和管理端点，不要以为 SSM 可以替代所有外网出口。

高级选项中要求 IMDSv2；实例角色只授予必要的 SSM 管理权限，应用若不需要 AWS API 则不授予广泛服务访问。不要把所有 AWS 管理权交给会执行任意命令的 Codex 用户。

**成功标志：** 实例运行、状态检查通过、区域/类型/磁盘与确认清单一致；到这里先连接验证，不创建第二台来“重试”。

### 2. 优先通过 SSM 连接

SSM 需要实例上的 Agent、合适的实例角色，以及到所需 AWS 端点的 HTTPS 出站连接。可从 `AmazonSSMManagedInstanceCore` 评估实例权限；发起连接的人还需要独立的会话权限。没有公网 SSH 端口并不等于无需认证。[Session Manager 前提](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html)

在实例“连接”页面选择 Session Manager，确认进入的是预期机器。若未就绪，先排查 Agent、角色、网络和区域；不要为修连接默认加管理员权限、开全网 SSH 或创建收费 NAT。

本地 AWS CLI 连接可参考 [SSM / SSH 操作指南](aws-instance-access.md)。CLI 方式需要 Session Manager plugin。必要时才使用受限 SSH，私钥只放在你控制的安全位置，不贴到对话或仓库。

### 3. 区分四种登录

| 登录 | 用途 | 减少重复登录的正确方式 |
| --- | --- | --- |
| AWS 控制台 / CLI | 管理云资源、发起 SSM | 复用临时会话；到期按 AWS 规则重新认证，不承诺一周后仍有效 |
| 主机 SSM / SSH | 进入 Linux 运维 | 使用受限身份、SSM 或 SSH 配置，不公开管理端口 |
| 服务器 Codex | 调用模型和工具 | 在服务用户下登录，保护独立的 `CODEX_HOME`，按提示续期 |
| 控制台 HTTPS | 使用本项目网页 | 密码管理器或[本机代理](setup.md#本机便捷入口)，不取消公网认证 |

AWS CLI `aws login` 在支持的身份/版本下缓存并刷新临时凭据，但总体会话仍受时长限制，官方上限为 12 小时。EC2 内部调用 AWS 服务则使用实例角色的临时凭据，不依赖你笔记本长期在线，也不为此保存长期访问密钥。[AWS CLI 登录说明](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)

## 安装与验收

实例准备好后，按[服务器部署指南](setup.md#服务器部署)安装。该指南包含准确命令与环境文件，以下是流程检查点，不另维护一套相互冲突的安装命令。

1. 在参考服务用户 `ubuntu` 下准备 Node.js 22+、npm、Git 和 Codex CLI。SSM 默认登录用户不一定是 `ubuntu`，先核对身份，再完成该用户的 Codex 登录。
2. 检出本仓库，配置真实项目、手动任务与运行数据目录。先保留现有文件，不能覆盖已有环境文件或 `CODEX_HOME`。
3. 运行 systemd 安装流程，确认 `strictOk=true`、`partial=false` 和服务稳定。此流程会重启服务，已有部署需事先安排任务与维护窗口。
4. 按参考 Caddy 配置设置域名、HTTPS 与入口认证，验证未登录不能读取会话。不能用前端隐藏按钮代替服务器认证。
5. 配置并验证数据备份。备份包含工作区、控制台状态、任务、附件、日志中需保留的证据和 Codex 数据；凭据备份必须加密并限制访问，快照/对象存储也要核算费用。
6. 先做无模型调用的健康检查、页面与权限检查。真实对话会消耗额度，在获得同意后用最小任务验证一次，并确认刷新后记录仍存在。

**完成标准：** 认证入口可用、服务用户与目录正确、模型账号状态正常、旧数据仍在、备份可恢复、未开放开发端口、费用与告警已复核。只显示网页不算端到端部署成功。

## 日常维护

- 更新代码与 CLI 前核对任务和备份；更新是替换程序，不是删除项目、历史和登录数据。参考[更新流程](setup.md#更新版本)。
- 监控磁盘、内存与 CPU credits；只清理经过确认的可再生成内容，不能用删 `~/.codex`、工作区或状态目录来释放空间。
- 停止实例会中断网页与任务；EBS、保留的 Elastic IP、快照等仍可能收费。终止实例不可恢复其运行状态，磁盘是否保留取决于属性；“停止”和“终止”不是同一个操作。[实例生命周期与费用](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html)
- 到期、费用异常或停止使用时，先盘点每个区域的资源和持久数据，再让账号所有者决定保留、导出、停机或删除。不能自动清空资源来实现所谓“零费用”。

## 让项目 Skill 带着做

仓库提供 [codex-cloud-setup](../.agents/skills/codex-cloud-setup/SKILL.md)，与本指南及 [setup.md](setup.md) 配套。在支持项目 Skill 的 Codex 环境中打开本仓库后，可请求：

```text
$codex-cloud-setup 先只读评估。我想部署 Codex Cloud Console，请先确认是否已有 AWS 账号和 EC2，解释费用，推荐配置并给出待确认清单。不要创建资源、改套餐或影响已有任务。
```

若未发现 Skill，先让代理读取上述 `SKILL.md` 路径；这不等于 Skill 已全局安装。保持完整仓库文档可访问，不要只复制入口文件导致引用缺失。引导期间登录由本人完成，发生套餐升级、额外收费或服务中断风险时必须停下来确认。
