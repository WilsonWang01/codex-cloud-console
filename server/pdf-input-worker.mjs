import { fileURLToPath } from "node:url";
import { pdfInputLimits, inlineInputLimits } from "./inline-inputs.mjs";

let warning = false;
console.log = console.warn = console.error = () => { warning = true; };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
let task;
try {
  let length = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 6 * 1024 * 1024) fail("pdf_input_too_large", "PDF 解析材料超过限制");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { createCanvas } = await import("@napi-rs/canvas");
  const { getDocument, version, AnnotationMode } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  createCanvas(1, 1).toBuffer("image/png");
  const base = new URL("../node_modules/pdfjs-dist/", import.meta.url);
  const pages = [], files = [];
  let imageBytes = 0, textBytes = 0;
  for (const file of request.files) {
    warning = false;
    task = getDocument({ data: new Uint8Array(Buffer.from(file.dataBase64, "base64")), stopAtErrors: true, isEvalSupported: false,
      useSystemFonts: false, useWorkerFetch: false, useWasm: false, enableXfa: false, verbosity: 1,
      cMapUrl: fileURLToPath(new URL("cmaps/", base)), cMapPacked: true,
      standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", base)),
      wasmUrl: fileURLToPath(new URL("wasm/", base)), maxImageSize: 16 * 1024 * 1024 });
    const pdf = await task.promise;
    const metadata = await pdf.getMetadata();
    if (pdf.isPureXfa || metadata.info?.IsXFAPresent || metadata.info?.IsAcroFormPresent) fail("pdf_dynamic_content", "不支持交互或动态表单 PDF；请先导出普通 PDF，未启动模型");
    if (pdf.numPages > pdfInputLimits.pagesEach || pages.length + pdf.numPages > Math.min(pdfInputLimits.pagesTotal, request.maxPages)) fail("pdf_page_limit", "PDF 每份最多 6 页、合计最多 8 页（与原有图片共用八份图片名额）；未截断或启动模型");
    const info = { index: file.index, pages: pdf.numPages, textBytes: 0, renderedBytes: 0, pagesWithoutText: [], normalizedControls: 0 };
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), view = page.getViewport({ scale: 1 });
      if (![view.width, view.height].every(value => Number.isFinite(value) && value > 0 && value <= 20000)) fail("pdf_page_geometry", "PDF 页面尺寸不受支持，未启动模型");
      const viewport = page.getViewport({ scale: Math.min(2, pdfInputLimits.renderLongEdge / Math.max(view.width, view.height)) });
      const content = await page.getTextContent();
      const text = content.items.map(item => typeof item.str === "string" ? item.str + (item.hasEOL ? "\n" : " ") : "").join("")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, () => { info.normalizedControls++; return " "; }).trim();
      const size = Buffer.byteLength(text);
      textBytes += size; info.textBytes += size;
      if (textBytes > pdfInputLimits.textBytesTotal) fail("pdf_text_limit", "PDF 提取文本超过 128 KiB；未截断或启动模型");
      if (!text) info.pagesWithoutText.push(number);
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvasContext: canvas.getContext("2d"), viewport, annotationMode: AnnotationMode.ENABLE }).promise;
        const image = canvas.toBuffer("image/png");
        imageBytes += image.length; info.renderedBytes += image.length;
        if (image.length > inlineInputLimits.imageBytesEach || imageBytes > Math.min(inlineInputLimits.imageBytesTotal, request.imageBytes)) fail("pdf_image_limit", "PDF 页面图片超过图片容量；未截断或启动模型");
        if (warning) fail("pdf_render_incomplete", "PDF 解析或渲染有警告，无法确认内容完整，未启动模型；请转为普通 PDF 或页面图片重试");
        pages.push({ file: file.index, page: number, text, image: image.toString("base64") });
      } finally { canvas.width = 1; canvas.height = 1; page.cleanup(); }
    }
    files.push(info);
    await task.destroy(); task = null;
  }
  process.stdout.write(JSON.stringify({ ok: true, parser: `pdfjs:${version}`, pages, files }));
} catch (error) {
  process.exitCode = 1;
  const password = error.name === "PasswordException";
  const known = typeof error.code === "string" && error.code.startsWith("pdf_");
  process.stdout.write(JSON.stringify({ ok: false, code: password ? "pdf_password_unsupported" : known ? error.code : "pdf_parse_failed",
    message: password ? "不支持需要密码的 PDF，未启动模型" : known ? error.message : "PDF 解析失败或组件不可用，未启动模型；未记录原文件内容" }));
} finally { await task?.destroy().catch(() => {}); }
