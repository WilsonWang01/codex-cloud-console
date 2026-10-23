import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check, Copy, Download, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import type { Automation } from "./types";

type Client = { id: string; name: string; tokenPrefix: string; automationIds: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; maxConcurrent?: number | null; dailyKnownTokenLimit?: number | null; policyRevision?: number };
type ClientLimits = { maxConcurrent: number; dailyBudgetTimezone: string; budgetMode: string };
type PolicyDraft = { maxConcurrent: string; dailyKnownTokenLimit: string; expiresAt: string };
type RequestBucket = { hour: string; clientId: string; requests: number; accepted: number; errors: number; replayed: number; polls?: number; pollErrors?: number; controls?: number; discovery?: number };
type RunBucket = { hour: string; clientId: string; runs: number; completed: number; failed: number; knownRuns: number; unknownRuns: number; inputTokens: number; outputTokens: number; totalTokens: number };
type RequestRow = { id: string; clientId: string; automationId: string; trigger: string; status: number; runId: string | null; deduplicated: boolean; durationMs: number | null; time: string };
type RunRow = { id: string; clientId: string; automationId: string; status: string; startedAt: string; finishedAt: string | null; model: string | null; reasoning: string | null; usage: { status: "complete" | "unknown"; inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number | null } };
type Duration = { samples: number; p50Ms: number | null; p95Ms: number | null };
type RequestSummary = { groups: { kind: string; requests: number; errors: number; accepted: number; replayed: number; duration: Duration }[]; errorTypes: { type: string; count: number }[] };
type RunSummary = { tasks: number; completed: number; failed: number; canceled: number; unresolved: number; active: number; unclassified: number; observedModelTurns: number; successRate: number | null; unknownUsageRate: number | null; queueWait: Duration; execution: Duration };
type Usage = { buckets: RequestBucket[]; runBuckets: RunBucket[]; requests: RequestRow[]; runs?: RunRow[]; droppedRequests: number; missingMetricFiles?: number; requestSummary?: RequestSummary; runSummary?: RunSummary; usageLedger?: { seededAt: string | null; retentionDays: number; timezone: string } };
const emptyUsage: Usage = { buckets: [], runBuckets: [], requests: [], runs: [], droppedRequests: 0 };
const requestLabels: Record<string, string> = { submit: "提交请求", discovery: "能力查询", poll: "结果查询", control: "取消请求" };
const errorLabels: Record<string, string> = { authorization: "权限拒绝", rate_limited: "频率受限", wait_ended: "等待超时或断开", conflict: "状态冲突", unavailable_object: "对象不可用", input_rejected: "输入拒绝", service_error: "服务错误" };
const runLabels: Record<string, string> = { completed: "已完成", failed: "明确失败", canceled: "已取消", cancelled: "已取消", interrupted: "中断待核对", needs_reconciliation: "待核对", queued: "排队中", running: "处理中", canceling: "取消中" };
const triggerLabels: Record<string, string> = { discovery: "能力查询", result: "结果查询", cancel: "取消请求", webhook: "新任务", heartbeat: "续接任务", "chat-completions": "OpenAI 对话", responses: "OpenAI Responses", messages: "Anthropic 消息", "image-generations": "图片生成" };
const durationText = (value: number | null | undefined) => value == null ? "--" : value < 1000 ? `${value.toLocaleString()} ms` : `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} 秒`;
const rateText = (value: number | null | undefined) => value == null ? "--" : `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const localDateInput = (value: string | null) => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
const policyDraft = (client?: Client): PolicyDraft => ({ maxConcurrent: client?.maxConcurrent?.toString() || "", dailyKnownTokenLimit: client?.dailyKnownTokenLimit?.toString() || "", expiresAt: localDateInput(client?.expiresAt || null) });
const policyPayload = (draft: PolicyDraft) => ({ maxConcurrent: draft.maxConcurrent ? Number(draft.maxConcurrent) : null, dailyKnownTokenLimit: draft.dailyKnownTokenLimit ? Number(draft.dailyKnownTokenLimit) : null, expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null });

function ClientPolicyFields({ value, onChange, ceiling, disabled, prefix }: { value: PolicyDraft; onChange: (value: PolicyDraft) => void; ceiling: number; disabled: boolean; prefix: string }) {
  return <fieldset className="usage-policy-fields" disabled={disabled}><legend>调用限制</legend>
    <label>并发上限<input aria-label={`${prefix}并发上限`} type="number" min="1" max={ceiling} step="1" placeholder={`继承服务器（${ceiling}）`} value={value.maxConcurrent} onChange={event => onChange({ ...value, maxConcurrent: event.target.value })} /></label>
    <label>每日已知 Token<input aria-label={`${prefix}每日已知 Token`} type="number" min="1" step="1" placeholder="未设置" value={value.dailyKnownTokenLimit} onChange={event => onChange({ ...value, dailyKnownTokenLimit: event.target.value })} /></label>
    <label>有效至（本机时区）<input aria-label={`${prefix}有效至`} type="datetime-local" value={value.expiresAt} onChange={event => onChange({ ...value, expiresAt: event.target.value })} /></label>
  </fieldset>;
}

function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function queryStart(rangeDays: number) {
  const now = new Date();
  if (rangeDays === 1) return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - rangeDays + 1).toISOString();
}

export default function UsageView({ automations, automationsReady, apiRequest: request, onOpenRun }: { automations: Automation[]; automationsReady: boolean; apiRequest: <T>(url: string, options?: RequestInit) => Promise<T>; onOpenRun?: (automationId: string, runId: string) => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [clientLimits, setClientLimits] = useState<ClientLimits | null>(null);
  const [usage, setUsage] = useState<Usage>(emptyUsage);
  const [rangeDays, setRangeDays] = useState(7);
  const [clientId, setClientId] = useState("");
  const [chartMode, setChartMode] = useState<"requests" | "discovery" | "polls" | "tokens">("requests");
  const [newName, setNewName] = useState("");
  const [newScopes, setNewScopes] = useState<string[]>([]);
  const [newPolicy, setNewPolicy] = useState<PolicyDraft>(() => policyDraft());
  const [editingPolicy, setEditingPolicy] = useState<{ id: string; revision: number; draft: PolicyDraft } | null>(null);
  const [policyError, setPolicyError] = useState("");
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
  const availableAutomations = useMemo(() => automationsReady ? automations : [], [automations, automationsReady]);

  useEffect(() => {
    setNewScopes(current => current.filter(id => availableAutomations.some(automation => automation.id === id)));
  }, [availableAutomations]);

  const refresh = useCallback(async () => {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const id = (requestRef.current?.id || 0) + 1;
    requestRef.current = { id, controller };
    setLoading(true);
    setError("");
    try {
      const [clientResult, usageResult] = await Promise.all([
        request<{ clients: Client[]; limits?: ClientLimits }>("/api/clients", { signal: controller.signal }),
        request<Usage>(`/api/clients/usage?from=${encodeURIComponent(queryStart(rangeDays))}&clientId=${encodeURIComponent(clientId)}`, { signal: controller.signal }),
      ]);
      if (requestRef.current?.id !== id || controller.signal.aborted) return;
      setClients(clientResult.clients);
      setClientLimits(clientResult.limits || null);
      setUsage(usageResult);
      setLoadedFilter(`${rangeDays}:${clientId}`);
      setLoadedAt(new Date().toISOString());
      setError("");
    } catch (cause) {
      if (requestRef.current?.id === id && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "调用数据加载失败");
    } finally {
      if (requestRef.current?.id === id && !controller.signal.aborted) setLoading(false);
    }
  }, [clientId, rangeDays, request]);

  useEffect(() => {
    void refresh();
    return () => requestRef.current?.controller.abort();
  }, [refresh]);

  const createClient = async () => {
    if (busy || !automationsReady || createdToken || !newName.trim() || !newScopes.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ token: string }>("/api/clients", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, automationIds: newScopes, ...(clientLimits ? policyPayload(newPolicy) : {}) }),
      });
      setCreatedToken(result.token);
      setNewName("");
      setNewScopes([]);
      setNewPolicy(policyDraft());
      await refresh();
    } catch (cause) {
      const status = (cause as { status?: number })?.status;
      setError(status && status >= 400 && status < 500 && ![408, 499].includes(status)
        ? cause instanceof Error ? cause.message : "创建被拒绝"
        : "创建结果未确认，请先刷新调用方列表核对；如发现多余令牌，请手动撤销，不要直接重复创建。");
    }
    finally { setBusy(false); }
  };

  const editPolicy = (client: Client) => {
    setEditingPolicy({ id: client.id, revision: client.policyRevision ?? 0, draft: policyDraft(client) });
    setPolicyError("");
  };
  const reloadPolicy = async () => {
    if (busy || !editingPolicy || !window.confirm("用服务器最新限制替换当前未保存输入？")) return;
    setBusy(true);
    try {
      const result = await request<{ clients: Client[]; limits?: ClientLimits }>("/api/clients");
      const client = result.clients.find(row => row.id === editingPolicy.id);
      if (!client || client.revokedAt) throw new Error("调用方已撤销或不可用，请关闭编辑并刷新列表。");
      setClients(result.clients); setClientLimits(result.limits || null); editPolicy(client);
    } catch (cause) { setPolicyError(cause instanceof Error ? cause.message : "限制读取失败，当前输入保留。"); }
    finally { setBusy(false); }
  };
  const savePolicy = async () => {
    if (busy || !editingPolicy || !clientLimits) return;
    const client = clients.find(row => row.id === editingPolicy.id);
    if (!client) return;
    const payload = policyPayload(editingPolicy.draft);
    if (!window.confirm(`保存「${client.name}」的调用限制？\n并发：${payload.maxConcurrent ?? `继承服务器 ${clientLimits.maxConcurrent}`}\n每日已知 Token：${payload.dailyKnownTokenLimit ?? "未设置"}（UTC）\n有效至：${payload.expiresAt ? new Date(payload.expiresAt).toLocaleString() : "不设到期时间"}\n不会清零已记录用量或中断正在运行的任务；待执行任务会按最新限制重新核对。`)) return;
    setBusy(true); setPolicyError("");
    try {
      const { expiresAt, ...limits } = payload;
      await request(`/api/clients/${encodeURIComponent(client.id)}/policy`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: editingPolicy.revision, ...limits,
        ...(editingPolicy.draft.expiresAt === localDateInput(client.expiresAt) ? {} : { expiresAt }) }) });
      setEditingPolicy(null); await refresh();
    } catch (cause) {
      const status = (cause as { status?: number })?.status;
      setPolicyError(status && status >= 400 && status < 500 && ![408, 499].includes(status)
        ? cause instanceof Error ? cause.message : "保存被拒绝，当前输入保留。"
        : "保存结果未确认，当前输入保留；请先载入最新限制核对，不要直接重复保存。");
    } finally { setBusy(false); }
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
    const values = new Map<string, { requests: number; discovery: number; polls: number; tokens: number }>();
    const keyFor = (hour: string) => rangeDays === 1 ? hour : localDay(new Date(hour));
    for (const row of visibleUsage.buckets) {
      const key = keyFor(row.hour);
      const value = values.get(key) || { requests: 0, discovery: 0, polls: 0, tokens: 0 };
      value.requests += row.requests;
      value.discovery += row.discovery || 0;
      value.polls += row.polls || 0;
      values.set(key, value);
    }
    for (const row of visibleUsage.runBuckets) {
      const key = keyFor(row.hour);
      const value = values.get(key) || { requests: 0, discovery: 0, polls: 0, tokens: 0 };
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
        ...(values.get(key) || { requests: 0, discovery: 0, polls: 0, tokens: 0 }),
      };
    });
  }, [rangeDays, visibleUsage.buckets, visibleUsage.runBuckets]);

  const peak = Math.max(1, ...chart.map((point) => point[chartMode]));
  const totalRequests = visibleUsage.buckets.reduce((sum, row) => sum + row.requests, 0);
  const accepted = visibleUsage.buckets.reduce((sum, row) => sum + row.accepted, 0);
  const errors = visibleUsage.requestSummary?.groups.reduce((sum, row) => sum + row.errors, 0);
  const replayed = visibleUsage.buckets.reduce((sum, row) => sum + row.replayed, 0);
  const discovery = visibleUsage.requestSummary ? visibleUsage.buckets.reduce((sum, row) => sum + (row.discovery || 0), 0) : undefined;
  const polls = visibleUsage.buckets.reduce((sum, row) => sum + (row.polls || 0), 0);
  const controls = visibleUsage.buckets.reduce((sum, row) => sum + (row.controls || 0), 0);
  const totalTokens = visibleUsage.runBuckets.reduce((sum, row) => sum + row.totalTokens, 0);
  const knownRuns = visibleUsage.runBuckets.reduce((sum, row) => sum + row.knownRuns, 0);
  const unknownRuns = visibleUsage.runBuckets.reduce((sum, row) => sum + row.unknownRuns, 0);
  const metric = (value: number | undefined) => hasCurrentData && value != null ? value.toLocaleString() : "--";
  const runSummary = visibleUsage.runSummary;
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
      {visibleUsage.usageLedger?.seededAt && <p className="usage-note">用量账本始于 {new Date(visibleUsage.usageLedger.seededAt).toLocaleString()}，保留 {visibleUsage.usageLedger.retentionDays} 天；此前历史仅覆盖仍保留的记录，统计可能不完整。每日预算按 UTC 日期计算。</p>}
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
        <div><span>提交请求</span><strong>{metric(totalRequests)}</strong></div>
        <div><span>受理任务</span><strong>{metric(accepted)}</strong></div>
        <div><span>同键重放</span><strong>{metric(replayed)}</strong></div>
        <div><span>能力查询</span><strong>{metric(discovery)}</strong></div>
        <div><span>结果查询</span><strong>{metric(polls)}</strong></div>
        <div><span>取消请求</span><strong>{metric(controls)}</strong></div>
        <div><span>调用错误</span><strong>{metric(errors)}</strong></div>
        <div><span>已知 token</span><strong>{metric(totalTokens)}</strong>{hasCurrentData && <small>{unknownRuns ? `${unknownRuns} 次运行用量未知` : `${knownRuns} 次运行已计量`}</small>}</div>
      </div>
      <p className="usage-note">仅统计已记录的已认证调用，部分限流拒绝未记录，不是完整网关流量或账单。调用错误含流式错误；等待超时或断开不等于后台任务失败。</p>
      <section className="usage-section" aria-label="调用曲线">
        <div className="usage-section-head"><h2>趋势</h2><div className="usage-segmented" role="group" aria-label="曲线指标">{([['requests', '提交'], ['discovery', '能力'], ['polls', '查询'], ['tokens', 'Token']] as const).map(([mode, label]) => <button type="button" key={mode} className={chartMode === mode ? "selected" : ""} disabled={mode === "discovery" && !visibleUsage.requestSummary} onClick={() => setChartMode(mode)}>{label}</button>)}</div></div>
        {hasCurrentData && (chartMode !== "discovery" || visibleUsage.requestSummary) ? <div className="usage-chart" role="img" aria-label={`${chartMode === "requests" ? "提交" : chartMode === "discovery" ? "能力" : chartMode === "polls" ? "查询" : "Token"} 趋势`}>{chart.map((point) => <div className="usage-chart-column" key={point.key} title={`${point.fullLabel}: ${point[chartMode].toLocaleString()}`}><div className="usage-chart-bar" style={{ height: `${Math.max(point[chartMode] ? 5 : 1, point[chartMode] / peak * 100)}%` }} /><small>{point.label}</small></div>)}</div> : <p className="usage-empty">{loading ? "正在加载趋势…" : "所选范围暂时无法显示趋势。"}</p>}
        {hasCurrentData && <details className="usage-chart-data"><summary>查看分时数据</summary><div><table><thead><tr><th scope="col">时间</th><th scope="col">提交</th><th scope="col">能力</th><th scope="col">查询</th><th scope="col">Token</th></tr></thead><tbody>{chart.map((point) => <tr key={point.key}><th scope="row">{point.fullLabel}</th><td>{point.requests.toLocaleString()}</td><td>{visibleUsage.requestSummary ? point.discovery.toLocaleString() : "--"}</td><td>{point.polls.toLocaleString()}</td><td>{point.tokens.toLocaleString()}</td></tr>)}</tbody></table></div></details>}
        {visibleUsage.droppedRequests > 0 && <p className="usage-note">有 {visibleUsage.droppedRequests} 条损坏的请求明细未计入，曲线可能不完整。</p>}
        {!!visibleUsage.missingMetricFiles && <p className="usage-note">读取期间有 {visibleUsage.missingMetricFiles} 个指标文件已移除，统计可能不完整。</p>}
        {unknownRuns > 0 && <p className="usage-note">Token 仅统计 {knownRuns} 次有完整单轮快照的运行；未知用量未计入，不代表零消耗。</p>}
      </section>
      <section className="usage-section" aria-label="任务质量与耗时">
        <div className="usage-section-head"><h2>任务质量与耗时</h2></div>
        {runSummary ? <><dl className="usage-quality">{[
          ["任务记录", metric(runSummary.tasks)], ["已观测模型回合", metric(runSummary.observedModelTurns)],
          ["任务成功率", rateText(runSummary.successRate)], ["未知用量占比", rateText(runSummary.unknownUsageRate)],
          ["已完成", metric(runSummary.completed)], ["明确失败", metric(runSummary.failed)], ["已取消", metric(runSummary.canceled)],
          ["待核对", metric(runSummary.unresolved)], ["处理中或排队", metric(runSummary.active)], ["未分类", metric(runSummary.unclassified)],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="usage-note">成功率仅按已完成与明确失败计算；未知用量占比仅含终态任务。模型回合只统计已取得会话和回合标识的记录，不代表完整计费次数。</p></> : <p className="usage-empty">{loading ? "正在加载任务统计…" : "服务器未提供任务汇总。"}</p>}
        <div className="usage-metrics-table"><table><thead><tr><th scope="col">耗时范围</th><th scope="col">P50</th><th scope="col">P95</th><th scope="col">样本</th></tr></thead><tbody>{[
          { label: "任务排队", duration: runSummary?.queueWait }, { label: "后台处理", duration: runSummary?.execution },
          ...["submit", "discovery", "poll", "control"].map(kind => ({ label: requestLabels[kind], duration: visibleUsage.requestSummary ? visibleUsage.requestSummary.groups.find(group => group.kind === kind)?.duration || { samples: 0, p50Ms: null, p95Ms: null } : undefined })),
        ].map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{durationText(row.duration?.p50Ms)}</td><td>{durationText(row.duration?.p95Ms)}</td><td>{row.duration?.samples.toLocaleString() ?? "--"}</td></tr>)}</tbody></table></div>
        <p className="usage-note">P50 为中位数，P95 表示 95% 样本不超过该耗时；无样本显示 --。后台处理包含准备及收尾，不等同于模型推理时间；中断待核对的结束时间不参与耗时统计。</p>
        {!!visibleUsage.requestSummary?.errorTypes.length && <dl className="usage-quality usage-error-types">{visibleUsage.requestSummary.errorTypes.map(row => <div key={row.type}><dt>{errorLabels[row.type] || "其他调用错误"}</dt><dd>{row.count.toLocaleString()}</dd></div>)}</dl>}
      </section>
      <section className="usage-section" aria-label="调用方">
        <div className="usage-section-head"><h2>调用方</h2><ShieldCheck size={18} /></div>
        <div className="usage-client-list">{clients.map((client) => <div className="usage-client" key={client.id}>
          <div><strong>{client.name}</strong><span>{client.revokedAt ? "已撤销" : client.expiresAt && Date.parse(client.expiresAt) <= Date.now() ? "已到期" : "启用"} · {client.tokenPrefix}… · {client.automationIds.join("、")}</span><small>最近调用 {client.lastUsedAt ? new Date(client.lastUsedAt).toLocaleString() : "无"}{client.expiresAt ? ` · 有效至 ${new Date(client.expiresAt).toLocaleString()}` : ""}</small>
            {clientLimits && <small>并发 {client.maxConcurrent ?? `继承（${clientLimits.maxConcurrent}）`} · 每日已知 Token {client.dailyKnownTokenLimit?.toLocaleString() ?? "未设置"}</small>}</div>
          {!client.revokedAt && <div className="usage-client-actions">{clientLimits && <button type="button" className="icon-button" title="调整调用限制" aria-label={`调整 ${client.name} 的限制`} disabled={busy} onClick={() => editPolicy(client)}><Settings2 size={17} /></button>}<button type="button" className="icon-button" title="撤销令牌" aria-label={`撤销 ${client.name}`} disabled={busy} onClick={() => void revokeClient(client)}><Trash2 size={17} /></button></div>}
          {editingPolicy?.id === client.id && clientLimits && <form className="usage-policy-editor" onSubmit={event => { event.preventDefault(); void savePolicy(); }}>
            <ClientPolicyFields value={editingPolicy.draft} ceiling={clientLimits.maxConcurrent} disabled={busy} prefix="编辑调用方" onChange={draft => setEditingPolicy({ ...editingPolicy, draft })} />
            <p className="usage-note">每日上限按 UTC 已知用量核对，单次任务可能超出；未结算任务会阻止再次启动，不是金额硬上限。</p>
            {policyError && <p role="alert" className="usage-error">{policyError}</p>}
            <div className="usage-policy-actions"><button type="submit" className="icon-button" disabled={busy} title="保存限制" aria-label={`保存 ${client.name} 的限制`}><Check size={18} /></button>{policyError && <button type="button" className="icon-button" disabled={busy} title="载入最新限制，替换未保存输入" aria-label="载入最新调用限制" onClick={() => void reloadPolicy()}><RefreshCw size={18} /></button>}<button type="button" className="icon-button" disabled={busy} title="取消编辑" aria-label="取消限制编辑" onClick={() => { setEditingPolicy(null); setPolicyError(""); }}><X size={18} /></button></div>
          </form>}
        </div>)}</div>
        {!clients.length && loadedAt && <p className="usage-empty">尚无独立调用方。旧共享令牌仍可按现有配置使用。</p>}
        <form className="usage-create" onSubmit={event => { event.preventDefault(); void createClient(); }}><input aria-label="调用方名称" placeholder="服务名称" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={80} /><div className="usage-scopes">{!automationsReady ? <p className="usage-note" role="status">自动化权限范围尚未加载，请先刷新控制台状态。</p> : !availableAutomations.length ? <p className="usage-note">暂无可授权的自动化。</p> : availableAutomations.map((automation) => <label key={automation.id}><input type="checkbox" disabled={busy} checked={newScopes.includes(automation.id)} onChange={(event) => setNewScopes((current) => event.target.checked ? [...current, automation.id] : current.filter((id) => id !== automation.id))} />{automation.name}</label>)}</div>
          {clientLimits && <details className="usage-new-policy"><summary>调用限制与有效期</summary><ClientPolicyFields value={newPolicy} onChange={setNewPolicy} ceiling={clientLimits.maxConcurrent} disabled={busy} prefix="新调用方" /></details>}
          <button type="submit" disabled={busy || !automationsReady || !!createdToken || !newName.trim() || !newScopes.length}><Plus size={16} />创建令牌</button></form>
        {createdToken && <div className="usage-token" role="status"><strong>新令牌仅显示一次</strong><code>{createdToken}</code><button type="button" onClick={() => void navigator.clipboard.writeText(createdToken)} aria-label="复制新令牌"><Copy size={16} /></button><button type="button" onClick={() => setCreatedToken("")}>关闭</button></div>}
      </section>
      <section className="usage-section" aria-label="请求明细"><div className="usage-section-head"><h2>最近请求</h2><Activity size={18} /></div><div className="usage-requests">{visibleUsage.requests.map((row) => {
        const run = row.runId ? runsById.get(row.runId) : null;
        return <details className="usage-request" key={row.id}><summary><time>{new Date(row.time).toLocaleString()}</time><strong>{clients.find((client) => client.id === row.clientId)?.name || (row.clientId === "legacy-shared" ? "旧共享令牌" : row.clientId)}</strong><span>{row.automationId} · {triggerLabels[row.trigger] || row.trigger}</span><span>{row.status}{row.deduplicated ? " · 重放" : ""}</span><small>{row.runId || "无关联任务"}</small></summary><div className="usage-request-expanded"><span>请求 ID <code>{row.id}</code></span><span>耗时 {durationText(row.durationMs)}</span>{run ? <><span>任务 {runLabels[run.status] || "状态未知"} · {run.model || "模型未知"} / {run.reasoning || "推理未知"}</span><span>Token {run.usage.status === "complete" ? `${run.usage.totalTokens}（输入 ${run.usage.inputTokens}，输出 ${run.usage.outputTokens}）` : "未知，未计为零"}</span>{onOpenRun && <button type="button" className="mini-action" onClick={() => onOpenRun(run.automationId, run.id)}>打开任务</button>}</> : row.runId ? <span>任务明细超出当前保留范围</span> : <span>本次请求没有关联任务记录</span>}</div></details>;
      })}</div>{hasCurrentData && !visibleUsage.requests.length && <p className="usage-empty">所选范围暂无请求。</p>}</section>
    </div>
  );
}
