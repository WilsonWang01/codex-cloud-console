import { CheckCircle2, Loader2, Package, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type CodexPlugin = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  developerName: string | null;
  category: string | null;
  capabilities: string[];
  marketplaceName: string;
  installed: boolean;
  enabled: boolean;
  featured: boolean;
  availability: string;
  disabledReason: string | null;
  installPolicy: string;
  version: string | null;
  localVersion: string | null;
};

type PluginCatalogResponse = {
  ok: boolean;
  plugins: CodexPlugin[];
  total?: number;
  matched?: number;
  returned?: number;
  installedCount?: number;
  truncated?: boolean;
  marketplaceLoadErrors?: Array<{ message: string }>;
  error?: string;
};

async function requestCatalog(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = (await response.json().catch(() => null)) as PluginCatalogResponse | null;
  if (!response.ok || !data?.ok) throw new Error(data?.error || `插件请求失败（HTTP ${response.status}）`);
  return data;
}

function disabledReason(plugin: CodexPlugin) {
  if (plugin.availability === "DISABLED_BY_ADMIN") return "已被管理员停用";
  if (plugin.disabledReason === "plan_not_eligible") return "当前套餐不可用";
  if (plugin.disabledReason === "required_app_unavailable") return "依赖的 App 不可用";
  if (plugin.installPolicy === "NOT_AVAILABLE") return "当前不可安装";
  return "";
}

export default function CodexPluginManager({ repoId, onChanged }: { repoId: string; onChanged: () => void }) {
  const [plugins, setPlugins] = useState<CodexPlugin[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [catalogMeta, setCatalogMeta] = useState({ total: 0, matched: 0, installedCount: 0, truncated: false });
  const requestEpoch = useRef(0);

  const load = useCallback(async (refresh = false, searchQuery = "") => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ repoId });
      if (refresh) params.set("refresh", "1");
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      const data = await requestCatalog(`/api/codex/plugins?${params.toString()}`);
      if (epoch !== requestEpoch.current) return;
      setPlugins(data.plugins || []);
      setCatalogMeta({
        total: Number(data.total || 0),
        matched: Number(data.matched || 0),
        installedCount: Number(data.installedCount || 0),
        truncated: data.truncated === true,
      });
      if (data.marketplaceLoadErrors?.length) setError(data.marketplaceLoadErrors.map((item) => item.message).join("；"));
    } catch (loadError) {
      if (epoch !== requestEpoch.current) return;
      setError(loadError instanceof Error ? loadError.message : "插件目录读取失败");
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(false, query), query.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const mutatePlugin = async (plugin: CodexPlugin) => {
    const uninstall = plugin.installed;
    const confirmed = window.confirm(
      uninstall
        ? `确认卸载“${plugin.displayName}”？项目文件不会被删除，但该插件提供的工具将不可用。`
        : `确认安装“${plugin.displayName}”？这会改变云端 Codex 的工具配置，并可能要求单独登录关联 App。`,
    );
    if (!confirmed) return;
    requestEpoch.current += 1;
    setLoading(false);
    setBusyId(plugin.id);
    setError("");
    try {
      const data = await requestCatalog(`/api/codex/plugins/${uninstall ? "uninstall" : "install"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId, pluginId: plugin.id, marketplaceName: plugin.marketplaceName, query: query.trim(), limit: 80 }),
      });
      setPlugins(data.plugins || []);
      setCatalogMeta({
        total: Number(data.total || 0),
        matched: Number(data.matched || 0),
        installedCount: Number(data.installedCount || 0),
        truncated: data.truncated === true,
      });
      onChanged();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "插件配置更新失败");
    } finally {
      setBusyId("");
      setLoading(false);
    }
  };

  const countLabel = query.trim()
    ? `${catalogMeta.installedCount} 已安装 · ${catalogMeta.matched} 个结果`
    : `${catalogMeta.installedCount} 已安装 · ${catalogMeta.total} 可用`;
  return (
    <section className="settings-copy plugin-manager">
      <div className="settings-section-head">
        <span>
          <strong>插件</strong>
          <small>{loading ? "同步中" : countLabel}</small>
        </span>
        <button className="mini-action" type="button" onClick={() => void load(true, query)} disabled={loading || Boolean(busyId)}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          刷新目录
        </button>
      </div>
      <label className="plugin-search">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件、开发者或能力" />
      </label>
      {error && <p className="detail-error" role="alert">{error}</p>}
      <div className="plugin-list">
        {plugins.map((plugin) => {
          const unavailable = plugin.installed ? "" : disabledReason(plugin);
          return (
            <article className="plugin-row" key={`${plugin.marketplaceName}:${plugin.id}`}>
              <span className="plugin-icon"><Package size={17} /></span>
              <span className="plugin-copy">
                <span>
                  <strong>{plugin.displayName}</strong>
                  {plugin.installed && <em><CheckCircle2 size={12} /> 已安装</em>}
                </span>
                <small>{plugin.description || plugin.developerName || plugin.marketplaceName}</small>
              </span>
              <button
                className={plugin.installed ? "icon-command danger" : "mini-action"}
                type="button"
                onClick={() => void mutatePlugin(plugin)}
                disabled={Boolean(busyId) || Boolean(unavailable)}
                title={unavailable || (plugin.installed ? "卸载插件" : "安装插件")}
                aria-label={`${plugin.installed ? "卸载" : "安装"}${plugin.displayName}`}
              >
                {busyId === plugin.id ? <Loader2 size={13} className="spin" /> : plugin.installed ? <Trash2 size={13} /> : <Package size={13} />}
                {!plugin.installed && "安装"}
              </button>
            </article>
          );
        })}
        {!loading && plugins.length === 0 && <p className="empty-copy">{query ? "没有匹配的插件。" : "当前没有可用插件。"}</p>}
        {!loading && catalogMeta.truncated && <p className="plugin-list-note">仅显示前 {plugins.length} 项，请输入关键词缩小范围。</p>}
      </div>
    </section>
  );
}
