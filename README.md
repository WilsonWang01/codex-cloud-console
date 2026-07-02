# Codex Cloud Console

Browser console for the Codex worker running on EC2. It mirrors the Codex desktop shape: workspace rail, automation runs, repo status, cloud health, and live operation logs.

## Local development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5174`.

## Cloud deployment

Run the app on the EC2 instance that already hosts `/home/ubuntu/codex-cloud`. The API reads:

- `/home/ubuntu/codex-cloud/workspace/*` repositories
- `/home/ubuntu/codex-cloud/logs`
- `systemctl list-timers 'codex-auto-*'`
- `codex login status`

Production mode is app-server-only for user-visible state and mutation. If
Codex app-server file, command, model, session, or thread calls fail, the API
must return an explicit non-authoritative error instead of a successful local
fallback. Set `CODEX_ALLOW_LOCAL_FALLBACK=1` only for local development.

Raw local CLI and local review mutation helpers are disabled by default. They
are available only for controlled debugging with:

- `CODEX_ENABLE_CLI_DEBUG=1`
- `CODEX_ENABLE_LOCAL_REVIEW_READ=1`
- `CODEX_ENABLE_LOCAL_REVIEW_MUTATION=1`

Recommended EC2 install path:

```bash
mkdir -p /home/ubuntu/codex-cloud/console
cd /home/ubuntu/codex-cloud/console
npm install
npm run build
bash ops/install-systemd.sh
```

The systemd service listens on `127.0.0.1:8787` by default. Browser access should go through the fixed HTTPS Caddy entrypoint or the local `127.0.0.1:18787` proxy. Do not expose the raw console port directly in the EC2 security group.

## Operations

- AWS instance access and recovery: [docs/aws-instance-access.md](docs/aws-instance-access.md)

## Verification

Run the full local/cloud smoke suite after changing the app-server bridge,
session UI, proxy, upload, automation, or status read model:

```bash
npm run verify:cloud
```

That command checks the generated Codex app-server schema, builds the frontend,
then verifies the live console through `http://127.0.0.1:18787/`:

- `/healthz` and `/api/status` must be healthy.
- `/api/chat/sessions`, `/api/chat/active`, and `/api/codex/thread-state`
  are called repeatedly to catch transient 502s.
- Desktop and mobile Playwright smoke pages must have no horizontal overflow,
  no loading dead state, and no visible local mock, disconnect, raw shell, or
  worktree path leakage.

Use `CODEX_CLOUD_SMOKE_URL`, `CODEX_CLOUD_SMOKE_REPO`,
`CODEX_CLOUD_SMOKE_REPEAT`, and `CODEX_CLOUD_SMOKE_UI_WAIT_MS` to target a
different console, repository, or timing profile.

## Use The Cloud Console

The public EC2 console port may be restricted by security groups or local
network policy. The stable local browser path is a LaunchAgent-backed proxy
that serves the built frontend locally and forwards API calls to the cloud
entrypoint with a token header. It also keeps a small cache for GET status
responses so a transient upstream reset does not make the UI report a false
disconnect. Session, thread, app-status, model, and automation fact-source
endpoints are not served fresh-cache-first. Any stale fallback is marked with
`x-codex-cloud-proxy-fallback: stale-cache` and must be treated as degraded.

This machine has a LaunchAgent that keeps the tunnel open at:

```text
http://127.0.0.1:18787/
```

MCP OAuth flows should be started from this local proxy URL. Codex app-server
creates loopback callback URLs on the EC2 host; the local proxy temporarily
listens on the callback port and relays the callback back to the cloud worker.
Opening the fixed HTTPS URL directly still works for normal chat, but it cannot
complete those loopback OAuth callbacks by itself.

To reinstall or refresh that background proxy:

```bash
npm run cloud:console:install
```

To open the browser, or start the background proxy if it is not running:

```bash
npm run cloud:console
```

To stop the persistent proxy:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.codex.cloud-console-proxy.plist
```

## Automation Triggers

Scheduled timers, manual runs, webhooks, and heartbeats all enter the same
app-server `AutomationRun` pipeline. For external callers, set
`CODEX_CLOUD_WEBHOOK_TOKEN` on the cloud service and call:

```bash
curl -X POST "$CODEX_CLOUD_URL/api/automations/invest-daily-update/webhook" \
  -H "Authorization: Bearer $CODEX_CLOUD_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"runner":"app-server","worktree":true}'
```

Use `/api/automations/:id/heartbeat` with `{"sessionId":"..."}` when the run
should continue an existing app-server thread instead of creating an isolated
worktree thread.
