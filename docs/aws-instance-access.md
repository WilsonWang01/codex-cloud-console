# AWS Instance Access

This guide describes a generic recovery path for an EC2-hosted Codex Cloud
Console. Replace every placeholder with resources from your own AWS account.
Never commit account IDs, instance IDs, IP addresses, SSH private-key paths, or
credentials to the repository.

## Recommended order

1. AWS Systems Manager Session Manager
2. EC2 Instance Connect Endpoint
3. Public SSH only when the deployment explicitly requires it

The first two approaches avoid exposing SSH directly to the internet.

## Systems Manager Session Manager

Attach an EC2 instance profile containing the minimum permissions required by
the SSM agent. AWS provides `AmazonSSMManagedInstanceCore` as a starting point;
review and narrow permissions for your environment.

Check registration:

```bash
aws ssm describe-instance-information \
  --region <aws-region> \
  --filters Key=InstanceIds,Values=<instance-id> \
  --query 'InstanceInformationList[*].[InstanceId,PingStatus,AgentVersion,PlatformName,LastPingDateTime]' \
  --output table
```

Start a shell:

```bash
aws ssm start-session \
  --region <aws-region> \
  --target <instance-id>
```

SSH over SSM can be configured locally without checking private host data into
the project:

```sshconfig
Host codex-cloud-ssm
  HostName <instance-id>
  User ubuntu
  IdentityFile ~/.ssh/<private-key-name>
  IdentitiesOnly yes
  ProxyCommand sh -c 'aws ssm start-session --region <aws-region> --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p'
```

## EC2 Instance Connect Endpoint

Create the endpoint in a subnet that can reach the instance. Restrict the
instance security group so TCP port 22 accepts traffic only from the endpoint
security group.

Inspect the endpoint:

```bash
aws ec2 describe-instance-connect-endpoints \
  --region <aws-region> \
  --instance-connect-endpoint-ids <endpoint-id> \
  --output table
```

Connect with AWS CLI v2:

```bash
aws ec2-instance-connect ssh \
  --region <aws-region> \
  --instance-id <instance-id> \
  --os-user ubuntu \
  --private-key-file ~/.ssh/<private-key-name> \
  --connection-type eice \
  --eice-options endpointId=<endpoint-id>
```

The IAM identity opening the tunnel needs the relevant EC2 Instance Connect
permissions. Scope resource ARNs and conditions to the intended instances,
users, VPC, and endpoint.

## Public SSH

If public SSH is unavoidable, limit port 22 to a known source CIDR, disable
password authentication, use short-lived access where possible, and monitor
authentication logs. Do not use `0.0.0.0/0` for SSH.

## Recovery checklist

1. Confirm the instance is running and the selected AWS region is correct.
2. Confirm the instance profile is attached and SSM reports the node online.
3. Verify route tables, VPC endpoints or internet egress needed by the SSM
   agent.
4. Verify EC2 Instance Connect Endpoint state and security-group references.
5. Inspect the console service with `systemctl status` and `journalctl` only
   after establishing a managed session.
6. Keep the Node service on loopback and verify the authenticated HTTPS proxy
   separately.

## References

- [AWS Systems Manager Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
- [EC2 Instance Connect Endpoint](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-ec2-instance-connect-endpoint.html)
- [Security groups for EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html)
