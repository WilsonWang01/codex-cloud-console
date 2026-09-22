import assert from "node:assert/strict";

export async function verifyReviewSafety({ page, baseUrl, waitUntil, out }) {
  const requests = [];
  const gates = new Map();
  const releases = [];
  let failSnapshot = false;
  let confirmRevert = false;
  const confirmations = [];
  const key = (kind, repo = "sample-app", view = "unstaged") => `${kind}:${repo}:${view}`;
  const hold = (...args) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    gates.set(key(...args), promise);
    const release = () => { gates.delete(key(...args)); resolve(); };
    releases.push(release);
    return release;
  };
  const snapshot = (repo, view, scope = "workspace", baseBranch = "main") => ({
    cwd: `/fixture/${repo}`, gitRoot: `/fixture/${repo}`, isGitRepo: true,
    scope, workspaceView: view, baseBranch, baseBranchOptions: ["main", "develop"], headBranch: "fixture",
    summary: { fileCount: 1, addedLineCount: 1, removedLineCount: 1 },
    files: [{
      id: "same-file-id", path: `${repo}-${scope === "workspace" ? view : baseBranch}.txt`, operation: "update",
      addedLineCount: 1, removedLineCount: 1, diff: "fixture patch",
      hunks: [{ id: "hunk", header: "@@ -1 +1 @@", patch: "fixture hunk", addedLineCount: 1, removedLineCount: 1,
        lines: [{ key: "line", kind: "add", text: `+${repo} ${view}`, newLine: 1, oldLine: null }] }],
    }],
  });
  const pattern = /\/api\/codex\/(?:review\/|git-diff-to-remote)/;
  const handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postDataJSON() || {};
    const repo = body.repoId || url.searchParams.get("repoId");
    const view = body.workspaceView || url.searchParams.get("workspaceView") || "unstaged";
    const kind = url.pathname.split("/").pop();
    requests.push({ kind, repo, view, body });
    const fail = failSnapshot && kind === "snapshot";
    await gates.get(key(kind, repo, view));
    let data = snapshot(repo, view, url.searchParams.get("scope") || "workspace", url.searchParams.get("baseBranch") || "main");
    if (kind === "pr-context") data = { available: true, reason: "", ghInstalled: true, authenticated: true, pr: { number: repo === "sample-app" ? 101 : 202, headRefName: repo, baseRefName: "main" } };
    const result = kind === "git-diff-to-remote" ? { diff: `${repo} remote diff` } : { data };
    await route.fulfill({ status: fail ? 503 : 200, contentType: "application/json", body: JSON.stringify(fail ? { error: "模拟变更读取失败" } : result) });
  };
  await page.route(pattern, handler);
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => {
    confirmations.push(dialog.message());
    return confirmRevert ? dialog.accept() : dialog.dismiss();
  });
  const composer = page.locator(".composer-shell textarea");
  const panel = page.locator(".review-panel");
  const currentFile = panel.locator(".review-file-head strong");
  const open = async (command) => {
    await waitUntil(() => composer.isEnabled());
    await composer.fill(`/${command}`);
    await composer.press("Enter");
  };
  const navigate = async (repo) => {
    await page.evaluate((repo) => { location.hash = `/project/${repo}/thread/${repo}-1`; }, repo);
    await page.locator(`.session-current[data-session-id="${repo}-1"]`).waitFor();
    await waitUntil(() => composer.isEnabled());
  };
  const fileIs = async (value) => waitUntil(async () => await currentFile.count() === 1 && await currentFile.textContent() === value);
  const actions = () => requests.filter((request) => request.kind === "action");
  try {
    await page.goto(`${baseUrl}#/project/sample-app/thread/sample-app-1`);
    await open("review");
    await fileIs("sample-app-unstaged.txt");
    await waitUntil(() => requests.some((request) => request.kind === "pr-context"));
    await page.waitForTimeout(900);
    assert.equal(requests.filter((request) => request.kind === "snapshot").length, 1, "打开面板不应重复读取快照");
    assert.equal(requests.filter((request) => request.kind === "stream").length, 0, "查看变更不能自动调用模型");

    const releaseStaged = hold("snapshot", "sample-app", "staged");
    await panel.getByRole("button", { name: "已暂存", exact: true }).click();
    await waitUntil(() => requests.some((request) => request.kind === "snapshot" && request.view === "staged"));
    assert.equal(await currentFile.count(), 0, "切换视图不能暂时沿用旧快照");
    const releaseUnstaged = hold("snapshot");
    await panel.getByRole("button", { name: "未暂存", exact: true }).click();
    await waitUntil(() => requests.filter((request) => request.kind === "snapshot" && request.view === "unstaged").length === 2);
    releaseStaged();
    await page.waitForTimeout(200);
    assert.equal(await panel.getByRole("button", { name: "刷新", exact: true }).isDisabled(), true, "旧请求结束不能清除新请求的加载状态");
    assert.equal(await panel.getByRole("button", { name: /^(暂存|取消暂存|还原)(全部|文件|hunk)$/ }).count(), 0);
    releaseUnstaged();
    await fileIs("sample-app-unstaged.txt");

    const releaseRefresh = hold("snapshot");
    failSnapshot = true;
    await panel.getByRole("button", { name: "刷新", exact: true }).click();
    await waitUntil(() => requests.filter((request) => request.kind === "snapshot" && request.view === "unstaged").length === 3);
    assert.equal(await panel.getByRole("button", { name: "还原全部", exact: true }).count(), 0);
    releaseRefresh();
    await panel.getByText("模拟变更读取失败", { exact: true }).waitFor();
    assert.equal(await currentFile.count(), 0, "读取失败后不能保留可操作的过期补丁");
    failSnapshot = false;
    await panel.getByRole("button", { name: "刷新", exact: true }).click();
    await fileIs("sample-app-unstaged.txt");

    await panel.getByRole("button", { name: "Base 分支", exact: true }).click();
    await fileIs("sample-app-main.txt");
    await panel.locator("select").selectOption("develop");
    await fileIs("sample-app-develop.txt");
    assert.equal(await panel.getByRole("button", { name: "还原全部", exact: true }).count(), 0);
    await panel.getByRole("button", { name: "工作区", exact: true }).click();
    await fileIs("sample-app-unstaged.txt");
    for (const name of ["还原全部", "还原文件", "还原hunk"]) {
      await panel.getByRole("button", { name, exact: true }).click();
    }
    assert.equal(confirmations.length, 3);
    assert(confirmations.every((message) => message.includes("sample-app") && message.includes("修改将丢失")));
    assert(confirmations[0].includes("未跟踪的文件和目录也会被删除"));
    assert.equal(actions().length, 0, "取消确认不得提交任何还原请求");
    await page.screenshot({ path: new URL("desktop-review-safety.png", out).pathname, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: new URL("mobile-review-safety.png", out).pathname, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    const releaseAction = hold("action");
    const releasePr = hold("pr-context");
    const prReads = requests.filter((request) => request.kind === "pr-context").length;
    await panel.getByRole("button", { name: "刷新 PR", exact: true }).click();
    await waitUntil(() => requests.filter((request) => request.kind === "pr-context").length === prReads + 1);
    confirmRevert = true;
    await panel.getByRole("button", { name: "还原全部", exact: true }).click();
    await waitUntil(() => actions().length === 1);
    await panel.getByRole("button", { name: "还原全部", exact: true }).dispatchEvent("click");
    assert.equal(await panel.getByRole("button", { name: "已暂存", exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole("button", { name: "刷新", exact: true }).isDisabled(), true);
    assert.equal(actions().length, 1);
    await navigate("sample-service");
    assert.equal(await panel.count(), 0, "跨项目关闭旧项目的操作面板");
    await open("review");
    await fileIs("sample-service-unstaged.txt");
    await panel.getByText(/PR #202/).waitFor();
    releaseAction();
    releasePr();
    await page.waitForTimeout(300);
    await fileIs("sample-service-unstaged.txt");
    assert.equal(await panel.getByText(/PR #101/).count(), 0);
    await panel.getByText(/PR #202/).waitFor();

    await navigate("sample-app");
    const releaseDiff = hold("git-diff-to-remote");
    await open("diff");
    await waitUntil(() => requests.some((request) => request.kind === "git-diff-to-remote" && request.repo === "sample-app"));
    await navigate("sample-service");
    await open("diff");
    await page.locator(".diff-panel pre").getByText("sample-service remote diff", { exact: true }).waitFor();
    releaseDiff();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".diff-panel pre").textContent(), "sample-service remote diff");
    assert.equal(requests.filter((request) => request.kind === "stream").length, 0);
    return ["打开 Review 不调用模型且不重复请求", "变更视图隔离迟到响应及加载状态", "刷新期间和失败后禁止应用旧补丁", "Base 分支对比只读", "三种还原粒度均需确认且取消不提交", "操作提交防重复且锁定当前视图", "跨项目隔离操作结果与 PR 状态", "远端 diff 不串项目", "Review 桌面与移动端无横向溢出"];
  } finally {
    releases.forEach((release) => release());
    await page.unroute(pattern, handler);
    page.removeAllListeners("dialog");
    page.on("dialog", (dialog) => dialog.accept());
  }
}
