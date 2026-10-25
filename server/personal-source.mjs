import Ajv from "ajv";

export const sourceText = (value, max) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : "";
export const sourceError = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });

export async function withPersonalSource({ request, cwd, model = "gpt-6-sol", prefix, label, toolNames, timeoutMs, resultBytes, onThread = () => {}, now = () => Date.now() }, read) {
  const fail = (code, message, status) => sourceError(`${prefix}_${code}`, message, status);
  const deadline = now() + timeoutMs;
  const call = (method, params, maximum = 15000) => {
    const timeout = Math.min(maximum, deadline - now());
    if (timeout <= 0) throw fail("timeout", `${label}读取超时，旧数据未更新`);
    return request(method, params, timeout);
  };
  let threadId;
  try {
    const started = await call("thread/start", { cwd, model, sandbox: "read-only", approvalPolicy: "on-request", ephemeral: true, serviceName: `codex_cloud_${prefix}_source` });
    threadId = started?.thread?.id;
    if (!threadId || typeof threadId !== "string" || sourceText(threadId, 200) !== threadId || started.thread.ephemeral !== true) throw fail("runtime_unsupported", "当前运行时不能建立临时只读上下文，未读取来源");
    onThread(threadId);
    const servers = [], cursors = new Set();
    let cursor = null;
    do {
      const catalog = await call("mcpServerStatus/list", { threadId, cursor, limit: 100, detail: "toolsAndAuthOnly" });
      if (!Array.isArray(catalog?.data)) throw fail("catalog_unavailable", `无法核对${label}工具，未读取来源`);
      servers.push(...catalog.data);
      cursor = catalog.nextCursor || null;
      if (cursor && (cursors.has(cursor) || cursors.size >= 4)) throw fail("catalog_unavailable", `${label}工具目录不完整，未读取来源`);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const server = servers.find(item => item.name === "codex_apps" && item.httpOrigin === "https://chatgpt.com");
    const tools = Object.fromEntries(toolNames.map(name => [name, server?.tools?.[name]]));
    for (const [name, tool] of Object.entries(tools)) {
      if (!tool || tool.name !== name || tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint !== false ||
          !tool._meta?.connector_id || sourceText(tool._meta.connector_id, 200) !== tool._meta.connector_id ||
          !tool._meta.link_id || sourceText(tool._meta.link_id, 200) !== tool._meta.link_id) throw fail("not_connected", `未找到已确认只读的${label}工具，请核对连接服务`, 409);
    }
    const installed = await call("app/installed", { threadId });
    if (Object.values(tools).some(tool => !installed?.apps?.some(app => app.id === tool._meta.connector_id && app.enabled === true && app.callable === true))) throw fail("not_connected", `当前${label}连接不可调用，未读取来源`, 409);
    const ajv = new Ajv({ strict: false, allErrors: false });
    const validators = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, ajv.compile(tool.inputSchema)]));
    const invoke = async (name, input, maximum = 20000) => {
      if (!validators[name]?.(input)) throw fail("contract_changed", `${label}工具参数已变化，需要重新核对接入，未调用工具`);
      const result = await call("mcpServer/tool/call", { threadId, server: server.name, tool: name, arguments: input }, maximum);
      if (!result || Buffer.byteLength(JSON.stringify(result)) > resultBytes) throw fail("result_invalid", `${label}返回过大或格式无法确认`);
      if (result.isError === true) {
        if (/forbidden|unauthorized|invalid_grant|permission|authentication|not.authenticated/i.test(JSON.stringify(result))) throw fail("authorization_required", `${label}读取被拒绝，请在连接服务中核对授权`, 403);
        throw fail("read_failed", `${label}读取失败，不能据此判断没有记录`);
      }
      if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
      const content = result.content?.filter(item => item.type === "text");
      if (content?.length === 1) {
        try { return JSON.parse(content[0].text); } catch { /* Free text is not a complete source result. */ }
      }
      throw fail("shape_changed", `${label}返回格式发生变化，未将结果当作空记录`);
    };
    return await read({ tools, server, invoke });
  } catch (error) {
    if (error.code?.startsWith(`${prefix}_`)) throw error;
    throw fail("read_failed", `${label}读取暂不可用，旧数据未更新；请稍后刷新或核对连接服务`);
  } finally {
    if (threadId) await request("thread/unsubscribe", { threadId }, 3000).catch(() => null);
  }
}
