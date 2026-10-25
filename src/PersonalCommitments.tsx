import { Check, ChevronRight, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import PersonalCommitmentResults, { type PersonalReplySource } from "./PersonalCommitmentResults";

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
  waitingReason?: string;
  milestones?: Array<{ id: string; title: string; done: boolean }>;
  relatedSessionIds?: string[];
  resultReferences?: PersonalReplySource[];
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
  try {
    if (Object.keys(links).length) sessionStorage.setItem(pendingLinksKey, JSON.stringify(links));
    else sessionStorage.removeItem(pendingLinksKey);
  }
  catch { /* Keep legacy migration state in memory when storage is unavailable. */ }
  return links;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const deadline = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(url, { cache: "no-store", ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
    if (url === "/api/personal/commitments" && response.status === 404) throw new Error("服务器尚未更新个人事项功能");
    const result = await response.json().catch(cause => { if (deadline.aborted) throw cause; return { error: response.status === 404 ? "服务器尚未更新个人事项功能" : "服务响应格式错误，保存结果未确认" }; }) as T & { ok?: boolean; error?: string };
    if (!response.ok || result?.ok !== true) throw Object.assign(new Error(result?.error || `服务响应无效（HTTP ${response.status}）`), { statusCode: response.status });
    return result;
  } catch (cause) {
    if (deadline.aborted && !options.signal?.aborted) throw new Error("等待服务器超时，保存结果未确认；请刷新核对后再操作。");
    throw cause;
  }
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

export default function PersonalCommitments({ sessions, onStart, onContinue, onChooseTask, onDueCountChange }: {
  sessions: Array<{ id: string; title?: string; isDraft?: boolean; messageCount?: number }>;
  onStart: (item: PersonalCommitment, pendingSessionId?: string) => Promise<PersonalCommitment | null>;
  onContinue: (sessionId: string) => void;
  onChooseTask: (prompt: string) => void;
  onDueCountChange: (count: number) => void;
}) {
  const [items, setItems] = useState<PersonalCommitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [progressSupported, setProgressSupported] = useState(false);
  const [resultsSupported, setResultsSupported] = useState(false);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editBase, setEditBase] = useState<PersonalCommitment | null>(null);
  const [conflict, setConflict] = useState<PersonalCommitment | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [waitingReason, setWaitingReason] = useState("");
  const [milestones, setMilestones] = useState<Array<{ id?: string; title: string; done: boolean }>>([]);
  const [relatedSessionIds, setRelatedSessionIds] = useState<string[]>([]);
  const [sessionToLink, setSessionToLink] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingLinks, setPendingLinks] = useState<Record<string, string>>(restorePendingLinks);

  const clearPendingLink = (id: string) => {
    if (!pendingLinks[id]) return;
    const remaining = { ...pendingLinks };
    delete remaining[id];
    setPendingLinks(persistPendingLinks(remaining));
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setUnavailable(false);
    void request<{ commitments: PersonalCommitment[]; progressVersion?: number; resultsVersion?: number }>("/api/personal/commitments", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { if (!Array.isArray(result.commitments)) throw new Error("事项列表响应无效，未确认当前记录。"); setItems(result.commitments); setProgressSupported(result.progressVersion === 1); setResultsSupported(result.resultsVersion === 1); } })
      .catch((cause) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "读取失败"); setUnavailable(cause instanceof Error && cause.message === "服务器尚未更新个人事项功能"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);

  const resetEditor = () => { setEditing(null); setEditBase(null); setConflict(undefined); setTitle(""); setNextStep(""); setDueAt(""); setWaitingReason(""); setMilestones([]); setRelatedSessionIds([]); setSessionToLink(""); };
  const edit = (item: PersonalCommitment) => {
    setEditing(item.id); setEditBase(item); setConflict(undefined); setError(""); setTitle(item.title); setNextStep(item.nextStep); setDueAt(localInputDate(item.dueAt));
    setWaitingReason(item.waitingReason || ""); setMilestones(item.milestones || []); setRelatedSessionIds(item.relatedSessionIds || []); setSessionToLink("");
  };
  const save = async () => {
    if (!title.trim() || milestones.some(step => !step.title.trim()) || busy || loading || conflict !== undefined) return;
    setBusy("save"); setError("");
    const current = editBase;
    try {
      const payload = { title, nextStep, dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        ...(progressSupported ? { waitingReason, milestones,
          ...(!current || JSON.stringify(relatedSessionIds) !== JSON.stringify(current.relatedSessionIds || []) ? { relatedSessionIds } : {}) } : {}),
        ...(current ? { revision: current.revision } : {}) };
      const result = await request<{ commitment: PersonalCommitment }>(current ? `/api/personal/commitments/${encodeURIComponent(current.id)}` : "/api/personal/commitments", {
        method: current ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      setItems((previous) => current ? previous.map((item) => item.id === current.id ? result.commitment : item) : [...previous, result.commitment]);
      resetEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
      if (current && [404, 409].includes((cause as { statusCode?: number }).statusCode || 0)) {
        try { const result = await request<{ commitments: PersonalCommitment[] }>("/api/personal/commitments"); setItems(result.commitments); setConflict(result.commitments.find(item => item.id === current.id) || null); }
        catch { setError("最新事项读取失败，你的输入仍保留；请稍后重试。"); }
      }
    }
    finally { setBusy(""); }
  };
  const toggleStep = async (item: PersonalCommitment, id: string) => {
    if (busy || !progressSupported) return;
    setBusy(item.id); setError("");
    const updatedSteps = (item.milestones || []).map(step => ({ ...step, done: step.id === id ? !step.done : step.done }));
    setItems(previous => previous.map(entry => entry.id === item.id ? { ...entry, milestones: updatedSteps } : entry));
    try {
      const result = await request<{ commitment: PersonalCommitment }>(`/api/personal/commitments/${encodeURIComponent(item.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: item.revision, milestones: updatedSteps }),
      });
      setItems(previous => previous.map(entry => entry.id === item.id ? result.commitment : entry));
    } catch (cause) {
      setItems(previous => previous.map(entry => entry.id === item.id ? item : entry));
      setError(`${cause instanceof Error ? cause.message : "步骤更新失败"}；已还原显示，请刷新核对保存结果。`);
    }
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
    try {
      const commitment = await onStart(item, pendingLinks[item.id]);
      if (!commitment?.sessionId) { setError("草稿尚未打开，请重试；已创建的草稿会继续保留。"); return; }
      setItems((previous) => previous.map((entry) => entry.id === item.id ? commitment : entry));
      clearPendingLink(item.id);
      onContinue(commitment.sessionId);
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : "操作失败"}；重试会沿用已创建的草稿。`); }
    finally { setBusy(""); }
  };

  const active = items.filter((item) => item.status === "active").sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const dueCount = active.filter((item) => item.dueAt && Date.parse(item.dueAt) <= endOfToday.getTime()).length;
  useEffect(() => { if (!loading) onDueCountChange(error ? 0 : dueCount); }, [dueCount, error, loading, onDueCountChange]);
  const completed = items.filter((item) => item.status === "done").sort((a, b) => Date.parse(b.completedAt || "") - Date.parse(a.completedAt || ""));
  const visible = showAll ? active : active.slice(0, 5);
  const results = (item: PersonalCommitment) => resultsSupported ? <PersonalCommitmentResults item={item} sessions={sessions} disabled={Boolean(busy) || editing === item.id}
    onUpdated={updated => setItems(previous => previous.map(entry => entry.id === updated.id && updated.revision >= entry.revision ? updated : entry))} onContinue={onContinue} onChooseTask={onChooseTask} />
    : item.resultReferences?.length ? <p className="personal-empty">回复结果关联保留，当前服务器暂不能核对。</p> : null;
  const progress = (item: PersonalCommitment) => {
    const steps = item.milestones || [], links = [...new Set([item.sessionId, ...(item.relatedSessionIds || [])].filter((id): id is string => Boolean(id)))];
    return (steps.length > 0 || links.length > 0) && <details className="personal-commitment-progress">
      <summary>{steps.length ? `步骤 ${steps.filter(step => step.done).length}/${steps.length}` : "关联对话"}{links.length > 0 && ` · ${links.length} 个对话`}</summary>
      {steps.length > 0 && <ul>{steps.map(step => <li key={step.id}><label><input type="checkbox" aria-label={`完成步骤 ${step.title}`} checked={step.done} disabled={Boolean(busy) || !progressSupported || item.status === "done" || editing === item.id} onChange={() => void toggleStep(item, step.id)} /><span>{step.title}</span><small>{step.done ? "已完成" : "未完成"}</small></label></li>)}</ul>}
      {links.map(id => { const session = sessions.find(entry => entry.id === id); return session
        ? <button type="button" className="personal-commitment-source" key={id} onClick={() => onContinue(id)}><span>{session.title || "个人对话"}<small>{session.isDraft ? "未发送草稿" : `${session.messageCount || 0} 条消息 · 查看原对话与结果`}</small></span><ChevronRight size={16} /></button>
        : <p className="personal-empty" key={id}>关联对话暂不可用，关联记录仍保留。</p>; })}
      <small>用户记录 · 更新于 {new Date(item.updatedAt).toLocaleString()}</small>
      {busy === item.id && <small role="status">保存中…</small>}
    </details>;
  };
  return <section className="personal-list-section personal-commitments" aria-label="个人关注事项">
    <div className="personal-section-heading"><h2>关注事项 {active.length > 0 && <small>{active.length}</small>}</h2><div className="personal-section-actions"><button type="button" aria-label="刷新关注事项" title="刷新关注事项" disabled={Boolean(busy) || loading} onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={16} /></button><button type="button" className="mini-action" disabled={Boolean(busy) || loading || unavailable} onClick={() => { resetEditor(); setEditing(""); }}><Plus size={16} />添加</button></div></div>
    {loading && <p className="personal-empty" role="status">正在读取关注事项…</p>}
    {error && <p className="warn-text" role="alert">{error}</p>}
    {!loading && !error && !active.length && editing === null && <p className="personal-empty">暂无关注事项。</p>}
    {visible.map((item) => {
      const linkedSession = sessions.find((session) => session.id === item.sessionId);
      return <div className="personal-commitment-row" key={item.id}>
        <span className="personal-commitment-copy"><strong>{item.title}</strong>{item.nextStep && <small>下一步：{item.nextStep}</small>}{item.waitingReason && <small className="personal-commitment-waiting">等待：{item.waitingReason}</small>}<small>{dueLabel(item.dueAt)}{linkedSession?.isDraft ? " · 对话草稿未发送" : ""}</small></span>
        <div className="personal-commitment-actions">
          <button type="button" className="mini-action" disabled={Boolean(busy)} onClick={() => linkedSession ? onContinue(linkedSession.id) : void start(item)}>{linkedSession ? linkedSession.isDraft ? "继续草稿" : "继续" : pendingLinks[item.id] ? "重试关联" : "起草"}</button>
          <button type="button" title="标记完成" aria-label={`完成 ${item.title}`} disabled={Boolean(busy)} onClick={() => void changeStatus(item)}><Check size={17} /></button>
          <button type="button" title="编辑事项" aria-label={`编辑 ${item.title}`} disabled={Boolean(busy)} onClick={() => edit(item)}><Pencil size={16} /></button>
          <button type="button" title="删除事项" aria-label={`删除 ${item.title}`} disabled={Boolean(busy)} onClick={() => void remove(item)}><Trash2 size={16} /></button>
        </div>
        {progress(item)}
        {results(item)}
      </div>;
    })}
    {active.length > 5 && <button type="button" className="personal-secondary-link" onClick={() => setShowAll((value) => !value)}>{showAll ? "收起" : `查看全部 ${active.length} 项`}</button>}
    {editing !== null && <fieldset className="personal-commitment-editor" disabled={Boolean(busy)}>
      <input aria-label="事项名称" placeholder="想持续推进的事" maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea aria-label="下一步" placeholder="下一步（可选）" maxLength={300} rows={2} value={nextStep} onChange={(event) => setNextStep(event.target.value)} />
      {progressSupported && <><label>等待原因（可选）<textarea aria-label="等待原因" placeholder="例如：等家人确认出行日期" maxLength={300} rows={2} value={waitingReason} onChange={event => setWaitingReason(event.target.value)} /></label>
      <fieldset className="personal-commitment-steps"><legend>步骤（可选）</legend>
        {milestones.map((step, index) => <div key={step.id || `new-${index}`}><label className="personal-commitment-step-toggle"><input type="checkbox" aria-label={`步骤 ${index + 1} 已完成`} checked={step.done} onChange={event => setMilestones(current => current.map((entry, n) => n === index ? { ...entry, done: event.target.checked } : entry))} /></label><input aria-label={`步骤 ${index + 1} 名称`} maxLength={160} value={step.title} onChange={event => setMilestones(current => current.map((entry, n) => n === index ? { ...entry, title: event.target.value } : entry))} /><button type="button" title="移除步骤" aria-label={`移除步骤 ${index + 1}`} onClick={() => setMilestones(current => current.filter((_, n) => n !== index))}><X size={16} /></button></div>)}
        <button type="button" className="mini-action" disabled={milestones.length >= 12} onClick={() => setMilestones(current => [...current, { title: "", done: false }])}><Plus size={16} />添加步骤</button>
      </fieldset>
      <fieldset className="personal-commitment-links"><legend>关联个人对话</legend>
        {relatedSessionIds.map(id => <div key={id}><span>{sessions.find(session => session.id === id)?.title || "关联对话暂不可用"}</span><button type="button" title="移除关联" aria-label={`移除关联 ${sessions.find(session => session.id === id)?.title || id}`} onClick={() => setRelatedSessionIds(current => current.filter(entry => entry !== id))}><X size={16} /></button></div>)}
        <label>选择个人对话<select aria-label="选择关联个人对话" value={sessionToLink} onChange={event => setSessionToLink(event.target.value)}><option value="">请选择</option>{sessions.filter(session => session.id !== editBase?.sessionId && !relatedSessionIds.includes(session.id)).map(session => <option key={session.id} value={session.id}>{session.title || "个人对话"}{session.isDraft ? "（草稿）" : ""}</option>)}</select></label>
        <button type="button" className="mini-action" disabled={!sessionToLink || relatedSessionIds.length >= 8} onClick={() => { setRelatedSessionIds(current => [...current, sessionToLink]); setSessionToLink(""); }}><Plus size={16} />关联对话</button>
      </fieldset></>}
      <label>到期时间（可选）<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
      {!progressSupported && <small>服务器暂不支持步骤、等待原因与多段对话关联，请先更新服务器。</small>}
      <small>未完成事项会供后续个人对话参考；起草后不会自动发送、提醒或执行。</small>
      {conflict !== undefined && <section className="personal-fact-conflict" aria-label="个人事项冲突"><strong>{conflict ? "其他页面已更新这条事项" : "这条事项已被删除"}</strong>
        {conflict && <p>最新记录：{conflict.title} · 下一步：{conflict.nextStep || "未填写"} · 等待：{conflict.waitingReason || "无"} · 已完成 {(conflict.milestones || []).filter(step => step.done).length}/{conflict.milestones?.length || 0} 步</p>}
        {conflict && <><ul>{(conflict.milestones || []).map(step => <li key={step.id}>{step.done ? "已完成" : "未完成"} · {step.title}</li>)}</ul><p>{dueLabel(conflict.dueAt)} · 关联：{(conflict.relatedSessionIds || []).map(id => sessions.find(session => session.id === id)?.title || "暂不可用").join("、") || "无"}</p></>}
        <p>你的输入仍保留，尚未保存。</p><div>{conflict ? <><button type="button" onClick={() => { setEditBase(conflict); setMilestones(current => current.map(step => ({ ...step, id: conflict.milestones?.some(entry => entry.id === step.id) ? step.id : undefined }))); setConflict(undefined); setError(""); }}>保留我的修改继续编辑</button><button type="button" onClick={() => edit(conflict)}>使用最新内容</button></> : <button type="button" onClick={() => { setEditBase(null); setEditing(""); setMilestones(current => current.map(step => ({ title: step.title, done: step.done }))); setConflict(undefined); setError(""); }}>转为新事项草稿</button>}</div>
      </section>}
      <div><button type="button" disabled={!title.trim() || milestones.some(step => !step.title.trim()) || Boolean(busy) || loading || conflict !== undefined} onClick={() => void save()}>{editing ? "保存" : "添加事项"}</button><button type="button" disabled={Boolean(busy)} onClick={resetEditor}>取消</button></div>
    </fieldset>}
    {completed.length > 0 && <details className="personal-completed"><summary>已完成 {completed.length} 项</summary>{completed.map((item) => <div className="personal-commitment-row" key={item.id}><span className="personal-commitment-copy"><strong>{item.title}</strong><small>{item.completedAt ? new Date(item.completedAt).toLocaleString() : "已完成"}</small></span><div className="personal-commitment-actions"><button type="button" title="重新跟进" aria-label={`重新跟进 ${item.title}`} disabled={Boolean(busy)} onClick={() => void changeStatus(item)}><RotateCcw size={16} /></button><button type="button" title="编辑事项" aria-label={`编辑 ${item.title}`} disabled={Boolean(busy)} onClick={() => edit(item)}><Pencil size={16} /></button><button type="button" title="删除事项" aria-label={`删除 ${item.title}`} disabled={Boolean(busy)} onClick={() => void remove(item)}><Trash2 size={16} /></button></div>{progress(item)}{results(item)}</div>)}</details>}
  </section>;
}
