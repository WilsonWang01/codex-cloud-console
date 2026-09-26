import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

type Fact = { id: string; label: string; value: string; source: "user"; createdAt: string; updatedAt: string };

async function factsRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export default function PersonalFacts() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    void factsRequest<{ facts: Fact[] }>("/api/personal/facts").then((result) => { if (mounted) setFacts(Array.isArray(result.facts) ? result.facts : []); }).catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : "读取失败"); }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  const save = async () => {
    if (busy || !label.trim() || !value.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await factsRequest<{ fact: Fact }>(editing ? `/api/personal/facts/${encodeURIComponent(editing)}` : "/api/personal/facts", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label, value }),
      });
      setFacts((current) => editing ? current.map((fact) => fact.id === editing ? result.fact : fact) : [...current, result.fact]);
      setLabel(""); setValue(""); setEditing("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  };
  const remove = async (fact: Fact) => {
    if (busy || !window.confirm(`删除个人事实「${fact.label}」？后续新任务不再读取；旧对话历史不会自动抹除。`)) return;
    setBusy(true); setError("");
    try {
      await factsRequest(`/api/personal/facts/${encodeURIComponent(fact.id)}`, { method: "DELETE" });
      setFacts((current) => current.filter((item) => item.id !== fact.id));
      if (editing === fact.id) { setLabel(""); setValue(""); setEditing(""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); }
    finally { setBusy(false); }
  };
  return <div className="personal-facts">
    <p>只记录你主动填写的偏好和事实，供后续个人任务参考；已有对话可能保留旧内容。</p>
    {loading && <p role="status">正在读取个人事实…</p>}
    {error && <p className="warn-text" role="alert">{error}</p>}
    <div className="personal-fact-list">{facts.map((fact) => <div className="personal-fact-row" key={fact.id}><span><strong>{fact.label}</strong><small>{fact.value}</small><small>你添加 · {new Date(fact.updatedAt).toLocaleString()}</small></span><button type="button" aria-label={`编辑 ${fact.label}`} title="编辑" disabled={busy} onClick={() => { setEditing(fact.id); setLabel(fact.label); setValue(fact.value); }}><Pencil size={16} /></button><button type="button" aria-label={`删除 ${fact.label}`} title="删除" disabled={busy} onClick={() => void remove(fact)}><Trash2 size={16} /></button></div>)}</div>
    <div className="personal-fact-editor"><input aria-label="事实名称" placeholder="例如：称呼" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} /><textarea aria-label="事实内容" placeholder="只填写愿意让个人助理在后续任务中使用的信息" maxLength={300} rows={2} value={value} onChange={(event) => setValue(event.target.value)} /><div><button type="button" disabled={busy || !label.trim() || !value.trim()} onClick={() => void save()}><Plus size={16} />{editing ? "保存修改" : "添加事实"}</button>{editing && <button type="button" onClick={() => { setEditing(""); setLabel(""); setValue(""); }}>取消编辑</button>}</div></div>
  </div>;
}
