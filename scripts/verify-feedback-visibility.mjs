import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = await fs.readFile(new URL("../src/PersonalMessageFeedback.tsx", import.meta.url), "utf8");
const start = source.indexOf('  const [content, setContent] = useState(');
const code = ts.transpileModule(source.slice(start, source.indexOf('  const digest = content.text', start)), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function setup({ fallback = false, failure = false } = {}) {
  const root = {}, updates = [], observers = [];
  let cleanup, calls = 0, resolve;
  const pending = new Promise(done => { resolve = done; });
  const context = {
    message: { text: "合成回复" }, TextEncoder, Uint8Array,
    useState: () => [{}, value => updates.push(value)],
    useRef: () => ({ current: { closest: selector => { assert.equal(selector, ".chat-window"); return root; } } }),
    useEffect: effect => { cleanup = effect(); },
    crypto: { subtle: { digest: async () => { calls++; await pending; if (failure) throw new Error("hash unavailable"); return new Uint8Array(32).buffer; } } },
    ...(fallback ? {} : { IntersectionObserver: class {
      constructor(callback, options) { assert.equal(options.root, root); assert.equal(options.rootMargin, "160px"); this.emit = visible => callback([{ isIntersecting: visible }]); observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    } }),
  };
  vm.runInNewContext(code, context);
  return { updates, observers, count: () => calls, close: () => cleanup(), finish: async () => { resolve(); await pending; await new Promise(done => setImmediate(done)); } };
}

test("屏外不校验，进入可见范围后只校验一次，并保留摘要校验结果", async () => {
  const view = setup(), observer = view.observers[0];
  observer.emit(false); assert.equal(view.count(), 0);
  observer.emit(true); observer.emit(true); assert.equal(view.count(), 1); assert.equal(observer.disconnected, true);
  await view.finish(); assert.equal(view.updates[0].digest, "0".repeat(64)); view.close();
});

test("切换后未开始或迟到的校验均不更新旧视图，失败仍不能冒充已校验", async () => {
  const unopened = setup(); unopened.close(); unopened.observers[0].emit(true); assert.equal(unopened.count(), 0);
  const late = setup(); late.observers[0].emit(true); late.close(); await late.finish(); assert.equal(late.updates.length, 0);
  const failed = setup({ failure: true }); failed.observers[0].emit(true); await failed.finish();
  assert.equal(failed.updates[0].digest, ""); assert.match(failed.updates[0].error, /暂不能评价/); failed.close();
});

test("不支持可见性观察时保持原来的即时校验", async () => {
  const view = setup({ fallback: true }); assert.equal(view.count(), 1); await view.finish(); assert.equal(view.updates[0].digest.length, 64); view.close();
});
