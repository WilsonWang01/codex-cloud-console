import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Copy, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { Automation } from "./types";

type Client = { id: string; name: string; tokenPrefix: string; automationIds: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null };
type RequestBucket = { hour: string; clientId: string; requests: number; accepted: number; errors: number; replayed: number };
type RunBucket = { hour: string; clientId: string; runs: number; completed: number; failed: number; knownRuns: number; unknownRuns: number; inputTokens: number; outputTokens: number; totalTokens: number };
type RequestRow = { id: string; clientId: string; automationId: string; trigger: string; status: number; runId: string | null; deduplicated: boolean; durationMs: number; time: string };
type Usage = { buckets: RequestBucket[]; runBuckets: RunBucket[]; requests: RequestRow[]; droppedRequests: number };

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export default function UsageView({ automations }: { automations: Automation[] }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [usage, setUsage] = useState<Usage>({ buckets: [], runBuckets: [], requests: [], droppedRequests: 0 });
  const [rangeDays, setRangeDays] = useState(7);
  const [clientId, setClientId] = useState("");
  const [chartMode, setChartMode] = useState<"requests" | "tokens">("requests");
  const [newName, setNewName] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>([]);
  const [createdToken, setCreatedToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [clientResult, usageResult] = await Promise.all([
        request<{ clients: Client[] }>("/api/clients"),
        request<Usage>(`/api/clients/usage?from=${encodeURIComponent(new Date(Date.now() - rangeDays * 86_400_000).toISOString())}&clientId=${encodeURIComponent(clientId)}`),
      ]);
      setClients(clientResult.clients);
      setUsage(usageResult);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "调用数据加载失败"); }
  }, [clientId, rangeDays]);

  useEffect(() => { void refresh(); }, [refresh]);

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
    const values = new Map<string, { requests: number; tokens: number }>();
    const keyFor = (hour: string) => rangeDays === 1 ? hour : hour.slice(0, 10);
    for (const row of usage.buckets) {
      const key = keyFor(row.hour);
      const value = values.get(key) || { requests: 0, tokens: 0 };
      value.requests += row.requests;
      values.set(key, value);
    }
    for (const row of usage.runBuckets) {
      const key = keyFor(row.hour);
      const value = values.get(key) || { requests: 0, tokens: 0 };
      value.tokens += row.totalTokens;
      values.set(key, value);
    }
    const count = rangeDays === 1 ? 24 : rangeDays;
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.now() - (count - index - 1) * (rangeDays === 1 ? 3_600_000 : 86_400_000));
      const key = rangeDays === 1 ? date.toISOString().slice(0, 13) + ":00:00Z" : date.toISOString().slice(0, 10);
      return { key, label: rangeDays === 1 ? key.slice(11, 13) : key.slice(5), ...(values.get(key) || { requests: 0, tokens: 0 }) };
    });
  }, [rangeDays, usage.buckets, usage.runBuckets]);

  const peak = Math.max(1, ...chart.map((point) => point[chartMode]));
  const totalRequests = usage.buckets.reduce((sum, row) => sum + row.requests, 0);
  const accepted = usage.buckets.reduce((sum, row) => sum + row.accepted, 0);
  const errors = usage.buckets.reduce((sum, row) => sum + row.errors, 0);
  const totalTokens = usage.runBuckets.reduce((sum, row) => sum + row.totalTokens, 0);
  const knownRuns = usage.runBuckets.reduce((sum, row) => sum + row.knownRuns, 0);
  const unknownRuns = usage.runBuckets.reduce((sum, row) => sum + row.unknownRuns, 0);

  return (
    <div className="usage-view">
      <header className="usage-header">
        <div><p className="eyebrow">API</p><h1>调用与用量</h1></div>
        <button type="button" className="icon-button" onClick={() => void refresh()} title="刷新" aria-label="刷新用量"><RefreshCw size={18} /></button>
      </header>
      {error && <p className="usage-error" role="alert">{error}</p>}
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
        <div><span>请求</span><strong>{totalRequests.toLocaleString()}</strong></div>
        <div><span>接受任务</span><strong>{accepted.toLocaleString()}</strong></div>
        <div><span>请求错误</span><strong>{errors.toLocaleString()}</strong></div>
        <div><span>已知 token</span><strong>{totalTokens.toLocaleString()}</strong><small>{unknownRuns ? `${unknownRuns} 次运行用量未知` : `${knownRuns} 次运行已计量`}</small></div>
      </div>
      <section className="usage-section" aria-label="调用曲线">
        <div className="usage-section-head"><h2>趋势</h2><div className="usage-segmented" role="group" aria-label="曲线指标"><button type="button" className={chartMode === "requests" ? "selected" : ""} onClick={() => setChartMode("requests")}>请求</button><button type="button" className={chartMode === "tokens" ? "selected" : ""} onClick={() => setChartMode("tokens")}>Token</button></div></div>
        <div className="usage-chart" role="img" aria-label={`${chartMode === "requests" ? "请求" : "Token"} 趋势`}>{chart.map((point) => <div className="usage-chart-column" key={point.key} title={`${point.key}: ${point[chartMode].toLocaleString()}`}><div className="usage-chart-bar" style={{ height: `${Math.max(point[chartMode] ? 5 : 1, point[chartMode] / peak * 100)}%` }} /><small>{point.label}</small></div>)}</div>
        {usage.droppedRequests > 0 && <p className="usage-note">有 {usage.droppedRequests} 条损坏的请求明细未计入，曲线可能不完整。</p>}
        {unknownRuns > 0 && <p className="usage-note">Token 仅统计 {knownRuns} 次有完整单轮快照的运行；未知用量未计入，不代表零消耗。</p>}
      </section>
      <section className="usage-section" aria-label="调用方">
        <div className="usage-section-head"><h2>调用方</h2><ShieldCheck size={18} /></div>
        <div className="usage-client-list">{clients.map((client) => <div className="usage-client" key={client.id}><div><strong>{client.name}</strong><span>{client.revokedAt ? "已撤销" : "启用"} · {client.tokenPrefix}… · {client.automationIds.join("、")}</span><small>最近调用 {client.lastUsedAt ? new Date(client.lastUsedAt).toLocaleString() : "无"}</small></div>{!client.revokedAt && <button type="button" className="icon-button" title="撤销令牌" aria-label={`撤销 ${client.name}`} disabled={busy} onClick={() => void revokeClient(client)}><Trash2 size={17} /></button>}</div>)}</div>
        {!clients.length && <p className="usage-empty">尚无独立调用方。旧共享令牌仍可按现有配置使用。</p>}
        <div className="usage-create"><input aria-label="调用方名称" placeholder="服务名称" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={80} /><div className="usage-scopes">{automations.map((automation) => <label key={automation.id}><input type="checkbox" checked={newScopes.includes(automation.id)} onChange={(event) => setNewScopes((current) => event.target.checked ? [...current, automation.id] : current.filter((id) => id !== automation.id))} />{automation.name}</label>)}</div><button type="button" disabled={busy || !newName.trim() || !newScopes.length} onClick={() => void createClient()}><Plus size={16} />创建令牌</button></div>
        {createdToken && <div className="usage-token" role="status"><strong>新令牌仅显示一次</strong><code>{createdToken}</code><button type="button" onClick={() => void navigator.clipboard.writeText(createdToken)} aria-label="复制新令牌"><Copy size={16} /></button><button type="button" onClick={() => setCreatedToken("")}>关闭</button></div>}
      </section>
      <section className="usage-section" aria-label="请求明细"><div className="usage-section-head"><h2>最近请求</h2><Activity size={18} /></div><div className="usage-requests">{usage.requests.map((row) => <div className="usage-request" key={row.id}><time>{new Date(row.time).toLocaleString()}</time><strong>{clients.find((client) => client.id === row.clientId)?.name || (row.clientId === "legacy-shared" ? "旧共享令牌" : row.clientId)}</strong><span>{row.automationId}</span><span>{row.status}{row.deduplicated ? " · 重放" : ""}</span><small>{row.runId || "未接受任务"}</small></div>)}</div>{!usage.requests.length && <p className="usage-empty">所选范围暂无请求。</p>}</section>
    </div>
  );
}
