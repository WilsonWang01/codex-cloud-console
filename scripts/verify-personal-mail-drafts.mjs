import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import { createPersonalMailDrafts, handlePersonalMailDraftCall, personalMailDraftRouter, personalMailDraftTool } from "../server/personal-mail-drafts.mjs";

const form = { to: ["contact@example.test"], subject: "Re: 核对材料", body: "你好，我会先核对材料，稍后确认。" };
const ref = { accountId: "mail-account", messageId: "mail-one", itemVersion: "a".repeat(64), snapshotVersion: "b".repeat(64) };
function fixture() {
  let state, time = Date.parse("2026-10-26T02:00:00.000Z"), writes = 0, failWrite = false, reads = 0;
  const view = { stale: false, reading: false, snapshot: { account: { id: ref.accountId, email: "owner@example.test" }, version: ref.snapshotVersion,
    window: { timeZone: "Asia/Shanghai" }, fetchedAt: new Date(time).toISOString(), expiresAt: new Date(time + 300000).toISOString(),
    items: [{ id: ref.messageId, threadId: "mail-thread", title: "核对材料（标题不是授权）", from: "联系人 <contact@example.test>", version: ref.itemVersion, receivedAt: new Date(time - 3600000).toISOString() }] } };
  const options = { read: async () => structuredClone(state), write: async value => { if (failWrite) throw new Error("synthetic disk failure"); state = structuredClone(value); writes++; },
    mail: { snapshot: async zone => { assert.equal(zone, "Asia/Shanghai"); reads++; return structuredClone(view); } }, now: () => time };
  return { options, store: createPersonalMailDrafts(options), view, input: () => ({ source: ref, timeZone: "Asia/Shanghai" }),
    state: () => structuredClone(state), setState: value => { state = value; }, writes: () => writes, reads: () => reads, failWrite: () => { failWrite = true; }, advance: ms => { time += ms; } };
}

test("逐封来源只创建本地空草稿，重复点击与重启找回原版本，不恢复已拒绝记录", async () => {
  const f = fixture(), item = await f.store.create(f.input());
  assert.equal(item.source.accountEmail, "owner@example.test"); assert.equal(item.source.from, f.view.snapshot.items[0].from);
  assert.deepEqual(item.form, { to: [], subject: "Re: 核对材料（标题不是授权）", body: "" });
  assert.equal(item.review, null); assert.equal(item.status, "draft");
  const rejected = await f.store.update(item.id, { revision: item.revision, status: "rejected" });
  f.advance(3600000);
  const reopened = createPersonalMailDrafts(f.options);
  assert.deepEqual(await reopened.create(f.input()), rejected);
  assert.equal((await reopened.list()).length, 1); assert.equal(f.writes(), 2); assert.equal(f.reads(), 1);
});

test("错误账号、对象、版本、过期、失败或正在读取均不能起草，也不会读取连接器", async () => {
  for (const change of [f => { f.view.snapshot.account.id = "other"; }, f => { f.view.snapshot.items = []; }, f => { f.view.snapshot.version = "c".repeat(64); },
    f => { f.view.snapshot.items[0].version = "d".repeat(64); }, f => f.advance(300000), f => { f.view.stale = true; }, f => { f.view.reading = true; }]) {
    const f = fixture(); change(f); await assert.rejects(f.store.create(f.input()), { code: "mail_draft_source_changed" }); assert.equal(f.writes(), 0);
  }
});

test("当前内容核对不是发送授权，编辑或状态变化使旧核对失效；旧版本不能覆盖", async () => {
  const f = fixture(), item = await f.store.create(f.input());
  await assert.rejects(f.store.update(item.id, { revision: 1, status: "ready" }), { code: "mail_draft_incomplete" });
  const edited = await f.store.update(item.id, { revision: 1, form });
  const ready = await f.store.update(item.id, { revision: edited.revision, status: "ready" });
  assert.equal(ready.review.revision, ready.revision); assert.equal(ready.status, "ready");
  await assert.rejects(f.store.update(item.id, { revision: edited.revision, form: { ...form, body: "旧设备覆盖" } }), { code: "mail_draft_conflict" });
  const changed = await f.store.update(item.id, { revision: ready.revision, form: { ...form, body: "我会重新核对再确认。" } });
  assert.equal(changed.review, null); assert.equal(changed.status, "draft");
  const deferred = await f.store.update(item.id, { revision: changed.revision, status: "deferred" });
  assert.equal(deferred.review, null); assert.equal((await f.store.list())[0].form.body, changed.form.body);
});

test("来源过期后仍能保存本地编辑，但不能把旧来源标为已核对", async () => {
  const f = fixture(), item = await f.store.create(f.input()); f.advance(300001);
  const edited = await f.store.update(item.id, { revision: 1, form });
  await assert.rejects(f.store.update(item.id, { revision: edited.revision, status: "ready" }), { code: "mail_draft_source_changed" });
  assert.deepEqual((await f.store.list())[0], edited);
});

test("同封邮件未变化时，其他邮件刷新不会重复创建或阻止核对；原邮件变化仍拒绝", async () => {
  const f=fixture(),item=await f.store.create(f.input());
  f.view.snapshot.version="e".repeat(64);
  const found=await f.store.create({...f.input(),source:{...ref,snapshotVersion:f.view.snapshot.version}});
  assert.equal(found.id,item.id);assert.equal(f.writes(),1);
  const edited=await f.store.update(item.id,{revision:1,form});
  const ready=await f.store.update(item.id,{revision:edited.revision,status:"ready"});assert.equal(ready.status,"ready");
  f.view.snapshot.items[0].version="f".repeat(64);
  await assert.rejects(f.store.update(item.id,{revision:ready.revision,status:"ready"}),{code:"mail_draft_source_changed"});
});

test("并发编辑只接受一个版本，保存失败和损坏数据不覆盖原记录", async () => {
  const f = fixture(), item = await f.store.create(f.input());
  const outcomes = await Promise.allSettled([f.store.update(item.id, { revision: 1, form }), f.store.update(item.id, { revision: 1, form: { ...form, body: "另一设备" } })]);
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  const before = f.state(); f.failWrite(); await assert.rejects(f.store.update(item.id, { revision: 2, status: "deferred" }), /disk/); assert.deepEqual(f.state(), before);
  f.setState({ version: 1, drafts: [{ ...item, status: "ready", review: null }] });
  await assert.rejects(f.store.list(), { code: "mail_draft_invalid" }); assert.equal(f.writes(), 2);
});

test("显式 null 文件不是不存在，读取或新增必须拒绝并保留原值",async()=>{
  const f=fixture();f.setState(null);
  await assert.rejects(f.store.list(),{code:"mail_draft_invalid"});
  await assert.rejects(f.store.create(f.input()),{code:"mail_draft_invalid"});
  assert.equal(f.state(),null);assert.equal(f.writes(),0);
});

test("收件人重复、控制字符、超限、额外执行参数被拒绝", async () => {
  for (const value of [{ ...form, to: ["a@example.test", "A@example.test"] }, { ...form, subject: "test\r\nBcc: secret@example.test" },
    { ...form, to: ["not-an-address"] }, { ...form, body: "x".repeat(12001) }]) {
    const f = fixture(), item = await f.store.create(f.input());
    await assert.rejects(f.store.update(item.id, { revision: 1, form: value })); assert.equal(f.writes(), 1);
  }
  const f = fixture(), item = await f.store.create(f.input());
  await assert.rejects(f.store.update(item.id, { revision: 1, form, send: true }));
  await assert.rejects(f.store.update(item.id, { revision: 1, form, status: "ready" }));
});

test("模型只能在当前前台个人回合保存草稿，迟到、后台、工作和受限任务不能保存", async () => {
  const f = fixture(), job = { kind: "turn", repo: { kind: "personal" }, sessionId: "session", threadId: "thread", turnId: "turn" };
  const params = { threadId: "thread", turnId: "turn", callId: "call", tool: personalMailDraftTool.name, arguments: { ...f.input(), form } };
  for (const [p,j] of [[{ ...params, turnId: "old" },job], [{ ...params, namespace: "external" },job], [params,{ ...job, repo: { kind: "work" } }],
    ...["cancelRequested", "completed", "finishing", "unattendedPersonalSchedule", "executionProfile"].map(key => [params,{ ...job, [key]: true }])]) {
    assert.equal((await handlePersonalMailDraftCall(p,j,f.store)).success, false);
  }
  assert.equal(f.writes(), 0);
  const result = await handlePersonalMailDraftCall(params,job,f.store); assert.equal(result.success,true);
  const receipt = JSON.parse(result.contentItems[0].text); assert.equal(receipt.status,"draft"); assert.equal(receipt.turnId,"turn");
  assert.equal((await handlePersonalMailDraftCall(params,job,f.store)).success,true); assert.equal(f.writes(),1);
  assert.equal((await handlePersonalMailDraftCall({ ...params, arguments: { ...params.arguments, form: { ...form, body:"不能覆盖" } } },job,f.store)).success,false);
  assert.equal((await f.store.list())[0].origin.sessionId,"session");
});

test("模型等待来源核对期间取消，保存前再次检查归属", async () => {
  const f = fixture(), job = { kind: "turn", repo: { kind: "personal" }, sessionId: "session", threadId: "thread", turnId: "turn" };
  const options = { ...f.options, mail: { snapshot: async zone => { job.cancelRequested = true; return f.options.mail.snapshot(zone); } } };
  const result = await handlePersonalMailDraftCall({ threadId:"thread",turnId:"turn",callId:"call",tool:personalMailDraftTool.name,arguments:{...f.input(),form}},job,createPersonalMailDrafts(options));
  assert.equal(result.success,false);assert.equal(f.writes(),0);
});

test("模型每回合最多三条，已有回执重放不占新名额；损坏的核对摘要拒绝读取",async()=>{
  const f=fixture(),caller={sessionId:"session",threadId:"thread",turnId:"turn",callId:"one"};
  for(const callId of ["one","two","three"])await f.store.create({...f.input(),form},{...caller,callId});
  assert.equal((await f.store.create({...f.input(),form},caller)).status,"draft");
  await assert.rejects(f.store.create({...f.input(),form},{...caller,callId:"four"}),{code:"mail_draft_capacity"});
  assert.equal(f.writes(),3);
  const first=(await f.store.list())[0],ready=await f.store.update(first.id,{revision:1,status:"ready"});
  const broken=f.state();broken.drafts[0].review.digest="f".repeat(64);f.setState(broken);
  await assert.rejects(f.store.list(),{code:"mail_draft_invalid"});assert.equal(ready.review.revision,ready.revision);
});

test("100条与字节容量分别有界，达到上限保留全部旧草稿",async()=>{
  const count=fixture();
  for(let n=0;n<100;n++){
    count.view.snapshot.items[0].id=`message-${n}`;
    await count.store.create({...count.input(),source:{...ref,messageId:`message-${n}`}});
  }
  const before=count.state();count.view.snapshot.items[0].id="message-overflow";
  await assert.rejects(count.store.create({...count.input(),source:{...ref,messageId:"message-overflow"}}),{code:"mail_draft_capacity"});
  assert.deepEqual(count.state(),before);
  const bytes=fixture();let blocked=false;
  for(let n=0;n<100;n++){
    bytes.view.snapshot.items[0].id=`large-${n}`;
    const item=await bytes.store.create({...bytes.input(),source:{...ref,messageId:`large-${n}`}}),saved=bytes.state();
    try{await bytes.store.update(item.id,{revision:1,form:{...form,body:"数".repeat(12000)}});}
    catch(error){assert.equal(error.code,"mail_draft_capacity");assert.deepEqual(bytes.state(),saved);blocked=true;break;}
  }
  assert.equal(blocked,true);
});

test("真实路由支持受限参数、编辑和只读重开，没有发送或 Gmail 写入入口", async () => {
  const f=fixture(),app=express();app.use(express.json());app.use("/api/personal/mail-drafts",personalMailDraftRouter(f.store));
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${server.address().port}/api/personal/mail-drafts`;
  const post=(url,body,method="POST")=>fetch(url,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  try{
    const list=await fetch(base);assert.equal(list.headers.get("cache-control"),"no-store");assert.deepEqual((await list.json()).drafts,[]);assert.equal(f.writes(),0);
    assert.equal((await post(base,{...f.input(),send:true})).status,400);
    const created=await(await post(base,f.input())).json();assert.equal(created.ok,true);
    assert.equal((await post(`${base}/${created.draft.id}`,{revision:1,form},"PATCH")).status,200);
    assert.equal((await post(`${base}/${created.draft.id}/send`,{revision:2})).status,404);
    assert.equal((await post(base,{...f.input(),source:{...ref,accountEmail:"attacker@example.test"}})).status,400);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
