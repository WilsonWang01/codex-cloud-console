import crypto from "node:crypto";

const approvalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "mcpServer/elicitation/request",
  "item/tool/requestUserInput",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function approvalDigest(method, params) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical({ method, params }))).digest("hex");
}

function denied(method, reason) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: { denied: { rejection: reason } } };
  }
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  throw new Error(reason);
}

function accepted(method, params, input) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: "accept" };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: "approved" };
  if (method === "item/permissions/requestApproval") {
    const requested = params.permissions;
    if (!requested || typeof requested !== "object") throw new Error("Missing requested permissions");
    const permissions = {};
    if (requested.network) permissions.network = requested.network;
    if (requested.fileSystem) permissions.fileSystem = requested.fileSystem;
    if (!Object.keys(permissions).length) throw new Error("Empty permission request");
    return { permissions, scope: "turn" };
  }
  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    if (!questions.length || !input.answers || typeof input.answers !== "object") throw new Error("Answers are required");
    const answers = {};
    for (const question of questions) {
      const value = input.answers[question.id];
      if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`Answer is required for ${question.id}`);
      }
      answers[question.id] = { answers: value.map((item) => item.trim()) };
    }
    return { answers };
  }
  if (method === "mcpServer/elicitation/request") {
    if (params.mode === "url") throw new Error("URL elicitation cannot be accepted in the console");
    if (!input.content || typeof input.content !== "object" || Array.isArray(input.content)) {
      throw new Error("Structured elicitation content is required");
    }
    return { action: "accept", content: input.content, _meta: null };
  }
  throw new Error("Unsupported approval method");
}

export function createApprovalBroker({ timeoutMs = 5 * 60_000, onChange = () => {} } = {}) {
  const pending = new Map();
  const list = () => [...pending.values()].map(({ resolve, timer, ...item }) => item);

  function settle(item, input, reason = "") {
    if (!pending.has(item.id)) return false;
    let result;
    if (input.decision === "accept") {
      result = accepted(item.method, item.params, input);
    } else {
      try { result = denied(item.method, reason || "Request declined"); }
      catch (error) { result = error; }
    }
    pending.delete(item.id);
    clearTimeout(item.timer);
    item.resolve(result);
    onChange({ id: item.id, method: item.method, owner: item.owner, digest: item.digest, outcome: input.decision === "accept" ? "accepted" : "declined" });
    return true;
  }

  return {
    list,
    request(method, params = {}, owner = {}) {
      if (!approvalMethods.has(method)) return Promise.reject(new Error(`Unsupported app-server request: ${method}`));
      const id = crypto.randomUUID();
      const item = {
        id,
        method,
        params,
        digest: approvalDigest(method, params),
        owner: { repoId: owner.repoId || null, sessionId: owner.sessionId || null },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      };
      return new Promise((resolve, reject) => {
        item.resolve = (result) => result instanceof Error ? reject(result) : resolve(result);
        item.timer = setTimeout(() => {
          try { settle(item, { decision: "decline" }, "Approval timed out"); }
          catch (error) { pending.delete(id); reject(error); }
        }, timeoutMs);
        item.timer.unref?.();
        pending.set(id, item);
        onChange({ id, method, owner: item.owner, digest: item.digest, outcome: "pending" });
      });
    },
    decide(id, input = {}) {
      const item = pending.get(id);
      if (!item) throw Object.assign(new Error("Approval is missing or expired"), { statusCode: 410 });
      if (Date.now() >= Date.parse(item.expiresAt)) {
        settle(item, { decision: "decline" }, "Approval timed out");
        throw Object.assign(new Error("Approval expired"), { statusCode: 410 });
      }
      if (input.digest !== item.digest) throw Object.assign(new Error("Approval parameters changed"), { statusCode: 409 });
      if (!["accept", "decline"].includes(input.decision)) throw Object.assign(new Error("Invalid decision"), { statusCode: 400 });
      return settle(item, input);
    },
    closeAll(reason = "App-server disconnected") {
      for (const item of [...pending.values()]) {
        try { settle(item, { decision: "decline" }, reason); }
        catch (error) {
          pending.delete(item.id);
          clearTimeout(item.timer);
          item.resolve(error);
        }
      }
    },
    closeForRepo(repoId, reason = "App-server disconnected") {
      for (const item of [...pending.values()].filter((entry) => entry.owner.repoId === repoId)) {
        try { settle(item, { decision: "decline" }, reason); }
        catch (error) {
          pending.delete(item.id);
          clearTimeout(item.timer);
          item.resolve(error);
        }
      }
    },
  };
}
