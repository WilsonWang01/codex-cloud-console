import { Check, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

export type PersonalCommitment = {
  id: string;
  title: string;
  nextStep: string;
  dueAt: string | null;
  status: "active" | "done";
  sessionId: string | null;
  source: "user";
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

const pendingLinksKey = "codex-cloud:personal-commitment-pending-links";

function restorePendingLinks(): Record<string, string> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingLinksKey) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).slice(0, 100).filter(([id, sessionId]) =>
      id.length > 0 && id.length <= 128 && typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 128)) as Record<string, string>;
  } catch { return {}; }
}

function persistPendingLinks(links: Record<string, string>) {
  try { sessionStorage.setItem(pendingLinksKey, JSON.stringify(links)); }
  catch { /* Storage can be unavailable; in-page retry still works. */ }
  return links;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (url === "/api/personal/commitments" && response.status === 404) throw new Error("服务器尚未更新个人事项功能");
  const result = await response.json().catch(() => ({ error: response.status === 404 ? "服务器尚未更新个人事项功能" : "服务响应格式错误" })) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function localInputDate(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function dueLabel(iso: string | null) {
  if (!iso) return "未设时间";
  const date = new Date(iso);
  const prefix = date.getTime() < Date.now() ? "已到期" : date.toDateString() === new Date().toDateString() ? "今天" : "到期";
  return `${prefix} · ${date.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

export default function PersonalCommitments({ sessions, onStart, onContinue, onDueCountChange }: {
  sessions: Array<{ id: string; isDraft?: boolean; messageCount?: number }>;
  onStart: (item: PersonalCommitment) => Promise<string | null>;
  onContinue: (sessionId: string) => void;
  onDueCountChange: (count: number) => void;
}) {
  const [items, setItems] = useState<PersonalCommitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingLinks, setPendingLinks] = useState<Record<string, string>>(restorePendingLinks);

  const clearPendingLink = (id: string) => {
    const remaining = { ...pendingLinks };
    delete remaining[id];
    setPendingLinks(persistPendingLinks(remaining));
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setUnavailable(false);
    void request<{ commitments: PersonalCommitment[] }>("/api/personal/commitments", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setItems(Array.isArray(result.commitments) ? result.commitments : []); })
      .catch((cause) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "读取失败"); setUnavailable(cause instanceof Error && cause.message === "服务器尚未更新个人事项功能"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);

  const resetEditor = () => { setEditing(null); setTitle(""); setNextStep(""); setDueAt(""); };
  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy("save"); setError("");
    const current = items.find((item) => item.id === editing);
    try {
      const payload = { title, nextStep, dueAt: dueAt ? new Date(dueAt).toISOString() : null, ...(current ? { revision: current.revision } : {}) };
      const result = await request<{ commitment: PersonalCommitment }>(current ? `/api/personal/commitments/${encodeURIComponent(current.id)}` : "/api/personal/commitments", {
        method: current ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      setItems((previous) => current ? previous.map((item) => item.id === current.id ? result.commitment : item) : [...previous, result.commitment]);
      resetEditor();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(""); }
  };
  const changeStatus = async (item: PersonalCommitment) => {
    if (busy) return;
    setBusy(item.id); setError("");
    try {
      const result = await request<{ commitment: PersonalCommitment }>(`/api/personal/commitments/${encodeURIComponent(item.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: item.revision, status: item.status === "active" ? "done" : "active" }),
      });
      setItems((previous) => previous.map((entry) => entry.id === item.id ? result.commitment : entry));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新失败"); }
    finally { setBusy(""); }
  };
  const remove = async (item: PersonalCommitment) => {
    if (busy || !window.confirm(`删除「${item.title}」？后续个人对话不再读取它；已有对话不会自动抹除。`)) return;
    setBusy(item.id); setError("");
    try {
      await request(`/api/personal/commitments/${encodeURIComponent(item.id)}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: item.revision }),
      });
      setItems((previous) => previous.filter((entry) => entry.id !== item.id));
      clearPendingLink(item.id);
      if (editing === item.id) resetEditor();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); }
    finally { setBusy(""); }
  };
  const start = async (item: PersonalCommitment) => {
    if (busy) return;
    setBusy(item.id); setError("");
    let startedSessionId: string | null = pendingLinks[item.id] || null;
    const retryingMissingLink = Boolean(startedSessionId && !sessions.some((session) => session.id === startedSessionId));
    try {
      if (!startedSessionId) startedSessionId = await onStart(item);
      if (!startedSessionId) { setError("新对话未创建，请稍后重试"); return; }
      setPendingLinks(persistPendingLinks({ ...pendingLinks, [item.id]: startedSessionId }));
      const result = await request<{ commitment: PersonalCommitment }>(`/api/personal/commitments/${encodeURIComponent(item.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: item.revision, sessionId: startedSessionId }),
      });
      setItems((previous) => previous.map((entry) => entry.id === item.id ? result.commitment : entry));
      clearPendingLink(item.id);
      onContinue(startedSessionId);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "个人对话不存在" && retryingMissingLink) {
        clearPendingLink(item.id);
        setError("原对话已不存在，已清除关联记录；请再次点击“起草”创建新对话。");
      } else {
        setError(`${cause instanceof Error ? cause.message : "操作失败"}${startedSessionId ? "；对话已建立，重试将沿用该对话" : ""}`);
      }
    }
    finally { setBusy(""); }
  };

  const active = items.filter((item) => item.status === "active").sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const dueCount = active.filter((item) => item.dueAt && Date.parse(item.dueAt) <= endOfToday.getTime()).length;
  useEffect(() => { if (!loading) onDueCountChange(error ? 0 : dueCount); }, [dueCount, error, loading, onDueCountChange]);
  const completed = items.filter((item) => item.status === "done").sort((a, b) => Date.parse(b.completedAt || "") - Date.parse(a.completedAt || ""));
  const visible = showAll ? active : active.slice(0, 5);
  return <section className="personal-list-section personal-commitments" aria-label="个人关注事项">
    <div className="personal-section-heading"><h2>关注事项 {active.length > 0 && <small>{active.length}</small>}</h2><div className="personal-section-actions"><button type="button" aria-label="刷新关注事项" title="刷新关注事项" disabled={Boolean(busy) || loading} onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={16} /></button><button type="button" className="mini-action" disabled={Boolean(busy) || loading || unavailable} onClick={() => { resetEditor(); setEditing(""); }}><Plus size={16} />添加</button></div></div>
    {loading && <p className="personal-empty" role="status">正在读取关注事项…</p>}
    {error && <p className="warn-text" role="alert">{error}</p>}
    {!loading && !error && !active.length && editing === null && <p className="personal-empty">暂无关注事项。</p>}
    {visible.map((item) => {
      const linkedSession = sessions.find((session) => session.id === item.sessionId);
      return <div className="personal-commitment-row" key={item.id}>
        <span className="personal-commitment-copy"><strong>{item.title}</strong>{item.nextStep && <small>{item.nextStep}</small>}<small>{dueLabel(item.dueAt)}{linkedSession?.isDraft ? " · 对话草稿未发送" : ""}</small></span>
        <div className="personal-commitment-actions">
          <button type="button" className="mini-action" disabled={Boolean(busy)} onClick={() => linkedSession ? onContinue(linkedSession.id) : void start(item)}>{linkedSession ? linkedSession.isDraft ? "继续草稿" : "继续" : pendingLinks[item.id] ? "重试关联" : "起草"}</button>
          <button type="button" title="标记完成" aria-label={`完成 ${item.title}`} disabled={Boolean(busy)} onClick={() => void changeStatus(item)}><Check size={17} /></button>
          <button type="button" title="编辑事项" aria-label={`编辑 ${item.title}`} disabled={Boolean(busy)} onClick={() => { setEditing(item.id); setTitle(item.title); setNextStep(item.nextStep); setDueAt(localInputDate(item.dueAt)); }}><Pencil size={16} /></button>
          <button type="button" title="删除事项" aria-label={`删除 ${item.title}`} disabled={Boolean(busy)} onClick={() => void remove(item)}><Trash2 size={16} /></button>
        </div>
      </div>;
    })}
    {active.length > 5 && <button type="button" className="personal-secondary-link" onClick={() => setShowAll((value) => !value)}>{showAll ? "收起" : `查看全部 ${active.length} 项`}</button>}
    {editing !== null && <div className="personal-commitment-editor">
      <input aria-label="事项名称" placeholder="想持续推进的事" maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea aria-label="下一步" placeholder="下一步（可选）" maxLength={300} rows={2} value={nextStep} onChange={(event) => setNextStep(event.target.value)} />
      <label>到期时间（可选）<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
      <small>未完成事项会供后续个人对话参考；起草后不会自动发送、提醒或执行。</small>
      <div><button type="button" disabled={!title.trim() || Boolean(busy)} onClick={() => void save()}>{editing ? "保存" : "添加事项"}</button><button type="button" onClick={resetEditor}>取消</button></div>
    </div>}
    {completed.length > 0 && <details className="personal-completed"><summary>已完成 {completed.length} 项</summary>{completed.map((item) => <div className="personal-commitment-row" key={item.id}><span className="personal-commitment-copy"><strong>{item.title}</strong><small>{item.completedAt ? new Date(item.completedAt).toLocaleString() : "已完成"}</small></span><div className="personal-commitment-actions"><button type="button" title="重新跟进" aria-label={`重新跟进 ${item.title}`} disabled={Boolean(busy)} onClick={() => void changeStatus(item)}><RotateCcw size={16} /></button><button type="button" title="删除事项" aria-label={`删除 ${item.title}`} disabled={Boolean(busy)} onClick={() => void remove(item)}><Trash2 size={16} /></button></div></div>)}</details>}
  </section>;
}
