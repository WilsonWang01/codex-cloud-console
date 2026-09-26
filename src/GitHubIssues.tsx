import { CheckCircle2, Copy, ExternalLink, GitBranch, GitPullRequestArrow, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Connection = {
  ghInstalled: boolean;
  authenticated: boolean;
  account: string | null;
  repo: { slug: string; url: string; permission?: string; defaultBranch?: string } | null;
  accessible: boolean;
  issuesEnabled?: boolean;
  archived?: boolean;
  reason: string;
};
type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  updatedAt: string;
  author: string;
  labels: string[];
  comments: Array<{ author: string; body: string; createdAt: string }>;
};
type PublishPreview = {
  previewId?: string;
  existingPr?: { url: string; state: string };
  slug?: string;
  branch?: string;
  baseBranch?: string;
  headSha?: string;
  remoteSha?: string;
  commitCount?: number;
  commits?: string[];
  changedFileCount?: number;
  changedFiles?: string[];
  title?: string;
  body?: string;
  expiresAt?: string;
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function dateLabel(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "" : time.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export default function GitHubIssues({ repoId, onPrepare }: { repoId: string; onPrepare: (number: number) => Promise<void> }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<Issue | null>(null);
  const [filter, setFilter] = useState<"open" | "closed">("open");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<"prepare" | "preview" | "publish" | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const publishBusyRef = useRef(false);
  publishBusyRef.current = busy === "publish";
  const previewOpen = Boolean(preview);

  useEffect(() => {
    if (!previewOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!publishBusyRef.current) setPreview(null);
        event.preventDefault();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [previewOpen]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ repoId, state: filter });
      const listed = await request<{ connection: Connection; issues: Issue[] }>(`/api/github/issues?${query}`, { signal });
      if (signal?.aborted) return;
      setConnection(listed.connection);
      setIssues(listed.issues);
      setSelectedNumber((current) => listed.issues.some((issue) => issue.number === current) ? current : listed.issues[0]?.number ?? null);
    } catch (failure) {
      if (signal?.aborted) return;
      try {
        const connected = await request<{ connection: Connection }>(`/api/github/connection?${new URLSearchParams({ repoId })}`, { signal });
        if (signal?.aborted) return;
        setConnection(connected.connection);
        setIssues([]);
        setSelectedNumber(null);
        setDetail(null);
        if (connected.connection.accessible && connected.connection.issuesEnabled) setError(failure instanceof Error ? failure.message : "无法读取 GitHub Issues");
      } catch (statusFailure) {
        if (!signal?.aborted) setError(statusFailure instanceof Error ? statusFailure.message : "无法核对 GitHub 连接");
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [filter, repoId]);

  useEffect(() => {
    const controller = new AbortController();
    setConnection(null);
    setIssues([]);
    setDetail(null);
    setPreview(null);
    setPublishedUrl("");
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!selectedNumber || !connection?.accessible) { setDetail(null); return; }
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    setPreview(null);
    setPublishedUrl("");
    const query = new URLSearchParams({ repoId });
    void request<{ issue: Issue }>(`/api/github/issues/${selectedNumber}?${query}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setDetail(result.issue); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取 Issue"); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [connection?.accessible, repoId, selectedNumber]);

  const prepare = async () => {
    if (!detail || busy) return;
    setBusy("prepare");
    setError("");
    try { await onPrepare(detail.number); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法建立 Issue 任务"); }
    finally { setBusy(null); }
  };

  const previewPublish = async () => {
    if (!detail || busy) return;
    setBusy("preview");
    setError("");
    setPublishedUrl("");
    try {
      const result = await request<{ preview: PublishPreview }>(`/api/github/issues/${detail.number}/publish-preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoId }),
      });
      setPreview(result.preview);
      setPublishConfirmed(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法准备 PR 发布预览"); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!preview?.previewId || !publishConfirmed || busy) return;
    setBusy("publish");
    setError("");
    try {
      const result = await request<{ published: { url?: string; existingPr?: { url: string } } }>("/api/github/publish", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoId, previewId: preview.previewId }),
      });
      setPublishedUrl(result.published.url || result.published.existingPr?.url || "");
      setPreview(null);
    } catch (failure) {
      setPreview(null);
      setError(failure instanceof Error ? failure.message : "发布失败，请重新预览远端状态");
    } finally { setBusy(null); }
  };

  const setupCommand = "gh auth login --web --hostname github.com\ngh auth setup-git --hostname github.com";
  return <div className="github-page">
    <header className="github-page-head">
      <div><span className="github-eyebrow">工作项目</span><h1>GitHub Issues</h1><p>从 Issue 建立独立开发任务；发布分支和 PR 前逐项核对。</p></div>
      <button type="button" className="mini-action" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? "spin" : undefined} />刷新</button>
    </header>

    <div className="github-connection">
      {loading && !connection ? <span role="status"><Loader2 size={16} className="spin" />正在核对 GitHub 连接…</span> : connection?.authenticated ? <span><CheckCircle2 size={16} />GitHub CLI 已登录{connection.account ? ` · @${connection.account}` : ""}</span> : <span>GitHub CLI 未连接</span>}
      {connection?.repo && <a href={connection.repo.url} target="_blank" rel="noopener noreferrer">{connection.repo.slug}<ExternalLink size={14} /></a>}
      {connection?.repo?.permission && <small>{connection.repo.permission} 权限</small>}
    </div>
    {error && <p className="github-error" role="alert">{error}</p>}

    {!loading && connection && (!connection.accessible || !connection.issuesEnabled) && <section className="github-setup">
      <h2>{connection.issuesEnabled === false ? "此仓库尚未启用 Issues" : "连接 GitHub 账号"}</h2>
      <p>{connection.reason || "当前仓库的 Issues 不可用。"}</p>
      {!connection.authenticated && <><p>请在 EC2 上以运行控制台的系统用户执行以下命令。网页不会接收或保存 GitHub token；Codex 内的 GitHub App 连接与主机 Git 凭据是两回事。</p><div className="github-setup-command"><code>{setupCommand}</code><button type="button" title="复制命令" aria-label="复制 GitHub 登录命令" onClick={() => void navigator.clipboard.writeText(setupCommand).catch(() => setError("复制失败，请手动选择命令"))}><Copy size={16} /></button></div></>}
    </section>}

    {connection?.accessible && connection.issuesEnabled && <div className="github-columns">
      <section className="github-issue-list" aria-label="Issue 列表">
        <div className="github-list-head"><h2>Issues <small>{issues.length}</small></h2><div className="github-filter" role="group" aria-label="Issue 状态"><button type="button" className={filter === "open" ? "selected" : ""} onClick={() => setFilter("open")}>开放</button><button type="button" className={filter === "closed" ? "selected" : ""} onClick={() => setFilter("closed")}>已关闭</button></div></div>
        {loading ? <p className="github-muted" role="status">正在读取 Issues…</p> : issues.length === 0 ? <p className="github-muted">当前没有{filter === "open" ? "开放" : "已关闭"}的 Issue。</p> : <div className="github-issue-rows">{issues.map((issue) => <button type="button" key={issue.number} className={`github-issue-row${selectedNumber === issue.number ? " selected" : ""}`} onClick={() => setSelectedNumber(issue.number)}><strong>#{issue.number} {issue.title}</strong><span>{issue.author ? `@${issue.author}` : ""}{issue.updatedAt ? ` · ${dateLabel(issue.updatedAt)}` : ""}</span>{issue.labels.length > 0 && <span className="github-labels">{issue.labels.slice(0, 3).map((label) => <em key={label}>{label}</em>)}</span>}</button>)}</div>}
      </section>
      <section className="github-issue-detail" aria-label="Issue 详情">
        {detailLoading ? <p className="github-muted" role="status">正在读取 Issue…</p> : !detail ? <p className="github-muted">选择一个 Issue 查看详情。</p> : <>
          <div className="github-detail-head"><span>#{detail.number} · {detail.state === "OPEN" ? "开放" : "已关闭"}</span><a href={detail.url} target="_blank" rel="noopener noreferrer" title="在 GitHub 打开"><ExternalLink size={17} /><span>GitHub</span></a></div>
          <h2>{detail.title}</h2>
          <div className="github-detail-meta">{detail.author ? `@${detail.author}` : "未知作者"}{detail.updatedAt ? ` · 更新于 ${dateLabel(detail.updatedAt)}` : ""}</div>
          <div className="github-issue-body">{detail.body || "Issue 没有正文。"}</div>
          {detail.comments.length > 0 && <div className="github-comments"><h3>最近评论</h3>{detail.comments.map((comment, index) => <div className="github-comment" key={`${comment.createdAt}-${index}`}><strong>{comment.author || "未知作者"}</strong><span>{dateLabel(comment.createdAt)}</span><p>{comment.body}</p></div>)}</div>}
          <div className="github-actions"><button type="button" className="primary-command" disabled={Boolean(busy)} onClick={() => void prepare()}>{busy === "prepare" ? <Loader2 size={16} className="spin" /> : <GitBranch size={16} />}建立开发任务</button><button type="button" className="mini-action" disabled={Boolean(busy) || detail.state !== "OPEN" || connection.archived} onClick={() => void previewPublish()}>{busy === "preview" ? <Loader2 size={16} className="spin" /> : <GitPullRequestArrow size={16} />}预览发布 PR</button></div>
          <p className="github-action-note">建立任务只生成本地草稿，不调用模型；发送草稿后才开始开发。发布 PR 需要干净的 codex/issue-{detail.number} 分支和本地提交。</p>
          {publishedUrl && <p className="github-published"><CheckCircle2 size={16} />已发布 <a href={publishedUrl} target="_blank" rel="noopener noreferrer">查看 PR <ExternalLink size={14} /></a></p>}
        </>}
      </section>
    </div>}

    {preview && <div className="github-modal-backdrop"><section ref={dialogRef} className="github-publish-modal" role="dialog" aria-modal="true" aria-label="确认发布 GitHub PR">
      <div className="github-modal-head"><h2>{preview.existingPr ? "已有 PR" : "确认发布 PR"}</h2><button type="button" className="mini-action" disabled={busy === "publish"} onClick={() => setPreview(null)}>关闭</button></div>
      {preview.existingPr ? <p>这个分支已有 PR：<a href={preview.existingPr.url} target="_blank" rel="noopener noreferrer">查看 {preview.existingPr.state || "PR"}<ExternalLink size={14} /></a></p> : <>
        <dl><dt>仓库</dt><dd>{preview.slug}</dd><dt>分支</dt><dd>{preview.branch} → {preview.baseBranch}</dd><dt>提交</dt><dd><code>{preview.headSha?.slice(0, 12)}</code> · {preview.commitCount} 个领先提交</dd><dt>动作</dt><dd>{preview.remoteSha ? "远端分支提交一致，只创建 PR" : "推送新分支并创建 PR"}</dd><dt>标题</dt><dd>{preview.title}</dd></dl>
        <div className="github-publish-changes"><strong>待发布提交</strong>{preview.commits?.length ? <ul>{preview.commits.map((commit, index) => <li key={`${index}-${commit}`}>{commit}</li>)}</ul> : <p>未取得提交摘要，请到 Review 核对。</p>}<strong>改动文件 · {preview.changedFileCount ?? 0}</strong>{preview.changedFiles?.length ? <ul>{preview.changedFiles.map((file) => <li key={file}>{file}</li>)}</ul> : <p>未取得文件清单，请到 Review 核对。</p>}</div>
        <p className="github-publish-warning">推送可能触发 GitHub Actions、消耗 CI 额度；PR 描述包含关闭 Issue 的关联语句，合并时可能自动关闭该 Issue。请先在 Review 中检查代码与测试结果。</p>
        <label className="github-confirm"><input type="checkbox" checked={publishConfirmed} onChange={(event) => setPublishConfirmed(event.target.checked)} />我已核对当前分支、提交、Issue 与可能的费用</label>
        <div className="github-modal-actions"><button type="button" className="mini-action" disabled={busy === "publish"} onClick={() => setPreview(null)}>取消</button><button type="button" className="primary-command" disabled={!publishConfirmed || Boolean(busy)} onClick={() => void publish()}>{busy === "publish" ? <Loader2 size={16} className="spin" /> : <GitPullRequestArrow size={16} />}确认发布</button></div>
      </>}
    </section></div>}
  </div>;
}
