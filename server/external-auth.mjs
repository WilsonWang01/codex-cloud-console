export function externalApiToken(req, { allowLegacyBasic = false } = {}) {
  const authorization = String(req.get("authorization") || "");
  const bearer = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
  const legacy = String(req.get("x-codex-cloud-token") || "").trim();
  if (authorization && !bearer && !(allowLegacyBasic && legacy && /^Basic [^\s]+$/i.test(authorization))) {
    throw Object.assign(new Error("无效的 API 认证信息"), { statusCode: 401, code: "invalid_authentication" });
  }
  const tokens = [bearer, String(req.get("x-api-key") || "").trim(), legacy].filter(Boolean);
  if (new Set(tokens).size > 1) throw Object.assign(new Error("API 认证信息冲突"), { statusCode: 401, code: "conflicting_authentication" });
  return tokens[0] || null;
}
