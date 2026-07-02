# Acceptance Synthesis - 2026-07-02

Scope: isolated end-to-end acceptance plus isolated code review for the cloud Codex CLI / Codex App aligned console.

## Source Reports

- E2E acceptance: `docs/research/acceptance/e2e-subagent-report-2026-07-02.md`
- Code review: `docs/research/acceptance/code-review-subagent-report-2026-07-02.md`

## Result

The project is functional and not a pure UI mock: the deployed console can reach the cloud app-server, list projects/sessions, send a real turn, read the official thread, set/clear goal, compact context, upload files, open slash commands, switch model/reasoning/permission panels, and render desktop/mobile without overflow.

It is not yet a fully app-server-native Codex App session host. The code review found blocking architecture gaps: local chat store, process-local job maps, custom SSE, automation JSON state, local review mutation helpers, CLI bypass terminal, and local/proxy caches still participate in state. Those gaps mean app-server is not the sole source of truth for thread/message/token/goal/compact/model/permission/MCP/plugin/review mutation/diff event replay.

## Fixed In Main Thread

- `/healthz` no longer blocks on slow direct Codex/login/repo probes. It now reuses the stale-while-revalidate status read model and returns the `health` snapshot quickly while slow probes refresh in the background.
- The local proxy no longer serves fresh-cache-first responses for session/thread/app-status/model/automation fact-source endpoints. It only keeps lightweight cache for health/status/notification status.
- `scripts/smoke-api.mjs` now fails on stale proxy fallback, partial/mock/local-fallback payloads, and raw deployment command leakage.
- Explicit missing `sessionId` now returns `404` on:
  - `/api/chat/active`
  - `/api/chat/history`
  - `/api/codex/thread-state`
  - `/api/codex/thread-read`
- App-server thread import is now stricter: only `app-<threadId>` or UUID-like thread IDs are considered importable, and the returned app-server thread id must match the requested id.
- Deployment/diagnostic shell audit summaries no longer expose raw `grep/stat/systemctl show` commands in Inbox/status.

## Fixed In Continued Repair Pass

- Production file, upload, blob, write, terminal, chat, pull, and automation-control fallback paths now fail explicitly when app-server is unavailable unless `CODEX_ALLOW_LOCAL_FALLBACK=1` is set for development.
- `scripts/smoke-api.mjs` now verifies app-server source for file tree/search, uploads, file reads, blob previews, and file writes.
- `/api/codex/models` no longer returns hardcoded model choices on app-server failure. It returns `502` with `source:"app-server-unavailable"`; successful responses include `source:"app-server"` and `authoritative:true`.
- `/api/codex/app-status` and `/api/codex/thread-state` now expose `source`, `authoritative`, and `partial` so the UI and smoke can reject non-authoritative state.
- Frontend loading for models, app status, and thread state now refuses non-authoritative responses instead of writing fallback values into primary UI state.
- App-server normalizers now preserve unknown item types as structured fallback messages and no longer replace invalid/missing timestamps with the current time.
- Added `npm run verify:normalizers` and wired it into `verify:cloud` to guard unknown app-server item handling.
- Raw CLI bypass routes are production-disabled by default: `/api/cli/sessions` returns `404`, and `/api/cli/terminal` rejects websocket upgrades unless `CODEX_ENABLE_CLI_DEBUG=1`.
- Local review helper routes are production-disabled by default: read routes `/api/codex/review/summary`, `/api/codex/review/snapshot`, `/api/codex/review/pr-context` return `501` unless `CODEX_ENABLE_LOCAL_REVIEW_READ=1`; mutation routes `/api/codex/review/action`, `/api/codex/review/pr-comment`, and `/api/codex/review/git/init` return `501` unless `CODEX_ENABLE_LOCAL_REVIEW_MUTATION=1`.
- Cross-project `@project:<repo>` mentions are ignored until app-server multi-root authorization exists; current-project file mention existence now uses app-server `fs/getMetadata`, not local `fs.stat`.
- App-server request timeouts are tracked as orphaned requests in app-host status, and late responses are recorded instead of disappearing silently.
- Automation reconciliation no longer marks running app-server automations as failed after a console restart; it marks them `interrupted` with an explicit unknown-state summary.
- Uploaded attachment paths persisted in official user messages are now hydrated back into attachment metadata, so refreshed thread history can render attachment cards/previews instead of plain path text only.
- Default active-session selection now prefers the latest app-server thread over empty local draft sessions. Local drafts are only preserved on explicit editing actions such as creating/selecting a draft, changing runtime, or saving draft input/attachments.
- Archive/delete/clear-history responses now recompute the active session after store mutation so `activeSessionId`, `sessions`, and returned `messages` stay consistent.
- `scripts/smoke-api.mjs` now covers this regression: forced session sync must activate an app-server thread, immediate draft creation must keep the local draft active, and the next forced sync must not let the empty local draft replace app-server state.
- App-server thread history no longer falls back to cached local `session.messages` when `thread/read` fails. The route now returns an explicit app-server read error message instead of stale cached conversation text.
- App-server thread refresh no longer persists official message bodies into the local chat session store; the local store keeps summary/runtime metadata while message content is read from app-server.
- `scripts/smoke-api.mjs` now verifies `/api/chat/history` for the active app-server session returns official thread messages without `mocked`, `threadReadError`, or `app-server-unavailable` markers.
- `/api/chat/active` now includes an app-server thread-state summary (`source`, `authoritative`, `partial`, token usage, goal, runtime) instead of reporting only process-local `activeTurns` / `activeCompactions` maps.
- `/api/chat/job-events` now explicitly marks the no-local-job path as `source:"process-local"` and `eventReplay:false`, with app-server thread-state summary when available. This makes the remaining event replay limitation visible instead of implying app-server-backed replay.
- `scripts/smoke-api.mjs` now verifies `/api/chat/active` includes authoritative app-server thread state.
- `/api/automations/runs` and `/api/automations/inbox` now add lightweight app-server thread verification for recent runs with `threadId`, exposing `stateSource:"local-run-store+app-server-thread"` and `threadVerified:true` when `thread/read` succeeds.
- `scripts/smoke-api.mjs` now verifies automation runs include at least one app-server thread-verified run, so the endpoint cannot silently regress to pure local JSON state.
- `/api/chat/sessions` now performs a fast app-server `thread/list` sync for normal reads and returns `502` with `source:"app-server-unavailable"` if that authoritative sync fails. Local cached sessions are still used for explicit local draft editing responses, but not as the normal session-list fact source.
- `/api/chat/sessions` responses now expose `source`, `authoritative`, `sessionListSource`, and `sessionListAuthoritative`; `scripts/smoke-api.mjs` asserts these are app-server authoritative for normal reads.
- Expired `/api/codex/app-status` and `/api/codex/thread-state` caches no longer return stale data as `authoritative:true`. The server now waits briefly for app-server refresh; if refresh times out, stale cache is explicitly marked `source:"app-server-stale"`, `authoritative:false`, and `partial:true`, which smoke and frontend state loaders reject.
- `/api/codex/app-status` now returns HTTP `503` for any non-authoritative or partial payload, and the first-response wait window was raised from `2s` to `8s` so the browser does not show a false disconnect during normal app-server refresh.
- `/api/codex/thread-state` first-response wait was raised from `1.5s` to `5s` for the same reason: prefer a short authoritative wait over showing stale state in the Codex App-style UI.
- Missing repository paths no longer render `mock snapshot` or `Cloud console preview`; `/api/status` now marks them as `source:"repository-unavailable"` with explicit unavailable text.
- `scripts/smoke-api.mjs` now treats `mock snapshot` and `Cloud console preview` as degraded status payloads.
- Frontend `api()` now rejects HTTP `200` JSON payloads with `ok:false`, so callers cannot accidentally write failed responses into primary UI state.
- Frontend failed turn/compact/review paths now mark messages as `messageType:"error"` or failed review state instead of `mocked:true`; user-visible labels no longer say `Codex 模拟响应` or `模拟日志`.
- API/UI smoke now treats `模拟响应` and `模拟日志` as degraded output.
- Local proxy API/health failures now return structured JSON with `ok:false`, `layer:"local-proxy"`, `path`, and `requestId` instead of plain-text `Cloud console proxy error`. The proxy also forwards `x-codex-cloud-request-id` upstream.
- Verified the proxy error shape with a temporary `18788` proxy pointed at `127.0.0.1:9`: `/api/status` returned HTTP `502` JSON plus `x-codex-cloud-request-id`.
- Service worker notification click URLs are now sanitized to same-origin page paths/hashes. External absolute URLs and `/api` paths are rewritten to `/#/inbox`.
- Verified service worker URL handling with a VM smoke: external URL sanitized, API URL sanitized, same-origin hash route preserved.
- Cloud console systemd now binds the Node service to `127.0.0.1:8787` instead of `0.0.0.0:8787`; browser access is expected to go through Caddy HTTPS or the local proxy.
- Public-IP HTTP Caddy access is now probe/redirect only. `/__proxy_probe` returns a minimal `200` response, while other paths redirect to the fixed HTTPS hostname. The Caddy rule uses `route` so the probe handler is not reordered behind `redir`.
- The local `127.0.0.1:18787` proxy now normalizes stale credentials that still point at a public-IP HTTP URL such as `http://13.231.3.21/` to the fixed `https://13.231.3.21.sslip.io/` entrypoint unless `CODEX_CLOUD_CONSOLE_ALLOW_PUBLIC_HTTP=1` is explicitly set. This prevents the proxy from turning the UI into a Caddy `301` response after HTTP hardening.
- Review summary and snapshot reads no longer depend on the disabled local review helper in production. They now execute read-only `git diff` commands through app-server `command/exec`, reuse the MIT `codexui` diff parser, and return `source:"app-server-command"`, `authoritative:true`, and `readOnly:true`. Stage/revert and PR publication remain disabled unless local review mutation is explicitly enabled.

## Verified After Fixes

- `node --check server/index.mjs`
- `node --check scripts/smoke-api.mjs`
- `node --check scripts/local-cloud-console-proxy.mjs`
- `node --check server/app-server-normalizers.mjs`
- `node --check server/codex-app-server-client.mjs`
- `npm run verify:normalizers`
- `npm run codex:schema:check`
- `npm run build`
- `git diff --check -- server/index.mjs scripts/smoke-api.mjs scripts/local-cloud-console-proxy.mjs`
- Deployed `server/index.mjs` to `/home/ubuntu/codex-cloud/console/server/index.mjs` and restarted `codex-cloud-console.service`.
- Deployed updated `server/app-server-normalizers.mjs`, `server/codex-app-server-client.mjs`, `dist/`, `package.json`, and smoke scripts to `/home/ubuntu/codex-cloud/console`.
- Live route checks:
  - `/healthz` returned `200`.
  - Missing session checks returned `404` for active/history/thread-state/thread-read.
  - `/api/cli/sessions` returned `404` in production default mode.
  - `/api/codex/review/summary` returned `501` in production default mode.
  - `/api/codex/review/action` returned `501` in production default mode.
  - `/api/codex/models`, `/api/codex/app-status`, and `/api/codex/thread-state` returned `source:"app-server"` and `authoritative:true` after app-server status refresh.
  - `/api/codex/thread-read` for the prior E2E upload thread returned one hydrated attachment for `.codex-cloud/uploads/.../e2e-subagent-upload-2026-07-02.txt`.
  - Default `/api/chat/active?repoId=invest-dashboard` still returned `200`.
  - `/api/status` no longer contained raw `terminal: grep`, `grep -n`, or `systemctl show codex-cloud-console.service`.
- `npm run verify:api` passed with missing-session 404, app-server source, raw CLI disabled, local review mutation disabled, and file upload/read/write source checks.
- `CODEX_CLOUD_SMOKE_UI_WAIT_MS=3000 npm run verify:ui` passed on desktop/mobile and slash command checks.
- Deployed the active-session repair package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T04:27:39.461Z`.
- Final `npm run verify:cloud` passed end to end: schema check, normalizer smoke, production build, API smoke, and desktop/mobile UI smoke.
- Deployed the message-source repair package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T04:35:43.549Z`.
- `npm run verify:api` passed with the new `chat history uses official app-server thread messages` check.
- `npm run verify:ui` passed after the message-source deployment on desktop/mobile and slash command checks.
- Deployed the active-state repair package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T04:41:29.993Z`.
- `npm run verify:api` passed with the new `chat active includes authoritative app-server thread state` check.
- `npm run verify:ui` passed after the active-state deployment on desktop/mobile and slash command checks.
- Deployed the automation verification package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T04:47:26.677Z`.
- `npm run verify:api` passed with the new `automation runs include app-server thread verification` check.
- `npm run verify:ui` passed after the automation verification deployment on desktop/mobile and slash command checks.
- Deployed the session-list authoritative package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T04:56:05.389Z`.
- `npm run verify:api` passed with the stricter `/api/chat/sessions` authoritative source assertions.
- `npm run verify:ui` passed after the session-list authoritative deployment on desktop/mobile and slash command checks.
- Deployed the stale-cache authority package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T05:01:37.140Z`.
- `npm run verify:api` and `npm run verify:ui` passed after the stale-cache authority deployment.
- Deployed the app-status first-response wait package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T05:13:15.928Z`.
- Cold `/api/codex/app-status?repoId=invest-dashboard` returned `200`, `source:"app-server"`, `authoritative:true` after waiting about `4.1s`, instead of emitting an early `503` that made the browser report a false disconnect.
- Final `npm run verify:cloud` passed end to end after this deployment: schema check, normalizer smoke, production build, API smoke, and desktop/mobile UI smoke.
- Deployed the repository-unavailable status package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T05:20:01.283Z`.
- `/api/status` returned `200` without `mock snapshot`, `Cloud console preview`, `local-fallback`, `Local mock`, or `连接断开` text.
- Final `npm run verify:cloud` passed again after this deployment.
- Deployed the frontend API/error semantics package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T05:46:03.715Z`.
- Reinstalled/restarted the local `com.codex.cloud-console-proxy` LaunchAgent so `127.0.0.1:18787` uses the structured proxy error handler; `/healthz` and `/api/status` returned healthy payloads without `模拟响应`, `模拟日志`, `Local mock`, or `连接断开`.
- Final `npm run verify:cloud` passed after the proxy restart and frontend API/error semantics deployment.
- Deployed the service-worker URL sanitization package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz` returned `ok:true`, app-server restarted at `2026-07-02T05:56:03.618Z`.
- Live `/codex-cloud-sw.js` contains `safeNotificationUrl`, same-origin checks, and `/api` path rejection.
- Final `npm run verify:cloud` passed after the service-worker deployment.
- Installed the hardened systemd unit on the EC2 instance and restarted `codex-cloud-console.service`; live `/healthz?force=1` reported `ec2Console.host:"127.0.0.1"` and app-server running.
- Patched live `/etc/caddy/Caddyfile` with the routed public-IP HTTP block while preserving the existing `catalystmemo.com` sites; `caddy validate` passed and Caddy reloaded.
- Verified remote listeners: Node listens on `127.0.0.1:8787`; Caddy listens on public `:80` and `:443`.
- Verified public-IP HTTP behavior from the instance: `Host: 13.231.3.21 /__proxy_probe` returned `200 {"ok":true}`, and `/` returned `301 https://13.231.3.21.sslip.io/`.
- Reinstalled/restarted the local `com.codex.cloud-console-proxy` LaunchAgent after adding target normalization; its startup log shows `127.0.0.1:18787 -> https://13.231.3.21.sslip.io/`.
- Live local proxy checks with `?force=1` returned healthy JSON: `/healthz` had `ok:true`, app-server running, and Codex `ChatGPT subscription`; `/api/status` had `localMode:false`, `health:true`, four repos, and no `Local mock`, `连接断开`, `模拟响应`, or `模拟日志`.
- Final `npm run verify:cloud` passed again after the systemd/Caddy/local-proxy hardening: schema check, normalizer smoke, production build, API smoke, and desktop/mobile UI smoke.
- Deployed the app-server read-only review package to `/home/ubuntu/codex-cloud/console` and restarted `codex-cloud-console.service`; `/healthz?force=1` returned `ok:true`, app-server restarted at `2026-07-02T06:28:25.386Z`.
- Live `/api/codex/review/summary?repoId=invest-dashboard` returned `ok:true`, `source:"app-server-command"`, `authoritative:true`, and numeric file/line counts.
- Live `/api/codex/review/snapshot?repoId=invest-dashboard` returned `ok:true`, `source:"app-server-command"`, `authoritative:true`, `readOnly:true`, and parsed diff files.
- Final `npm run verify:cloud` passed after the review read migration; API smoke now includes `review summary app-server source`, `review snapshot app-server source`, and `local review mutation disabled`.

## Remaining Required Work

These are not fixed by the main-thread patches and remain real gaps before claiming Codex App parity:

1. Replace local chat-history/session state with app-server thread APIs or a clearly marked migration cache. Normal session-list reads and message reads are now app-server-authoritative, but local draft/session cache still exists for compose state and compatibility until app-server exposes native draft/active-session state.
2. Replace process-local active turn/compact/job maps and custom SSE with replayable app-server thread/turn event state. Current responses now disclose this limitation and merge app-server thread state, but event replay itself still needs a lower-level app-server capability.
3. Move automation run lifecycle off local JSON and reconcile from app-server run/thread state after console restart. The false-failed restart behavior is fixed, and recent run APIs now verify app-server threads, but the lifecycle source is still local until app-server exposes durable automation run state.
4. Add app-server-native review mutations and PR publishing once the app-server review/git capability surface can replace the disabled local helper routes. Read-only review summary/snapshot is now app-server-backed.
5. Continue type-level Result/source enforcement beyond the currently hardened models/app-status/thread-state endpoints.

## Current Acceptance Status

E2E user flows are passing after the targeted fixes. The highest-risk fake-success paths are now disabled or fail explicit smoke checks. Full architecture acceptance for "app-server as the only fact source" is still not complete because session storage, active job/event replay, automation run lifecycle, and read-only review snapshots still need deeper app-server-native migration.
