import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Copy, Download, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { Automation } from "./types";

type Client = { id: string; name: string; tokenPrefix: string; automationIds: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null };
type RequestBucket = { hour: string; clientId: string; requests: number; accepted: number; errors: number; replayed: number; polls?: number; pollErrors?: number; controls?: number };
type RunBucket = { hour: string; clientId: string; runs: number; completed: number; failed: number; knownRuns: number; unknownRuns: number; inputTokens: number; outputTokens: number; totalTokens: number };
type RequestRow = { id: string; clientId: string; automationId: string; trigger: string; status: number; runId: string | null; deduplicated: boolean; durationMs: number; time: string };
type RunRow = { id: string; clientId: string; automationId: string; status: string; startedAt: string; finishedAt: string | null; model: string | null; reasoning: string | null; usage: { status: "complete" | "unknown"; inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number | null } };
type Usage = { buckets: RequestBucket[]; runBuckets: RunBucket[]; requests: RequestRow[]; runs?: RunRow[]; droppedRequests: number };
const emptyUsage: Usage = { buckets: [], runBuckets: [], requests: [], runs: [], droppedRequests: 0 };

function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function queryStart(rangeDays: number) {
  const now = new Date();
  if (rangeDays === 1) return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - rangeDays + 1).toISOString();
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export default function UsageView({ automations, onOpenRun }: { automations: Automation[]; onOpenRun?: (automationId: string, runId: string) => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [usage, setUsage] = useState<Usage>(emptyUsage);
  const [rangeDays, setRangeDays] = useState(7);
  const [clientId, setClientId] = useState("");
  const [chartMode, setChartMode] = useState<"requests" | "polls" | "tokens">("requests");
  const [newName, setNewName] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>([]);
  const [createdToken, setCreatedToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadedFilter, setLoadedFilter] = useState("");
  const [loadedAt, setLoadedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const requestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const filterKey = `${rangeDays}:${clientId}`;
  const visibleUsage = loadedFilter === filterKey ? usage : emptyUsage;
  const hasCurrentData = loadedFilter === filterKey;

  const refresh = useCallback(async () => {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const id = (requestRef.current?.id || 0) + 1;
    requestRef.current = { id, controller };
    setLoading(true);
    setError("");
    try {
      const [clientResult, usageResult] = await Promise.all([
        request<{ clients: Client[] }>("/api/clients", { signal: controller.signal }),
        request<Usage>(`/api/clients/usage?from=${encodeURIComponent(queryStart(rangeDays))}&clientId=${encodeURIComponent(clientId)}`, { signal: controller.signal }),
      ]);
      if (requestRef.current?.id !== id || controller.signal.aborted) return;
      setClients(clientResult.clients);
      setUsage(usageResult);
      setLoadedFilter(`${rangeDays}:${clientId}`);
      setLoadedAt(new Date().toISOString());
      setError("");
    } catch (cause) {
      if (requestRef.current?.id === id && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "调用数据加载失败");
    } finally {
      if (requestRef.current?.id === id && !controller.signal.aborted) setLoading(false);
    }
  }, [clientId, rangeDays]);

  useEffect(() => {
    void refresh();
    return () => requestRef.current?.controller.abort();
  }, [refresh]);

  const createClient = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await request<{ token: string }>("/api/clients", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, automationIds: newScopes }),
      });
      setCreatedToken(result.token);
      setNewName("");
      setNewScopes([]);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建失败"); }
    finally { setBusy(false); }
  };

  const revokeClient = async (client: Client) => {
    if (busy || !window.confirm(`撤销「${client.name}」的令牌？后续新请求将被拒绝，已启动的任务不会停止。`)) return;
    setBusy(true);
    try {
      await request(`/api/clients/${encodeURIComponent(client.id)}/revoke`, { method: "POST" });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "撤销失败"); }
    finally { setBusy(false); }
  };

  const chart = useMemo(() => {
    const values = new Map<string, { requests: number; polls: number; tokens: number }>();
    const keyFor = (hour: string) => rangeDays === 1 ? hour : localDay(new Date(hour));
    for (const row of visibleUsage.buckets) {
      const key = keyFor(row.hour);
      const value = values.get(key) || { requests: 0, polls: 0, tokens: 0 };
      value.requests += row.requests;
      value.polls += row.polls || 0;
      values.set(key, value);
    }
    for (const row of visibleUsage.runBuckets) {
      const key = keyFor(row.hour);
      const value = values.get(key) || { requests: 0, polls: 0, tokens: 0 };
      value.tokens += row.totalTokens;
      values.set(key, value);
    }
    const count = rangeDays === 1 ? 25 : rangeDays;
    return Array.from({ length: count }, (_, index) => {
      const now = new Date();
      const date = rangeDays === 1
        ? new Date(now.getTime() - (count - index - 1) * 3_600_000)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - index - 1));
      const key = rangeDays === 1 ? date.toISOString().slice(0, 13) + ":00:00Z" : localDay(date);
      return {
        key,
        label: rangeDays === 1 ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", hour12: false }) : key.slice(5),
        fullLabel: rangeDays === 1 ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", hour12: false, timeZoneName: "short" }) : key,
        ...(values.get(key) || { requests: 0, polls: 0, tokens: 0 }),
      };
    });
  }, [rangeDays, visibleUsage.buckets, visibleUsage.runBuckets]);

  const peak = Math.max(1, ...chart.map((point) => point[chartMode]));
  const totalRequests = visibleUsage.buckets.reduce((sum, row) => sum + row.requests, 0);
  const accepted = visibleUsage.buckets.reduce((sum, row) => sum + row.accepted, 0);
  const errors = visibleUsage.buckets.reduce((sum, row) => sum + row.errors, 0);
  const polls = visibleUsage.buckets.reduce((sum, row) => sum + (row.polls || 0), 0);
  const controls = visibleUsage.buckets.reduce((sum, row) => sum + (row.controls || 0), 0);
  const totalTokens = visibleUsage.runBuckets.reduce((sum, row) => sum + row.totalTokens, 0);
  const knownRuns = visibleUsage.runBuckets.reduce((sum, row) => sum + row.knownRuns, 0);
  const unknownRuns = visibleUsage.runBuckets.reduce((sum, row) => sum + row.unknownRuns, 0);
  const metric = (value: number) => hasCurrentData ? value.toLocaleString() : "--";
  const runsById = new Map((visibleUsage.runs || []).map((run) => [run.id, run]));

  const exportUsage = () => {
    if (!hasCurrentData) return;
    const blob = new Blob([JSON.stringify({ rangeDays, clientId: clientId || null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...visibleUsage }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `codex-api-usage-${localDay(new Date())}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="usage-view">
      <header className="usage-header">
        <div><p className="eyebrow">API</p><h1>调用与用量</h1></div>
        <div className="usage-header-actions"><button type="button" className="icon-button" onClick={exportUsage} disabled={!hasCurrentData} title="导出 JSON" aria-label="导出用量 JSON"><Download size={18} /></button><button type="button" className="icon-button" onClick={() => void refresh()} title="刷新" aria-label="刷新用量"><RefreshCw size={18} /></button></div>
      </header>
      {error && <p className="usage-error" role="alert">{error}</p>}
      {loading && <p className="usage-note" role="status">正在更新调用数据…</p>}
      {hasCurrentData && <p className="usage-note">{error ? "当前显示上次成功数据；" : ""}更新于 {new Date(loadedAt).toLocaleString()}；按本机时区 {Intl.DateTimeFormat().resolvedOptions().timeZone} 显示。Token 仅覆盖已计量的外部任务。</p>}
      <div className="usage-filters">
        <div className="usage-segmented" role="group" aria-label="时间范围">
          {[1, 7, 30].map((days) => <button type="button" key={days} className={rangeDays === days ? "selected" : ""} onClick={() => setRangeDays(days)}>{days === 1 ? "24 小时" : `${days} 天`}</button>)}
        </div>
        <select aria-label="筛选调用方" value={clientId} onChange={(event) => setClientId(event.target.value)}>
          <option value="">全部调用方</option>
          <option value="legacy-shared">旧共享令牌</option>
          {clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}
        </select>
      </div>
      <div className="usage-summary" aria-label="用量摘要">
        <div><span>请求</span><strong>{metric(totalRequests)}</strong></div>
        <div><span>接受任务</span><strong>{metric(accepted)}</strong></div>
        <div><span>请求错误</span><strong>{metric(errors)}</strong></div>
        <div><span>结果查询</span><strong>{metric(polls)}</strong></div>
        <div><span>取消请求</span><strong>{metric(controls)}</strong></div>
        <div><span>已知 token</span><strong>{metric(totalTokens)}</strong>{hasCurrentData && <small>{unknownRuns ? `${unknownRuns} 次运行用量未知` : `${knownRuns} 次运行已计量`}</small>}</div>
      </div>
      <section className="usage-section" aria-label="调用曲线">
        <div className="usage-section-head"><h2>趋势</h2><div className="usage-segmented" role="group" aria-label="曲线指标"><button type="button" className={chartMode === "requests" ? "selected" : ""} onClick={() => setChartMode("requests")}>请求</button><button type="button" className={chartMode === "polls" ? "selected" : ""} onClick={() => setChartMode("polls")}>查询</button><button type="button" className={chartMode === "tokens" ? "selected" : ""} onClick={() => setChartMode("tokens")}>Token</button></div></div>
        {hasCurrentData ? <div className="usage-chart" role="img" aria-label={`${chartMode === "requests" ? "请求" : chartMode === "polls" ? "查询" : "Token"} 趋势`}>{chart.map((point) => <div className="usage-chart-column" key={point.key} title={`${point.fullLabel}: ${point[chartMode].toLocaleString()}`}><div className="usage-chart-bar" style={{ height: `${Math.max(point[chartMode] ? 5 : 1, point[chartMode] / peak * 100)}%` }} /><small>{point.label}</small></div>)}</div> : <p className="usage-empty">{loading ? "正在加载趋势…" : "所选范围暂时无法显示趋势。"}</p>}
        {hasCurrentData && <details className="usage-chart-data"><summary>查看分时数据</summary><div><table><thead><tr><th scope="col">时间</th><th scope="col">请求</th><th scope="col">查询</th><th scope="col">Token</th></tr></thead><tbody>{chart.map((point) => <tr key={point.key}><th scope="row">{point.fullLabel}</th><td>{point.requests.toLocaleString()}</td><td>{point.polls.toLocaleString()}</td><td>{point.tokens.toLocaleString()}</td></tr>)}</tbody></table></div></details>}
        {visibleUsage.droppedRequests > 0 && <p className="usage-note">有 {visibleUsage.droppedRequests} 条损坏的请求明细未计入，曲线可能不完整。</p>}
        {unknownRuns > 0 && <p className="usage-note">Token 仅统计 {knownRuns} 次有完整单轮快照的运行；未知用量未计入，不代表零消耗。</p>}
      </section>
      <section className="usage-section" aria-label="调用方">
        <div className="usage-section-head"><h2>调用方</h2><ShieldCheck size={18} /></div>
        <div className="usage-client-list">{clients.map((client) => <div className="usage-client" key={client.id}><div><strong>{client.name}</strong><span>{client.revokedAt ? "已撤销" : "启用"} · {client.tokenPrefix}… · {client.automationIds.join("、")}</span><small>最近调用 {client.lastUsedAt ? new Date(client.lastUsedAt).toLocaleString() : "无"}</small></div>{!client.revokedAt && <button type="button" className="icon-button" title="撤销令牌" aria-label={`撤销 ${client.name}`} disabled={busy} onClick={() => void revokeClient(client)}><Trash2 size={17} /></button>}</div>)}</div>
        {!clients.length && <p className="usage-empty">尚无独立调用方。旧共享令牌仍可按现有配置使用。</p>}
        <div className="usage-create"><input aria-label="调用方名称" placeholder="服务名称" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={80} /><div className="usage-scopes">{automations.map((automation) => <label key={automation.id}><input type="checkbox" checked={newScopes.includes(automation.id)} onChange={(event) => setNewScopes((current) => event.target.checked ? [...current, automation.id] : current.filter((id) => id !== automation.id))} />{automation.name}</label>)}</div><button type="button" disabled={busy || !newName.trim() || !newScopes.length} onClick={() => void createClient()}><Plus size={16} />创建令牌</button></div>
        {createdToken && <div className="usage-token" role="status"><strong>新令牌仅显示一次</strong><code>{createdToken}</code><button type="button" onClick={() => void navigator.clipboard.writeText(createdToken)} aria-label="复制新令牌"><Copy size={16} /></button><button type="button" onClick={() => setCreatedToken("")}>关闭</button></div>}
      </section>
      <section className="usage-section" aria-label="请求明细"><div className="usage-section-head"><h2>最近请求</h2><Activity size={18} /></div><div className="usage-requests">{visibleUsage.requests.map((row) => {
        const run = row.runId ? runsById.get(row.runId) : null;
        return <details className="usage-request" key={row.id}><summary><time>{new Date(row.time).toLocaleString()}</time><strong>{clients.find((client) => client.id === row.clientId)?.name || (row.clientId === "legacy-shared" ? "旧共享令牌" : row.clientId)}</strong><span>{row.automationId} · {row.trigger === "result" ? "结果查询" : row.trigger === "cancel" ? "取消" : row.trigger}</span><span>{row.status}{row.deduplicated ? " · 重放" : ""}</span><small>{row.runId || "未接受任务"}</small></summary><div className="usage-request-expanded"><span>请求 ID <code>{row.id}</code></span><span>耗时 {row.durationMs} ms</span>{run ? <><span>任务 {run.status} · {run.model || "模型未知"} / {run.reasoning || "推理未知"}</span><span>Token {run.usage.status === "complete" ? `${run.usage.totalTokens}（输入 ${run.usage.inputTokens}，输出 ${run.usage.outputTokens}）` : "未知，未计为零"}</span>{onOpenRun && <button type="button" className="mini-action" onClick={() => onOpenRun(run.automationId, run.id)}>打开任务</button>}</> : row.runId ? <span>任务明细超出当前保留范围</span> : <span>本次请求未接受任务</span>}</div></details>;
      })}</div>{hasCurrentData && !visibleUsage.requests.length && <p className="usage-empty">所选范围暂无请求。</p>}</section>
    </div>
  );
}
