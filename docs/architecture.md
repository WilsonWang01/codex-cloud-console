# Architecture

Codex Cloud Console is a self-hosted control plane for a Codex worker running
near one or more development repositories.

```text
Browser
  │ HTTPS + operator authentication
  ▼
Caddy on Amazon EC2
  │ loopback reverse proxy
  ▼
Node.js console API ── Codex app-server
  │                    ├─ threads and turns
  ├─ repository state  ├─ tool events
  ├─ automation state  └─ model/capability discovery
  ├─ audit events
  └─ notification adapters
```

## Trust boundaries

- The Node service binds to `127.0.0.1` by default.
- Caddy is the public TLS and operator-authentication boundary.
- External automation triggers require a separate random webhook token and an
  idempotency key.
- Production mode fails closed when the app-server fact source is unavailable.
- Repository paths are resolved under a configured workspace root.
- Raw CLI and local review mutations are disabled unless explicitly enabled.

## AWS deployment

The reference deployment uses Amazon EC2, an instance profile, Systems Manager
Session Manager, CloudWatch, and optional S3 artifact storage. The application
does not require long-lived AWS access keys. See
[`aws-instance-access.md`](aws-instance-access.md) for a generic access pattern.

## Project direction

The current implementation is deliberately small and operable by one
developer. Roadmap work focuses on reusable configuration, automated AWS test
matrices, artifact retention, least-privilege deployment templates, and a
documented extension interface for community-provided automations.
