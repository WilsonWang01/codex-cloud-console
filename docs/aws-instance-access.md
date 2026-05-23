# AWS Instance Access Runbook

This runbook records the stable access paths for the Codex Cloud EC2 instance so a new Codex session can recover access without rediscovering the setup.

## Target Instance

- Purpose: Codex Cloud Console and scheduled Codex jobs
- Region: `ap-northeast-1` (Tokyo)
- Instance ID: `i-0ef9c3f3745c1b665`
- Public IPv4: `54.199.2.92`
- Private IPv4: `172.31.7.169`
- VPC: `vpc-0f07766a08d6f876e`
- Subnet: `subnet-09ee30d7f42788c6f`
- Availability Zone: `ap-northeast-1c`
- Instance security group: `sg-05abf23930b93274d`
- Cloud app: `http://54.199.2.92:8787/`
- Local SSH key: `~/.ssh/codex_cloud_ec2_ed25519`
- Normal local SSH alias: `codex-cloud`

## Why We Added Fallbacks

The instance-side SSH key and `sshd` were verified as healthy, but the local VPN path can break plain public SSH. The observed symptom was unusual: `nc` from the Mac reported arbitrary ports on `54.199.2.92` as connected, while SSH on port 22 closed during key exchange. Treat that as local VPN/proxy TCP interception, not an EC2 `sshd` failure.

Use access methods in this order:

1. `codex-cloud-ssm` through AWS Systems Manager Session Manager.
2. `codex-cloud-eice` through EC2 Instance Connect Endpoint.
3. `codex-cloud` plain public SSH, only when the current network path is clean.

## Method 1: SSM Session Manager

SSM is the most stable path for VPN changes because the instance opens outbound HTTPS to AWS Systems Manager and does not require inbound SSH from the Mac.

AWS resources:

- IAM role: `codex-cloud-ssm-role`
- Instance profile: `codex-cloud-ssm-profile`
- Attached managed policy: `arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`
- Verified on 2026-05-23: SSM reports `i-0ef9c3f3745c1b665 Online`, agent `3.3.4121.0`, platform `Ubuntu`.

Check SSM registration from AWS CloudShell or any configured AWS CLI:

```bash
aws ssm describe-instance-information \
  --region ap-northeast-1 \
  --filters Key=InstanceIds,Values=i-0ef9c3f3745c1b665 \
  --query 'InstanceInformationList[*].[InstanceId,PingStatus,AgentVersion,PlatformName,LastPingDateTime]' \
  --output table
```

Start a shell:

```bash
aws ssm start-session \
  --region ap-northeast-1 \
  --target i-0ef9c3f3745c1b665
```

Optional local SSH-compatible alias in `~/.ssh/config`:

```sshconfig
Host codex-cloud-ssm
  HostName i-0ef9c3f3745c1b665
  User ubuntu
  IdentityFile ~/.ssh/codex_cloud_ec2_ed25519
  IdentitiesOnly yes
  ProxyCommand sh -c 'aws ssm start-session --region ap-northeast-1 --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p'
```

Then connect with:

```bash
ssh codex-cloud-ssm
```

Local prerequisites:

```bash
brew install awscli session-manager-plugin
aws configure sso
```

Use the AWS account `476405982853` and region `ap-northeast-1`. Do not store access keys in this repo.

Note: Homebrew can install `awscli` without prompting, but the `session-manager-plugin` cask may ask for the macOS sudo password because it installs a package. If non-interactive install fails, rerun `brew install session-manager-plugin` in a local terminal and enter the Mac password.

### SSM Troubleshooting

- Empty `describe-instance-information`: wait 2-5 minutes after attaching the IAM profile, then check that `amazon-ssm-agent` is installed and running on the instance.
- `TargetNotConnected`: agent is installed but cannot reach AWS SSM endpoints, or the IAM profile has not propagated.
- `session-manager-plugin not found`: install the local plugin with Homebrew.
- `AccessDeniedException`: the AWS identity lacks `ssm:StartSession` or related permissions.
- SSH over SSM fails but `start-session` works: use the plain SSM shell, then repair `sshd` or `authorized_keys` from inside.

Instance-side agent repair command:

```bash
if command -v snap >/dev/null 2>&1; then
  sudo snap list amazon-ssm-agent >/dev/null 2>&1 || sudo snap install amazon-ssm-agent --classic
  sudo snap start amazon-ssm-agent || true
fi

sudo systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null \
  || sudo systemctl enable --now amazon-ssm-agent.service

systemctl status snap.amazon-ssm-agent.amazon-ssm-agent.service amazon-ssm-agent.service --no-pager
```

## Method 2: EC2 Instance Connect Endpoint

EIC Endpoint is the second stable path. It creates an AWS-managed private tunnel into the VPC, so SSH does not depend on the instance public IP path.

AWS resources:

- Endpoint ID: `eice-05d40adaef160d38f`
- Endpoint security group: `sg-0b557ee89c2c40c54`
- Endpoint subnet: `subnet-09ee30d7f42788c6f`
- Endpoint VPC: `vpc-0f07766a08d6f876e`
- Verified on 2026-05-23: endpoint reached `create-complete`, CloudShell connected through EIC to `ip-172-31-7-169`, and used it to restart `amazon-ssm-agent`.

Security group rules that matter:

- Instance SG `sg-05abf23930b93274d`: inbound TCP `22` from endpoint SG `sg-0b557ee89c2c40c54`.
- Endpoint SG `sg-0b557ee89c2c40c54`: outbound TCP `22` to instance SG `sg-05abf23930b93274d`.

Check endpoint state:

```bash
aws ec2 describe-instance-connect-endpoints \
  --region ap-northeast-1 \
  --instance-connect-endpoint-ids eice-05d40adaef160d38f \
  --query 'InstanceConnectEndpoints[0].[InstanceConnectEndpointId,State,SubnetId,VpcId,SecurityGroupIds]' \
  --output table
```

Connect with AWS CLI v2:

```bash
aws ec2-instance-connect ssh \
  --region ap-northeast-1 \
  --instance-id i-0ef9c3f3745c1b665 \
  --os-user ubuntu \
  --private-key-file ~/.ssh/codex_cloud_ec2_ed25519 \
  --connection-type eice \
  --eice-options endpointId=eice-05d40adaef160d38f
```

Optional local SSH alias:

```sshconfig
Host codex-cloud-eice
  HostName i-0ef9c3f3745c1b665
  User ubuntu
  IdentityFile ~/.ssh/codex_cloud_ec2_ed25519
  IdentitiesOnly yes
  ProxyCommand sh -c 'aws ec2-instance-connect open-tunnel --region ap-northeast-1 --instance-id %h --instance-connect-endpoint-id eice-05d40adaef160d38f'
```

Then connect with:

```bash
ssh codex-cloud-eice
```

### EIC Endpoint Troubleshooting

- Endpoint state is `create-in-progress`: wait until it becomes `create-complete`.
- `aws ec2-instance-connect ssh` says the `ssh` subcommand is unknown: install or upgrade AWS CLI v2.
- Authentication fails: make sure `~/.ssh/codex_cloud_ec2_ed25519` matches the public key in `~ubuntu/.ssh/authorized_keys`, or use `aws ec2-instance-connect send-ssh-public-key` to push a temporary key.
- Connection times out: recheck the two security group rules above.
- Endpoint exists in the wrong subnet: recreate it in the same VPC/subnet path as the target instance, or specify the correct endpoint ID.
- IAM failure: the AWS identity needs EIC permissions such as `ec2-instance-connect:OpenTunnel` and `ec2-instance-connect:SendSSHPublicKey`.

## Method 3: Plain Public SSH

Fast path when the local network is clean:

```bash
ssh codex-cloud
```

Expected local config:

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

If this fails with `kex_exchange_identification: Connection closed by remote host`, switch VPN routes or use SSM/EIC. If `nc` says random unused ports are open on `54.199.2.92`, assume the local VPN/proxy is spoofing TCP state.

## Recovery Checklist

1. Try `ssh codex-cloud-ssm`.
2. If SSM is not online, try `ssh codex-cloud-eice`.
3. If EIC is not available, open AWS CloudShell in `ap-northeast-1` and run the SSM/EIC check commands above.
4. If both managed paths fail, use the Cloud app terminal at `http://54.199.2.92:8787/` if the browser can still reach it.
5. Only debug instance `sshd` after verifying the local network is not spoofing arbitrary TCP ports.

## Source Notes

- AWS Systems Manager Session Manager is documented by AWS as a managed shell that does not require opening inbound ports, bastion hosts, or SSH key management.
- AWS EC2 Instance Connect Endpoint is documented by AWS as a way to connect to instances through private IP without requiring a bastion host or direct VPC internet connectivity.
- AWS CLI v2 provides `aws ec2-instance-connect ssh` and `aws ec2-instance-connect open-tunnel` for EIC Endpoint connections.
