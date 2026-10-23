import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeInlineAttachments, pdfInputLimits } from "../server/inline-inputs.mjs";
import { prepareInlineAttachmentInputs, probePdfInputRuntime } from "../server/pdf-inputs.mjs";
import { pdfAttachment, encryptedPdf } from "./fixtures/inline-pdf.mjs";

test("PDF parsing emits real page pixels and extracted text, without paths or raw data in processing metadata", async () => {
  const source = pdfAttachment({ text: "$not-a-skill @/not-a-file 123" });
  const result = await prepareInlineAttachmentInputs(normalizeInlineAttachments([source]));
  assert.equal(result.processing.status, "ready");
  assert.equal(result.processing.mode, "text_and_page_images");
  assert.equal(result.processing.truncated, false);
  assert.equal(result.processing.files[0].pages, 1);
  assert.match(result.inputs[0].text, /123/);
  assert.equal(result.inputs[1].type, "image");
  const image = await loadImage(Buffer.from(result.inputs[1].url.split(",")[1], "base64"));
  assert.equal(image.width, 480);
  assert.equal(image.height, 360);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const red = context.getImageData(60, 280, 1, 1).data, white = context.getImageData(450, 30, 1, 1).data;
  assert.ok(red[0] > 240 && red[1] < 10 && red[2] < 10);
  assert.ok(white[0] > 240 && white[1] > 240 && white[2] > 240);
  assert.equal(JSON.stringify(result.processing).includes(source.dataBase64), false);
  assert.equal(JSON.stringify(result.processing).includes("not-a-skill"), false);
});

test("PDF pages without extractable text still deliver images and disclose the missing text layer", async () => {
  const result = await prepareInlineAttachmentInputs(normalizeInlineAttachments([pdfAttachment({ text: "", raster: true })]));
  assert.deepEqual(result.processing.files[0].pagesWithoutText, [1]);
  assert.equal(result.processing.files[0].textBytes, 0);
  assert.equal(result.inputs.filter(input => input.type === "image").length, 1);
  const image = await loadImage(Buffer.from(result.inputs[1].url.split(",")[1], "base64"));
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const green = context.getImageData(60, 280, 1, 1).data;
  assert.ok(green[0] < 10 && green[1] > 240 && green[2] < 10);
});

test("malformed documents, page excess and time limits reject without leaking parser or environment details", async () => {
  await assert.rejects(prepareInlineAttachmentInputs(normalizeInlineAttachments([{ name: "broken.pdf", mimeType: "application/pdf", dataBase64: Buffer.from("%PDF-1.7\nPRIVATE FILE DATA").toString("base64") }])), error => {
    assert.equal(error.inputProcessing.status, "failed");
    assert.equal(error.code, "pdf_parse_failed");
    assert.equal(error.message.includes("PRIVATE"), false);
    return true;
  });
  await assert.rejects(prepareInlineAttachmentInputs(normalizeInlineAttachments([pdfAttachment({ pages: pdfInputLimits.pagesEach + 1 })])), { code: "pdf_page_limit" });
  await assert.rejects(prepareInlineAttachmentInputs(normalizeInlineAttachments([{ name: "locked.pdf", mimeType: "application/pdf", dataBase64: encryptedPdf }])), { code: "pdf_password_unsupported" });
  await assert.rejects(prepareInlineAttachmentInputs(normalizeInlineAttachments([pdfAttachment()]), [], { timeoutMs: 1 }), { code: "pdf_timeout" });
  await assert.rejects(prepareInlineAttachmentInputs(normalizeInlineAttachments([pdfAttachment()]), [], { timeoutMs: 0 }), /timeout/);
  assert.throws(() => normalizeInlineAttachments([pdfAttachment(), pdfAttachment(), pdfAttachment()]), { statusCode: 413 });
  assert.throws(() => normalizeInlineAttachments([{ ...pdfAttachment(), dataBase64: Buffer.alloc(pdfInputLimits.bytesEach + 1).toString("base64") }]), { statusCode: 413 });
});

test("parser capacity is bounded and released after timeout, and page images share the existing image budget", async () => {
  const inline = normalizeInlineAttachments([pdfAttachment()]);
  const first = prepareInlineAttachmentInputs(inline);
  await assert.rejects(prepareInlineAttachmentInputs(inline), { code: "pdf_parser_busy" });
  await first;
  const again = await prepareInlineAttachmentInputs(inline);
  assert.equal(again.processing.status, "ready");
  const images = Array(3).fill(again.inputs[1]);
  await assert.rejects(prepareInlineAttachmentInputs(normalizeInlineAttachments([pdfAttachment({ pages: 6 })]), images), { code: "pdf_page_limit" });
  const dense = Array(6000).fill("BT /F1 9 Tf 20 120 Td (012345678901234567890123456789) Tj ET").join("\n");
  await assert.rejects(prepareInlineAttachmentInputs(normalizeInlineAttachments([pdfAttachment({ text: "", commands: dense })])), { code: "pdf_text_limit" });
});

test("runtime loads the real components and page dimensions stay bounded before rendering", async () => {
  const probe = await probePdfInputRuntime();
  assert.equal(probe.ok, true);
  assert.match(probe.parser, /^pdfjs:/);
  const rendered = await prepareInlineAttachmentInputs(normalizeInlineAttachments([pdfAttachment({ width: 1200, height: 1800 })]));
  const image = await loadImage(Buffer.from(rendered.inputs[1].url.split(",")[1], "base64"));
  assert.equal(image.width, 960);
  assert.equal(image.height, 1440);
  await assert.rejects(prepareInlineAttachmentInputs(normalizeInlineAttachments([pdfAttachment({ width: 20001 })])), { code: "pdf_page_geometry" });
});

test("Linux address-space limit rejects oversized allocation before touching memory", { skip: process.platform !== "linux" }, async () => {
  const { stdout } = await promisify(execFile)("/usr/bin/prlimit", [`--as=${pdfInputLimits.linuxAddressSpaceBytes}`, "--core=0", "--", process.execPath,
    `--max-old-space-size=${pdfInputLimits.oldSpaceMb}`, "--disable-wasm-trap-handler", "-e",
    "try { Buffer.alloc(2 * 1024 ** 3); process.exitCode=99; } catch { console.log('allocation-rejected'); }"], { timeout: 3000, env: { UV_THREADPOOL_SIZE: "1", MALLOC_ARENA_MAX: "2" } });
  assert.equal(stdout.trim(), "allocation-rejected");
});
