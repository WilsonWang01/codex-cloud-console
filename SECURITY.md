# Security Policy

## Supported versions

Until the project reaches 1.0, security fixes are applied to the latest commit
on `main`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature on this repository.
Do not open a public issue for suspected credential exposure, authentication
bypass, path traversal, cross-repository data access, or remote command
execution.

Include the affected commit, reproduction steps, expected impact, and any
suggested mitigation. You should receive an acknowledgement within seven days.

## Deployment boundary

This console can initiate privileged development-agent operations. Operators
must keep the Node service on loopback, put an authenticated HTTPS reverse
proxy in front of it, use a random webhook token, restrict the EC2 security
group, and avoid mounting unrelated credentials or repositories. Example
values in this repository are documentation values only.
