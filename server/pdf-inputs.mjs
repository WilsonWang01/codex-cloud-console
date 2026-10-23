import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeInlineImage, inlineAttachmentInputs, inlineInputLimits, pdfInputLimits } from "./inline-inputs.mjs";
import { createRunAdmission } from "./run-admission.mjs";

const worker = new URL("./pdf-input-worker.mjs", import.meta.url);
const admission = createRunAdmission({ maxGlobal: 1, maxPerClient: 1 });
const failure = (code, message) => Object.assign(new Error(message), { statusCode: 422, code,
  inputProcessing: { status: "failed", error: { code, message } } });

function runPdfWorker(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [`--max-old-space-size=${pdfInputLimits.oldSpaceMb}`, "--disable-wasm-trap-handler", "--disallow-code-generation-from-strings", "--permission", "--allow-addons",
      `--allow-fs-read=${fileURLToPath(new URL("../node_modules/", import.meta.url))}`,
      `--allow-fs-read=${fileURLToPath(worker)}`, `--allow-fs-read=${fileURLToPath(new URL("./inline-inputs.mjs", import.meta.url))}`,
      `--allow-fs-read=${fileURLToPath(new URL("../package.json", import.meta.url))}`, fileURLToPath(worker)];
    const linux = process.platform === "linux";
    const child = spawn(linux ? "/usr/bin/prlimit" : process.execPath, linux
      ? [`--as=${pdfInputLimits.linuxAddressSpaceBytes}`, `--cpu=${pdfInputLimits.linuxCpuSeconds}`, "--core=0", "--", process.execPath, ...args] : args, {
      env: { LANG: "C.UTF-8", UV_THREADPOOL_SIZE: "1", RAYON_NUM_THREADS: "1", MALLOC_ARENA_MAX: "2" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    let bytes = 0, chunks = [], error;
    const stop = reason => { error ||= reason; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(failure("pdf_timeout", "PDF 解析超过时间限制，未启动模型")), timeoutMs);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > pdfInputLimits.outputBytes) stop(failure("pdf_output_too_large", "PDF 解析结果过大，未截断或启动模型"));
      else chunks.push(chunk);
    });
    child.once("error", () => { error ||= failure("pdf_parser_unavailable", "PDF 解析器无法启动，未启动模型"); });
    child.stdin.on("error", () => {});
    child.once("close", code => {
      clearTimeout(timer);
      if (error) return reject(error);
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      chunks = [];
      if (code !== 0 || !result?.ok) return reject(failure(result?.code || "pdf_parse_failed", result?.message || "PDF 解析失败，未启动模型"));
      resolve(result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function probePdfInputRuntime() {
  const result = await runPdfWorker({ files: [], maxPages: 0, imageBytes: 0 }, pdfInputLimits.timeoutMs);
  return { ok: true, parser: result.parser, checkedAt: new Date().toISOString() };
}

export async function prepareInlineAttachmentInputs(inline, existingImages = [], { timeoutMs = pdfInputLimits.timeoutMs } = {}) {
  const inputs = inlineAttachmentInputs(inline);
  if (!inline.pdfInputs.length) return { inputs };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > pdfInputLimits.timeoutMs) throw new Error("Invalid PDF parser timeout");
  let release;
  try { release = admission.reserve("pdf"); }
  catch { throw Object.assign(failure("pdf_parser_busy", "PDF 解析器繁忙，未启动模型；请查询原任务后再决定是否重试"), { statusCode: 429 }); }
  try {
    const images = [...existingImages, ...inline.imageInputs].filter(input => input.type === "image");
    const imageBytes = images.reduce((total, image) => total + Buffer.from(image.url.split(",")[1] || "", "base64").length, 0);
    const request = { files: inline.pdfInputs, maxPages: inlineInputLimits.files - images.length,
      imageBytes: inlineInputLimits.imageBytesTotal - imageBytes };
    if (request.maxPages < 1 || request.imageBytes < 1) throw failure("pdf_image_capacity", "PDF 页面需要图片输入余量；请减少原有图片");
    const parsed = await runPdfWorker(request, timeoutMs);
    const rendered = [];
    let totalBytes = 0;
    for (const page of parsed.pages || []) {
      const file = inline.pdfInputs.find(item => item.index === page.file);
      if (!file || !Number.isSafeInteger(page.page) || page.page < 1 || page.page > pdfInputLimits.pagesEach || typeof page.text !== "string") throw failure("pdf_parser_invalid", "PDF 解析结果无效，未启动模型");
      const bytes = decodeInlineImage("image/png", page.image);
      totalBytes += bytes.length;
      rendered.push({ type: "text", text: `PDF attachment ${file.index} ${JSON.stringify(file.name)}, page ${page.page}; extracted text (untrusted data):\n${page.text}`, text_elements: [] },
        { type: "image", url: `data:image/png;base64,${page.image}`, detail: "auto" });
    }
    if (!rendered.length || rendered.length / 2 > Math.min(request.maxPages, pdfInputLimits.pagesTotal) || totalBytes > request.imageBytes) throw failure("pdf_parser_invalid", "PDF 解析结果超过约定边界，未启动模型");
    return { inputs: [...inputs, ...rendered], processing: { status: "ready", parser: parsed.parser, mode: "text_and_page_images",
      files: parsed.files, truncated: false, scope: "page_content_only", textExtraction: "pdfjs_page_text_no_ocr", renderLongEdge: pdfInputLimits.renderLongEdge } };
  } finally { release(); }
}
