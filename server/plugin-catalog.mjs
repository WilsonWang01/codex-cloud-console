export function pluginCatalogPage(catalog, options = {}) {
  const query = String(options.query || "").trim().toLocaleLowerCase("en");
  const requestedLimit = Number.parseInt(String(options.limit || ""), 10);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 80, 20), 200);
  const allPlugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  const filteredPlugins = query
    ? allPlugins.filter((plugin) =>
        [
          plugin.displayName,
          plugin.name,
          plugin.description,
          plugin.developerName,
          plugin.category,
          plugin.marketplaceName,
          ...(plugin.capabilities || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase("en")
          .includes(query),
      )
    : allPlugins;
  const plugins = [...filteredPlugins]
    .sort(
      (a, b) =>
        Number(b.installed) - Number(a.installed) ||
        Number(b.featured) - Number(a.featured) ||
        a.displayName.localeCompare(b.displayName, "zh-CN"),
    )
    .slice(0, limit);
  return {
    plugins,
    total: allPlugins.length,
    matched: filteredPlugins.length,
    returned: plugins.length,
    installedCount: allPlugins.filter((plugin) => plugin.installed).length,
    truncated: filteredPlugins.length > plugins.length,
    marketplaceLoadErrors: catalog?.marketplaceLoadErrors || [],
  };
}
