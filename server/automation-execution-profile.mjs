import fs from "node:fs/promises";
import path from "node:path";

export const restrictedExecutionProfile = "workspace-restricted-v1";
const fail = (message, statusCode = 503) => Object.assign(new Error(message), { code: "execution_profile_unavailable", statusCode });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeExecutionProfile(value) {
  if (value == null) return null;
  if (value === restrictedExecutionProfile) return value;
  throw fail("自动化执行策略未知，未回退到默认权限");
}

export function assertExecutionProfile(accepted, configured) {
  if (normalizeExecutionProfile(accepted) !== normalizeExecutionProfile(configured)) throw fail("已接收任务的执行策略与当前配置不同，请核对原任务；未重新执行", 409);
}

export function automationExecutionProfile(automation) {
  const profile = normalizeExecutionProfile(automation.executionProfile);
  if (profile && (automation.mode !== "on-demand" || automation.service || automation.timer || automation.personalRoutine)) throw fail("受限执行策略仅支持无系统定时服务的按需自动化");
  return profile;
}

export function assertProfileSource(profile, source) {
  assertExecutionProfile(source?.executionProfile, profile);
  if (profile && (!source?.threadId || source.worktreePolicy !== "detached-worktree" || !source.worktreePath)) throw fail("原任务没有可核对的受限工作树，未复用会话", 409);
}

export function profileRuntime(runtime, profile) {
  return normalizeExecutionProfile(profile) ? { ...runtime, sandbox: "workspace-write", approval: "never", search: false } : runtime;
}

export function profileSandbox(cwd) {
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

export function profileThreadConfig(config, cwd) {
  if (!object(config)) throw fail("无法核对 Codex 有效配置，未启动受限任务");
  const disabled = key => {
    const entries = config[key] ?? {};
    if (!object(entries) || Object.keys(entries).length > 400) throw fail("连接器或插件配置无法完整核对，未启动受限任务");
    return Object.fromEntries(Object.keys(entries).map(id => {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw fail("连接器或插件名称无法安全覆盖，未启动受限任务");
      return [`${key}.${id}.enabled`, false];
    }));
  };
  return {
    ...disabled("mcp_servers"), ...disabled("plugins"), ...disabled("apps"), "apps._default.enabled": false,
    features: { apps: false, plugins: false, remote_plugin: false, multi_agent: false, memories: false },
    web_search: "disabled", tools: { web_search: false },
    sandbox_workspace_write: { writable_roots: [cwd], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
  };
}

export async function verifyProfileThread(request, response, cwd, expectedThreadId = response?.thread?.id) {
  const sandbox = response?.sandbox;
  if (!response?.thread?.id || response.thread.id !== expectedThreadId || response.approvalPolicy !== "never" || sandbox?.type !== "workspaceWrite" || sandbox.networkAccess !== false ||
      sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true || !Array.isArray(sandbox.writableRoots)) throw fail("Codex 未确认受限执行权限，未启动模型");
  let root;
  try {
    root = await fs.realpath(cwd);
    if (await fs.realpath(response.cwd) !== root) throw new Error();
    for (const candidate of sandbox.writableRoots) {
      const actual = await fs.realpath(candidate);
      if (actual !== root && !actual.startsWith(root + path.sep)) throw new Error();
    }
  } catch { throw fail("Codex 可写目录超出当前工作树或无法核对，未启动模型"); }
  const cursors = new Set(), names = new Set(); let cursor = null;
  do {
    const result = await request("mcpServerStatus/list", { threadId: response.thread.id, cursor, limit: 100, detail: "toolsAndAuthOnly" }, 15000);
    if (!Array.isArray(result?.data) || result.data.length > 100) throw fail("受限线程的连接器目录不完整，未启动模型");
    for (const server of result.data) {
      if (typeof server?.name !== "string" || !server.name || names.has(server.name) || server.runtimeStatus !== "disabled" || !object(server.tools) || Object.keys(server.tools).length) throw fail("受限线程仍有未停用或无法核对的连接器，未启动模型");
      names.add(server.name);
    }
    cursor = result.nextCursor;
    if (cursor !== null && (typeof cursor !== "string" || !cursor || cursors.has(cursor) || cursors.size >= 3)) throw fail("受限线程的连接器目录不完整，未启动模型");
    if (cursor) cursors.add(cursor);
  } while (cursor);
}

export function executionProfileView(value) {
  const profile = normalizeExecutionProfile(value);
  return profile ? { profile, sandbox: "workspace-write", approval: "never", command_network_access: false, web_search: false,
    mcp_tools: "disabled_and_checked_before_model", write_scope: "detached_worktree", host_read_isolation: false, delegation_block_verified: false, trusted_clients_only: true }
    : { profile: null, mode: "legacy_console_defaults", host_read_isolation: false, trusted_clients_only: true };
}
