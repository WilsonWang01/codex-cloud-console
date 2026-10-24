import { CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, Link2, Loader2, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

type ConnectedApp = { id: string; name: string; description: string; installUrl: string | null; accessible: boolean; enabled: boolean; callable: boolean | null };
type Catalog = { ok: boolean; apps: ConnectedApp[]; runtimeScope: string; runtimeVerified: boolean; directoryError?: string; error?: string };
const preferredServices = ["gmail", "google calendar", "google drive", "outlook", "github"];

function serviceRank(app: ConnectedApp) {
  const name = app.name.toLowerCase();
  const priority = preferredServices.findIndex((item) => name.includes(item));
  return priority < 0 ? preferredServices.length : priority;
}

function safeAuthorizationUrl(value: string | null) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.port && !url.username && !url.password && url.pathname.startsWith("/apps/") ? url.href : undefined;
  } catch { return undefined; }
}

export default function ConnectedServices({ repoId, onPrepare, initialScope = "available" }: { repoId: string; onPrepare?: (appName: string) => void; initialScope?: "available" | "all" }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"available" | "all">(initialScope);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const load = useCallback(async (refresh = false) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ repoId, ...(refresh ? { refresh: "1" } : {}) });
      const response = await fetch(`/api/codex/apps?${params}`, { signal: request.signal });
      const data = await response.json() as Catalog;
      if (!response.ok || !data.ok) throw new Error(data.error || "服务目录暂不可用");
      if (!request.signal.aborted) { setCatalog(data); setPage(0); }
    } catch (failure) {
      if (!request.signal.aborted) {
        setCatalog(null);
        setError(failure instanceof Error ? failure.message : "服务目录读取失败");
      }
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, [repoId]);

  useEffect(() => {
    setCatalog(null);
    setQuery(""); setScope(initialScope); setPage(0);
    void load();
    const onVisible = () => { if (!document.hidden) void load(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.current?.abort(); document.removeEventListener("visibilitychange", onVisible); };
  }, [load, initialScope]);

  const selectedScope = catalog?.runtimeVerified ? scope : "all";
  const apps = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (catalog?.apps || []).filter(app => (selectedScope === "all" || app.callable === true)
      && `${app.name} ${app.description}`.toLowerCase().includes(search))
      .sort((a, b) => Number(b.callable === true) - Number(a.callable === true) || serviceRank(a) - serviceRank(b) || a.name.localeCompare(b.name));
  }, [catalog?.apps, selectedScope, query]);
  const pageSize = 20, pageCount = Math.max(1, Math.ceil(apps.length / pageSize)), currentPage = Math.min(page, pageCount - 1);
  const changePage = (next: number) => {
    setPage(next);
    list.current?.focus({ preventScroll: true });
    list.current?.scrollIntoView({ block: "start" });
  };
  const callableCount = catalog?.apps.filter((app) => app.callable === true).length || 0;
  return <section className="connected-services" aria-label="账号服务连接">
    <div className="connected-services-head">
      <span>{catalog?.runtimeVerified ? `${callableCount} 项服务可调用` : "账号服务"}</span>
      <button type="button" className="mini-action" onClick={() => void load(true)} disabled={loading}>
        {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}刷新连接
      </button>
    </div>
    <div className="segmented-control connected-service-scope" role="group" aria-label="服务范围">
      <button type="button" className={selectedScope === "available" ? "selected" : ""} aria-pressed={selectedScope === "available"} disabled={!catalog?.runtimeVerified} onClick={() => { setScope("available"); setPage(0); }}>当前可用</button>
      <button type="button" className={selectedScope === "all" ? "selected" : ""} aria-pressed={selectedScope === "all"} onClick={() => { setScope("all"); setPage(0); }}>服务目录</button>
    </div>
    <label className="plugin-search"><Search size={15} /><input aria-label="搜索服务" placeholder={selectedScope === "available" ? "搜索可调用服务" : "搜索 Gmail、Outlook、日历、文档…"} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
    {error && <p className="detail-error" role="alert">{error}</p>}
    {catalog?.directoryError && <details className="connected-directory-warning"><summary>{catalog.runtimeVerified ? "目录信息不完整，已安装状态已核对" : "目录信息不完整，工具状态待确认"}</summary><p>{catalog.directoryError}</p></details>}
    {loading && <p role="status">正在核对账号服务…</p>}
    {catalog && !catalog.runtimeVerified && <p className="warn-text">工具状态暂未确认，不能据此判断服务已可调用。</p>}
    <div className="connected-service-list" id={listId} ref={list} role="region" aria-label="服务列表" tabIndex={-1}>
      {apps.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((app) => {
        const href = safeAuthorizationUrl(app.installUrl);
        const state = app.callable === true ? "可调用" : app.callable === null ? "调用状态未知" : app.accessible ? "账号可访问，工具暂不可调用" : "待连接";
        return <article className="connected-service-row" key={app.id}>
          {app.callable ? <CheckCircle2 size={18} /> : <Link2 size={18} />}
          <div className="connected-service-content"><strong>{app.name}</strong><small>{state}{!app.enabled && app.accessible ? " · 配置未启用" : ""}</small>
            {app.description.length > 180 ? <details className="connected-service-description"><summary>{app.description.slice(0, 100)}…</summary><small>{app.description}</small></details> : <small>{app.description}</small>}
          </div>
          <div className="connected-service-actions">
            {catalog?.runtimeVerified && app.callable === true && onPrepare && <button type="button" className="mini-action" onClick={() => onPrepare(app.name)}>起草</button>}
            {href ? <a className="mini-action" href={href} target="_blank" rel="noopener noreferrer" aria-label={`${app.callable ? "管理" : "连接"}${app.name}`}><ExternalLink size={14} />{app.callable ? "管理" : "前往授权"}</a> : !app.callable ? <a className="mini-action" href="https://chatgpt.com/apps" target="_blank" rel="noopener noreferrer" aria-label={`在官方目录查找${app.name}`}><ExternalLink size={14} />官方目录</a> : null}
          </div>
        </article>;
      })}
    </div>
    {apps.length > pageSize && <nav className="connected-service-pagination" aria-label="服务目录分页">
      <span role="status">{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, apps.length)} / {query.trim() ? "匹配" : selectedScope === "available" ? "可调用" : "已载入"} {apps.length.toLocaleString()} 项</span>
      <button type="button" className="mini-action" title="上一页服务" aria-label="上一页服务" aria-controls={listId} disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={18} /></button>
      <button type="button" className="mini-action" title="下一页服务" aria-label="下一页服务" aria-controls={listId} disabled={currentPage + 1 >= pageCount} onClick={() => changePage(currentPage + 1)}><ChevronRight size={18} /></button>
    </nav>}
    {!loading && !error && apps.length === 0 && <p className="empty-copy">{query ? "没有匹配的服务。" : selectedScope === "available" ? "当前没有已核对的可调用服务。" : "当前没有可展示的服务。可前往官方目录管理连接，或查看已配置的 MCP 服务。"}</p>}
    <a className="mini-action connected-all-apps" href="https://chatgpt.com/apps" target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />管理全部服务</a>
    <details className="connected-permission-details"><summary>授权与权限说明</summary><p>“可调用”只表示工具在当前运行时可用，不保证具体账号数据可读或业务操作成功。服务授权由官方页面处理，可能与同账号的工作空间共用。外发、修改、删除和付费操作需要单独确认；这里不会获取本机软件或设备权限。</p></details>
  </section>;
}
