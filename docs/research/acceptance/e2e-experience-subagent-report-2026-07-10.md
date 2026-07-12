# Codex Cloud Console E2E Experience Acceptance Report - 2026-07-10

## Conclusion

Status: not accepted.

The console is partially usable through the local proxy, and core build/schema checks pass, but the current end-to-end acceptance gate fails on authoritative session state, mobile project rendering, and browser 404 errors. The product currently tells the user "cloud Codex online" while key chat/session APIs are degraded, which is the main experience risk.

## Test Environment

- Workspace: `/Users/xiaoxin/Documents/codex_cloud`
- Date/timezone: 2026-07-10, Asia/Shanghai
- Target URL used by smoke/E2E scripts: `http://127.0.0.1:18787/`
- Default repo under test: `invest-dashboard`
- AWS EC2 instance checked by CLI: `i-0ef9c3f3745c1b665`
- EC2 state from AWS CLI during this pass: `running`
- Browser/UI state caveat: the user-provided AWS Console screenshot showed the same instance as stopped earlier, so the deployment/access experience has a stale-state/conflicting-state risk.

## Commands Run

| Command | Result |
| --- | --- |
| `git status --short --branch` | Passed; worktree initially clean (`main...origin/main`). |
| `npm run build` | Passed. Vite built `dist/` successfully. |
| `npm run verify:normalizers` | Passed. Checks: `unknown-item-fallback`, `stable-null-time`, `known-item-time`, `upload-path-attachment`. |
| `npm run codex:schema:check` | Passed. App-server schema is up to date. |
| `node --check server/index.mjs && node --check server/codex-app-server-client.mjs && node --check server/app-server-normalizers.mjs` | Passed. |
| `curl -fsS --max-time 8 http://127.0.0.1:18787/healthz` | Returned `ok=true`, `strictOk=true`, `partial=false`, but `appServer.lastError` included missing log path `ENOENT: no such file or directory, stat '云端日志/smoke-latest.log'`. |
| `npm run verify:api` | Failed. `/api/chat/sessions` failed 10/10 attempts because payload included `"authoritative":false`. |
| `npm run verify:ui` | Failed. `cli-mobile` hit React minified error #306; expected one composer textarea, got 0. |
| `aws ec2 describe-instances --region ap-northeast-1 --instance-ids i-0ef9c3f3745c1b665 ...` | Returned `State=running`, public IP `13.231.3.21`, private IP `172.31.7.169`, type `t3.micro`. |
| `npm run verify:e2e` | Failed. Functional steps mostly passed, but final result failed on browser console/page errors: three `404 Not Found` resource loads. |

## Evidence

- Full frontend E2E artifact root: `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z`
- Trace: `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/trace.zip`
- Screenshots:
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/01-desktop-project.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/02-desktop-slash-menu.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/03-desktop-status-panel.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/04-desktop-model-panel.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/05-desktop-reasoning-panel.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/06-desktop-permissions-panel.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/07-desktop-sessions-panel.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/08-desktop-upload-and-paste-attachments.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/09-mobile-project.png`
  - `docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z/screenshots/10-mobile-slash-menu.png`

## Findings

### P1 - Chat session API is degraded while the UI presents cloud status as healthy

`npm run verify:api` failed because `/api/chat/sessions?repoId=invest-dashboard` returned a degraded/mock/fallback payload containing `"authoritative":false` in all 10 repeated attempts.

Why this is bad for users: the shell still shows "云端 Codex 在线" and active project/session surfaces, but the backing session list is not authoritative. Users can trust the wrong conversation state, continue the wrong session, or miss that the app-server source is not fully healthy.

Reproduction:

```bash
npm run verify:api
```

Observed failure:

```text
chat sessions had 10/10 failed attempts
chat sessions returned degraded/mock/fallback payload: "authoritative":false
```

Acceptance requirement: `/api/chat/sessions`, `/api/chat/active`, and `/api/codex/thread-state` must all return `source: "app-server"`, `authoritative: true`, and `partial: false` before the UI is allowed to show a normal online state.

### P1 - Mobile CLI route crashes and loses the composer

`npm run verify:ui` failed on `cli-mobile` with React minified error #306. The smoke script expected one composer textarea and found none.

Why this is bad for users: mobile users can land on a blank/broken project screen without the primary input control. That is a core workflow failure, not a cosmetic issue.

Reproduction:

```bash
npm run verify:ui
```

Observed failure:

```text
cli-mobile errors:
Minified React error #306 ...
slashCommand: expected one composer textarea, got 0
```

Acceptance requirement: mobile project route must render the active session, composer textarea, slash menu, status controls, and no uncaught React errors.

### P1 - Full E2E run fails on uncaught browser 404s

`npm run verify:e2e` completed the main desktop/mobile steps, upload/paste attachment checks, and command panels, but failed the run because the browser recorded three `404 Not Found` resource errors.

Why this is bad for users: missing resources are usually stale bundles, service worker cache drift, asset path mismatch, or routes that silently fail. Even if the main page visually loads, the E2E gate correctly treats uncaught 404s as release blockers because they often become intermittent production failures.

Reproduction:

```bash
npm run verify:e2e
```

Evidence:

```text
artifactRoot: docs/research/acceptance/frontend-e2e/2026-07-10T10-52-54-825Z
error: browser console/page errors: Failed to load resource: the server responded with a status of 404 (Not Found) x3
```

Acceptance requirement: E2E must fail on uncaught browser errors, and the product should not ship until the missing resource URLs are identified and either fixed or explicitly ignored with a narrow allowlist.

### P2 - Health endpoint reports healthy while carrying an app-server lastError

`/healthz` returned `ok=true`, `strictOk=true`, and `partial=false`, but also included:

```text
ENOENT: no such file or directory, stat '云端日志/smoke-latest.log'
```

Why this is bad for users/operators: health looks green even while surfacing a stale internal file-path error. This weakens trust in the status model and leaks an implementation detail into the health payload.

Acceptance requirement: stale log-file misses should be either downgraded to a non-health-impacting diagnostics field or hidden from `appServer.lastError` when app-server itself is available.

### P2 - AWS instance state was contradictory between browser and CLI

The user-visible AWS Console screenshot showed `i-0ef9c3f3745c1b665` as stopped, while the AWS CLI later returned `State=running`. This may be a stale AWS Console table, delayed refresh, or a user-visible filtering/cache issue.

Why this matters: deployment instructions depend on whether Session Manager/SSH can connect. If the console view is stale, the operator can make the wrong decision about starting, connecting, or deploying.

Acceptance requirement: deployment runbooks should tell operators to refresh the EC2 table and verify state with either the instance details page or:

```bash
aws ec2 describe-instances --region ap-northeast-1 --instance-ids i-0ef9c3f3745c1b665
```

## UX Risk Areas Reviewed

- First screen and project shell: renders, but can show online state while sessions are degraded.
- Session switching: not accepted because session list source can be non-authoritative.
- Automation views: smoke render passed on desktop, but external trigger trust depends on backend findings in the code review report.
- Webhook/heartbeat guidance: not fully revalidated in this pass beyond render smoke.
- Mobile layout: not accepted because `cli-mobile` crashes.
- Upload/paste attachment flow: passed in the full E2E script before the final browser-error failure.
- Status trust: not accepted because health and session authority disagree.
- Cloud unreachable/stale states: not fully covered; existing failures show the product still blurs healthy/degraded distinctions.

## Suggested Acceptance Gates

1. `npm run verify:api` must pass without allowing degraded payloads.
2. `npm run verify:ui` must pass on desktop and mobile with no React errors and exactly one project composer textarea.
3. `npm run verify:e2e` must pass with zero uncaught browser console/page errors.
4. `/healthz` must not report `strictOk=true` while exposing app-server `lastError` caused by optional log/stat failures.
5. The UI online badge should require authoritative app-server session/thread state, not only account/app-server reachability.
6. Deployment docs should include an explicit EC2 state verification step before SSH/SSM instructions.

## Uncovered / Partial

- Did not run a real Codex turn (`CODEX_CLOUD_E2E_REAL_TURN=1`), so streaming response quality and actual command/tool behavior were not accepted.
- Did not run compact flow (`CODEX_CLOUD_E2E_COMPACT=1`).
- Did not manually inspect every screenshot beyond the scripted failures.
- Did not test external third-party webhook callers end to end.
- Did not test service restart recovery, stale service-worker cleanup, or multi-tab conflict behavior.
