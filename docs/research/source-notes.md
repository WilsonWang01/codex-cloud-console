# Reference Source Notes

This project intentionally borrows only from sources whose license and scope fit the cloud Codex console goal.

## Direct-Code References

### `friuns2/codexui`

- Repository: `https://github.com/friuns2/codexui`
- License: MIT
- Local research checkout: `/tmp/codex-cloud-refs/codexui`
- Safe to adapt with attribution:
  - Codex app-server bridge patterns from `src/server/codexAppServerBridge.ts`
  - App-server DTO and item normalization from `src/api/appServerDtos.ts` and `src/api/normalizers/v2.ts`
  - Composer command/runtime dropdown and Codex-style thread UI components under `src/components/content/`
  - Terminal manager behavior from `src/server/terminalManager.ts`
- Why it fits:
  - It already treats Codex app-server as the session host and exposes the Codex App experience through a browser UI.
  - Its normalizers handle real app-server items such as `commandExecution`, `fileChange`, `plan`, images, and in-progress thread state.
- Copy boundary:
  - Reuse small server and UI patterns after adapting to this repo's Express/React shape.
  - Keep attribution comments when code is materially derived.
- Current local adaptation:
  - `server/review-git.mjs` is a mechanically transpiled/adapted copy of `src/server/reviewGit.ts` with an attribution banner, exposed through repo-scoped `/api/codex/review/*` wrappers so review snapshot and stage/unstage/revert behavior stay aligned with the reference implementation.
  - Skill palette grouping in `server/index.mjs` is adapted from `src/api/codexGateway.ts` helpers (`normalizeSkillMarkdownPath`, grouped skill root derivation) so `$` composer suggestions use the same app-server `skills/list` semantics instead of a hand-rolled flat name list.
  - Review finding parsing in `src/App.tsx` is adapted from `src/api/codexGateway.ts` (`parseReviewText` / location parsing) so official Codex review output can be rendered as clickable findings in the cloud Review panel.
  - Thread deep-linking in `src/App.tsx` was added after reviewing `codexui`'s `/thread/:threadId` route shape and RemCodex's refresh/reconnect session model. It is a local hash-route implementation, not copied source code.

### `kzahel/yepanywhere`

- Repository: `https://github.com/kzahel/yepanywhere`
- License: MIT
- Local research checkout: `/tmp/codex-cloud-refs-yep/yepanywhere`
- Safe to adapt with attribution:
  - Protocol generation/update script from `scripts/update-codex-protocol.mjs`
  - Server-owned process and late-client replay concepts from `packages/server/src/supervisor/`
  - Upload UX and draft-safe composer behavior from `packages/client/src/components/MessageInput.tsx`
  - Inbox/activity concepts from `packages/client/src/contexts/InboxContext.tsx`, `packages/client/src/pages/InboxPage.tsx`, and `packages/server/src/routes/inbox.ts`
- Why it fits:
  - It is explicitly built around remote supervision, client disconnect survival, file upload, inbox, activity stream, and Codex support.
- Copy boundary:
  - Reuse small utilities and state-machine ideas; do not import the whole framework.
  - Preserve attribution comments for materially derived code.
- Current local adaptation:
  - Automation inbox bucketing and webhook/heartbeat trigger semantics follow Yep Anywhere's server-owned supervision and prioritized inbox pattern.
  - No Yep Anywhere source was copied for these routes; the Express implementation remains project-specific.
  - The current UI gap evaluation keeps Yep Anywhere's tiered inbox, upload, activity stream, and server-owned-process model as the reference for future notification and offline recovery work.

### `lupishan/remcodex`

- Repository: `https://github.com/lupishan/remcodex`
- License: MIT
- Local research checkout: `/tmp/codex-cloud-refs-remcodex`
- Safe to adapt with attribution:
  - Structured timeline rendering from `web/session-timeline-renderer.js`
  - Composer slash menu and fixed composer behavior from `web/components/composer.js`
  - Approval lifecycle and reconnect/resume UI concepts from `web/app.js`
- Why it fits:
  - It is explicitly a browser workspace for Codex sessions, focused on long-running sessions, approval prompts, resume after refresh, and semantic timeline rendering instead of raw terminal logs.
- Copy boundary:
  - Reuse small UI/state-machine patterns only; keep Codex app-server protocol ownership in this project rather than adopting RemCodex's storage model.
  - Preserve attribution comments for materially derived code.
- Current local adaptation:
  - The 2026-05-31 routing update mirrors RemCodex's core UX goal of a recoverable session workspace, but it keeps storage and thread facts in this project's app-server-backed session APIs.

### `pugliatechs/polpo`

- Repository: `https://github.com/pugliatechs/polpo`
- License: MIT
- Safe to adapt with attribution:
  - Mobile-first conversation layout, tool-call cards, approvals, attachment previews, conversation search, and PWA/cloud deployment patterns.
- Why it fits:
  - It is built for remote browser/mobile supervision of CLI agents and explicitly supports Codex-like session discovery and resume flows.
- Copy boundary:
  - Treat its Codex adapter as a UI/process-management reference only. It is based on CLI JSON/resume behavior, while this project should keep Codex app-server as the only thread/turn fact source.

## 2026-05-31 UI Gap Snapshot

- Current UI is now closer to the reference projects in interaction shape: left project/thread rail, central app-server timeline, fixed composer, slash command entry, upload/paste support, permission/model/reasoning chips, context usage, review/diff, and automation inbox.
- The remaining product gap against `codexui` is not the basic chat shell; it is making app-server the only durable fact source for every item type and route. The new hash route (`#/project/:repoId/thread/:sessionId`) closes the most visible missing piece: a thread is now directly addressable and recoverable after refresh.
- The remaining gap against Yep Anywhere is cross-device/offline notification and a richer activity stream. Browser notification exists, but push/webhook-to-notification delivery is still future work.
- The remaining gap against RemCodex is visual quietness around state surfaces. The duplicated connection chip was removed from the CLI topbar on 2026-05-31; future UI passes should keep reducing dashboard-style panels into one status affordance plus a details drawer.
- The 2026-05-31 responsive pass fixed the mobile composer/thread layout so a long app-server thread keeps the input, footer, and single status affordance inside the viewport at 390px width.
- The 2026-05-31 audit/status pass follows the same "structured but quiet by default" direction: `/api/status` now returns compact automation/audit previews, redacts opaque payloads, and keeps full UI pages from being dominated by raw tool event text.
- The 2026-05-31 capability-status pass extends the app-server fact-source rule to MCP health: top-level status now derives MCP login warnings from `mcpServerStatus/list`, surfaces them in Inbox and Settings, and keeps the global connection label separate from optional capability degradation.
- The 2026-05-31 settings pass closes the action loop for those MCP warnings by wiring Settings to the existing app-server-backed OAuth login and MCP reload APIs, rather than leaving capability warnings as static text.
- The 2026-05-31 thread-route pass tightens the same app-server-first rule for navigation: CLI URLs now prefer the real Codex app-server thread id, and the backend can resolve/import a raw thread id through `thread/resume` before falling back to local UI metadata. This follows the thin-wrapper route shape used by Codex app-server Web clients while keeping draft sessions local until the first thread exists.
- The 2026-05-31 final audit verified that a raw app-server thread URL for `invest-dashboard` restores the same session, shows exactly one `App-server 在线` status, zero `连接断开` labels, and no desktop/mobile horizontal overflow or composer button overlap. This turns the current comparison gap into product-level items rather than a basic Codex App shell mismatch.
- The 2026-05-31 inbox state pass adds a backend acknowledgement store for attention items. This borrows the product idea of a manageable activity inbox from Yep Anywhere/The Companion without copying code, and it keeps counts/notifications tied to server state instead of local-only UI dismissal.
- The 2026-05-31 external notification pass extends that inbox state into a real cloud bridge: the backend can poll unresolved attention items, dedupe against acknowledged/delivered state, and send to configured webhook, Slack, or Telegram channels. The UI only reports enabled channels when environment-backed configuration exists, so it does not present a fake notification capability.
- The 2026-05-31 session-search pass borrows the thin app-server client direction from `codex-web-local`/`codex-web`: the in-thread session picker now queries app-server `thread/list` with `searchTerm` for the current repo instead of only filtering already-loaded frontend state.
- The 2026-05-31 timeline-density pass follows `codexui` and RemCodex's structured item direction: app-server `commandExecution` is now normalized as a concise command card with expandable output details, and stream-only command notifications are recovered from the app-server audit source by thread/session/item id when `thread/read` omits them. This keeps refreshed timelines session-like instead of terminal-log-like without inventing a separate command store.
- The 2026-05-31 slash-command-center pass follows the Codex App/codexui composer-first direction: `/` now opens a compact command center with app-server-backed connection, runtime, context, and goal state before the command list. The implementation is local React/CSS, not copied source; it reuses existing app-server-backed props and preserves keyboard execution so the UI change does not drift from backend capabilities.
- The 2026-06-01 activity-routing pass follows Yep Anywhere/The Companion's actionable inbox idea while keeping Codex app-server as the session fact source: approval/request/elicitation/audit attention items with `repoId + sessionId/threadId` now route back to the exact thread, and automation runs can use a bare app-server `threadId` as the recovery target. The implementation is local Express/React code, not copied from the reference projects.
- The same pass fixed a local routing race that appeared during verification: when opening an Inbox item inside the currently selected repo, `pendingRouteSessionRef` now synchronously protects the requested thread hash until the matching session is active, so the current old session cannot overwrite the URL before `/api/chat/sessions` returns.
- Cloud verification then exposed a stale-local-session case, so attention/automation routing now prefers app-server `threadId` over local `sessionId` when both are present. This keeps the Inbox aligned with app-server as the durable fact source instead of creating a fresh local draft for an expired UI session id.
- Hash tracing exposed a follow-up reload race: clearing `pendingRouteSession` caused a default no-hint history load that could restore the previous active draft. The repo/session history effect now skips that default reload when an active session is already present after a pending route has completed.
- Final cloud verification for this pass used a real deployed Inbox audit item and confirmed both desktop and mobile routes stayed on the imported app-server thread URL instead of falling back to the stale draft session.

### `0xcaff/codex-web`

- Repository: `https://github.com/0xcaff/codex-web`
- License: MIT in the repository metadata at research time.
- Use case:
  - Browser-based thin wrapper around a long-lived Codex app-server.
  - Useful as a counterweight to over-building custom state: the Web UI should mainly attach to app-server, not emulate it.
- Copy boundary:
  - Safe to inspect thin bridge and process separation ideas.
  - Keep local implementation app-specific because this project also has EC2 status, automation, audit, upload, review, and local proxy needs.

### `pavel-voronin/codex-web-local`

- Repository: `https://github.com/pavel-voronin/codex-web-local`
- Use case:
  - Lightweight Web UI that explicitly aims to replicate the Codex desktop UI over Codex app-server.
  - Useful as a visual and interaction benchmark for keeping this project's CLI page quiet and session-centric.
- Copy boundary:
  - Verify license before copying any code.
  - Safe to use as a visual QA reference for layout, composer density, and thread-first navigation.

### `friuns2/codexui` / `codexapp`

- Repository: `https://github.com/friuns2/codexui`
- Use case:
  - One-command browser UI for Codex app-server workflows across Linux, Windows, and Termux/Android.
  - Provides LAN/tunnel-oriented remote access, cloudflared/Tailscale guidance, Telegram bridge, project import/export, mobile drawer, skills hub, and voice dictation.
- Copy boundary:
  - MIT according to repository README at 2026-06-01 research time; individual files should still be checked before copying.
  - Good candidate for code-level study of mobile drawer, composer attachment flow, import/export, and tunnel/bridge UX.
- Code-level reuse in this project:
  - `src/components/sidebar/SidebarThreadTree.vue` uses a short default thread list plus an explicit Show more/Show less reveal. The current React sidebar ports that interaction as `compactSidebarSessions(...)`, preserving the selected thread while keeping the default list quiet.
  - The same file treats app-server thread rows as durable history and separates transient chat/new-thread affordances. The current backend now prunes stale local empty drafts so draft sessions do not masquerade as app-server history.

### `ByeongkiJeong/Aimighty`

- Repository: `https://github.com/ByeongkiJeong/Aimighty`
- Use case:
  - Self-hosted Codex workspace for organizations; wraps official `codex app-server` with FastAPI + WebSocket.
  - Emphasizes allowed workspace roots, JWT production mode, local static assets, schema drift checks, MCP/Skills panels, file APIs, review, and diagnostics.
- Copy boundary:
  - Treat as an implementation reference for cloud/self-hosted operations. Verify license before copying code.
  - Especially relevant for `allowed roots`, schema drift checks, deployment diagnostics, and auth boundary design.

### `jakemor/kanna`

- Repository: `https://github.com/jakemor/kanna`
- Use case:
  - Web UI for Claude Code and Codex CLIs with project-first sidebar, per-provider model/effort controls, rich transcript rendering, plan mode, WebSocket subscriptions, event sourcing, CQRS read models, and snapshot compaction.
- Copy boundary:
  - MIT according to repository README at 2026-06-01 research time; individual files should still be checked before copying.
  - Useful for UI/read-model patterns, but do not replace app-server as the source of truth for Codex threads/messages.

### `shuto-S/codex-app-mobile`

- Repository: `https://github.com/shuto-S/CodexAppMobile`
- Use case:
  - Remote iOS client for Codex app-server with thread create/resume/fork/archive, model/reasoning controls, slash commands, MCP, skills, approvals, notifications, and SSH fallback.
  - Useful as a mobile interaction checklist for this Web console.
- Copy boundary:
  - Verify license before copying any code.
  - Treat native iOS patterns as product guidance; Web implementation should remain React/app-server based.

### Codex Relay / Clawdex Mobile

- References:
  - `https://www.codexrelay.com/`
  - `https://github.com/clawdex/clawdex`
- Use case:
  - Mobile companion / relay layer for remote agent sessions, image attachments, approvals, web preview, terminal/git fallback, and voice/mobile supervision.
- Copy boundary:
  - Treat as product and interaction references unless a specific permissively licensed file is reviewed.
  - Keep this project browser-first; borrow only approval routing, mobile fallback, and notification concepts.

## Architecture-Only References

### `getpaseo/paseo`

- License: AGPL according to the gap plan.
- Use only for architecture and UX concepts: daemon, attach/send/list, worktree isolation, relay/TLS, multi-agent orchestration.
- Do not copy implementation code.

### The Companion

- Documentation: `https://docs.thecompanion.sh/`
- Use only for product and architecture concepts: session/task/permission state, tool-call visibility, Docker/environments, Git worktrees, manual/webhook/schedule triggers, Tailscale/cloud VM deployment, and multi-tab views for Chat/Diff/Editor/Terminal/Process.
- Do not copy implementation code unless a specific permissively licensed source file is separately verified.

### CloudCLI

- License: GPL-3 according to the gap plan.
- Use only for product and operations concepts: persistent cloud environment, API automation, SSH/IDE access, MCP/config/context sharing.
- Do not copy implementation code.

### MuxAgent / AgentD / touchgrass.sh

- Use only as lightweight product references for mobile/Telegram/Slack/browser supervision of long-running coding agents.
- Relevant ideas: external notifications, session switching, risky-action approval routing, and multi-device control.
- These are not app-server UI references; they should not influence the core thread/turn protocol design.

## Official Protocol Source

### OpenAI Codex app-server

- Source of truth: installed `codex app-server generate-ts`.
- Current checked-in schema was generated with `@openai/codex@0.135.0` into `src/generated/app-server/`.
- The schema updater defaults to `npx -y @openai/codex@0.135.0` so deployment is not silently coupled to an older global `codex` binary. Override with `CODEX_SCHEMA_CLI_VERSION` when intentionally upgrading.
- MCP OAuth login follows the same official `mcpServer/oauth/login` entrypoint used by `codexui`, with an added local proxy callback relay because the cloud app-server returns EC2 loopback callback URLs.
- Refresh command:

```bash
npm run codex:schema
```

Use this generated schema to keep API names and payload shapes aligned with Codex App instead of guessing fields.
