import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { chromium } from "playwright";
import { nextPersonalOccurrence } from "../server/personal-schedule.mjs";

const source = await fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const fixture = { Date };
vm.createContext(fixture);
const start = source.indexOf("const fallbackRun =");
const end = source.indexOf("\nfunction cx(", start);
vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.statusFixture = fallbackStatus;", fixture);
const status = JSON.parse(JSON.stringify(fixture.statusFixture));
status.health.ok = true;
status.health.layers.appServer = { ok: true, running: true };
status.repos.push({ id: "_personal", name: "个人助理", kind: "personal", runtimeMode: "shared", executionAvailable: true, path: "/tmp/personal", remote: "", accent: "teal", present: true, branch: "", commit: "", dirty: false, statusText: "个人空间 · 共用账号", lastCommit: "非 Git 空间" });
status.automations.push({ id: "personal-plan", name: "每周资料整理", repoId: "_personal", enabled: true, nextRun: new Date(Date.now() + 86_400_000).toISOString(), lastRun: "", timer: "", service: "", schedule: "", model: "gpt-6-sol", reasoning: "medium", run: { activeState: "", failedState: "", exitCode: "", logName: null, logUpdatedAt: null, logTail: [] } });
status.diagnostics = { repoId: "sample-app", generatedAt: new Date().toISOString(), ok: false, summary: { total: 1, ok: 0, warn: 0, danger: 1 }, checks: [{ id: "old-work-auth", label: "其他项目的历史诊断", tone: "danger", ok: false, summary: "旧登录错误", detail: "", durationMs: 0 }] };
const sessions = ["sample-app", "_personal"].map((repoId) => ({
  id: `${repoId}-session`, repoId, title: `${repoId} 对话`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  messageCount: 0, isDraft: true, draft: { input: "", attachments: [], revision: 0 }, model: "gpt-5.6-terra", reasoning: "medium",
  sandbox: repoId === "_personal" ? "read-only" : "danger-full-access", approval: repoId === "_personal" ? "on-request" : "never", search: true,
}));
sessions.find((item) => item.repoId === "_personal").goal = { threadId: "personal-thread", objective: "整理家庭旅行计划", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000 };
let newSessionCount = 0;
let pending = [{
  id: "approval-test", method: "item/commandExecution/requestApproval", digest: "digest-test", owner: { repoId: "sample-app", sessionId: "sample-app-session" },
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), params: { command: "echo approval-check", cwd: "/tmp" },
}];
let decision = null;
let createdToken = "";
let personalLoginFlow = null;
let includeNewModel = false;
let selectedRuntime = null;
let appsFailure = false;
let appsDirectoryDenied = false;
let submittedMessages = 0;
let queueFlow = false;
let releaseJobEvents = null;
let steeredMessages = [];
let uploadedCount = 0;
let personalFilesDeleted = 0;
let manualAutomationRuns = 0;
let personalRoutineSequence = 0;
const personalTrials = new Map();
let archivedPersonalRoutines = [];
let personalFiles = [
  { path: "results/demo.md", name: "demo.md", kind: "output", size: 13, updatedAt: new Date().toISOString(), previewable: true, mimeType: "text/plain; charset=utf-8" },
  { path: ".codex-cloud/uploads/2026-09-26/notes.txt", name: "notes.txt", kind: "input", size: 12, updatedAt: new Date().toISOString(), previewable: true, mimeType: "text/plain; charset=utf-8" },
];
let personalFacts = [];
let personalFactsReadFailure = false;
let personalCommitments = [];
let briefReviewedAt = null;
const briefEvent = { id: "run:recent-personal:completed", kind: "completed", title: "资料整理完成", detail: "定时任务已完成", time: new Date().toISOString(), sessionId: "_personal-session" };
const personalPushEndpoint = "https://push.example.test/personal-browser";
let personalReminderSettings = { enabled: false, timeZone: "Asia/Shanghai", quietStart: "22:00", quietEnd: "08:00" };
let failNextCommitmentDraftResponse = false;
let oldCommitmentApi = false;
let usageRace = false;
let usageFailure = false;
const errors = [];
const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route("**/healthz", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status.health) }));
await context.route("**/api/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const body = req.postDataJSON() || {};
  const repoId = body.repoId || url.searchParams.get("repoId") || "sample-app";
  const send = (data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
  if (url.pathname === "/api/status") return send(status);
  if (url.pathname === "/api/automations/personal-plan/run" && req.method() === "POST") { manualAutomationRuns += 1; return send({ ok: true }); }
  if (url.pathname === "/api/personal/routines" && req.method() === "GET") return send({ ok: true, routines: [...status.automations.filter((item) => item.personalRoutine), ...archivedPersonalRoutines] });
  if (url.pathname === "/api/personal/routines" && req.method() === "POST") {
    const id = `personal-routine-test-${++personalRoutineSequence}`;
    status.automations.push({ id, name: body.name, prompt: body.prompt, repoId: "_personal", personalRoutine: true, revision: 1,
      mode: "on-demand", enabled: true, nextRun: "按需触发", lastRun: "", timer: null, service: null, schedule: "手动运行", model: "gpt-6-sol", reasoning: "medium",
      run: { activeState: "inactive", failedState: "inactive", exitCode: "ready", logName: null, logUpdatedAt: null, logTail: [] } });
    return send({ ok: true, routine: { id, ...body, revision: 1 } }, 201);
  }
  if (url.pathname.startsWith("/api/personal/routines/") && url.pathname.endsWith("/test") && req.method() === "GET") {
    return send({ ok: true, test: personalTrials.get(url.pathname.split("/").at(-2)) || null });
  }
  if (url.pathname.startsWith("/api/personal/routines/") && url.pathname.endsWith("/test") && req.method() === "POST") {
    const id = url.pathname.split("/").at(-2);
    const routine = status.automations.find((item) => item.id === id);
    if (!routine || routine.revision !== body.revision) return send({ error: "流程已修改" }, 409);
    if (!body.confirmModelCost) return send({ error: "未确认额度" }, 428);
    if (routine.personalSchedule?.enabled) return send({ error: "请先暂停计划" }, 409);
    routine.personalTestApproval = null;
    routine.revision += 1;
    manualAutomationRuns += 1;
    const test = { id: `trial-${manualAutomationRuns}`, status: "completed", startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), summary: "模拟试运行完成", error: null, reviewIssue: null, promptMatches: true, sessionId: "_personal-session" };
    personalTrials.set(id, test);
    return send({ ok: true, run: test, revision: routine.revision, output: "试运行已启动" });
  }
  if (url.pathname.startsWith("/api/personal/routines/") && url.pathname.endsWith("/test/approve") && req.method() === "POST") {
    const id = url.pathname.split("/").at(-3);
    const routine = status.automations.find((item) => item.id === id);
    const test = personalTrials.get(id);
    if (!body.confirmResult) return send({ error: "请先确认结果" }, 428);
    if (!routine || routine.revision !== body.revision || test?.id !== body.runId || !test.promptMatches) return send({ error: "试运行已过期" }, 409);
    routine.personalTestApproval = { runId: test.id, approvedAt: new Date().toISOString(), current: true };
    routine.revision += 1;
    return send({ ok: true, routine });
  }
  if (url.pathname.startsWith("/api/personal/routines/") && url.pathname.endsWith("/schedule") && req.method() === "PATCH") {
    const id = url.pathname.split("/").at(-2);
    const routine = status.automations.find((item) => item.id === id);
    if (!routine || routine.revision !== body.revision) return send({ error: "流程已修改" }, 409);
    if (body.enabled && body.confirmModelCost !== true) return send({ error: "未确认额度" }, 428);
    if (body.enabled && !routine.personalTestApproval?.current) return send({ error: "请先试运行" }, 409);
    routine.personalSchedule = { cadence: body.cadence, time: body.time, timeZone: body.timeZone, enabled: body.enabled,
      nextRunAt: body.enabled ? nextPersonalOccurrence(body, Date.now()) : null };
    routine.nextRun = body.enabled ? routine.personalSchedule.nextRunAt : "按需触发";
    routine.revision += 1;
    return send({ ok: true, routine });
  }
  if (url.pathname.startsWith("/api/personal/routines/") && req.method() === "PATCH") {
    const routine = status.automations.find((item) => item.id === url.pathname.split("/").at(-1));
    if (!routine || routine.revision !== body.revision) return send({ error: "流程已修改" }, 409);
    if (routine.prompt !== body.prompt) {
      if (routine.personalTestApproval) routine.personalTestApproval.current = false;
      if (routine.personalSchedule?.enabled) { routine.personalSchedule.enabled = false; routine.personalSchedule.nextRunAt = null; }
      if (personalTrials.has(routine.id)) personalTrials.get(routine.id).promptMatches = false;
    }
    Object.assign(routine, { name: body.name, prompt: body.prompt, revision: routine.revision + 1 });
    return send({ ok: true, routine });
  }
  if (url.pathname.startsWith("/api/personal/routines/") && req.method() === "DELETE") {
    const id = url.pathname.split("/").at(-1);
    const index = status.automations.findIndex((item) => item.id === id && item.revision === body.revision);
    if (index < 0) return send({ error: "流程已修改" }, 409);
    const routine = status.automations.splice(index, 1)[0];
    routine.archivedAt = new Date().toISOString();
    routine.revision += 1;
    archivedPersonalRoutines.push(routine);
    return send({ ok: true, routine });
  }
  if (url.pathname.startsWith("/api/personal/routines/") && url.pathname.endsWith("/restore") && req.method() === "POST") {
    const id = url.pathname.split("/").at(-2);
    const index = archivedPersonalRoutines.findIndex((item) => item.id === id && item.revision === body.revision);
    if (index < 0) return send({ error: "流程已修改" }, 409);
    const routine = archivedPersonalRoutines.splice(index, 1)[0];
    routine.archivedAt = null;
    routine.revision += 1;
    status.automations.push(routine);
    return send({ ok: true, routine });
  }
  if (url.pathname === "/api/attention/acknowledgements" && req.method() === "POST") {
    const acknowledged = status.attention.items.filter((item) => body.itemIds?.includes(item.id));
    for (const item of acknowledged) item.acknowledged = true;
    status.attention.count = status.attention.unreadCount = status.attention.items.filter((item) => !item.acknowledged).length;
    status.attention.acknowledgedCount = status.attention.items.length - status.attention.count;
    return send({ ok: true, acknowledged: acknowledged.map((item) => item.id), attention: status.attention });
  }
  if (url.pathname === "/api/personal/files") {
    if (req.method() === "DELETE") { personalFilesDeleted += 1; personalFiles = personalFiles.filter((file) => file.path !== url.searchParams.get("path")); return send({ ok: true }); }
    return send({ ok: true, files: personalFiles });
  }
  if (url.pathname === "/api/personal/files/content") return route.fulfill({ status: 200, contentType: "text/plain", body: "sample result\n" });
  if (url.pathname === "/api/personal/brief") return send({ ok: true, brief: { until: new Date().toISOString(), reviewedAt: briefReviewedAt, items: briefReviewedAt ? [] : [briefEvent], total: briefReviewedAt ? 0 : 1 } });
  if (url.pathname === "/api/personal/brief/review") { briefReviewedAt = body.through; return send({ ok: true, reviewedAt: briefReviewedAt }); }
  if (url.pathname === "/api/personal/reminders/status") return body.endpoint === personalPushEndpoint ? send({ ok: true, settings: personalReminderSettings }) : send({ ok: false, error: "未订阅" }, 404);
  if (url.pathname === "/api/personal/reminders" && req.method() === "PATCH") { personalReminderSettings = body.settings; return send({ ok: true, settings: personalReminderSettings }); }
  if (url.pathname === "/api/personal/facts") {
    if (req.method() === "POST") { const fact = { id: `fact-${personalFacts.length + 1}`, label: body.label, value: body.value, source: "user", revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; personalFacts.push(fact); return send({ ok: true, fact }, 201); }
    if (personalFactsReadFailure) return send({ ok: false, error: "模拟网络故障" }, 503);
    return send({ ok: true, facts: personalFacts });
  }
  if (url.pathname === "/api/personal/commitments") {
    if (oldCommitmentApi) return send({ ok: false, error: "Unknown API route: GET /personal/commitments" }, 404);
    if (req.method() === "POST") {
      const now = new Date().toISOString();
      const commitment = { id: `commitment-${personalCommitments.length + 1}`, title: body.title, nextStep: body.nextStep || "", dueAt: body.dueAt || null, status: "active", sessionId: null, source: "user", revision: 1, createdAt: now, updatedAt: now, completedAt: null };
      personalCommitments.push(commitment);
      return send({ ok: true, commitment }, 201);
    }
    return send({ ok: true, commitments: personalCommitments });
  }
  const commitmentDraft = url.pathname.match(/^\/api\/personal\/commitments\/([^/]+)\/draft$/);
  if (commitmentDraft && req.method() === "POST") {
    const item = personalCommitments.find((entry) => entry.id === commitmentDraft[1]);
    if (!item) return send({ ok: false, error: "not found" }, 404);
    let session = sessions.find((entry) => entry.id === item.sessionId && entry.repoId === "_personal");
    if (!session) {
      if (item.revision !== body.revision) return send({ ok: false, error: "stale" }, 409);
      session = sessions.find((entry) => entry.id === body.pendingSessionId && entry.repoId === "_personal");
      if (!session) {
        const id = `_personal-new-${++newSessionCount}`;
        session = { ...sessions.find((entry) => entry.repoId === "_personal"), id, title: item.title, goal: null, draft: { input: `请帮我推进这项个人事项：${item.title}\n当前下一步：${item.nextStep}`, attachments: [], revision: 1 } };
        sessions.push(session);
      }
      Object.assign(item, { sessionId: session.id, revision: item.revision + 1, updatedAt: new Date().toISOString() });
    }
    if (failNextCommitmentDraftResponse) { failNextCommitmentDraftResponse = false; return send({ ok: false, error: "temporary draft response failure" }, 503); }
    return send({ ok: true, repoId: "_personal", activeSessionId: session.id, sessions: sessions.filter((entry) => entry.repoId === "_personal"), messages: [], commitment: item });
  }
  if (url.pathname.startsWith("/api/personal/commitments/")) {
    const id = url.pathname.split("/").at(-1);
    const item = personalCommitments.find((entry) => entry.id === id);
    if (!item) return send({ ok: false, error: "not found" }, 404);
    if (item.revision !== body.revision) return send({ ok: false, error: "stale" }, 409);
    if (req.method() === "DELETE") { personalCommitments = personalCommitments.filter((entry) => entry.id !== id); return send({ ok: true, commitment: item }); }
    if (body.sessionId && !sessions.some((session) => session.id === body.sessionId && session.repoId === "_personal")) return send({ ok: false, error: "个人对话不存在" }, 404);
    Object.assign(item, Object.fromEntries(Object.entries(body).filter(([key]) => ["title", "nextStep", "dueAt", "status", "sessionId"].includes(key))));
    item.revision += 1;
    item.updatedAt = new Date().toISOString();
    item.completedAt = item.status === "done" ? item.updatedAt : null;
    return send({ ok: true, commitment: item });
  }
  if (url.pathname.startsWith("/api/personal/facts/")) {
    const id = url.pathname.split("/").at(-1);
    const fact = personalFacts.find((item) => item.id === id);
    if (!fact) return send({ ok: false, error: "not found" }, 404);
    if (body.revision !== fact.revision) return send({ ok: false, error: "个人事实已在其他页面修改，请核对最新内容" }, 409);
    if (req.method() === "PATCH") { fact.label = body.label; fact.value = body.value; fact.revision += 1; fact.updatedAt = new Date().toISOString(); return send({ ok: true, fact }); }
    if (req.method() === "DELETE") { personalFacts = personalFacts.filter((item) => item.id !== id); return send({ ok: true, fact }); }
  }
  if (url.pathname === "/api/uploads" && req.method() === "POST") { uploadedCount += 1; return send({ ok: true, files: body.files.map((file, index) => ({ name: file.name, path: `.codex-cloud/uploads/2026-09-26/${uploadedCount}-${index}-${file.name}`, mimeType: file.type, size: 12, kind: file.type.startsWith("image/") ? "image" : "file", source: "personal-upload" })) }); }
  if (url.pathname === "/api/chat/queue" && queueFlow) {
    const session = sessions.find((item) => item.id === body.sessionId && item.repoId === repoId);
    if (!session) return send({ ok: false, error: "not found" }, 404);
    if (req.method() === "POST") {
      session.queuedTurn = { id: "queued-ui-1", message: body.message, preview: body.message, status: "queued", createdAt: new Date().toISOString() };
      return send({ ok: true, queuedTurn: session.queuedTurn }, 202);
    }
    const queuedTurn = session.queuedTurn;
    session.draft = { ...session.draft, input: queuedTurn.message, revision: session.draft.revision + 1 };
    session.queuedTurn = null;
    return send({ ok: true, queuedTurn, draft: session.draft });
  }
  if (url.pathname.endsWith("/external-action-review/acknowledge") && req.method() === "POST") {
    const sessionId = decodeURIComponent(url.pathname.split("/")[4]);
    const session = sessions.find((item) => item.id === sessionId && item.repoId === repoId);
    if (!session || session.externalActionReview?.id !== body.reviewId) return send({ ok: false, error: "stale review" }, 409);
    session.externalActionReview = null;
    return send({ ok: true });
  }
  if (url.pathname === "/api/codex/turn-steer" && queueFlow) { steeredMessages.push(body.message); return send({ ok: true }); }
  if (url.pathname === "/api/codex/apps") return appsFailure ? send({ ok: false, error: "服务暂不可用" }, 502) : send({ ok: true, runtimeVerified: true, runtimeScope: "shared", directoryError: appsDirectoryDenied ? "上游拒绝了云端服务目录请求（403）。" : "", apps: [
    { id: "mail", name: "Gmail", description: "整理邮件", installUrl: "https://chatgpt.com/apps/gmail/mail", accessible: false, enabled: true, callable: false },
    { id: "calendar", name: "Calendar", description: "查看日程", installUrl: "https://chatgpt.com/apps/calendar/cal", accessible: true, enabled: true, callable: true },
    { id: "invalid", name: "Untrusted", description: "不可信授权链接", installUrl: "javascript:alert(1)", accessible: false, enabled: false, callable: null },
  ] });
  if (url.pathname === "/api/approvals") return send({ ok: true, pending });
  if (url.pathname === "/api/approvals/approval-test/decision") { decision = body; pending = []; return send({ ok: true }); }
  if (url.pathname === "/api/clients") {
    if (req.method() === "POST") { createdToken = "ccc_test-token-only-once"; return send({ ok: true, token: createdToken, client: { id: "new", name: body.name } }, 201); }
    return send({ ok: true, clients: [{ id: "client-a", name: "研究服务", tokenPrefix: "ccc_test", automationIds: [status.automations[0].id], createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, lastUsedAt: new Date().toISOString() }] });
  }
  if (url.pathname === "/api/clients/usage") {
    if (usageFailure) return send({ ok: false, error: "模拟统计不可用" }, 502);
    const requestedDays = (Date.now() - Date.parse(url.searchParams.get("from"))) / 86_400_000;
    if (usageRace && requestedDays > 4 && requestedDays < 10) await new Promise((resolve) => setTimeout(resolve, 300));
    const requests = usageRace && requestedDays > 20 ? 30 : usageRace && requestedDays > 4 ? 7 : 2;
    return send({ ok: true, droppedRequests: 0,
    buckets: [{ hour: new Date().toISOString().slice(0, 13) + ":00:00Z", clientId: "client-a", requests, accepted: 1, errors: 0, replayed: 1, polls: 3, controls: 1 }],
    runBuckets: [{ hour: new Date().toISOString().slice(0, 13) + ":00:00Z", clientId: "client-a", runs: 2, completed: 1, failed: 0, knownRuns: 1, unknownRuns: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }],
    requests: [{ id: "request-1", clientId: "client-a", automationId: status.automations[0].id, trigger: "webhook", status: 200, runId: "run-1", deduplicated: false, durationMs: 5, time: new Date().toISOString() }],
    runs: [{ id: "run-1", clientId: "client-a", automationId: status.automations[0].id, status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), model: "gpt-5.6-terra", reasoning: "medium", usage: { status: "complete", inputTokens: 100, outputTokens: 20, totalTokens: 120 } }],
  }).catch(() => null);
  }
  if (url.pathname === "/api/codex/account/login") {
    personalLoginFlow = { loginId: "personal-login", type: "chatgptDeviceCode", status: "pending", userCode: "TEST-CODE", verificationUrl: "https://login.example.test/device" };
    return send({ ok: true, flow: personalLoginFlow, accountLogin: { active: personalLoginFlow, latest: personalLoginFlow, flows: [personalLoginFlow] } });
  }
  if (url.pathname === "/api/codex/app-status") return send({ ok: true, source: "app-server", authoritative: true, partial: false, account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" }, auth: { ok: true }, accountLogin: { active: personalLoginFlow, latest: personalLoginFlow, flows: personalLoginFlow ? [personalLoginFlow] : [] }, mcpServers: [], plugins: { installed: 0, enabled: 0, available: 0, names: [] }, skills: { enabled: 0, total: 0, names: [], items: [] }, features: { enabled: 0, total: 0, names: [] }, permissionProfiles: [], config: {}, gaps: [] });
  if (url.pathname === "/api/codex/models") return send({ ok: true, source: "app-server", authoritative: true, models: [{ id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] }, ...(includeNewModel ? [{ id: "gpt-6-astra", displayName: "GPT-6 Astra", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "ultra"] }] : [])] });
  if (url.pathname.endsWith("/runtime") && req.method() === "PATCH") {
    selectedRuntime = body;
    Object.assign(sessions.find((item) => item.repoId === repoId), body);
    return send({ ok: true, runtime: body });
  }
  const selectedSession = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/select$/);
  if (selectedSession && req.method() === "POST") {
    const sessionId = decodeURIComponent(selectedSession[1]);
    if (!sessions.some((item) => item.id === sessionId && item.repoId === body.repoId)) return send({ ok: false, error: "wrong space" }, 404);
    return send({ ok: true, authoritative: true, repoId: body.repoId, activeSessionId: sessionId, sessions: sessions.filter((item) => item.repoId === body.repoId), messages: [] });
  }
  const draft = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/draft$/);
  if (draft) {
    const session = sessions.find((item) => item.id === decodeURIComponent(draft[1]));
    if (!session || session.repoId !== repoId) return send({ ok: false, error: "wrong space" }, 404);
    if (req.method() === "PATCH") session.draft = { input: body.input, attachments: body.attachments, revision: session.draft.revision + 1 };
    return send({ ok: true, repoId, sessionId: session.id, draft: session.draft });
  }
  if (url.pathname === "/api/chat/sessions" || url.pathname === "/api/chat/history") {
    if (req.method() === "POST") {
      const id = `${repoId}-new-${++newSessionCount}`;
      sessions.push({ id, repoId, title: body.title || "新会话", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, isDraft: true, draft: { input: "", attachments: [], revision: 0 }, model: "gpt-6-sol", reasoning: "medium", sandbox: "read-only", approval: "on-request", search: true });
      return send({ ok: true, authoritative: true, repoId, activeSessionId: id, sessions: sessions.filter((item) => item.repoId === repoId), messages: [] });
    }
    return send({ ok: true, authoritative: true, repoId, activeSessionId: `${repoId}-session`, sessions: sessions.filter((item) => item.repoId === repoId), messages: [] });
  }
  if (url.pathname === "/api/chat/active") return send({ ok: true, turn: queueFlow ? { id: "active-queue-ui", kind: "turn", repoId: "_personal", sessionId: "_personal-session", threadId: "thread-ui", turnId: "turn-ui", startedAt: new Date().toISOString(), completed: false, events: [] } : null, compact: null, queuedTurn: sessions.find((item) => item.id === url.searchParams.get("sessionId"))?.queuedTurn || null });
  if (url.pathname === "/api/chat/job-events" && queueFlow) {
    await new Promise((resolve) => { releaseJobEvents = resolve; });
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: done\ndata: {"ok":true,"sessionId":"_personal-session"}\n\n` });
  }
  if (url.pathname === "/api/chat/stream") {
    submittedMessages += 1;
    return send({ ok: false, error: "personal execution unavailable" }, 503);
  }
  return send({ ok: true, entries: [], items: [], sessions: [], runs: [], events: [], matches: [] });
});

const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const openRecentPersonalChat = () => page.locator(".personal-list-section").filter({ has: page.getByRole("heading", { name: "继续对话" }) }).locator(".personal-task-row").first().click();
const out = new URL("../docs/research/acceptance/personal-usage-2026-09-26/", import.meta.url);
await fs.mkdir(out, { recursive: true });
try {
  const baseUrl = process.env.CODEX_CLOUD_SAFETY_UI_URL || "http://127.0.0.1:5174/";
  const pendingStatusPage = await context.newPage();
  await pendingStatusPage.route("**/api/status", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fallback().catch(() => null);
  });
  await pendingStatusPage.goto(`${baseUrl}#/automations/_personal`);
  await pendingStatusPage.locator(".app-shell").waitFor();
  assert.equal(new URL(pendingStatusPage.url()).hash, "#/automations/_personal");
  assert.doesNotMatch(await pendingStatusPage.locator("body").innerText(), /sample-app|Sample repository maintenance/);
  await pendingStatusPage.close();
  await page.goto(`${baseUrl}#/project/sample-app/thread/sample-app-session`);
  await page.locator(".space-switch").getByRole("button", { name: "个人" }).click();
  await page.getByRole("heading", { name: "今日" }).waitFor();
  await page.getByRole("heading", { name: "可以交办" }).waitFor();
  await page.getByRole("heading", { name: "关注事项" }).waitFor();
  await page.getByRole("heading", { name: "新变化" }).waitFor();
  await page.getByText("资料整理完成", { exact: true }).waitFor();
  await page.getByRole("button", { name: /整理家庭旅行计划/ }).waitFor();
  await page.getByText("每周资料整理", { exact: true }).waitFor();
  assert.equal(await page.getByText("echo approval-check", { exact: true }).count(), 0);
  await page.screenshot({ path: new URL("today-desktop.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.ok(await page.locator(".personal-today .command-button").evaluate((element) => element.getBoundingClientRect().height >= 44));
  await page.screenshot({ path: new URL("today-390.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("today-320.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator(".personal-brief").getByRole("button", { name: "全部标记已查看" }).click();
  await page.locator(".personal-brief").getByText("上次查看后暂无新变化。").waitFor();
  assert.equal(await page.getByText("其他项目的历史诊断", { exact: true }).count(), 0);
  await openRecentPersonalChat();
  await page.locator(".personal-scope-notice").waitFor();
  await page.locator(".session-current[data-session-id='_personal-session']").waitFor();
  assert.match(page.url(), /_personal/);
  assert.equal(await page.locator(".send-button").isDisabled(), true);
  const composer = page.locator(".composer-shell textarea");
  await page.locator(".hidden-file-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("my notes\n") });
  await page.getByText("notes.txt", { exact: true }).waitFor();
  assert.equal(uploadedCount, 1);
  await page.getByRole("button", { name: "移除附件 notes.txt" }).click();
  await page.getByRole("button", { name: "连接邮箱" }).click();
  await page.getByRole("link", { name: "连接Gmail" }).waitFor();
  await page.locator(".command-panel").getByRole("button", { name: "关闭面板" }).click();
  await page.getByRole("button", { name: /整理邮件待办/ }).click();
  assert.match(await composer.inputValue(), /不要代我发送邮件/);
  assert.equal(submittedMessages, 0);
  await page.getByRole("button", { name: "任务建议", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator(".command-panel").getByRole("button", { name: /调研一个问题/ }).click();
  assert.match(await composer.inputValue(), /不要代我发送邮件/);
  await page.locator(".command-panel").getByRole("button", { name: "关闭面板" }).click();
  await page.getByRole("button", { name: /^会话设置：/ }).click();
  await page.locator(".personal-session-settings").getByRole("button", { name: /工作区权限/ }).click();
  assert.equal(await page.locator(".choice-list").getByRole("button", { name: /全权限/ }).count(), 0);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /^允许写入个人工作区/ }).click();
  assert.equal(selectedRuntime, null);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^允许写入个人工作区/ }).click();
  await page.getByRole("button", { name: /^会话设置：.*工作区写入/ }).waitFor();
  assert.equal(selectedRuntime.sandbox, "workspace-write");
  assert.equal(selectedRuntime.approval, "on-request");
  await page.getByRole("button", { name: "连接服务", exact: true }).click();
  const mailAuthorization = page.getByRole("link", { name: "连接Gmail" });
  await mailAuthorization.waitFor();
  assert.equal(await mailAuthorization.getAttribute("href"), "https://chatgpt.com/apps/gmail/mail");
  assert.equal(await mailAuthorization.getAttribute("rel"), "noopener noreferrer");
  assert.match(await page.locator(".connected-service-row").filter({ hasText: "Calendar" }).innerText(), /可调用/);
  assert.equal(await page.getByRole("link", { name: "连接Untrusted" }).count(), 0);
  await page.getByRole("textbox", { name: "搜索服务" }).fill("Gmail");
  assert.equal(await page.locator(".connected-service-row").count(), 1);
  await page.getByRole("textbox", { name: "搜索服务" }).fill("");
  await page.screenshot({ path: new URL("connections-desktop.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  const panelBounds = await page.locator(".command-panel").evaluate((element) => ({ top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height, viewport: innerHeight }));
  assert.equal(Math.round(panelBounds.top), 0);
  assert.ok(panelBounds.height >= panelBounds.viewport);
  await page.screenshot({ path: new URL("connections-390.png", out).pathname });
  appsFailure = true;
  await page.getByRole("button", { name: "刷新连接" }).click();
  await page.getByText("服务暂不可用", { exact: true }).waitFor();
  assert.equal(await page.locator(".connected-service-row").count(), 0);
  appsFailure = false;
  appsDirectoryDenied = true;
  await page.getByRole("button", { name: "刷新连接" }).click();
  await mailAuthorization.waitFor();
  await page.locator(".connected-directory-warning summary").click();
  await page.getByText("上游拒绝了云端服务目录请求（403）。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "管理全部服务" }).getAttribute("href"), "https://chatgpt.com/apps");
  appsDirectoryDenied = false;
  await page.locator(".command-panel").getByRole("button", { name: "关闭面板" }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await composer.fill("独立个人草稿");
  assert.equal(await page.locator(".send-button").isEnabled(), true);
  await page.locator(".space-switch").getByRole("button", { name: "工作" }).click();
  await page.locator(".session-current[data-session-id='sample-app-session']").waitFor();
  assert.equal(await composer.inputValue(), "");
  await page.locator(".space-switch").getByRole("button", { name: "个人" }).click();
  await page.getByRole("heading", { name: "今日" }).waitFor();
  await openRecentPersonalChat();
  await page.locator(".session-current[data-session-id='_personal-session']").waitFor();
  assert.equal(await composer.inputValue(), "独立个人草稿");
  includeNewModel = true;
  await page.getByRole("button", { name: /^会话设置：/ }).click();
  await page.locator(".personal-session-settings").getByRole("button", { name: /模型/ }).click();
  await page.getByRole("button", { name: /GPT-6 Astra gpt-6-astra/ }).click();
  await page.getByRole("button", { name: /^会话设置：GPT-6 Astra/ }).waitFor();
  assert.equal(selectedRuntime?.model, "gpt-6-astra");
  assert.equal(selectedRuntime?.reasoning, "medium");
  await page.screenshot({ path: new URL("personal-desktop.png", out).pathname, fullPage: true });

  await page.locator(".space-switch").getByRole("button", { name: "工作" }).click();
  await page.getByRole("button", { name: "同意本次" }).click();
  assert.deepEqual(decision, { decision: "accept", digest: "digest-test" });
  await page.getByRole("button", { name: /调用与用量/ }).click();
  await page.getByRole("heading", { name: "调用与用量" }).waitFor();
  assert.match(await page.locator(".usage-summary").innerText(), /120/);
  assert.match(await page.locator(".usage-view").innerText(), /1 次运行用量未知/);
  assert.match(await page.locator(".usage-summary").innerText(), /结果查询\s*3/);
  await page.locator(".usage-request summary").first().click();
  assert.match(await page.locator(".usage-request-expanded").innerText(), /Token 120/);
  await page.getByRole("group", { name: "曲线指标" }).getByRole("button", { name: "查询" }).click();
  await page.getByRole("img", { name: "查询 趋势" }).waitFor();
  assert.ok(await page.locator('.usage-chart-column[title$=": 3"]').count());
  await page.locator(".usage-chart-data summary").click();
  assert.match(await page.locator(".usage-chart-data table").innerText(), /查询[\s\S]*3/);
  await page.getByRole("textbox", { name: "调用方名称" }).fill("第二个服务");
  await page.locator(".usage-scopes input[type='checkbox']").first().check();
  await page.getByRole("button", { name: "创建令牌" }).click();
  await page.getByText(createdToken).waitFor();
  await page.getByRole("group", { name: "时间范围" }).getByRole("button", { name: "24 小时" }).click();
  await page.waitForFunction(() => document.querySelector(".usage-summary > div:first-child strong")?.textContent === "2");
  usageRace = true;
  await page.getByRole("group", { name: "时间范围" }).getByRole("button", { name: "7 天" }).click();
  await page.getByRole("group", { name: "时间范围" }).getByRole("button", { name: "30 天" }).click();
  await page.waitForFunction(() => document.querySelector(".usage-summary > div:first-child strong")?.textContent === "30");
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".usage-summary > div:first-child strong").innerText(), "30");
  usageRace = false;
  usageFailure = true;
  await page.getByRole("button", { name: "刷新用量" }).click();
  await page.getByText("模拟统计不可用", { exact: true }).waitFor();
  assert.equal(await page.locator(".usage-summary > div:first-child strong").innerText(), "30");
  await page.getByText(/当前显示上次成功数据/).waitFor();
  usageFailure = false;
  await page.getByRole("button", { name: "刷新用量" }).click();
  await page.waitForFunction(() => !document.querySelector(".usage-error"));
  await page.screenshot({ path: new URL("usage-desktop.png", out).pathname, fullPage: true });
  for (const width of [320, 360, 390, 430, 768, 820, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width <= 430 ? 800 : 900 });
    if (width <= 820) await page.getByRole("button", { name: "打开侧边栏" }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `horizontal overflow at ${width}px`);
    if (width <= 820) {
      await page.locator(".mobile-sidebar-close").click();
      const undersized = await page.locator(".usage-header .icon-button, .usage-client .icon-button, .usage-token button, .usage-filters button, .usage-filters select, .usage-section-head .usage-segmented button").evaluateAll((buttons) => buttons.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44;
      }).map((button) => button.outerHTML.slice(0, 160)));
      assert.deepEqual(undersized, [], `undersized usage controls at ${width}px`);
      await page.screenshot({ path: new URL(`usage-${width}.png`, out).pathname, fullPage: true });
      if (width === 390) {
        await page.getByRole("button", { name: "打开侧边栏" }).click();
        await page.locator(".space-switch").getByRole("button", { name: "个人" }).click();
        await page.getByRole("heading", { name: "今日" }).waitFor();
        await page.screenshot({ path: new URL("today-390.png", out).pathname });
        await openRecentPersonalChat();
        await page.locator(".session-current[data-session-id='_personal-session']").waitFor();
        await page.getByText("共用账号", { exact: true }).waitFor();
        const chatHeight = await page.locator(".chat-window").evaluate((element) => element.getBoundingClientRect().height);
        const chatLayout = await page.evaluate(() => Object.fromEntries([".topbar", ".app-session-strip", ".personal-scope-notice", ".composer-shell", ".composer", ".composer-footer", ".chat-window"].map((selector) => [selector, Math.round(document.querySelector(selector)?.getBoundingClientRect().height || 0)])));
        assert.ok(chatHeight >= 844 * 0.5, `390px personal chat window too short: ${chatHeight}px; ${JSON.stringify(chatLayout)}`);
        const smallControls = await page.locator(".composer-shell .attach-button, .composer-shell .send-button, .composer-shell .clear-chat, .personal-scope-actions button, .session-actions button").evaluateAll((buttons) => buttons.filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
        }).map((button) => button.outerHTML.slice(0, 140)));
        assert.deepEqual(smallControls, [], "undersized personal controls at 390px");
        await page.getByRole("button", { name: "连接服务", exact: true }).click();
        assert.equal(await page.locator(".command-panel").getAttribute("aria-modal"), "true");
        await page.waitForFunction(() => document.activeElement?.closest(".command-panel") !== null);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".command-panel").count(), 0);
        await page.screenshot({ path: new URL("personal-390.png", out).pathname, fullPage: true });
        await page.getByRole("button", { name: "打开侧边栏" }).click();
        await page.locator(".space-switch").getByRole("button", { name: "工作" }).click();
        await page.getByRole("button", { name: "打开侧边栏" }).click();
        await page.getByRole("button", { name: /调用与用量/ }).click();
        await page.getByRole("heading", { name: "调用与用量" }).waitFor();
      }
    }
  }
  await page.goto(`${baseUrl}#/inbox`);
  await page.evaluate(() => localStorage.setItem("codex-cloud-last-space-repo", "_personal"));
  await page.reload();
  await page.getByRole("heading", { name: "今日" }).waitFor();
  assert.match(page.url(), /#\/project\/_personal/);
  assert.equal(await page.getByText("仅草稿", { exact: true }).count(), 0);
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText(/与工作空间共用登录/).waitFor();
  assert.equal(await page.getByText("其他项目的历史诊断", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "重新登录" }).first().click();
  const authorizationLink = page.getByRole("link", { name: /打开授权页/ }).first();
  await authorizationLink.waitFor();
  assert.equal(await authorizationLink.getAttribute("href"), "https://login.example.test/device");
  assert.equal(await authorizationLink.getAttribute("rel"), "noopener noreferrer");
  await page.getByRole("textbox", { name: "事实名称" }).fill("称呼");
  await page.getByRole("textbox", { name: "事实内容" }).fill("小王");
  await page.getByRole("button", { name: "添加事实" }).click();
  await page.getByText("小王", { exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑 称呼" }).click();
  await page.getByRole("textbox", { name: "事实内容" }).fill("小李");
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.getByText("小李", { exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑 称呼" }).click();
  await page.getByRole("textbox", { name: "事实内容" }).fill("手机尚未保存的修改");
  const otherDevice = await context.newPage();
  await otherDevice.goto(page.url());
  await otherDevice.getByRole("button", { name: "编辑 称呼" }).click();
  await otherDevice.getByRole("textbox", { name: "事实内容" }).fill("电脑已保存的最新内容");
  await otherDevice.getByRole("button", { name: "保存修改" }).click();
  await otherDevice.getByText("电脑已保存的最新内容", { exact: true }).waitFor();
  await otherDevice.close();
  await page.getByRole("button", { name: "保存修改" }).click();
  const factConflict = page.getByRole("region", { name: "个人事实冲突" });
  await factConflict.waitFor();
  assert.match(await factConflict.innerText(), /电脑已保存的最新内容/);
  assert.equal(await page.getByRole("textbox", { name: "事实内容" }).inputValue(), "手机尚未保存的修改");
  assert.equal(await page.getByRole("button", { name: "保存修改" }).isDisabled(), true);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await factConflict.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const smallButtons = await page.locator(".personal-facts button").evaluateAll((buttons) => buttons.filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
    }).map((button) => button.textContent));
    assert.deepEqual(smallButtons, []);
    await page.screenshot({ path: new URL(`personal-facts-conflict-${width}.png`, out).pathname });
  }
  await factConflict.getByRole("button", { name: "保留我的修改继续编辑" }).click();
  assert.equal(personalFacts[0].value, "电脑已保存的最新内容", "conflict resolution must not automatically save");
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.getByText("手机尚未保存的修改", { exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑 称呼" }).click();
  await page.getByRole("textbox", { name: "事实内容" }).fill("不应覆盖");
  personalFacts[0].value = "另一次最新内容";
  personalFacts[0].revision += 1;
  await page.getByRole("button", { name: "保存修改" }).click();
  await factConflict.getByRole("button", { name: "使用最新内容" }).click();
  assert.equal(await page.getByRole("textbox", { name: "事实内容" }).inputValue(), "另一次最新内容");
  await page.getByRole("textbox", { name: "事实内容" }).fill("网络错误时仍保留");
  personalFacts[0].value = "网络中断前更新";
  personalFacts[0].revision += 1;
  personalFactsReadFailure = true;
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.getByText("无法读取最新事实，你的输入已保留，请稍后再试。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "事实内容" }).inputValue(), "网络错误时仍保留");
  assert.equal(personalFacts[0].value, "网络中断前更新");
  personalFactsReadFailure = false;
  await page.getByRole("button", { name: "保存修改" }).click();
  await factConflict.getByRole("button", { name: "使用最新内容" }).click();
  await page.getByRole("button", { name: "取消编辑" }).click();
  personalFacts[0].value = "删除前又被更新";
  personalFacts[0].revision += 1;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除 称呼" }).click();
  await page.getByText("删除前又被更新", { exact: true }).waitFor();
  assert.equal(personalFacts.length, 1, "stale delete must preserve the fact");
  await page.getByRole("button", { name: "编辑 称呼" }).click();
  await page.getByRole("textbox", { name: "事实内容" }).fill("被删除后保留的草稿");
  personalFacts = [];
  await page.getByRole("button", { name: "保存修改" }).click();
  await factConflict.getByText("这条事实已被删除", { exact: true }).waitFor();
  await factConflict.getByRole("button", { name: "转为新事实草稿" }).click();
  assert.equal(personalFacts.length, 0, "deleted fact must not be resurrected automatically");
  assert.equal(await page.getByRole("textbox", { name: "事实内容" }).inputValue(), "被删除后保留的草稿");
  await page.getByRole("button", { name: "添加事实" }).click();
  await page.getByText("被删除后保留的草稿", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除 称呼" }).click();
  await page.locator(".personal-fact-row").waitFor({ state: "detached" });
  assert.equal(personalFacts.length, 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  pending.push({ id: "personal-approval-test", method: "item/commandExecution/requestApproval", digest: "personal-digest", owner: { repoId: "_personal", sessionId: "_personal-session" }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), params: { command: "echo personal approval check", cwd: "/tmp/personal" } });
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText("echo personal approval check", { exact: true }).waitFor();
  assert.match(await page.locator(".personal-daily-summary").innerText(), /1 项需要你处理/);
  assert.equal(await page.getByText("echo approval-check", { exact: true }).count(), 0);
  await page.locator(".personal-list-section").filter({ has: page.getByRole("heading", { name: "最近结果" }) }).getByRole("button", { name: /demo.md/ }).click();
  await page.getByRole("heading", { name: "助理生成的文件" }).waitFor();
  await page.getByRole("heading", { name: "demo.md" }).waitFor();
  await page.screenshot({ path: new URL("material-desktop.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("material-390.png", out).pathname });
  await page.locator(".personal-files .personal-task-row").filter({ hasText: "notes.txt" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "删除上传副本" }).click();
  assert.equal(personalFilesDeleted, 0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除上传副本" }).click();
  await page.waitForFunction(() => !document.querySelector(".personal-files")?.textContent?.includes("notes.txt"));
  assert.equal(personalFilesDeleted, 1);
  await page.locator(".personal-files .personal-task-row").filter({ hasText: "demo.md" }).click();
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.ok(await page.getByRole("button", { name: "继续修改" }).evaluate((element) => element.getBoundingClientRect().height >= 44));
  await page.screenshot({ path: new URL("material-320.png", out).pathname });
  await page.getByRole("button", { name: "继续修改" }).click();
  await page.locator(".personal-scope-notice").waitFor();
  await page.setViewportSize({ width: 390, height: 480 });
  await page.waitForFunction(() => {
    const composer = document.querySelector(".composer-shell");
    const input = composer?.querySelector("textarea");
    return composer && input && composer.getBoundingClientRect().bottom <= innerHeight && input.getBoundingClientRect().height >= 44;
  }, undefined, { timeout: 3000 });
  await page.screenshot({ path: new URL("personal-390-short.png", out).pathname });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.match(await composer.inputValue(), /独立个人草稿[\s\S]*@results\/demo.md/);
  queueFlow = true;
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".composer-shell textarea")?.getAttribute("placeholder") === "排队下一条消息");
  await composer.fill("下一个待办");
  await page.getByRole("button", { name: "排队下一条消息" }).click();
  await page.getByText("下一条已排队").waitFor();
  assert.equal(sessions.find((item) => item.repoId === "_personal").queuedTurn.message, "下一个待办");
  await page.screenshot({ path: new URL("personal-queued-390-short.png", out).pathname });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.ok(await page.locator(".composer-shell").evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight));
  await page.evaluate(() => { location.hash = "/project/_personal/today"; });
  await page.getByRole("heading", { name: "排队待发送" }).waitFor();
  await page.getByRole("button", { name: /新对话.*下一个待办/ }).waitFor();
  const queuedSession = sessions.find((item) => item.repoId === "_personal");
  queuedSession.queuedTurn.status = "paused";
  queuedSession.queuedTurn.reason = "上一轮未成功，排队已暂停";
  await page.reload();
  await page.getByRole("button", { name: /待核对.*上一轮未成功/ }).waitFor();
  await page.evaluate(() => { location.hash = "/project/_personal/thread/_personal-session"; });
  await page.getByRole("button", { name: "撤回到草稿" }).waitFor();
  await page.getByRole("button", { name: "撤回到草稿" }).click();
  await page.waitForFunction(() => !document.querySelector(".queued-turn-banner"));
  assert.equal(await composer.inputValue(), "下一个待办");
  await page.getByRole("button", { name: "立即补充本轮" }).click();
  assert.deepEqual(steeredMessages, ["下一个待办"]);
  queueFlow = false;
  releaseJobEvents?.();
  await page.waitForFunction(() => document.querySelector(".composer-shell textarea")?.getAttribute("placeholder") === "向个人助理发送消息");
  await page.evaluate(() => { location.hash = "/project/_personal/today"; });
  await page.getByRole("heading", { name: "可以交办" }).waitFor();
  const beforePrompt = submittedMessages;
  const draftSaved = page.waitForResponse((response) => response.url().includes("/api/chat/sessions/_personal-new-1/draft") && response.request().method() === "PATCH");
  await page.locator(".personal-today .personal-guide").getByRole("button", { name: /调研一个问题/ }).click();
  await page.locator(".session-current[data-session-id='_personal-new-1']").waitFor();
  assert.match(await composer.inputValue(), /帮我调研这个问题/);
  await draftSaved;
  assert.match(sessions.find((item) => item.id === "_personal-new-1").draft.input, /帮我调研这个问题/);
  assert.equal(submittedMessages, beforePrompt);
  await page.evaluate(() => { location.hash = "/project/_personal/today"; });
  await page.getByRole("heading", { name: "关注事项" }).waitFor();
  await page.locator(".personal-commitments").getByRole("button", { name: "添加" }).click();
  await page.getByRole("textbox", { name: "事项名称" }).fill("周末前整理行程");
  await page.getByRole("textbox", { name: "下一步" }).fill("核对酒店和车次");
  const yesterdayLocal = new Date(Date.now() - 86_400_000);
  await page.locator('.personal-commitment-editor input[type="datetime-local"]').fill(new Date(yesterdayLocal.getTime() - yesterdayLocal.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  await page.getByRole("button", { name: "添加事项" }).click();
  await page.getByText("周末前整理行程", { exact: true }).waitFor();
  pending = [];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText("1 项关注事项今天或此前到期").waitFor();
  assert.equal(personalCommitments.length, 1);
  await page.locator(".personal-commitments").getByRole("button", { name: "起草" }).click();
  await page.locator(".session-current[data-session-id='_personal-new-2']").waitFor();
  assert.match(await composer.inputValue(), /周末前整理行程[\s\S]*核对酒店和车次/);
  assert.equal(personalCommitments[0].sessionId, "_personal-new-2");
  assert.equal(submittedMessages, beforePrompt);
  await page.evaluate(() => { location.hash = "/project/_personal/today"; });
  await page.locator(".personal-commitments").getByRole("button", { name: "继续草稿" }).waitFor();
  await page.getByText(/对话草稿未发送/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("today-commitment-active-390.png", out).pathname });
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("today-commitment-active-320.png", out).pathname });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "完成 周末前整理行程" }).click();
  await page.getByText("已完成 1 项").waitFor();
  assert.equal(personalCommitments[0].status, "done");
  await page.locator(".personal-completed summary").click();
  personalCommitments[0].revision += 1;
  await page.getByRole("button", { name: "重新跟进 周末前整理行程" }).click();
  await page.getByText("stale", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新关注事项" }).click();
  await page.waitForFunction(() => !document.querySelector(".personal-commitments .warn-text"));
  await page.locator(".personal-commitments").getByRole("button", { name: "添加" }).click();
  await page.getByRole("textbox", { name: "事项名称" }).fill("给家人整理照片");
  await page.getByRole("button", { name: "添加事项" }).click();
  await page.getByText("给家人整理照片", { exact: true }).waitFor();
  failNextCommitmentDraftResponse = true;
  const beforeRetry = newSessionCount;
  await page.locator(".personal-commitments").getByRole("button", { name: "起草" }).click();
  await page.getByText(/temporary draft response failure.*重试会沿用已创建的草稿/).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("codex-cloud:personal-commitment-pending-links")), null);
  await page.reload();
  await page.locator(".personal-commitments").getByRole("button", { name: "继续草稿" }).waitFor();
  await page.locator(".personal-commitments").getByRole("button", { name: "继续草稿" }).click();
  await page.locator(`.session-current[data-session-id='_personal-new-${beforeRetry + 1}']`).waitFor();
  assert.equal(newSessionCount, beforeRetry + 1);
  assert.equal(personalCommitments[1].sessionId, `_personal-new-${beforeRetry + 1}`);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("codex-cloud:personal-commitment-pending-links") || "{}")["commitment-2"]), undefined);
  const otherTab = await context.newPage();
  await otherTab.goto(new URL("#/project/_personal/today", process.env.CODEX_CLOUD_SAFETY_UI_URL || "http://127.0.0.1:18787/").href);
  await otherTab.locator(".personal-commitment-row").filter({ hasText: "给家人整理照片" }).getByRole("button", { name: "继续草稿" }).click();
  await otherTab.locator(`.session-current[data-session-id='_personal-new-${beforeRetry + 1}']`).waitFor();
  assert.equal(newSessionCount, beforeRetry + 1);
  await otherTab.close();
  await page.evaluate(() => { location.hash = "/project/_personal/today"; });
  await page.locator(".personal-commitments").getByRole("button", { name: "添加" }).click();
  await page.getByRole("textbox", { name: "事项名称" }).fill("核对失效草稿");
  await page.getByRole("button", { name: "添加事项" }).click();
  await page.getByText("核对失效草稿", { exact: true }).waitFor();
  await page.evaluate(() => sessionStorage.setItem("codex-cloud:personal-commitment-pending-links", JSON.stringify({ "commitment-3": "missing-personal-session" })));
  await page.reload();
  await page.locator(".personal-commitments").getByRole("button", { name: "重试关联" }).waitFor();
  const beforeStaleLink = newSessionCount;
  await page.locator(".personal-commitments").getByRole("button", { name: "重试关联" }).click();
  await page.locator(`.session-current[data-session-id='_personal-new-${beforeStaleLink + 1}']`).waitFor();
  assert.equal(personalCommitments[2].sessionId, `_personal-new-${beforeStaleLink + 1}`);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("codex-cloud:personal-commitment-pending-links") || "{}")["commitment-3"]), undefined);
  await page.evaluate(() => { location.hash = "/project/_personal/today"; });
  await page.locator(".personal-commitments").getByRole("button", { name: "添加" }).click();
  await page.getByRole("textbox", { name: "事项名称" }).fill("迁移之前的个人草稿");
  await page.getByRole("button", { name: "添加事项" }).click();
  await page.getByText("迁移之前的个人草稿", { exact: true }).waitFor();
  const legacySessionId = "_personal-legacy-draft";
  sessions.push({ ...sessions.find((entry) => entry.repoId === "_personal"), id: legacySessionId, goal: null, draft: { input: "用户编辑过的旧草稿", attachments: [], revision: 2 } });
  await page.evaluate((id) => sessionStorage.setItem("codex-cloud:personal-commitment-pending-links", JSON.stringify({ "commitment-4": id })), legacySessionId);
  await page.reload();
  const beforeLegacy = newSessionCount;
  await page.locator(".personal-commitments").getByRole("button", { name: "重试关联" }).click();
  await page.locator(`.session-current[data-session-id='${legacySessionId}']`).waitFor();
  assert.equal(newSessionCount, beforeLegacy);
  assert.equal(personalCommitments[3].sessionId, legacySessionId);
  assert.equal(await composer.inputValue(), "用户编辑过的旧草稿");
  await page.evaluate(() => { location.hash = "/project/_personal/today"; });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("today-commitments-390.png", out).pathname });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator(".sidebar .nav-item").filter({ hasText: "设置" }).click();
  await page.getByRole("heading", { name: "连接服务" }).waitFor();
  const callableCalendar = page.locator(".personal-settings .connected-service-row").filter({ hasText: "Calendar" });
  assert.equal(await page.locator(".personal-settings .connected-service-row").filter({ hasText: "Gmail" }).getByRole("button", { name: "起草" }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.ok(await callableCalendar.getByRole("button", { name: "起草" }).evaluate((element) => element.getBoundingClientRect().height >= 44));
  await page.setViewportSize({ width: 1280, height: 900 });
  await callableCalendar.getByRole("button", { name: "起草" }).click();
  await page.locator(`.session-current[data-session-id='_personal-new-${newSessionCount}']`).waitFor();
  assert.match(await composer.inputValue(), /已连接服务 "Calendar"[\s\S]*我的任务是/);
  assert.equal(submittedMessages, beforePrompt);
  oldCommitmentApi = true;
  await page.evaluate(() => { location.hash = "/project/_personal/today"; });
  await page.getByText("服务器尚未更新个人事项功能", { exact: true }).waitFor();
  assert.equal(await page.locator(".personal-commitments").getByRole("button", { name: "添加" }).isDisabled(), true);
  assert.equal(await page.locator(".personal-commitments").getByText("暂无关注事项。").count(), 0);
  const reminderPage = await context.newPage();
  reminderPage.on("pageerror", (error) => errors.push(error.message));
  await reminderPage.addInitScript((endpoint) => {
    if (!("PushManager" in window)) Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    const registration = { scope: `${location.origin}/`, active: { scriptURL: `${location.origin}/codex-cloud-sw.js` }, pushManager: { getSubscription: async () => ({ endpoint }) } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistrations: async () => [registration], getRegistration: async () => registration } });
  }, personalPushEndpoint);
  await reminderPage.goto(`${baseUrl}#/project/_personal/today`);
  await reminderPage.locator(".sidebar .nav-item").filter({ hasText: "设置" }).click();
  await reminderPage.getByLabel("到期时在本机浏览器提醒我").waitFor();
  await reminderPage.setViewportSize({ width: 390, height: 844 });
  await reminderPage.getByLabel("到期时在本机浏览器提醒我").check();
  await reminderPage.getByLabel("安静时段开始").fill("21:30");
  await reminderPage.getByRole("button", { name: "保存提醒设置" }).click();
  await reminderPage.getByText("提醒设置已保存。").waitFor();
  assert.deepEqual(personalReminderSettings, { enabled: true, timeZone: "Asia/Shanghai", quietStart: "21:30", quietEnd: "08:00" });
  assert.equal(await reminderPage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await reminderPage.screenshot({ path: new URL("personal-reminders-390.png", out).pathname, fullPage: true });
  await reminderPage.close();
  oldCommitmentApi = false;
  const reviewRun = {
    id: "review-run-ui", automationId: "personal-plan", repoId: "_personal", name: "每周资料整理", trigger: "schedule", runner: "app-server",
    status: "needs_reconciliation", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    threadId: null, sessionId: "_personal-session", worktreePath: null, worktreePolicy: "none", model: "gpt-6-sol", reasoning: "medium",
    prompt: "", summary: "日历事件可能已创建", diffStat: "", error: "写入结果未确认", events: [],
  };
  status.automationRuns = [reviewRun];
  status.attention = {
    count: 1, unreadCount: 1, totalCount: 1, acknowledgedCount: 0, needsAttentionCount: 1, activeCount: 0,
    dirtyRepoCount: 0, auditIssueCount: 0, latestItemId: "automation:review-run-ui", latestTitle: "每周资料整理",
    items: [{ id: "automation:review-run-ui", type: "automation", tone: "danger", title: "每周资料整理", body: "日历事件可能已创建", time: new Date().toISOString(), repoId: "_personal", automationId: "personal-plan", runId: reviewRun.id, sessionId: "_personal-session", action: "thread", acknowledged: false }],
  };
  sessions.find((item) => item.id === "_personal-session").externalActionReview = {
    id: "external-review-ui", automationRunId: reviewRun.id, server: "Calendar", tool: "create_event", count: 2,
    at: new Date().toISOString(), reason: "连接服务写入尚无可信的成功回执，是否已执行尚不明确。请先在对应服务核对，勿直接重试。",
    actions: [
      { server: "Calendar", tool: "create_event", status: "completed" },
      { server: "Calendar", tool: "update_event", status: "inProgress" },
    ],
  };
  sessions.find((item) => item.id === "_personal-session").queuedTurn = { id: "review-queue-ui", preview: "继续处理日历", status: "needs_reconciliation", reason: "上一轮写入待核对", createdAt: new Date().toISOString() };
  await page.goto(`${baseUrl}#/project/_personal/today`);
  await page.reload();
  await page.getByRole("heading", { name: /需要你决定/ }).waitFor().catch(async (error) => {
    throw new Error(`Missing external review on ${page.url()}: ${(await page.locator("body").innerText()).slice(0, 1800)}`, { cause: error });
  });
  assert.equal(await page.locator(".personal-priority-section .personal-task-row").count(), 1);
  assert.match(await page.locator(".personal-daily-summary").innerText(), /1 项需要你处理/);
  const unrelatedRun = { ...reviewRun, id: "unrelated-run-ui" };
  status.automationRuns.push(unrelatedRun);
  status.attention.items.push({ ...status.attention.items[0], id: "automation:unrelated-run-ui", runId: unrelatedRun.id, title: "另一项待核对运行" });
  await page.reload();
  await page.getByRole("heading", { name: "今日" }).waitFor();
  assert.equal(await page.locator(".personal-priority-section .personal-task-row").count(), 2);
  status.automationRuns.pop();
  status.attention.items.pop();
  await page.reload();
  await page.getByRole("heading", { name: "今日" }).waitFor();
  assert.match(await page.locator(".personal-list-section").filter({ has: page.getByRole("heading", { name: "最近结果" }) }).innerText(), /外部操作待核对/);
  await page.locator(".sidebar .nav-item").filter({ hasText: "计划任务" }).click();
  await page.locator(".automation-runs-panel").waitFor();
  assert.match(await page.locator(".automation-runs-panel").innerText(), /已关联会话/);
  await page.goto(`${baseUrl}#/project/_personal/today`);
  await page.reload();
  await page.locator(".personal-priority-section").getByRole("button", { name: /外部操作待核对/ }).click();
  await page.getByTestId("external-action-review").waitFor();
  await page.reload();
  await page.getByTestId("external-action-review").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("external-review-390.png", out).pathname, fullPage: true });
  await page.locator(".external-review-details summary").click();
  assert.match(await page.getByTestId("external-action-review").innerText(), /create_event[\s\S]*update_event/);
  assert.ok(await page.getByRole("button", { name: "已在服务中核对" }).evaluate((element) => element.getBoundingClientRect().height >= 44));
  assert.equal(await page.locator(".send-button").isDisabled(), true);
  const beforeBlockedSend = submittedMessages;
  await composer.fill("保留这条输入");
  await composer.press("Enter");
  assert.equal(submittedMessages, beforeBlockedSend);
  assert.equal(await composer.inputValue(), "保留这条输入");
  await page.screenshot({ path: new URL("external-review-expanded-390.png", out).pathname, fullPage: true });
  await page.locator(".external-review-details summary").click();
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("external-review-320.png", out).pathname, fullPage: true });
  await page.getByRole("button", { name: "已在服务中核对" }).click();
  await page.getByTestId("external-action-review").waitFor({ state: "detached" });
  assert.equal(sessions.find((item) => item.id === "_personal-session").externalActionReview, null);
  sessions.find((item) => item.id === "_personal-session").queuedTurn = null;
  reviewRun.sessionId = null;
  status.attention.items[0].sessionId = null;
  await page.goto(`${baseUrl}#/project/_personal/today`);
  await page.reload();
  await page.locator(".personal-priority-section").getByRole("button", { name: /每周资料整理/ }).click();
  await page.locator(".automation-panel").waitFor();
  assert.match(page.url(), /automations/);
  assert.equal(await page.locator(".automation-list .automation-row").count(), 1);
  assert.equal(await page.getByRole("button", { name: "同步" }).count(), 0);
  assert.match(await page.locator(".automation-runs-panel").innerText(), /会话待建立/);
  assert.equal(await page.locator(".automation-task-grid").count(), 0);
  assert.match(await page.locator(".personal-routine-prompt").innerText(), /任务内容/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("personal-routines-390.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.equal(await page.locator(".topbar").count(), 1);
  assert.equal(await page.evaluate(() => Boolean(document.elementFromPoint(160, 760)?.closest(".topbar"))), false);
  await page.screenshot({ path: new URL("personal-routines-320.png", out).pathname });
  let runConfirmation = "";
  page.once("dialog", (dialog) => { runConfirmation = dialog.message(); void dialog.dismiss(); });
  await page.getByRole("button", { name: "立即运行" }).click();
  assert.match(runConfirmation, /模型额度/);
  assert.equal(manualAutomationRuns, 0);
  await page.goto(`${baseUrl}#/project/_personal/today`);
  await page.reload();
  await page.locator(".personal-list-section").filter({ has: page.getByRole("heading", { name: "持续跟进" }) }).getByRole("button", { name: /每周资料整理/ }).click();
  await page.locator(".automation-panel").waitFor();
  assert.match(page.url(), /automations/);
  status.automations.find((item) => item.id === "personal-plan").mode = "on-demand";
  status.automations.find((item) => item.id === "personal-plan").nextRun = "按需触发";
  await page.reload();
  await page.locator(".automation-brief .run-badge").getByText("按需", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "暂停", exact: true }).count(), 0);
  await page.getByRole("button", { name: "新建流程" }).click();
  const routineEditor = page.locator(".personal-routine-editor");
  await routineEditor.getByRole("textbox", { name: "名称" }).fill("每天整理资料");
  await routineEditor.getByRole("textbox", { name: "每次执行的任务" }).fill("只读总结资料，不修改外部数据");
  await page.screenshot({ path: new URL("personal-routine-create-320.png", out).pathname });
  assert.equal(manualAutomationRuns, 0);
  await routineEditor.getByRole("button", { name: "保存" }).click();
  await page.locator(".automation-row").filter({ hasText: "每天整理资料" }).waitFor();
  assert.equal(manualAutomationRuns, 0);
  const scheduleForm = page.locator(".personal-routine-schedule");
  await scheduleForm.waitFor();
  assert.match(await scheduleForm.innerText(), /未启用/);
  assert.match(await scheduleForm.innerText(), /尚未试运行/);
  assert.equal(await scheduleForm.getByRole("button", { name: "启用计划" }).isDisabled(), true);
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  await page.getByRole("button", { name: "试运行" }).click();
  assert.equal(manualAutomationRuns, 0);
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("button", { name: "试运行" }).click();
  await scheduleForm.getByText("试运行待确认").waitFor();
  assert.equal(manualAutomationRuns, 1);
  assert.equal(await scheduleForm.getByRole("button", { name: "启用计划" }).isDisabled(), true);
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await scheduleForm.getByRole("button", { name: "确认结果" }).click();
  await scheduleForm.getByText("试运行已确认").waitFor();
  await scheduleForm.getByRole("combobox", { name: "频率" }).selectOption("weekdays");
  await scheduleForm.getByRole("textbox", { name: "时区" }).fill("Asia/Shanghai");
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  await scheduleForm.getByRole("button", { name: "启用计划" }).click();
  assert.equal(status.automations.find((item) => item.name === "每天整理资料").personalSchedule, undefined);
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await scheduleForm.getByRole("button", { name: "启用计划" }).click();
  await scheduleForm.getByText("已启用", { exact: true }).waitFor();
  assert.equal(manualAutomationRuns, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("personal-routine-schedule-320.png", out).pathname });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("personal-routine-schedule-390.png", out).pathname });
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("personal-routine-schedule-desktop.png", out).pathname });
  await page.setViewportSize({ width: 320, height: 800 });
  await scheduleForm.getByRole("button", { name: "暂停" }).click();
  await scheduleForm.getByText("未启用").waitFor();
  await page.reload();
  await scheduleForm.getByText("未启用").waitFor();
  await page.getByRole("button", { name: "编辑" }).click();
  await routineEditor.getByRole("textbox", { name: "名称" }).fill("每次整理资料");
  await routineEditor.getByRole("button", { name: "保存" }).click();
  await page.locator(".automation-row").filter({ hasText: "每次整理资料" }).waitFor();
  await page.reload();
  await page.locator(".automation-row").filter({ hasText: "每次整理资料" }).waitFor();
  await page.locator(".automation-row").filter({ hasText: "每次整理资料" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  page.once("dialog", (dialog) => { void dialog.dismiss(); });
  await page.getByRole("button", { name: "试运行" }).click();
  assert.equal(manualAutomationRuns, 1);
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("button", { name: "试运行" }).click();
  await page.waitForFunction(() => document.body.textContent?.includes("试运行已启动"));
  assert.equal(manualAutomationRuns, 2);
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("button", { name: "归档" }).click();
  await page.locator(".automation-row").filter({ hasText: "每次整理资料" }).waitFor({ state: "detached" });
  await page.getByText("已归档流程 (1)").click();
  await page.locator(".personal-routine-archive-row").getByRole("button", { name: "恢复" }).click();
  await page.locator(".automation-row").filter({ hasText: "每次整理资料" }).waitFor();
  assert.equal(manualAutomationRuns, 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("personal-routine-edit-320.png", out).pathname });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator(".sidebar .nav-item").filter({ hasText: "今日" }).click();
  await page.getByRole("heading", { name: "今日" }).waitFor();
  assert.match(await page.locator(".personal-list-section").filter({ has: page.getByRole("heading", { name: "可复用流程" }) }).innerText(), /每次整理资料/);
  await page.reload();
  await page.getByRole("heading", { name: "今日" }).waitFor();
  const reviewButton = page.locator(".personal-priority-section").getByRole("button", { name: "已核对" });
  assert.equal(await reviewButton.count(), 1, `Missing review action on ${page.url()}: ${(await page.locator("body").innerText()).slice(0, 2200)}`);
  let reviewConfirmation = "";
  page.once("dialog", (dialog) => { reviewConfirmation = dialog.message(); void dialog.accept(); });
  await reviewButton.click();
  assert.match(reviewConfirmation, /运行记录仍会保留/);
  await page.locator(".personal-priority-section").waitFor({ state: "detached" });
  assert.equal(status.attention.items[0].acknowledged, true);
  await page.reload();
  assert.equal(await page.locator(".personal-priority-section").count(), 0);
  assert.match(await page.locator(".personal-list-section").filter({ has: page.getByRole("heading", { name: "最近结果" }) }).innerText(), /外部操作待核对/);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${baseUrl}#/project/_personal/thread/_personal-session`);
  const personalDraft = page.locator(".composer-shell textarea");
  await personalDraft.fill("请每次检查我的待办进度，并给出下一步");
  const submittedBeforeRoutine = submittedMessages;
  const saveRoutineButton = page.getByRole("button", { name: "保存草稿为流程" });
  assert.ok(await saveRoutineButton.evaluate((element) => element.getBoundingClientRect().width >= 44 && element.getBoundingClientRect().height >= 44));
  await saveRoutineButton.click();
  const draftRoutineEditor = page.locator(".personal-routine-editor");
  assert.equal(await draftRoutineEditor.getByRole("textbox", { name: "每次执行的任务" }).inputValue(), "请每次检查我的待办进度，并给出下一步");
  assert.equal(manualAutomationRuns, 2);
  assert.equal(submittedMessages, submittedBeforeRoutine);
  await draftRoutineEditor.getByRole("textbox", { name: "名称" }).fill("跟进待办");
  await draftRoutineEditor.getByRole("button", { name: "保存" }).click();
  await page.locator(".automation-row").filter({ hasText: "跟进待办" }).waitFor();
  await page.goto(`${baseUrl}#/project/_personal/thread/_personal-session`);
  assert.equal(await personalDraft.inputValue(), "请每次检查我的待办进度，并给出下一步");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.goto(`${baseUrl}#/automations/_personal`);
  await page.locator(".automation-panel").waitFor();
  assert.match(page.url(), /#\/automations\/_personal/);
  const taskSearch = page.getByPlaceholder("搜索任务、项目、服务");
  await taskSearch.fill("没有匹配的流程");
  assert.equal(await page.locator(".automation-list .automation-row").count(), 0);
  assert.equal(await page.locator(".personal-routine-starters").count(), 0);
  await taskSearch.fill("");
  const savedAutomations = status.automations.splice(0);
  await page.reload();
  await page.getByRole("button", { name: "新建流程" }).waitFor({ timeout: 5_000 }).catch(async () => {
    throw new Error(`个人流程空态未载入：${page.url()} ${(await page.locator("body").innerText()).slice(0, 800)}`);
  });
  const starters = page.locator(".personal-routine-starters");
  assert.equal(await starters.getByRole("button").count(), 3);
  await starters.getByRole("button", { name: "查看近期日程" }).click();
  const starterEditor = page.locator(".personal-routine-editor");
  assert.equal(await starterEditor.getByRole("textbox", { name: "名称" }).inputValue(), "查看近期日程");
  assert.match(await starterEditor.getByRole("textbox", { name: "每次执行的任务" }).inputValue(), /只读查看[\s\S]*不要创建、修改/);
  assert.equal(manualAutomationRuns, 2);
  await starterEditor.getByRole("button", { name: "取消" }).click();
  await starters.getByRole("button", { name: "整理待处理邮件" }).click();
  assert.equal(await starterEditor.getByRole("textbox", { name: "名称" }).inputValue(), "整理待处理邮件");
  assert.match(await starterEditor.getByRole("textbox", { name: "每次执行的任务" }).inputValue(), /不要发送、归档/);
  await starterEditor.getByRole("button", { name: "取消" }).click();
  assert.ok(await page.locator(".automation-panel").evaluate((element) => element.getBoundingClientRect().height < 380));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("personal-routine-starters-320.png", out).pathname });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: new URL(`personal-routine-starters-${width}.png`, out).pathname });
  }
  status.automations.push(...savedAutomations);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["个人/工作切换与草稿保留", "个人空间共用登录且可发送", "个人附件上传及移除", "打开模型列表发现新增模型并保留 medium", "一次性审批决定及个人/工作审批隔离", "调用/token 摘要、查询趋势与未知用量", "新客户端令牌仅显示一次", "7 个宽度无横向溢出及移动触控尺寸", "390px 个人/工作侧栏切换", "个人空间刷新旧工作页深链回到个人对话", "不展示其他项目的历史诊断", "弹窗被拦截时仍可打开账号授权链接", "个人事实增删改", "今日变化列表可查看并显式标记已读", "个人提醒可在 390px 开关、设置安静时段并保存", "今日结果直达预览与继续修改草稿", "排队消息撤回到草稿与本轮补充独立交互", "今日区分排队待发送与排队待核对", "今日展示持续目标与已配置计划", "场景建议新建个人会话并保存草稿但不自动发送", "用户维护的个人事项可创建、关联个人草稿、继续、完成，且手机无溢出", "到期事项进入今日概览，关联失败重试不重复建会话", "失效旧草稿关联可清除并重新起草，新草稿首次关联异常仍可复用", "390px 连接服务草稿按钮可触控且不溢出", "连接服务待核对状态跨刷新保留、逐项显示并可人工确认", "同一外部写入的自动化、队列和会话提醒只计一次", "无会话的自动化异常与未来计划可从今日直达", "个人计划页 320/390 无溢出，试运行及人工确认前不可启用计划", "个人流程创建编辑、归档恢复、今日入口和额度确认", "个人草稿一键预填流程且保留草稿", "个人对话跳转计划深链接不被写回", "个人计划空态预填只读范例且不运行模型", "按需任务隐藏无效暂停，自动化提醒可标记已核对且保留运行历史"], screenshots: out.pathname }, null, 2));
} finally { await browser.close(); }
