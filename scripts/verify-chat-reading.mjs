import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const exports = {};
vm.runInNewContext(ts.transpileModule(await fs.readFile(new URL("../src/chat-reading-position.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports, require: createRequire(import.meta.url) });
const { ChatReadingPositions } = exports;
const storageKey = "codex-cloud-chat-reading-v1";
const position = { anchor: "native-message", offset: -25, top: 3500, follow: false, seen: '["tail",100,false]' };
const copy = value => JSON.parse(JSON.stringify(value));
const storage = () => {
  const values = new Map([["codex-cloud-draft:personal:a", "private unsent draft"]]);
  return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
};

test("reading positions keep space/thread scope, reload and a bounded private tab cache without touching drafts", () => {
  const local = storage(), first = new ChatReadingPositions(() => local);
  const a = JSON.stringify(["_personal", "native-a"]), work = JSON.stringify(["work", "native-a"]);
  first.set(a, position);
  assert.equal(first.get(work), null);
  const second = new ChatReadingPositions(() => local);
  assert.deepEqual(copy(second.get(a)), position);
  second.set(work, { ...position, top: 200 });
  assert.equal(second.get(a).top, 3500); assert.equal(second.get(work).top, 200);
  for (let index = 0; index < 45; index++) second.set(`scope-${index}`, position);
  const parsed = JSON.parse(local.getItem(storageKey));
  assert.equal(parsed.entries.length, 40); assert.equal(second.get("scope-0"), null); assert.ok(second.get("scope-44"));
  assert.equal(local.getItem("codex-cloud-draft:personal:a"), "private unsent draft");
  assert.equal(local.getItem(storageKey).includes("private unsent draft"), false);
  assert.deepEqual(Object.keys(parsed.entries[0].position).sort(), ["anchor", "follow", "offset", "seen", "top"]);
  const escaped = storage(), large = new ChatReadingPositions(() => escaped);
  for (let index = 0; index < 40; index++) large.set(JSON.stringify([index, "\x00".repeat(150)]), { ...position, anchor: "\x00".repeat(512), seen: JSON.stringify(["\x00".repeat(150)]) });
  assert.ok(escaped.getItem(storageKey).length <= 128000, "escaped identifiers cannot exceed the serialized limit");
});

test("unknown, corrupt, duplicate and oversized reading caches are preserved instead of rewritten", () => {
  const row = { key: "scope", position };
  for (const raw of ["{broken", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [row, row] }),
    JSON.stringify({ version: 1, entries: [{ key: "scope", position: { ...position, top: -1 } }] }), " ".repeat(128001)]) {
    const local = storage(); local.setItem(storageKey, raw);
    const cache = new ChatReadingPositions(() => local);
    assert.equal(cache.get("scope"), null);
    cache.set("new-scope", position);
    assert.deepEqual(copy(cache.get("new-scope")), position, "the current page still has an in-memory fallback");
    assert.equal(local.getItem(storageKey), raw);
  }
  const local = storage(), cache = new ChatReadingPositions(() => local);
  for (const invalid of [{ ...position, top: NaN }, { ...position, offset: Infinity }, { ...position, anchor: "x".repeat(513) }, { ...position, follow: "yes" }]) cache.set("bad", invalid);
  assert.equal(cache.get("bad"), null); assert.equal(local.getItem(storageKey), null);
});

test("blocked tab storage and quota errors do not crash navigation or discard the current page position", () => {
  for (const getter of [() => { throw new Error("storage blocked"); }, () => ({ getItem: () => null, setItem: () => { throw new Error("quota"); } })]) {
    const cache = new ChatReadingPositions(getter);
    cache.set("a", position); cache.set("b", { ...position, top: 200 });
    assert.equal(cache.get("a").top, 3500); assert.equal(cache.get("b").top, 200);
  }
});

test("expanded history size survives reload without storing messages or breaking old reading entries", () => {
  const local = storage(), cache = new ChatReadingPositions(() => local);
  cache.set("expanded", { ...position, count: 500 });
  cache.set("legacy", position);
  assert.equal(new ChatReadingPositions(() => local).get("expanded").count, 500);
  assert.deepEqual(copy(new ChatReadingPositions(() => local).get("legacy")), position);
  for (const count of [-1, 0, 1.5, 2001, "500", NaN]) cache.set("invalid", { ...position, count });
  assert.equal(cache.get("invalid"), null);
  assert.equal(local.getItem(storageKey).includes("合成历史"), false);
});
