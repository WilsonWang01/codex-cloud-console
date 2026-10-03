import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const maxBytes = 8 * 1024 * 1024;
const fail = (message, code = "image_result_unavailable") => {
  throw Object.assign(new Error(message), { statusCode: 502, code });
};
const within = (root, target) => target !== root && !path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== ".." && !path.isAbsolute(path.relative(root, target));

function imageBytes(data) {
  if (typeof data !== "string" || !data.length || data.length > Math.ceil(maxBytes / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    fail("生成图片没有可用的标准 Base64 结果");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) fail("生成图片编码无效");
  return bytes;
}

async function savedImage(target, root) {
  if (!root || !path.isAbsolute(target) || !within(path.resolve(root), path.resolve(target))) fail("生成图片路径不在允许目录");
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  if (!within(realRoot, realTarget)) fail("生成图片符号链接指向允许目录之外");
  const file = await fs.open(realTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail("生成图片不是普通文件或超过 8 MiB", "image_output_too_large");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail("生成图片在读取期间发生变化");
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("生成图片在读取期间发生变化");
    return bytes;
  } finally { await file.close(); }
}

function imageMime(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) return "image/jpeg";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  fail("生成图片不是受支持的 PNG/JPEG/WebP 栅格数据");
}

// Only exact-turn imageGeneration items are exportable, never paths found in model text or tool logs.
export async function modelApiTurnResult(thread, turnId, { generatedImagesRoot } = {}) {
  const turn = thread?.turns?.find((item) => item.id === turnId);
  if (!turn || !Array.isArray(turn.items)) fail("完整回合结果不可用", "result_unavailable");
  const images = [];
  let total = 0;
  let summary = "";
  for (const item of turn.items) {
    if (item.type === "agentMessage") {
      if (typeof item.text !== "string") fail("回合文本格式不可用", "result_unavailable");
      summary += item.text;
    }
    if (item.type !== "imageGeneration") continue;
    if (item.failure || item.status !== "completed") fail("图片生成未成功完成，请查询后台任务", "image_generation_failed");
    if (images.length >= 4) fail("图片输出最多 4 张、总计 8 MiB", "image_output_too_large");
    let bytes;
    try {
      bytes = item.savedPath ? await savedImage(item.savedPath, generatedImagesRoot) : imageBytes(item.result);
    } catch (error) {
      if (error.statusCode) throw error;
      fail("生成图片文件暂不可读；请使用原幂等键重试");
    }
    total += bytes.length;
    if (total > maxBytes) fail("图片输出总计超过 8 MiB", "image_output_too_large");
    if (item.revisedPrompt && (typeof item.revisedPrompt !== "string" || Buffer.byteLength(item.revisedPrompt) > 64 * 1024)) fail("图片提示信息超过允许范围", "image_output_too_large");
    images.push({ id: String(item.id), b64_json: bytes.toString("base64"), media_type: imageMime(bytes),
      ...(item.revisedPrompt ? { revised_prompt: String(item.revisedPrompt) } : {}) });
  }
  if (Buffer.byteLength(summary) > 4 * 1024 * 1024) fail("文本输出超过 4 MiB", "output_too_large");
  return { summary, images };
}

export function responsesBody(run) {
  const text = run.summary || "";
  return {
    id: `resp_${run.id}`, object: "response", created_at: Math.floor(Date.parse(run.startedAt) / 1000),
    status: "completed", model: run.model, error: null, incomplete_details: null,
    output: [
      ...(text ? [{ id: `msg_${run.id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] : []),
      ...(run.images || []).map((image) => ({ id: image.id, type: "image_generation_call", status: "completed", result: image.b64_json, output_format: image.media_type.slice(6),
        ...(image.revised_prompt ? { revised_prompt: image.revised_prompt } : {}) })),
    ],
    usage: run.usage?.status === "complete" ? {
      input_tokens: run.usage.inputTokens, output_tokens: run.usage.outputTokens, total_tokens: run.usage.totalTokens,
      input_tokens_details: { cached_tokens: run.usage.cachedInputTokens ?? null },
      output_tokens_details: { reasoning_tokens: run.usage.reasoningOutputTokens ?? null },
    } : null,
    store: false, parallel_tool_calls: false,
  };
}
