# Codex Cloud Console

A self-hosted web console for operating a persistent Codex worker and
repository automations on AWS EC2.

Codex Cloud Console brings threads, repository status, automation runs, health
signals, approvals, generated files, and live operation events into one
browser interface. It is designed for individual developers and small teams
that want to keep their development environment in their own AWS account.

> [!IMPORTANT]
> This is an independent community project. It is not an official product of,
> or affiliated with, OpenAI or Amazon Web Services.

## Why this project exists

Long-running development agents need more than a terminal. Operators need to
know which repository and thread own a task, whether a run is still active,
what changed, whether the underlying service is healthy, and how to recover
without weakening the host. This project provides that operational layer while
keeping the worker and its data self-hosted.

## Features

- Browser access to Codex app-server threads and turn events.
- Repository-aware sessions, file browsing, uploads, and generated artifacts.
- Searchable Codex plugin catalog with explicit install and uninstall controls.
- Scheduled, manual, webhook, and heartbeat automation triggers.
- Run history, audit events, attention queues, and optional notifications.
- Production fail-closed behavior when the authoritative app-server source is
  unavailable.
- Atomic EC2 deployment with health checks and release rollback.
- Loopback-only application server behind authenticated HTTPS.
- Repeatable local, API, UI, and end-to-end verification commands.

See [Architecture](docs/architecture.md) for the system boundaries and AWS
deployment shape.

## Security model

This console can initiate development-agent operations and must be treated as
a privileged administration surface.

- Keep the Node service bound to `127.0.0.1`.
- Put Caddy or another authenticated HTTPS reverse proxy in front of it.
- Restrict the EC2 security group; do not expose port `8787` publicly.
- Configure a random `CODEX_CLOUD_WEBHOOK_TOKEN` for external triggers.
- Prefer an EC2 instance profile and Systems Manager over long-lived AWS keys.
- Mount only repositories and credentials needed by the worker.

Read [SECURITY.md](SECURITY.md) before using the project with non-test data.

## Requirements

- Node.js 22 or newer
- A working Codex CLI/app-server installation on the host
- Linux for the reference systemd deployment
- Caddy or an equivalent authenticated HTTPS reverse proxy for remote access

## Local development

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:5174`.

The local server stores disposable state under `.codex-cloud-state/` and
`.codex-cloud-local/`, both of which are ignored by Git.

## EC2 deployment

The reference layout uses `/home/ubuntu/codex-cloud`:

```text
/home/ubuntu/codex-cloud/
├── console-current -> releases/console/<release-id>
├── releases/console/
├── workspace/
├── logs/
├── state/
└── worktrees/
```

Create a server-only environment file from
[`ops/codex-cloud-console.env.example`](ops/codex-cloud-console.env.example),
then install the systemd service:

```bash
sudo install -m 600 ops/codex-cloud-console.env.example /etc/codex-cloud-console.env
sudo editor /etc/codex-cloud-console.env
sudo bash ops/install-systemd.sh
```

The installer validates the environment, builds with `npm ci` in a new release
directory, atomically switches `console-current`, and rolls back if the strict
health check fails. Workspace and state directories remain outside releases.

For resilient EC2 access without opening inbound SSH, see
[AWS instance access](docs/aws-instance-access.md).

## Configuration

Important server-side variables include:

| Variable | Purpose |
| --- | --- |
| `CODEX_CLOUD_ROOT` | Root for workspace, logs, state, and releases |
| `CODEX_WORKSPACE_ROOT` | Parent directory containing managed repositories |
| `CODEX_CLOUD_PUBLIC_ORIGIN` | Canonical authenticated HTTPS origin |
| `CODEX_CLOUD_WEBHOOK_TOKEN` | Token required by automation webhooks |
| `CODEX_PUBLIC_IP` / `CODEX_PRIVATE_IP` | Optional display-only instance metadata |
| `AWS_REGION` | Region displayed by the console |
| `CODEX_ALLOW_LOCAL_FALLBACK` | Development-only fallback; leave unset in production |
| `CODEX_ENABLE_CLI_DEBUG` | Opt-in raw CLI diagnostics |
| `CODEX_ENABLE_LOCAL_REVIEW_READ` | Opt-in local review reads |
| `CODEX_ENABLE_LOCAL_REVIEW_MUTATION` | Opt-in local review mutations |
| `CODEX_PLUGIN_CATALOG_CACHE_TTL_MS` | Plugin catalog cache lifetime; defaults to five minutes |
| `CODEX_AUTOMATION_RECOVERY_ENABLED` | Continue eligible interrupted app-server runs after restart; defaults to enabled |
| `CODEX_AUTOMATION_RECOVERY_MAX_AGE_MS` | Only recover runs active within this window; defaults to 30 minutes |
| `CODEX_AUTOMATION_RECOVERY_MAX_ATTEMPTS` | Bounded automatic continuation attempts per lineage; defaults to one |
| `CODEX_AUTOMATION_RECOVERY_STARTUP_DELAY_MS` | Startup grace period before recovery; trigger requests wait behind this gate; defaults to one second |

The checked-in values are documentation placeholders. Never commit a populated
environment file.

Repositories can also be added through the console. Their definitions are
stored under the configured state directory, not in the source checkout.

## Verification

Run the isolated checks before opening a pull request:

```bash
npm run verify:local
```

This validates the generated app-server schema, normalizers, TypeScript build,
and regression suite.

After deploying to a controlled test instance:

```bash
npm run verify:cloud
```

For the full browser pass with replayable Playwright artifacts:

```bash
npm run verify:cloud:full
```

When the bundled Playwright browser is unavailable, point the verification
scripts at an installed browser:

```bash
PLAYWRIGHT_CHROMIUM_CHANNEL=chrome npm run verify:ui
# Or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an absolute browser path.
```

Real model turns are opt-in because they can incur usage:

```bash
CODEX_CLOUD_E2E_REAL_TURN=1 npm run verify:e2e
```

## Automation webhooks

External callers use the same automation pipeline as scheduled and manual
runs. Configure the public origin and webhook token, then send a stable
idempotency key:

```bash
curl -X POST "$CODEX_CLOUD_URL/api/automations/sample-maintenance/webhook" \
  -H "x-codex-cloud-token: $CODEX_CLOUD_WEBHOOK_TOKEN" \
  -H "Idempotency-Key: sample-maintenance-$(date +%F)" \
  -H "Content-Type: application/json" \
  -d '{"runner":"app-server","worktree":true}'
```

Use `/api/automations/:id/heartbeat` with a session ID to continue an existing
thread instead of creating an isolated run.

## Project status

The project is pre-1.0 and currently maintainer-led. Interfaces and deployment
details may change between releases. See [GOVERNANCE.md](GOVERNANCE.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) to participate.

## License

Licensed under the [Apache License 2.0](LICENSE).
