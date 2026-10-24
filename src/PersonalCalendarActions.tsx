import { CalendarPlus, Check, ExternalLink, Pause, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Form = { title: string; description: string; location: string; attendees: string[]; timeZone: string; allDay: boolean; startLocal: string; endLocal: string; startOffset?: number; endOffset?: number };
type Proposal = {
  id: string; revision: number; payload: { title: string; description: string; location: string; attendees: string[]; timeZone: string; allDay: boolean; start: string; end: string };
  target: { email: string }; status: string; attempted: boolean; error: string | null; eventId: string | null;
  preview: { digest: string; expiresAt: string; availability: { conflicts: Array<{ id: string; title: string; start: string; end: string; url: string | null }> } } | null;
  receipt: { url: string | null; checkedAt: string } | null; reconciliation: { note: string } | null;
};
type Editor = { id?: string; revision?: number; clientKey: string; form: Form };
const root = "/api/personal/calendar-proposals", editorKey = "codex-cloud:calendar-proposal-editor:v1";
const statusNames: Record<string, string> = { draft: "草稿 · 未执行", deferred: "已稍后处理", rejected: "已拒绝", executing: "执行中 · 请勿重复创建", succeeded: "已创建并核验", needs_reconciliation: "结果待核对 · 未自动重试", reconciled: "用户已核对 · 非系统成功回执" };
const empty = (): Editor => ({ clientKey: crypto.randomUUID(), form: { title: "", description: "", location: "", attendees: [], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", allDay: false, startLocal: "", endLocal: "" } });
function restored(): Editor | null {
  try {
    const raw = sessionStorage.getItem(editorKey); if (!raw || raw.length > 16_000) return null;
    const value = JSON.parse(raw) as Editor, form = value.form;
    return typeof value.clientKey === "string" && form && [form.title, form.description, form.location, form.timeZone, form.startLocal, form.endLocal].every(item => typeof item === "string") && typeof form.allDay === "boolean" && Array.isArray(form.attendees) && form.attendees.every(item => typeof item === "string") ? value : null;
  } catch { return null; }
}
function toForm(item: Proposal): Form {
  const parts = (value: string) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: item.payload.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  const wall = (value: string) => { const p = parts(value); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
  const offset = (value: string) => (Date.parse(wall(value) + ":00Z") - Date.parse(value)) / 60_000;
  const p = item.payload;
  return { title: p.title, description: p.description, location: p.location, attendees: p.attendees, timeZone: p.timeZone, allDay: p.allDay,
    startLocal: p.allDay ? p.start : wall(p.start), endLocal: p.allDay ? p.end : wall(p.end), ...(!p.allDay ? { startOffset: offset(p.start), endOffset: offset(p.end) } : {}) };
}
const when = (value: string, item: Proposal) => item.payload.allDay ? value : new Date(value).toLocaleString("zh-CN", { timeZone: item.payload.timeZone, dateStyle: "medium", timeStyle: "long", hour12: false });

async function request(route = "", method = "GET", body?: unknown) {
  let response: Response;
  try { response = await fetch(root + route, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(method === "GET" ? 15_000 : 130_000) }); }
  catch { throw new Error("连接中断或等待超时，后台可能仍在结束操作；请刷新核对，未自动重试。"); }
  const data = await response.json().catch(() => ({ error: "响应格式无法确认，请刷新核对；未自动重试" })) as { ok?: boolean; version?: number; proposals?: Proposal[]; proposal?: Proposal; error?: string; details?: { field: string; offsets: Array<{ minutes: number; label: string }> } };
  if (!response.ok || data.ok !== true) throw Object.assign(new Error(data.error || "日程操作结果未确认，请刷新核对"), { details: data.details });
  return data;
}

function Confirmation({ item, busy, clock, onConfirm }: { item: Proposal; busy: boolean; clock: number; onConfirm: (conflicts: boolean) => void }) {
  const [confirmed, setConfirmed] = useState(false), [conflicts, setConflicts] = useState(false);
  const expired = !item.preview || Date.parse(item.preview.expiresAt) <= clock;
  return <div className="calendar-action-confirm" role="region" aria-label={`确认日程 ${item.payload.title}`}>
    <strong>将写入 {item.target.email} 的主日历</strong>
    <p>{item.payload.title}<br />{when(item.payload.start, item)} 至 {when(item.payload.end, item)}{item.payload.allDay && "（结束日不含）"}<br />{item.payload.timeZone}</p>
    {item.payload.description && <p>{item.payload.description}</p>}{item.payload.location && <p>地点：{item.payload.location}</p>}
    <p>仅创建这一条，私密、占用时间，不设提醒、不生成 Meet 链接、不重复。</p>
    <p>{item.payload.attendees.length ? `参与者：${item.payload.attendees.join("、")}；可能收到日历邀请。` : "无其他参与者，不发送邀请。"}</p>
    <p>只核对了主日历，其他日历和临时安排未覆盖。</p>
    {item.preview?.availability.conflicts.length ? <><strong className="warn-text">此时段已有日程</strong><ul>{item.preview.availability.conflicts.map(event => <li key={event.id}>{event.title} · {when(event.start, item)} 至 {when(event.end, item)} {event.url && <a href={event.url} target="_blank" rel="noopener noreferrer" aria-label={`核对冲突 ${event.title}`}><ExternalLink size={16} /></a>}</li>)}</ul><label><input type="checkbox" checked={conflicts} disabled={busy || expired} onChange={e => setConflicts(e.target.checked)} />我已核对冲突，仍要创建</label></> : <p>本次核对未发现主日历冲突。</p>}
    {expired ? <p role="status" className="warn-text">核对已过期，请重新核对后确认。</p> : <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />我确认以上账号、内容和影响，允许创建这一条日程</label>}
    <button type="button" className="mini-action" disabled={busy || expired || !confirmed || Boolean(item.preview?.availability.conflicts.length && !conflicts)} onClick={() => onConfirm(conflicts)}><Check size={16} />确认并创建</button>
  </div>;
}

export default function PersonalCalendarActions() {
  const [items, setItems] = useState<Proposal[]>([]), [editor, setEditor] = useState<Editor | null>(restored), [error, setError] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [clock, setClock] = useState(Date.now);
  const [reviewing, setReviewing] = useState(""), [offsets, setOffsets] = useState<{ field: string; offsets: Array<{ minutes: number; label: string }> } | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const lock = useRef(false), mounted = useRef(true);
  const refresh = async () => { const data = await request(); if (!Array.isArray(data.proposals) || data.version !== 1) throw new Error("服务器尚不支持日程提案，请先更新服务器"); if (mounted.current) setItems(data.proposals); };
  useEffect(() => { mounted.current = true; void refresh().catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : "日程草稿读取失败"); }).finally(() => { if (mounted.current) setLoading(false); }); const timer = setInterval(() => setClock(Date.now()), 10_000); return () => { mounted.current = false; clearInterval(timer); }; }, []);
  useEffect(() => { try { if (editor) sessionStorage.setItem(editorKey, JSON.stringify(editor)); else sessionStorage.removeItem(editorKey); } catch { setError("浏览器未能保留本机输入，离开页面前请保存草稿。"); } }, [editor]);
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (cause) { if (mounted.current) { setError(cause instanceof Error ? cause.message : "结果未确认，请刷新核对；未自动重试"); setOffsets((cause as { details?: typeof offsets }).details || null); } }
    finally { lock.current = false; if (mounted.current) { setBusy(false); setClock(Date.now()); } }
  };
  const action = (item: Proposal, name: string, extra: object = {}) => run(async () => { const data = await request(`/${item.id}/${name}`, "POST", { revision: item.revision, ...extra }); if (data.proposal && mounted.current) { setItems(previous => previous.map(value => value.id === item.id ? data.proposal! : value)); if (name === "preview") setReviewing(item.id); } });
  const status = (item: Proposal, value: string) => run(async () => { await request(`/${item.id}`, "PATCH", { revision: item.revision, status: value }); await refresh(); });
  const formChange = (patch: Partial<Form>) => { if (editor) setEditor({ ...editor, form: { ...editor.form, ...patch } }); setOffsets(null); };
  const save = () => run(async () => { if (!editor) return; await request(editor.id ? `/${editor.id}` : "", editor.id ? "PATCH" : "POST", editor.id ? { revision: editor.revision, form: editor.form } : { clientKey: editor.clientKey, form: editor.form }); setEditor(null); setOffsets(null); await refresh(); });
  const remove = (item: Proposal) => { if (!window.confirm(`永久删除未执行草稿“${item.payload.title}”？不会删除原日历的日程。`)) return; void run(async () => { await request(`/${item.id}`, "DELETE", { revision: item.revision }); await refresh(); }); };
  const finished = items.filter(item => ["succeeded", "rejected", "reconciled"].includes(item.status));
  const rows = (entries: Proposal[]) => entries.map(item => <article className="calendar-action-row" key={item.id}>
    <div><strong>{item.payload.title}</strong><small>{statusNames[item.status] || "状态需核对"}</small><small>{when(item.payload.start, item)} 至 {when(item.payload.end, item)} · {item.payload.timeZone}</small><small>{item.target.email} · 主日历 · 来源：你填写的草稿</small></div>
    {item.error && <p className="warn-text" role="status">{item.error}</p>}
    {item.eventId && <small>原日程编号：<code>{item.eventId}</code></small>}
    {item.receipt && <p className="personal-brief-source">Google Calendar 读取回执 · 核验于 {new Date(item.receipt.checkedAt).toLocaleString("zh-CN")}</p>}
    <div className="personal-section-actions">
      {!item.attempted && <><button type="button" disabled={busy || loading || Boolean(editor)} title="编辑日程草稿" aria-label={`编辑日程 ${item.payload.title}`} onClick={() => { setEditor({ id: item.id, revision: item.revision, clientKey: crypto.randomUUID(), form: toForm(item) }); setReviewing(""); setOffsets(null); }}><Pencil size={16} /></button>
        {item.status === "draft" ? <><button type="button" className="mini-action" disabled={busy || loading || Boolean(editor)} onClick={() => void action(item, "preview")}><RefreshCw size={16} />核对并预览</button><button type="button" title="稍后处理" aria-label={`稍后处理日程 ${item.payload.title}`} disabled={busy} onClick={() => void status(item, "deferred")}><Pause size={16} /></button><button type="button" title="拒绝提案" aria-label={`拒绝日程 ${item.payload.title}`} disabled={busy} onClick={() => void status(item, "rejected")}><X size={16} /></button></> : <button type="button" className="mini-action" disabled={busy} onClick={() => void status(item, "draft")}><RotateCcw size={16} />恢复草稿</button>}
        <button type="button" className="mini-action" disabled={busy || Boolean(editor)} onClick={() => void action(item, "rebind")} title="只读核对当前账号并使旧确认失效">重新绑定账号</button>
        <button type="button" disabled={busy || Boolean(editor)} title="删除未执行草稿" aria-label={`删除日程草稿 ${item.payload.title}`} onClick={() => remove(item)}><Trash2 size={16} /></button></>}
      {item.receipt?.url && <a className="mini-action" href={item.receipt.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />原日程</a>}
      {item.status === "needs_reconciliation" && item.eventId && <button type="button" className="mini-action" disabled={busy} onClick={() => void action(item, "check")}><RefreshCw size={16} />只读核验回执</button>}
    </div>
    {reviewing === item.id && item.status === "draft" && item.preview && !editor && <Confirmation key={item.preview.digest} item={item} busy={busy} clock={clock} onConfirm={conflicts => void action(item, "execute", { digest: item.preview!.digest, confirm: true, confirmConflicts: conflicts })} />}
    {item.status === "needs_reconciliation" && <div className="calendar-action-reconcile"><label>原日历核对说明<input maxLength={300} value={note[item.id] || ""} onChange={e => setNote(previous => ({ ...previous, [item.id]: e.target.value }))} /></label><button type="button" className="mini-action" disabled={busy || !note[item.id]?.trim()} onClick={() => void action(item, "reconcile", { note: note[item.id] })}>我已在原日历核对</button><small>只记录你的核对，不重试创建，也不作为系统成功回执。</small></div>}
    {item.reconciliation && <p>你的核对：{item.reconciliation.note}</p>}
  </article>);
  return <section className="personal-list-section calendar-actions" aria-label="日程提案">
    <div className="personal-section-heading"><h2><CalendarPlus size={17} />日程提案 <small>{items.filter(item => !item.attempted && item.status === "draft").length}</small></h2><div className="personal-section-actions"><button type="button" aria-label="刷新日程提案" title="读取已保存的提案，不重试创建" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={16} /></button><button type="button" className="mini-action" disabled={busy || loading || Boolean(editor)} onClick={() => setEditor(empty())}><Plus size={16} />新增草稿</button></div></div>
    {error && <p className="warn-text" role="alert">{error}</p>}{busy && <p role="status">正在核对或保存，请勿重复操作。离开页面不会自动重试。</p>}
    {editor && <fieldset className="personal-commitment-editor" disabled={busy}><legend>{editor.id ? "编辑日程草稿" : "新日程草稿"} · 保存不会创建日程</legend>
      <label>日程标题<input value={editor.form.title} maxLength={200} onChange={e => formChange({ title: e.target.value })} /></label>
      <label className="calendar-action-checkbox"><input type="checkbox" checked={editor.form.allDay} onChange={e => formChange({ allDay: e.target.checked, startLocal: "", endLocal: "", startOffset: undefined, endOffset: undefined })} />全天</label>
      <div className="calendar-action-times"><label>开始<input type={editor.form.allDay ? "date" : "datetime-local"} value={editor.form.startLocal} onChange={e => formChange({ startLocal: e.target.value, startOffset: undefined })} /></label><label>{editor.form.allDay ? "结束（不含当天）" : "结束"}<input type={editor.form.allDay ? "date" : "datetime-local"} value={editor.form.endLocal} onChange={e => formChange({ endLocal: e.target.value, endOffset: undefined })} /></label></div>
      <label>时区<input value={editor.form.timeZone} maxLength={80} list="calendar-action-zones" onChange={e => formChange({ timeZone: e.target.value, startOffset: undefined, endOffset: undefined })} /><datalist id="calendar-action-zones">{["Asia/Shanghai", "Asia/Tokyo", "America/New_York", "Europe/London", "UTC"].map(zone => <option key={zone} value={zone} />)}</datalist></label>
      {offsets && <label>重复时间的 UTC 偏移<select value={String(editor.form[offsets.field as "startOffset" | "endOffset"] ?? "")} onChange={e => { if (e.target.value) formChange({ [offsets.field]: Number(e.target.value) }); }}><option value="">请选择</option>{offsets.offsets.map(value => <option key={value.minutes} value={value.minutes}>{value.label}</option>)}</select></label>}
      <label>地点<input value={editor.form.location} maxLength={300} onChange={e => formChange({ location: e.target.value })} /></label>
      <label>参与者邮箱（可空，用逗号分隔，最多 10 个）<input value={editor.form.attendees.join(",")} maxLength={2550} onChange={e => formChange({ attendees: e.target.value ? e.target.value.split(",") : [] })} /></label>
      <label>说明<textarea value={editor.form.description} maxLength={2000} rows={3} onChange={e => formChange({ description: e.target.value })} /></label>
      <div><button type="button" onClick={() => { setEditor(null); setOffsets(null); }}>取消</button><button type="button" disabled={!editor.form.title.trim() || !editor.form.startLocal || !editor.form.endLocal} onClick={() => void save()}>保存草稿</button></div>
    </fieldset>}
    {loading ? <p role="status">正在读取日程提案…</p> : items.length === 0 && !editor && <p className="personal-empty">暂无日程提案</p>}
    {rows(items.filter(item => !finished.includes(item)))}
    {finished.length > 0 && <details className="personal-completed"><summary>已处理 {finished.length}</summary>{rows(finished)}</details>}
  </section>;
}
