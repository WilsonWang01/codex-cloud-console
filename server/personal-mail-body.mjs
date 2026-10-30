import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { compile } from "html-to-text";
import { z } from "zod";
import { sourceError as fail } from "./personal-source.mjs";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const mailSourceReference = z.object({ accountId: id, messageId: id, itemVersion: hash, snapshotVersion: hash }).strict();
export const mailBodyInput = z.object({ timeZone: z.string().min(1).max(80), source: mailSourceReference, confirm: z.literal(true) }).strict();
export const mailBodyLimits = Object.freeze({ inputBytes: 128 * 1024, textBytes: 32 * 1024, parts: 64, depth: 12 });
const omitted = "[CODEX_CLOUD_HTML_LIMIT_REACHED]";
const htmlText = compile({ wordwrap: false, limits: { maxInputLength: mailBodyLimits.inputBytes, maxDepth: 64, maxChildNodes: 5000, ellipsis: omitted },
  selectors: ["img", "script", "style", "iframe", "object", "svg", "head"].map(selector => ({ selector, format: "skip" })).concat([{ selector: "a", options: { ignoreHref: true } }]) });
const unavailable = () => fail("mail_body_unavailable", "正文格式不支持、内容不完整或超过安全上限，请到 Gmail 查看；未另取或解析附件");
const field = (object, camel, snake) => {
  if (object?.[camel] !== undefined && object?.[snake] !== undefined && !isDeepStrictEqual(object[camel], object[snake])) throw unavailable();
  return object?.[camel] === undefined ? object?.[snake] : object[camel];
};

// Only decoded text MIME parts are consumed; attachments and external resources are never fetched.
export function parseMailBody(payload) {
  let count = 0, bytes = 0;
  const walk = (part, depth) => {
    if (!part || typeof part !== "object" || Array.isArray(part) || ++count > mailBodyLimits.parts || depth > mailBodyLimits.depth) throw unavailable();
    if (part.headers !== undefined && !Array.isArray(part.headers) || part.parts !== undefined && !Array.isArray(part.parts) || part.body !== undefined && (!part.body || typeof part.body !== "object" || Array.isArray(part.body))) throw unavailable();
    const filename = field(part, "filename", "file_name"), attachmentId = field(part.body, "attachmentId", "attachment_id");
    if (filename != null && typeof filename !== "string" || attachmentId != null && typeof attachmentId !== "string") throw unavailable();
    if (filename || attachmentId || part.headers?.some(header => typeof header?.name === "string" && header.name.toLowerCase() === "content-disposition" && /^attachment(?:;|$)/i.test(header.value?.trim() || ""))) return { text: "", plain: false };
    const mime = field(part, "mimeType", "mime_type");
    if (typeof mime !== "string") throw unavailable();
    if (mime.startsWith("multipart/")) {
      if (!["multipart/alternative", "multipart/mixed", "multipart/related", "multipart/signed"].includes(mime) || !Array.isArray(part.parts) || !part.parts.length) throw unavailable();
      const parts = part.parts.map(child => walk(child, depth + 1));
      if (mime === "multipart/alternative") return parts.find(child => child.plain && child.text) || parts.find(child => child.text) || { text: "", plain: false };
      return { text: parts.map(child => child.text).filter(Boolean).join("\n\n"), plain: false };
    }
    if (!["text/plain", "text/html"].includes(mime)) return { text: "", plain: false };
    if (typeof part.body?.content !== "string" || part.parts?.length) throw unavailable();
    bytes += Buffer.byteLength(part.body.content);
    if (bytes > mailBodyLimits.inputBytes) throw unavailable();
    const text = mime === "text/html" ? htmlText(part.body.content) : part.body.content;
    if (text.includes(omitted)) throw unavailable();
    return { text, plain: mime === "text/plain" };
  };
  const text = walk(payload, 0).text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  if (!text || Buffer.byteLength(text) > mailBodyLimits.textBytes) throw unavailable();
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
