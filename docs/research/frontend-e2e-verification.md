# Cloud Frontend E2E Verification

This project cannot use Codex App-only browser annotations, Appshots, or
Computer Use from the cloud CLI. The cloud equivalent is a Playwright-based
acceptance harness that opens the deployed console, drives the UI, checks
app-server-backed state, and stores replayable artifacts.

## Commands

Fast cloud smoke:

```bash
npm run verify:cloud
```

Replayable frontend acceptance:

```bash
npm run verify:e2e
```

Full local/cloud verification:

```bash
npm run verify:cloud:full
```

By default, `verify:e2e` does not send a real Codex turn. This keeps the suite
fast and avoids consuming model quota on every build. Enable the expensive
paths explicitly:

```bash
CODEX_CLOUD_E2E_REAL_TURN=1 npm run verify:e2e
CODEX_CLOUD_E2E_REAL_TURN=1 CODEX_CLOUD_E2E_COMPACT=1 npm run verify:e2e
```

Useful environment variables:

- `CODEX_CLOUD_E2E_URL`: target console URL. Defaults to
  `CODEX_CLOUD_SMOKE_URL`, `CODEX_CLOUD_CONSOLE_URL`, then
  `http://127.0.0.1:18787/`.
- `CODEX_CLOUD_E2E_REPO`: target repository. Defaults to `invest-dashboard`.
- `CODEX_CLOUD_E2E_ARTIFACT_DIR`: output directory for reports, screenshots,
  fixtures, and trace zip.
- `CODEX_CLOUD_E2E_HEADLESS=0`: run Chromium headed for local debugging.
- `CODEX_CLOUD_E2E_ALLOW_PARTIAL_STATUS=1`: allow local UI-only validation
  when the console is running on a workstation without mounted cloud
  workspaces. Do not set this for cloud deployment acceptance.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`: use a system Chromium binary on cloud
  hosts where Playwright cannot download its bundled browser.

## Coverage

The E2E harness verifies:

- `/healthz`, `/api/status`, `/api/codex/models`, and
  `/api/codex/app-status` use healthy app-server-backed state.
- Desktop project UI renders without disconnect, local mock, stale fallback,
  horizontal overflow, unnamed buttons, or overlapping composer controls.
- Slash command center opens with app-like `/` interaction and exposes status,
  sessions, model, reasoning, compact, and MCP entries.
- Status, model, reasoning, permissions, and session panels open from the same
  composer surface users operate.
- File upload and pasted image attachment chips render in the composer.
- Mobile project page and slash command menu stay inside the viewport.
- Optional real turn verifies the UI response against official
  `/api/codex/thread-read`.
- Optional compact verifies the status panel shows a compacting state and the
  active job completes.

## Artifacts

Each run writes:

- `report.json`: machine-readable result.
- `summary.md`: human-readable acceptance summary.
- `trace.zip`: Playwright trace with snapshots and screenshots.
- `screenshots/*.png`: key desktop/mobile states.

The default artifact root is:

```text
docs/research/acceptance/frontend-e2e/<run-id>/
```

## Known Product Gap

This harness is intentionally not a clone of Codex App's in-app browser. It
cannot create Codex App browser comments, Appshots, or desktop Computer Use
captures from a headless cloud CLI. Those remain app-only interaction features.
For cloud deployment, screenshots, Playwright traces, API evidence, and saved
reports are the durable verification substitute.
