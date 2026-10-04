import { Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

type Fact = { id: string; label: string; value: string; source: "user"; revision: number; createdAt: string; updatedAt: string };

async function factsRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { statusCode: response.status });
  return data;
}

export default function PersonalFacts() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<Fact | null>(null);
  const [conflict, setConflict] = useState<Fact | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    void factsRequest<{ facts: Fact[] }>("/api/personal/facts").then((result) => { if (mounted) setFacts(Array.isArray(result.facts) ? result.facts : []); }).catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : "读取失败"); }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  const clearEditor = () => { setLabel(""); setValue(""); setEditing(null); setConflict(undefined); };
  const refresh = async () => {
    const result = await factsRequest<{ facts: Fact[] }>("/api/personal/facts");
    setFacts(result.facts);
    return result.facts;
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
    setBusy(true); setError("");
    try {
      const result = await factsRequest<{ fact: Fact }>(editing ? `/api/personal/facts/${encodeURIComponent(editing.id)}` : "/api/personal/facts", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label, value, revision: editing?.revision }),
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
    <div className="personal-facts-header"><p>只记录你主动填写的偏好和事实，供后续个人任务参考；已有对话可能保留旧内容。</p><button type="button" aria-label="刷新个人事实" title="刷新个人事实" disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={16} /></button></div>
    {loading && <p role="status">正在读取个人事实…</p>}
    {error && <p className="warn-text" role="alert">{error}</p>}
    <div className="personal-fact-list">{facts.map((fact) => <div className="personal-fact-row" key={fact.id}><span><strong>{fact.label}</strong><small>{fact.value}</small><small>你添加 · {new Date(fact.updatedAt).toLocaleString()}</small></span><button type="button" aria-label={`编辑 ${fact.label}`} title="编辑" disabled={busy} onClick={() => { setEditing(fact); setLabel(fact.label); setValue(fact.value); setConflict(undefined); setError(""); }}><Pencil size={16} /></button><button type="button" aria-label={`删除 ${fact.label}`} title="删除" disabled={busy} onClick={() => void remove(fact)}><Trash2 size={16} /></button></div>)}</div>
    <div className="personal-fact-editor"><input aria-label="事实名称" placeholder="例如：称呼" maxLength={80} disabled={busy} value={label} onChange={(event) => setLabel(event.target.value)} /><textarea aria-label="事实内容" placeholder="只填写愿意让个人助理在后续任务中使用的信息" maxLength={300} rows={2} disabled={busy} value={value} onChange={(event) => setValue(event.target.value)} />
      {conflict !== undefined && <section className="personal-fact-conflict" aria-label="个人事实冲突">
        <strong>{conflict ? "其他页面已更新这条事实" : "这条事实已被删除"}</strong>
        {conflict && <p>最新内容：{conflict.label} · {conflict.value}</p>}
        <p>你的输入仍保留，尚未保存。</p>
        <div>{conflict ? <><button type="button" onClick={() => { setEditing(conflict); setConflict(undefined); setError(""); }}>保留我的修改继续编辑</button><button type="button" onClick={() => { setEditing(conflict); setLabel(conflict.label); setValue(conflict.value); setConflict(undefined); setError(""); }}>使用最新内容</button></> : <button type="button" onClick={() => { setEditing(null); setConflict(undefined); setError(""); }}>转为新事实草稿</button>}</div>
      </section>}
      <div><button type="button" disabled={busy || loading || conflict !== undefined || !label.trim() || !value.trim()} onClick={() => void save()}>{editing ? <Save size={16} /> : <Plus size={16} />}{editing ? "保存修改" : "添加事实"}</button>{editing && <button type="button" disabled={busy} onClick={clearEditor}>取消编辑</button>}</div>
    </div>
  </div>;
}
