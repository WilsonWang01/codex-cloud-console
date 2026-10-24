import { Check, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Fact = { id: string; label: string; value: string; source: string; revision: number; createdAt: string; updatedAt: string; enabled?: boolean; expiresAt?: string | null; confirmedAt?: string | null; origin?: { type?: string } };
type Candidate = { id: string; label: string; value: string; reason: string; expiresAt: string | null; revision: number; status: "pending" | "accepted" | "rejected"; createdAt: string; origin: { sessionId: string; turnId: string } };
type FactsResponse = { facts: Fact[]; candidates?: Candidate[]; governanceVersion?: number };
const localDate = (value?: string | null) => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";

async function factsRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { statusCode: response.status });
  return data;
}

export default function PersonalFacts() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reviewing, setReviewing] = useState<Candidate | null>(null);
  const [candidateConflict, setCandidateConflict] = useState(false);
  const [deleting, setDeleting] = useState<Candidate | null>(null);
  const deletion = useRef<HTMLDialogElement>(null);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [expiresAt, setExpiresAt] = useState("");
  const [governance, setGovernance] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [editing, setEditing] = useState<Fact | null>(null);
  const [conflict, setConflict] = useState<Fact | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    void factsRequest<FactsResponse>("/api/personal/facts").then((result) => { if (mounted) { setFacts(Array.isArray(result.facts) ? result.facts : []); setCandidates(result.candidates || []); setGovernance(result.governanceVersion === 1); } }).catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : "读取失败"); }).finally(() => { if (mounted) setLoading(false); });
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { if (deleting) deletion.current?.showModal(); else deletion.current?.close(); }, [deleting]);
  const clearEditor = () => { setLabel(""); setValue(""); setEnabled(true); setExpiresAt(""); setEditing(null); setReviewing(null); setCandidateConflict(false); setConflict(undefined); };
  const edit = (fact: Fact) => { setReviewing(null); setCandidateConflict(false); setEditing(fact); setLabel(fact.label); setValue(fact.value); setEnabled(fact.enabled !== false); setExpiresAt(localDate(fact.expiresAt)); setConflict(undefined); setError(""); };
  const review = (candidate: Candidate) => { setEditing(null); setReviewing(candidate); setCandidateConflict(false); setLabel(candidate.label); setValue(candidate.value); setEnabled(true); setExpiresAt(localDate(candidate.expiresAt)); setConflict(undefined); setError(""); };
  const refresh = async () => {
    const result = await factsRequest<FactsResponse>("/api/personal/facts");
    setFacts(result.facts);
    setCandidates(result.candidates || []);
    setGovernance(result.governanceVersion === 1);
    return result.facts;
  };
  const decide = async (candidate: Candidate, decision: "accept" | "reject") => {
    if (busy || loading || candidateConflict) return;
    setBusy(true); setError("");
    try {
      const result = await factsRequest<{ candidate: Candidate; fact: Fact | null }>(`/api/personal/memory-candidates/${encodeURIComponent(candidate.id)}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: candidate.revision, decision,
          ...(decision === "accept" ? { label, value, enabled, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null } : {}) }),
      });
      setCandidates(current => current.map(item => item.id === candidate.id ? result.candidate : item));
      if (result.fact) setFacts(current => [...current, result.fact!]);
      if (reviewing?.id === candidate.id) clearEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "核对失败");
      if ([404, 409, 428].includes((cause as { statusCode?: number }).statusCode || 0)) {
        if (reviewing?.id === candidate.id) setCandidateConflict(true);
        try { await refresh(); } catch { setError("候选状态未能核对，输入已保留，请稍后刷新。"); }
      }
    } finally { setBusy(false); }
  };
  const removeCandidate = async () => {
    if (!deleting || busy) return;
    const candidate = deleting; setDeleting(null); setBusy(true); setError("");
    try {
      await factsRequest(`/api/personal/memory-candidates/${encodeURIComponent(candidate.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: candidate.revision }) });
      setCandidates(current => current.filter(item => item.id !== candidate.id));
      if (reviewing?.id === candidate.id) clearEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "清理失败");
      try { await refresh(); } catch { /* Keep the last known list; no mutation retry. */ }
    } finally { setBusy(false); }
  };
  const reload = async () => {
    if (busy || loading) return;
    setBusy(true); setError("");
    try { await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (busy || loading || conflict !== undefined || !label.trim() || !value.trim()) return;
    if (reviewing) { await decide(reviewing, "accept"); return; }
    setBusy(true); setError("");
    try {
      const result = await factsRequest<{ fact: Fact }>(editing ? `/api/personal/facts/${encodeURIComponent(editing.id)}` : "/api/personal/facts", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label, value, revision: editing?.revision,
          ...(governance ? { enabled, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null } : {}) }),
      });
      setFacts((current) => editing ? current.map((fact) => fact.id === editing.id ? result.fact : fact) : [...current, result.fact]);
      clearEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
      if (editing && [404, 409, 428].includes((cause as { statusCode?: number }).statusCode || 0)) {
        try { setConflict((await refresh()).find((fact) => fact.id === editing.id) || null); }
        catch { setError("无法读取最新事实，你的输入已保留，请稍后再试。"); }
      }
    }
    finally { setBusy(false); }
  };
  const remove = async (fact: Fact) => {
    if (busy || loading || !window.confirm(`删除个人事实「${fact.label}」？后续新任务不再读取；旧对话历史不会自动抹除。`)) return;
    setBusy(true); setError("");
    try {
      await factsRequest(`/api/personal/facts/${encodeURIComponent(fact.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: fact.revision }) });
      setFacts((current) => current.filter((item) => item.id !== fact.id));
      if (editing?.id === fact.id) clearEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
      if ([404, 409, 428].includes((cause as { statusCode?: number }).statusCode || 0)) {
        try { await refresh(); }
        catch { setError("未删除事实，最新内容读取失败，请稍后重试。"); }
      }
    }
    finally { setBusy(false); }
  };
  return <div className="personal-facts">
    <div className="personal-facts-header"><p>由你填写并确认。{governance ? "停用、到期或更正后，含旧资料的会话需开启新上下文；旧历史和已开始的任务不会被抹除。" : "供后续个人任务参考；已有对话可能保留旧内容。"}</p><button type="button" aria-label="刷新个人事实" title="刷新个人事实" disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={16} /></button></div>
    {loading && <p role="status">正在读取个人事实…</p>}
    {error && <p className="warn-text" role="alert">{error}</p>}
    {candidates.length > 0 && <section className="personal-memory-candidates" aria-label="记忆候选">
      <h3>待确认记忆 <small>{candidates.filter(item => item.status === "pending").length}</small></h3>
      {candidates.filter(item => item.status === "pending").map(candidate => <div className="personal-memory-candidate" key={candidate.id}>
        <strong>{candidate.label}</strong><p>{candidate.value}</p><small>{candidate.reason}</small>
        <a href={`#/project/_personal/thread/${encodeURIComponent(candidate.origin.sessionId)}`}>来源对话 · {new Date(candidate.createdAt).toLocaleString()}</a>
        <small>尚未记住{candidate.expiresAt ? ` · 建议有效至 ${new Date(candidate.expiresAt).toLocaleString()}` : ""}</small>
        <div><button type="button" disabled={busy || Boolean(label || value || editing || reviewing)} onClick={() => review(candidate)}><Pencil size={16} />核对 {candidate.label}</button><button type="button" disabled={busy || candidateConflict} onClick={() => void decide(candidate, "reject")}><X size={16} />不记住 {candidate.label}</button></div>
      </div>)}
      {candidates.some(item => item.status !== "pending") && <details><summary>已处理记录</summary>{candidates.filter(item => item.status !== "pending").map(candidate => <div className="personal-fact-row" key={candidate.id}>
        <span><strong>{candidate.label}</strong><small>{candidate.status === "accepted" ? "已接受，当前内容见个人事实" : "已拒绝，不供后续任务使用"}</small></span>
        <button type="button" aria-label={`清理候选 ${candidate.label}`} title="清理候选记录，不删除已接受事实" disabled={busy} onClick={() => setDeleting(candidate)}><Trash2 size={16} /></button>
      </div>)}</details>}
    </section>}
    <div className="personal-fact-list">{facts.map((fact) => <div className="personal-fact-row" key={fact.id}><span><strong>{fact.label}</strong><small>{fact.value}</small>
      <small>{fact.source === "user" ? fact.origin?.type === "model-candidate" ? "助理建议，你已确认" : "你主动填写" : "来源未确认"} · {fact.confirmedAt ? `确认于 ${new Date(fact.confirmedAt).toLocaleString()}` : "旧版未记录确认时间"}</small>
      {governance && <small>{fact.enabled === false ? "已停用" : fact.expiresAt && Date.parse(fact.expiresAt) <= now ? "已到期" : fact.source === "user" ? "启用中" : "未启用"} · {fact.expiresAt ? `有效至 ${new Date(fact.expiresAt).toLocaleString()}` : "长期有效"}</small>}
    </span><button type="button" aria-label={`编辑 ${fact.label}`} title="编辑" disabled={busy} onClick={() => edit(fact)}><Pencil size={16} /></button><button type="button" aria-label={`删除 ${fact.label}`} title="删除" disabled={busy} onClick={() => void remove(fact)}><Trash2 size={16} /></button></div>)}</div>
    <div className="personal-fact-editor">{reviewing && <strong>核对记忆：{reviewing.label}</strong>}<input aria-label="事实名称" placeholder="例如：称呼" maxLength={80} disabled={busy} value={label} onChange={(event) => setLabel(event.target.value)} /><textarea aria-label="事实内容" placeholder="只填写愿意让个人助理在后续任务中使用的信息" maxLength={300} rows={2} disabled={busy} value={value} onChange={(event) => setValue(event.target.value)} />
      {governance && <fieldset className="personal-fact-settings" disabled={busy}><legend>使用范围</legend>
        <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />在后续个人任务中使用</label>
        <label><input type="checkbox" checked={Boolean(expiresAt)} onChange={(event) => setExpiresAt(event.target.checked ? localDate(new Date(Date.now() + 86400_000).toISOString()) : "")} />设置有效期</label>
        {expiresAt && <label className="personal-fact-expiry">到期时间（本机时区）<input type="datetime-local" aria-label="事实到期时间" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>}
      </fieldset>}
      {conflict !== undefined && <section className="personal-fact-conflict" aria-label="个人事实冲突">
        <strong>{conflict ? "其他页面已更新这条事实" : "这条事实已被删除"}</strong>
        {conflict && <p>最新内容：{conflict.label} · {conflict.value}</p>}
        <p>你的输入仍保留，尚未保存。</p>
        <div>{conflict ? <><button type="button" onClick={() => { setEditing(conflict); setConflict(undefined); setError(""); }}>保留我的修改继续编辑</button><button type="button" onClick={() => edit(conflict)}>使用最新内容</button></> : <button type="button" onClick={() => { setEditing(null); setConflict(undefined); setError(""); }}>转为新事实草稿</button>}</div>
      </section>}
      {candidateConflict && <p role="alert">这条候选状态已变化。你的输入仍保留，尚未接受；请核对已处理记录后取消此次核对。</p>}
      <div><button type="button" disabled={busy || loading || conflict !== undefined || candidateConflict || !label.trim() || !value.trim()} onClick={() => void save()}>{reviewing ? <Check size={16} /> : editing ? <Save size={16} /> : <Plus size={16} />}{reviewing ? "接受并记住" : editing ? "保存修改" : "添加事实"}</button>{(editing || reviewing || label || value) && <button type="button" disabled={busy} onClick={clearEditor}>{reviewing ? "取消核对" : editing ? "取消编辑" : "清空输入"}</button>}</div>
    </div>
    <dialog ref={deletion} className="personal-context-dialog" aria-label="清理记忆候选记录" onClose={() => setDeleting(null)} onCancel={() => setDeleting(null)}>
      <h3>清理候选记录？</h3><p>只删除「{deleting?.label}」的建议记录，不删除已接受的个人事实、原对话或历史。</p>
      <div><button type="button" className="mini-action" autoFocus onClick={() => setDeleting(null)}>取消</button><button type="button" className="mini-action" onClick={() => void removeCandidate()}><Trash2 size={16} />确认清理</button></div>
    </dialog>
  </div>;
}
