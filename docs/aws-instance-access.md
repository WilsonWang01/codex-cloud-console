# AWS 实例登录与恢复手册

这份手册记录云端 Codex EC2 实例的稳定登录方式。之后即使新会话忘了上下文，也可以按这里恢复访问，不需要重新排查一遍。

## 目标实例

- 用途：云端 Codex 控制台和定时 Codex 任务
- 区域：`ap-northeast-1`，东京
- 实例 ID：`i-0ef9c3f3745c1b665`
- 公网 IPv4：`54.199.2.92`
- 私网 IPv4：`172.31.7.169`
- VPC：`vpc-0f07766a08d6f876e`
- 子网：`subnet-09ee30d7f42788c6f`
- 可用区：`ap-northeast-1c`
- 实例安全组：`sg-05abf23930b93274d`
- 云端控制台：`http://54.199.2.92:8787/`
- 本地 SSH 私钥：`~/.ssh/codex_cloud_ec2_ed25519`
- 普通公网 SSH alias：`codex-cloud`

## 为什么要加备用登录方式

实例侧的 SSH key 和 `sshd` 已确认正常，但本机 VPN 线路可能破坏公网 SSH。之前出现过一个很反常的现象：Mac 上 `nc` 扫 `54.199.2.92` 的任意端口都显示 connected，但 SSH 22 在 key exchange 阶段直接断开。这更像本地 VPN/代理在劫持或伪造 TCP 状态，不是 EC2 的 `sshd` 坏了。

以后优先按这个顺序登录：

1. `codex-cloud-ssm`：走 AWS Systems Manager Session Manager。
2. `codex-cloud-eice`：走 EC2 Instance Connect Endpoint。
3. `codex-cloud`：普通公网 SSH，只在当前网络线路正常时使用。

## 方法一：SSM Session Manager

SSM 是最推荐的稳定入口。它不依赖入站 SSH，实例主动通过 HTTPS 连接 AWS Systems Manager，所以本机 VPN 换线路时一般不影响。

AWS 资源：

- IAM Role：`codex-cloud-ssm-role`
- Instance Profile：`codex-cloud-ssm-profile`
- 已挂托管策略：`arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`
- 2026-05-23 已验证：SSM 显示 `i-0ef9c3f3745c1b665 Online`，agent 版本 `3.3.4121.0`，平台 `Ubuntu`。

在 AWS CloudShell 或已配置凭证的本机 AWS CLI 里检查 SSM 注册状态：

```bash
aws ssm describe-instance-information \
  --region ap-northeast-1 \
  --filters Key=InstanceIds,Values=i-0ef9c3f3745c1b665 \
  --query 'InstanceInformationList[*].[InstanceId,PingStatus,AgentVersion,PlatformName,LastPingDateTime]' \
  --output table
```

直接打开 SSM shell：

```bash
aws ssm start-session \
  --region ap-northeast-1 \
  --target i-0ef9c3f3745c1b665
```

本机 `~/.ssh/config` 里已经配置了类似下面的 SSH alias：

```sshconfig
Host codex-cloud-ssm
  HostName i-0ef9c3f3745c1b665
  User ubuntu
  IdentityFile ~/.ssh/codex_cloud_ec2_ed25519
  IdentitiesOnly yes
  ProxyCommand sh -c 'aws ssm start-session --region ap-northeast-1 --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p'
```

使用方式：

```bash
ssh codex-cloud-ssm
```

本机依赖：

```bash
brew install awscli session-manager-plugin
aws configure sso
```

AWS 账号是 `476405982853`，默认区域用 `ap-northeast-1`。不要把 AWS access key 或 secret 写进这个仓库。

注意：`awscli` 已经在本机装好；`session-manager-plugin` 的 Homebrew cask 需要 macOS sudo 密码，因为它要安装系统 pkg。非交互环境无法输入密码，如果后续 `ssh codex-cloud-ssm` 提示缺插件，在本机终端手动运行一次 `brew install session-manager-plugin` 并输入 Mac 密码即可。

### SSM 常见问题

- `describe-instance-information` 没有实例：刚挂 IAM profile 后等 2-5 分钟，再检查实例内 `amazon-ssm-agent` 是否安装并运行。
- `TargetNotConnected`：agent 已安装但无法连到 AWS SSM endpoint，或者 IAM profile 还没完全传播。
- 提示 `session-manager-plugin not found`：本机安装 `session-manager-plugin`。
- `AccessDeniedException`：当前 AWS 身份没有 `ssm:StartSession` 等权限。
- SSM shell 能进但 SSH over SSM 失败：先用普通 SSM shell 进实例，再修 `sshd` 或 `authorized_keys`。

实例内修复 agent 的命令：

```bash
if command -v snap >/dev/null 2>&1; then
  sudo snap list amazon-ssm-agent >/dev/null 2>&1 || sudo snap install amazon-ssm-agent --classic
  sudo snap start amazon-ssm-agent || true
fi

sudo systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null \
  || sudo systemctl enable --now amazon-ssm-agent.service

systemctl status snap.amazon-ssm-agent.amazon-ssm-agent.service amazon-ssm-agent.service --no-pager
```

## 方法二：EC2 Instance Connect Endpoint

EIC Endpoint 是第二条稳定入口。它在 AWS 控制面创建一个进入 VPC 的托管私有隧道，SSH 不依赖实例公网 IP 的 22 端口路径。

AWS 资源：

- Endpoint ID：`eice-05d40adaef160d38f`
- Endpoint 安全组：`sg-0b557ee89c2c40c54`
- Endpoint 子网：`subnet-09ee30d7f42788c6f`
- Endpoint VPC：`vpc-0f07766a08d6f876e`
- 2026-05-23 已验证：endpoint 已进入 `create-complete`，CloudShell 已通过 EIC 连到 `ip-172-31-7-169`，并用它重启了 `amazon-ssm-agent`。

关键安全组规则：

- 实例安全组 `sg-05abf23930b93274d`：允许 TCP `22` 入站来源为 endpoint 安全组 `sg-0b557ee89c2c40c54`。
- Endpoint 安全组 `sg-0b557ee89c2c40c54`：允许 TCP `22` 出站到实例安全组 `sg-05abf23930b93274d`。

检查 endpoint 状态：

```bash
aws ec2 describe-instance-connect-endpoints \
  --region ap-northeast-1 \
  --instance-connect-endpoint-ids eice-05d40adaef160d38f \
  --query 'InstanceConnectEndpoints[0].[InstanceConnectEndpointId,State,SubnetId,VpcId,SecurityGroupIds]' \
  --output table
```

用 AWS CLI v2 连接：

```bash
aws ec2-instance-connect ssh \
  --region ap-northeast-1 \
  --instance-id i-0ef9c3f3745c1b665 \
  --os-user ubuntu \
  --private-key-file ~/.ssh/codex_cloud_ec2_ed25519 \
  --connection-type eice \
  --eice-options endpointId=eice-05d40adaef160d38f
```

本机 `~/.ssh/config` 里已经配置了类似下面的 SSH alias：

```sshconfig
Host codex-cloud-eice
  HostName i-0ef9c3f3745c1b665
  User ubuntu
  IdentityFile ~/.ssh/codex_cloud_ec2_ed25519
  IdentitiesOnly yes
  ProxyCommand sh -c 'aws ec2-instance-connect open-tunnel --region ap-northeast-1 --instance-id %h --instance-connect-endpoint-id eice-05d40adaef160d38f'
```

使用方式：

```bash
ssh codex-cloud-eice
```

### EIC Endpoint 常见问题

- Endpoint 状态是 `create-in-progress`：等它变成 `create-complete`。
- `aws ec2-instance-connect ssh` 提示没有 `ssh` 子命令：安装或升级 AWS CLI v2。
- 认证失败：确认 `~/.ssh/codex_cloud_ec2_ed25519` 对应的公钥在 `~ubuntu/.ssh/authorized_keys`，或者用 `aws ec2-instance-connect send-ssh-public-key` 临时推送公钥。
- 连接超时：重点检查上面的两条安全组规则。
- Endpoint 建在错误子网：在目标实例所在 VPC/子网路径下重建，或命令里指定正确 endpoint ID。
- IAM 报错：当前 AWS 身份需要 EIC 相关权限，例如 `ec2-instance-connect:OpenTunnel` 和 `ec2-instance-connect:SendSSHPublicKey`。

## 方法三：普通公网 SSH

当前网络线路正常时可以直接用：

```bash
ssh codex-cloud
```

本机配置应类似：

```sshconfig
Host codex-cloud
  HostName 54.199.2.92
  User ubuntu
  IdentityFile ~/.ssh/codex_cloud_ec2_ed25519
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
  StrictHostKeyChecking accept-new
```

如果报 `kex_exchange_identification: Connection closed by remote host`，优先切换 VPN/直连，或者直接用 SSM/EIC。若 `nc` 显示 `54.199.2.92` 上很多随机未开放端口都能 connected，基本可以判断是本机 VPN/代理在伪造 TCP 状态。

## 恢复检查清单

1. 先试 `ssh codex-cloud-ssm`。
2. 如果 SSM 不在线，试 `ssh codex-cloud-eice`。
3. 如果 EIC 也不可用，打开 AWS CloudShell，区域选 `ap-northeast-1`，运行上面的 SSM/EIC 检查命令。
4. 如果两条 AWS 托管通道都失败，但浏览器还能访问云端控制台，可以用 `http://54.199.2.92:8787/` 里的终端能力做临时修复。
5. 只有在确认本机网络没有伪造 TCP 状态后，再去排查实例 `sshd`。

## 资料依据

- AWS Systems Manager Session Manager：AWS 官方文档说明它可以在不开放入站端口、不维护 bastion、不管理 SSH key 的情况下管理实例。
- AWS EC2 Instance Connect Endpoint：AWS 官方文档说明它可以通过私网 IP 连接实例，不要求 bastion，也不要求 VPC 具备直接公网连通。
- AWS CLI v2：提供 `aws ec2-instance-connect ssh` 和 `aws ec2-instance-connect open-tunnel` 用于 EIC Endpoint 连接。
