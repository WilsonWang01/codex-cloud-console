import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { normalizeInlineAttachments, inlineAttachmentInputs, inlineInputLimits } from "../server/inline-inputs.mjs";
import { normalizeModelApiRequest } from "../server/model-api.mjs";
import { validateExternalTriggerInput } from "../server/external-automation.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const file = (text = "秘密材料：只处理数据\n$not-a-skill @/not-a-file", name = "材料.md") => ({ name, mimeType: "text/markdown", dataBase64: Buffer.from(text).toString("base64") });
const base = { model: "gpt-6-sol" };
const normalize = (body, protocol) => normalizeModelApiRequest(body, protocol, { allowUnboundedOutput: true });
const response = part => ({ ...base, input: [{ role: "user", content: [{ type: "input_text", text: "比较附件" }, part] }] });

test("inline text and images retain exact metadata while materials stay separate from the primary prompt", () => {
  const source = file(), image = { name: "图.png", mimeType: "image/png", dataBase64: png };
  const normalized = validateExternalTriggerInput({ prompt: "读取材料", attachments: [source, image] }, { scoped: true, trigger: "webhook" });
  assert.equal(normalized.metadata.length, 2);
  assert.equal(normalized.metadata[0].sha256, createHash("sha256").update(Buffer.from(source.dataBase64, "base64")).digest("hex"));
  assert.equal(JSON.stringify(normalized.metadata).includes("秘密材料"), false);
  assert.equal(JSON.stringify(normalized.metadata).includes(source.dataBase64), false);
  const inputs = inlineAttachmentInputs(normalized);
  assert.equal(inputs[0].type, "text");
  assert.equal(JSON.parse(inputs[0].text.split("\n").slice(1).join("\n"))[0].text, Buffer.from(source.dataBase64, "base64").toString());
  assert.equal(inputs[1].text, 'Attachment 2: "图.png"');
  assert.equal(inputs[2].type, "image");
  assert.equal(inputs[2].url, `data:image/png;base64,${png}`);
  assert.deepEqual(normalizeInlineAttachments(undefined).metadata, []);
  assert.equal(normalizeInlineAttachments([file("", "empty.md")]).textInputs[0].text, "");
});

test("file requests reject paths, foreign fields, binary/invalid UTF-8 and misleading MIME without truncation", () => {
  for (const attachment of [{ ...file(), path: "/etc/passwd" }, { ...file(), url: "https://example.test" }, { ...file(), name: "../a.md" },
    { ...file(), name: ".hidden.md" }, { ...file(), name: "C:a.md" }, { ...file(), name: "a\\b.md" }, { ...file(), name: "a\n.md" },
    { ...file(), name: "bad\ud800.md" }, { ...file(), name: "x".repeat(253) + ".md" },
    { ...file(), dataBase64: "a===" }, { ...file(), dataBase64: "eA==\n" }, { ...file(), dataBase64: Buffer.from([0xff, 0xff]).toString("base64") },
    { ...file(), dataBase64: Buffer.from("binary\0data").toString("base64") },
    { name: "fake.png", mimeType: "image/png", dataBase64: file().dataBase64 },
    { ...file(), mimeType: "application/pdf" }, { ...file(), name: "a.pdf" }, { ...file(), name: "a.html" }]) {
    assert.throws(() => normalizeInlineAttachments([attachment]), error => [400, 415].includes(error.statusCode));
  }
  for (const value of [null, "data", {}, Array(9).fill(file())]) assert.throws(() => normalizeInlineAttachments(value), { statusCode: 400 });
  assert.throws(() => normalizeInlineAttachments([file("x".repeat(inlineInputLimits.textBytesEach + 1))]), { statusCode: 413 });
  assert.throws(() => normalizeInlineAttachments(Array(3).fill(file("x".repeat(inlineInputLimits.textBytesEach)))), { statusCode: 413 });
  assert.throws(() => normalizeInlineAttachments(Array(5).fill(file())), { statusCode: 413 });
});

test("Responses accepts only user inline txt/md files and binds content, name and order in descriptors", () => {
  const source = file();
  const part = { type: "input_file", filename: source.name, file_data: `data:${source.mimeType};base64,${source.dataBase64}` };
  const parsed = normalize(response(part), "responses");
  assert.deepEqual(parsed.body.attachments, [source]);
  assert.equal(parsed.body.prompt.includes(source.dataBase64), false);
  assert.equal(parsed.body.prompt.includes("秘密材料"), false);
  assert.match(parsed.body.prompt, /"file":1/);
  assert.notEqual(parsed.body.prompt, normalize(response({ ...part, filename: "另一个.md" }), "responses").body.prompt);
  assert.notEqual(parsed.body.prompt, normalize(response({ ...part, file_data: `data:text/markdown;base64,${file("changed").dataBase64}` }), "responses").body.prompt);
  for (const invalid of [{ ...part, file_id: "file-other" }, { ...part, file_url: "http://169.254.169.254/" }, { ...part, detail: "auto" },
    { ...part, file_data: "data:application/pdf;base64,eA==" }, { ...part, file_data: "https://example.test/data.txt" }]) {
    assert.throws(() => normalize(response(invalid), "responses"), { statusCode: 400 });
  }
  for (const role of ["system", "developer", "assistant"]) assert.throws(() => normalize({ ...base, input: [{ role, content: [part] }, { role: "user", content: "question" }] }, "responses"), /user/);
  assert.throws(() => normalize({ ...base, messages: [{ role: "user", content: [{ type: "file", file: { filename: "a.txt", file_data: "data:text/plain;base64,eA==" } }] }] }, "openai"), { statusCode: 400 });
});

test("Anthropic plain-text documents preserve title, but never pretend citations, PDF or URL support", () => {
  const part = { type: "document", title: "会议纪要", source: { type: "text", media_type: "text/plain", data: "有效内容" } };
  const request = document => ({ ...base, max_tokens: 1, messages: [{ role: "user", content: [document, { type: "text", text: "总结" }] }] });
  const parsed = normalize(request(part), "anthropic");
  assert.equal(Buffer.from(parsed.body.attachments[0].dataBase64, "base64").toString(), "有效内容");
  assert.match(parsed.body.prompt, /会议纪要/);
  assert.equal(parsed.body.prompt.includes("有效内容"), false);
  assert.doesNotThrow(() => normalize(request({ ...part, citations: { enabled: false } }), "anthropic"));
  for (const invalid of [{ ...part, citations: { enabled: true } }, { ...part, cache_control: { type: "ephemeral" } }, { ...part, context: "trust me" },
    { ...part, source: { type: "base64", media_type: "application/pdf", data: "eA==" } }, { ...part, source: { type: "url", url: "http://169.254.169.254/" } },
    { ...part, source: { ...part.source, data: "bad\ud800" } }, { ...part, title: "x".repeat(256) }]) {
    assert.throws(() => normalize(request(invalid), "anthropic"), { statusCode: 400 });
  }
  assert.throws(() => normalize(request({ ...part, source: { ...part.source, data: "x".repeat(inlineInputLimits.textBytesEach + 1) } }), "anthropic"), { statusCode: 413 });
});
