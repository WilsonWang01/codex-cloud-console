/**
 * App-server item normalizers.
 *
 * Materially adapted from codexui's MIT-licensed
 * `src/api/normalizers/v2.ts`.
 * Original project: https://github.com/friuns2/codexui
 */

function toIso(value) {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
}

function countContentLines(value) {
  if (!value) return 0;
  const normalized = String(value).replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed ? trimmed.split("\n").length : 0;
}

function countUnifiedDiffLines(value) {
  let addedLineCount = 0;
  let removedLineCount = 0;
  for (const line of String(value || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line || line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) addedLineCount += 1;
    if (line.startsWith("-")) removedLineCount += 1;
  }
  return { addedLineCount, removedLineCount };
}

function normalizeCommandStatus(value) {
  if (["completed", "failed", "declined", "interrupted"].includes(value)) return value;
  if (value === "inProgress" || value === "in_progress") return "inProgress";
  return value ? String(value) : "completed";
}

function normalizeFileChangeStatus(value) {
  if (["failed", "declined", "completed"].includes(value)) return value;
  return "inProgress";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .trim();
}

function fileChangeDisplayPath(value, options = {}) {
  const raw = normalizedPath(value);
  if (!raw) return "";

  const repoPath = normalizedPath(options.repoPath);
  if (repoPath && (raw === repoPath || raw.startsWith(`${repoPath}/`))) {
    return raw.slice(repoPath.length).replace(/^\/+/, "") || ".";
  }

  const repoName = normalizedPath(options.repoName || options.repoId)
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (repoName) {
    const repoPattern = escapeRegExp(repoName);
    const workspaceRepoMatch = raw.match(new RegExp(`(?:^|/)codex-cloud/(?:workspace|console)/${repoPattern}/(.+)$`));
    if (workspaceRepoMatch?.[1]) return workspaceRepoMatch[1];
    const worktreeRepoMatch = raw.match(new RegExp(`(?:^|/)codex-cloud/worktrees/[^/]+/${repoPattern}/(.+)$`));
    if (worktreeRepoMatch?.[1]) return worktreeRepoMatch[1];
  }

  const workspaceMatch = raw.match(/(?:^|\/)codex-cloud\/workspace\/[^/]+\/(.+)$/);
  if (workspaceMatch?.[1]) return workspaceMatch[1];

  const consoleMatch = raw.match(/(?:^|\/)codex-cloud\/console\/(.+)$/);
  if (consoleMatch?.[1]) return consoleMatch[1];

  const worktreeMatch = raw.match(/(?:^|\/)codex-cloud\/worktrees\/[^/]+\/(.+)$/);
  if (worktreeMatch?.[1]) return worktreeMatch[1];

  return raw;
}

function displayProjectPathText(value, options = {}) {
  let text = String(value || "");
  const repoPath = normalizedPath(options.repoPath);
  if (repoPath) {
    const escapedRepoPath = escapeRegExp(repoPath);
    text = text
      .replace(new RegExp(`${escapedRepoPath}/`, "g"), "")
      .replace(new RegExp(escapedRepoPath, "g"), ".");
  }
  return text
    .replace(/\/home\/ubuntu\/codex-cloud\/workspace\/[^/\s)\]]+\//g, "")
    .replace(/\/home\/ubuntu\/codex-cloud\/console\//g, "")
    .replace(/\/home\/ubuntu\/codex-cloud\/worktrees\/[^/\s)\]]+\//g, "隔离工作区/")
    .replace(/\bworktrees?\b/gi, "隔离工作区")
    .replace(/独立\s+隔离工作区/g, "独立隔离工作区")
    .replace(/隔离工作区\s+来/g, "隔离工作区来");
}

function toFileChanges(changes, options = {}) {
  const rows = Array.isArray(changes) ? changes : [];
  const normalized = [];
  for (const row of rows) {
    const change = row && typeof row === "object" ? row : {};
    const filePath = typeof change.path === "string" ? change.path : "";
    const diff = typeof change.diff === "string" ? change.diff : "";
    const kind = change.kind && typeof change.kind === "object" ? change.kind : {};
    const operationType = kind.type;
    if (!filePath || !["add", "delete", "update"].includes(operationType)) continue;
    const movedToPath = operationType === "update" && typeof kind.move_path === "string" ? kind.move_path : null;
    const counts =
      operationType === "update"
        ? countUnifiedDiffLines(diff)
        : operationType === "add"
          ? { addedLineCount: countContentLines(diff), removedLineCount: 0 }
          : { addedLineCount: 0, removedLineCount: countContentLines(diff) };
    normalized.push({
      path: fileChangeDisplayPath(filePath, options),
      rawPath: filePath,
      operation: operationType,
      movedToPath: movedToPath ? fileChangeDisplayPath(movedToPath, options) : null,
      rawMovedToPath: movedToPath,
      diff,
      ...counts,
    });
  }
  return normalized;
}

function summarizeFileChanges(item, options = {}) {
  const status = normalizeFileChangeStatus(item.status);
  const changes = toFileChanges(item.changes, options);
  if (!changes.length) return { text: "文件修改状态已更新。", status };
  const rows = changes.map((change) => {
    const moved = change.movedToPath ? ` -> ${change.movedToPath}` : "";
    const counts = `+${change.addedLineCount} -${change.removedLineCount}`;
    return `- ${change.operation} ${change.path}${moved} (${counts})`;
  });
  return {
    text: `文件修改：\n${rows.join("\n")}`,
    status: `fileChange ${status}`,
  };
}

function summarizeUserInputs(content) {
  if (!Array.isArray(content)) return "";
  const chunks = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") chunks.push(block.text);
    else if (block.type === "image" && typeof block.url === "string") chunks.push(`[图片] ${block.url}`);
    else if (block.type === "localImage" || block.type === "mention") {
      // Render local files as attachment cards instead of noisy absolute paths.
    }
    else if (block.type === "skill" && typeof block.name === "string") chunks.push(`$${block.name}`);
    else chunks.push(`[${block.type || "input"}]`);
  }
  return chunks.filter(Boolean).join("\n").trim();
}

function inputAttachmentKind(block) {
  if (block?.type === "localImage") return "image";
  if (block?.type === "mention") return "file";
  return null;
}

function mimeFromPath(value, kind = "file") {
  const ext = fileNameFromPath(value).split(".").pop()?.toLowerCase() || "";
  if (kind === "image") {
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "avif") return "image/avif";
    if (ext === "apng") return "image/apng";
    return "image/*";
  }
  if (ext === "pdf") return "application/pdf";
  if (ext === "json") return "application/json";
  if (ext === "csv") return "text/csv";
  if (ext === "md") return "text/markdown";
  if (ext === "txt" || ext === "log") return "text/plain";
  return "application/octet-stream";
}

function userInputAttachments(content) {
  if (!Array.isArray(content)) return [];
  const attachments = [];
  const seen = new Set();
  for (const block of content) {
    const kind = inputAttachmentKind(block);
    if (!kind || typeof block.path !== "string" || !block.path.trim()) continue;
    const attachmentPath = block.path.trim();
    if (seen.has(`${kind}:${attachmentPath}`)) continue;
    seen.add(`${kind}:${attachmentPath}`);
    attachments.push({
      name: fileNameFromPath(attachmentPath, kind === "image" ? "image" : "file"),
      path: attachmentPath,
      absolutePath: attachmentPath.startsWith("/") ? attachmentPath : undefined,
      mimeType: mimeFromPath(attachmentPath, kind),
      size: 0,
      kind,
    });
  }
  return attachments;
}

function uploadedAttachmentFromToken(token, options = {}) {
  const cleaned = String(token || "")
    .trim()
    .replace(/^[-*"`'(\[]+/, "")
    .replace(/[)"'`,.;:\]]+$/g, "");
  const marker = ".codex-cloud/uploads/";
  const markerIndex = cleaned.indexOf(marker);
  if (markerIndex < 0) return null;
  const relativePath = cleaned.slice(markerIndex).replaceAll("\\", "/");
  if (!relativePath.startsWith(marker) || relativePath.includes("..")) return null;
  const ext = fileNameFromPath(relativePath, "upload").split(".").pop()?.toLowerCase() || "";
  const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "apng"]);
  const mimeType = mimeFromPath(relativePath, imageExts.has(ext) ? "image" : "file");
  const kind = mimeType.startsWith("image/") ? "image" : "file";
  const repoPath = normalizedPath(options.repoPath);
  return {
    name: fileNameFromPath(relativePath, "upload"),
    path: relativePath,
    absolutePath: repoPath ? `${repoPath}/${relativePath}` : undefined,
    mimeType,
    size: 0,
    kind,
  };
}

function uploadedAttachmentsFromText(text, options = {}) {
  const attachments = [];
  const seen = new Set();
  for (const token of String(text || "").split(/\s+/)) {
    const attachment = uploadedAttachmentFromToken(token, options);
    if (!attachment || seen.has(attachment.path)) continue;
    seen.add(attachment.path);
    attachments.push(attachment);
  }
  return attachments;
}

function mergeAttachments(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();
  for (const attachment of [...primary, ...secondary]) {
    const key = attachment?.path || attachment?.absolutePath || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(attachment);
  }
  return merged;
}

function truncateOutput(value, limit = 5000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...`;
}

function outputStats(value, limit = 5000) {
  const raw = String(value || "");
  const output = truncateOutput(raw, limit);
  return {
    output,
    outputLineCount: countContentLines(raw),
    outputLength: raw.length,
    outputTruncated: raw.length > limit,
  };
}

function unwrapShellCommand(command) {
  return String(command || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\/bin\/(?:bash|sh)\s+-lc\s*/i, "")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();
}

function inlineCommand(command, limit = 180) {
  const text = unwrapShellCommand(command);
  if (!text) return "command";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function inlineStructuredValue(value, fallback = "", limit = 180) {
  if (value == null || value === "") return fallback;
  let text = "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function structuredPreview(value, limit = 3000) {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 1)}…`;
  } catch {
    return inlineStructuredValue(value, "", limit);
  }
}

function mcpResultSummary(result) {
  if (!result || typeof result !== "object") return "";
  const contentCount = Array.isArray(result.content) ? result.content.length : 0;
  const hasStructured = result.structuredContent != null;
  const hasMeta = result._meta != null;
  const parts = [];
  if (contentCount) parts.push(`${contentCount} 段内容`);
  if (hasStructured) parts.push("结构化结果");
  if (hasMeta) parts.push("meta");
  return parts.length ? ` · 结果 ${parts.join(" / ")}` : " · 有结果";
}

function dynamicToolContentSummary(contentItems) {
  if (!Array.isArray(contentItems) || !contentItems.length) return "";
  const textCount = contentItems.filter((item) => item?.type === "inputText").length;
  const imageCount = contentItems.filter((item) => item?.type === "inputImage").length;
  const parts = [];
  if (textCount) parts.push(`${textCount} 段文本`);
  if (imageCount) parts.push(`${imageCount} 张图片`);
  return parts.length ? ` · 输出 ${parts.join(" / ")}` : ` · 输出 ${contentItems.length} 项`;
}

function commandActionsSummary(commandActions) {
  if (!Array.isArray(commandActions) || !commandActions.length) return "";
  const counts = new Map();
  for (const action of commandActions) {
    const type = action?.type ? String(action.type) : "unknown";
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const rows = [...counts.entries()].map(([type, count]) => `${type} ${count}`);
  return rows.length ? ` · 动作 ${rows.join(" / ")}` : "";
}

function collabAgentSummary(item) {
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0;
  const stateCount = item.agentsStates && typeof item.agentsStates === "object" ? Object.keys(item.agentsStates).length : 0;
  const parts = [];
  if (receivers) parts.push(`${receivers} 个接收会话`);
  if (item.model) parts.push(String(item.model));
  if (item.reasoningEffort) parts.push(`reasoning ${item.reasoningEffort}`);
  if (stateCount) parts.push(`${stateCount} 个 agent 状态`);
  if (item.prompt) parts.push(`prompt ${inlineStructuredValue(item.prompt, "", 80)}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function toHookPromptFragments(fragments) {
  const rows = Array.isArray(fragments) ? fragments : [];
  return rows
    .map((fragment) => ({
      hookRunId: typeof fragment?.hookRunId === "string" ? fragment.hookRunId : "",
      text: typeof fragment?.text === "string" ? fragment.text : "",
    }))
    .filter((fragment) => fragment.hookRunId || fragment.text);
}

function hookPromptSummary(item) {
  const fragments = toHookPromptFragments(item.fragments);
  if (!fragments.length) return { text: "Hook 提示已更新。", fragments };
  const first = inlineStructuredValue(fragments[0]?.text || fragments[0]?.hookRunId, "", 100);
  const prefix = `Hook 提示: ${fragments.length} 段`;
  return { text: first ? `${prefix} · ${first}` : prefix, fragments };
}

function memoryCitationSummary(memoryCitation) {
  if (!memoryCitation || typeof memoryCitation !== "object") return "";
  const entryCount = Array.isArray(memoryCitation.entries) ? memoryCitation.entries.length : 0;
  const threadCount = Array.isArray(memoryCitation.threadIds) ? memoryCitation.threadIds.length : 0;
  const parts = [];
  if (entryCount) parts.push(`${entryCount} 条记忆引用`);
  if (threadCount) parts.push(`${threadCount} 个会话`);
  return parts.length ? parts.join(" · ") : "";
}

function asyncQuestions(questions) {
  return (Array.isArray(questions) ? questions : [])
    .map((question) => ({
      title: typeof question?.title === "string" ? question.title.trim() : "",
      options: Array.isArray(question?.options)
        ? question.options.filter((option) => typeof option === "string" && option.trim()).slice(0, 12)
        : null,
    }))
    .filter((question) => question.title)
    .slice(0, 8);
}

function webSearchResultSummary(results) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return "";
  return ` · ${rows.length} 条结果`;
}

function fileNameFromPath(value, fallback = "image") {
  const parts = String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  return parts.at(-1) || fallback;
}

function message(id, role, text, time, extra = {}) {
  return {
    id: String(id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    role,
    text: String(text || "").slice(0, 12000),
    time,
    mocked: false,
    ...extra,
  };
}

function itemMessages(item, time, options = {}) {
  if (!item || typeof item !== "object") return [];

  if (item.type === "agentMessage") {
    if (!item.text) return [];
    const questions = asyncQuestions(item.questions);
    const details = {
      kind: "agentMessage",
      phase: item.phase || null,
      delivery: item.delivery || null,
      questions,
      memoryCitation: item.memoryCitation || null,
      memoryCitationSummary: memoryCitationSummary(item.memoryCitation),
    };
    const hasDetails = Boolean(details.phase || details.delivery || details.questions.length || details.memoryCitationSummary);
    return [message(item.id, "codex", displayProjectPathText(item.text, options), time, { messageType: item.type, ...(hasDetails ? { details } : {}) })];
  }

  if (item.type === "userMessage") {
    const text = summarizeUserInputs(item.content);
    const attachments = mergeAttachments(userInputAttachments(item.content), uploadedAttachmentsFromText(text, options));
    return text || attachments.length ? [message(item.id, "user", text || "请查看我上传的附件。", time, { messageType: item.type, attachments })] : [];
  }

  if (item.type === "hookPrompt") {
    const summary = hookPromptSummary(item);
    return [
      message(item.id, "codex", summary.text, time, {
        messageType: item.type,
        status: "hook recorded",
        details: {
          kind: "hookPrompt",
          fragments: summary.fragments,
          fragmentCount: summary.fragments.length,
        },
      }),
    ];
  }

  if (item.type === "plan") {
    return [message(item.id, "codex", displayProjectPathText(item.text || "计划已更新。", options), time, { messageType: item.type, status: "plan" })];
  }

  if (item.type === "functionCallOutput") {
    const output = structuredPreview(item.output, 5000);
    const name = `${item.namespace ? `${item.namespace}.` : ""}${item.name || "function"}`;
    return [
      message(item.id, "codex", `函数结果: ${name}`, time, {
        messageType: item.type,
        status: "tool completed",
        details: {
          kind: "functionCallOutput",
          name: item.name || null,
          namespace: item.namespace || null,
          output,
        },
      }),
    ];
  }

  if (item.type === "commandExecution") {
    const status = normalizeCommandStatus(item.status);
    const stats = outputStats(item.aggregatedOutput || "");
    const exit = typeof item.exitCode === "number" ? ` · 退出码 ${item.exitCode}` : "";
    const output = stats.outputLineCount ? ` · 输出 ${stats.outputLineCount} 行${stats.outputTruncated ? "（已截断）" : ""}` : "";
    const duration = typeof item.durationMs === "number" ? ` · ${item.durationMs}ms` : "";
    const text = `运行命令: ${inlineCommand(item.command)}${exit}${duration}${output}${commandActionsSummary(item.commandActions)}`;
    return [
      message(item.id, "codex", text, time, {
        messageType: item.type,
        status: `command ${status}`,
        details: {
          kind: "command",
          command: item.command || "",
          cwd: item.cwd || null,
          exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
          processId: item.processId || null,
          source: item.source || null,
          pluginId: item.pluginId || null,
          scriptPath: item.scriptPath || null,
          status,
          commandActions: Array.isArray(item.commandActions) ? item.commandActions : [],
          output: stats.output,
          outputLineCount: stats.outputLineCount,
          outputLength: stats.outputLength,
          outputTruncated: stats.outputTruncated,
        },
      }),
    ];
  }

  if (item.type === "fileChange") {
    const summary = summarizeFileChanges(item, options);
    return [
      message(item.id, "codex", summary.text, time, {
        messageType: item.type,
        status: summary.status,
        details: {
          kind: "fileChange",
          changes: toFileChanges(item.changes, options),
          status: normalizeFileChangeStatus(item.status),
        },
      }),
    ];
  }

  if (item.type === "mcpToolCall") {
    const status = item.status ? String(item.status) : "unknown";
    const duration = typeof item.durationMs === "number" ? ` · ${item.durationMs}ms` : "";
    const error = item.error?.message ? ` · 错误 ${inlineStructuredValue(item.error.message, "", 120)}` : "";
    const text = `MCP 工具调用: ${item.server || "mcp"} / ${item.tool || "tool"}${duration}${error || mcpResultSummary(item.result)}`;
    return [
      message(item.id, "codex", text, time, {
        messageType: item.type,
        status: `mcp ${status}`,
        details: {
          kind: "mcp",
          server: item.server || null,
          tool: item.tool || null,
          status,
          arguments: item.arguments ?? item.input ?? null,
          result: item.result ?? null,
          error: item.error ?? null,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
          pluginId: item.pluginId ?? null,
          appContext: item.appContext ?? null,
          mcpAppResourceUri: item.mcpAppResourceUri || null,
          readOnlyHint: typeof item.readOnlyHint === "boolean" ? item.readOnlyHint : null,
        },
      }),
    ];
  }

  if (item.type === "dynamicToolCall") {
    const status = item.status ? String(item.status) : "unknown";
    const duration = typeof item.durationMs === "number" ? ` · ${item.durationMs}ms` : "";
    const outcome = typeof item.success === "boolean" ? ` · ${item.success ? "成功" : "失败"}` : "";
    const text = `工具调用: ${item.namespace ? `${item.namespace}.` : ""}${item.tool || "tool"}${duration}${outcome}${dynamicToolContentSummary(item.contentItems)}`;
    return [
      message(item.id, "codex", text, time, {
        messageType: item.type,
        status: `tool ${status}`,
        details: {
          kind: "tool",
          namespace: item.namespace || null,
          tool: item.tool || null,
          status,
          success: typeof item.success === "boolean" ? item.success : null,
          arguments: item.arguments ?? item.input ?? null,
          contentItems: Array.isArray(item.contentItems) ? item.contentItems : null,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
        },
      }),
    ];
  }

  if (item.type === "collabAgentToolCall") {
    const status = item.status ? String(item.status) : "unknown";
    const text = `协作 Agent: ${item.tool || "agent"}${collabAgentSummary(item)}`;
    return [
      message(item.id, "codex", text, time, {
        messageType: item.type,
        status: `agent ${status}`,
        details: {
          kind: "collabAgent",
          tool: item.tool || null,
          status,
          senderThreadId: item.senderThreadId || null,
          receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [],
          prompt: item.prompt || null,
          model: item.model || null,
          reasoningEffort: item.reasoningEffort || null,
          agentsStates: item.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : {},
        },
      }),
    ];
  }

  if (item.type === "subAgentActivity") {
    const state = item.kind ? String(item.kind) : "unknown";
    return [
      message(item.id, "codex", `子 Agent ${state}: ${item.agentPath || item.agentThreadId || "agent"}`, time, {
        messageType: item.type,
        status: `agent ${state}`,
        details: {
          kind: "subAgentActivity",
          activity: state,
          agentThreadId: item.agentThreadId || null,
          agentPath: item.agentPath || null,
        },
      }),
    ];
  }

  if (item.type === "webSearch") {
    const results = Array.isArray(item.results) ? item.results.slice(0, 20) : [];
    return [
      message(item.id, "codex", `联网搜索: ${item.query || ""}${webSearchResultSummary(item.results)}`.trim(), time, {
        messageType: item.type,
        status: "webSearch",
        details: {
          kind: "webSearch",
          query: item.query || "",
          action: item.action || null,
          results,
          resultCount: Array.isArray(item.results) ? item.results.length : 0,
        },
      }),
    ];
  }

  if (item.type === "imageView") {
    const imagePath = item.path || "";
    return [
      message(item.id, "codex", imagePath ? `查看图片: ${fileNameFromPath(imagePath)}` : "查看图片。", time, {
        messageType: item.type,
        status: "image",
        details: { kind: "imageView", path: imagePath, name: fileNameFromPath(imagePath) },
      }),
    ];
  }

  if (item.type === "sleep") {
    const durationMs = Number(item.durationMs || 0);
    const durationText = durationMs >= 1000 ? `${Math.round(durationMs / 100) / 10} 秒` : `${durationMs} 毫秒`;
    return [
      message(item.id, "codex", `等待 ${durationText}`, time, {
        messageType: item.type,
        status: "sleep completed",
        details: { kind: "sleep", durationMs },
      }),
    ];
  }

  if (item.type === "imageGeneration") {
    const savedPath = item.savedPath || "";
    const failure = item.failure && typeof item.failure === "object" ? item.failure : null;
    const result = truncateOutput(item.result || "", 3000);
    const failedText = failure?.type === "usageLimitExceeded" ? "图片生成额度已用尽" : failure ? "图片生成失败" : "";
    return [
      message(item.id, "codex", failedText || (savedPath ? `生成图片: ${fileNameFromPath(savedPath)}` : "图片生成已更新。"), time, {
        messageType: item.type,
        status: failure ? "failed" : item.status || "imageGeneration",
        details: {
          kind: "imageGeneration",
          status: item.status || null,
          savedPath,
          name: fileNameFromPath(savedPath),
          revisedPrompt: item.revisedPrompt || null,
          transparentBackground: item.transparentBackground === true,
          failure,
          result,
        },
      }),
    ];
  }

  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return [message(item.id, "codex", item.review || item.type, time, { messageType: item.type, status: "review" })];
  }

  if (item.type === "contextCompaction") {
    return [message(item.id, "codex", "上下文已压缩。", time, { messageType: item.type, status: "compact" })];
  }

  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
    const content = Array.isArray(item.content) ? item.content.filter((value) => typeof value === "string") : [];
    const text = summary || (content.length ? "推理内容已更新。" : "");
    return text
      ? [
          message(item.id, "codex", text, time, {
            messageType: item.type,
            status: "reasoning",
            details: {
              kind: "reasoning",
              summary: Array.isArray(item.summary) ? item.summary : [],
              content,
            },
          }),
        ]
      : [];
  }

  const rawType = item.type ? String(item.type) : "unknown";
  const rawStatus = item.status ? String(item.status) : "";
  const fieldNames = Object.keys(item)
    .filter((key) => !["id", "type", "status"].includes(key))
    .slice(0, 8);
  const text = [
    `未识别的 Codex 事件: ${rawType}`,
    rawStatus ? `状态 ${rawStatus}` : "",
    fieldNames.length ? `字段 ${fieldNames.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    message(item.id, "codex", text, time, {
      messageType: rawType,
      status: rawStatus ? `unknown ${rawStatus}` : "unknown",
      details: {
        kind: "unknownItem",
        rawType,
        rawStatus: rawStatus || null,
        fields: fieldNames,
        rawPreview: structuredPreview(item),
      },
    }),
  ];
}

function turnTime(turn, thread) {
  return toIso(turn?.completedAt || turn?.startedAt || thread?.updatedAt || thread?.createdAt);
}

export function normalizeAppServerThreadMessages(thread = {}, options = {}) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const messages = [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex] || {};
    const time = turnTime(turn, thread);
    const items = Array.isArray(turn.items) ? turn.items : Array.isArray(turn.itemsView?.items) ? turn.itemsView.items : [];
    for (const item of items) {
      for (const itemMessage of itemMessages(item, time, options)) {
        messages.push({ ...itemMessage, turnId: turn.id || null, turnIndex });
      }
    }
    const errorText =
      turn.status === "failed" && turn.error && typeof turn.error === "object" && typeof turn.error.message === "string"
        ? turn.error.message.trim()
        : "";
    if (errorText) {
      messages.push(message(`${turn.id || `turn-${turnIndex}`}-error`, "codex", displayProjectPathText(errorText, options), time, { messageType: "turnError", status: "failed" }));
    }
  }
  return messages;
}
