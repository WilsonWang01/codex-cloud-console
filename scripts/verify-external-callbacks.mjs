import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import https from "node:https";
import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openRunUsageLedger } from "../server/run-usage-ledger.mjs";
import { createExternalTaskStore } from "../server/external-task-store.mjs";
import { callbackLimits } from "../server/external-callback-store.mjs";
import { callbackTargets, readCallbackTargets, publicCallbackAddress, deliverCallback, createCallbackDispatcher } from "../server/external-callbacks.mjs";
import { verifyCallback } from "./callback-receiver-example.mjs";

const secret = "synthetic-callback-secret-not-a-real-credential";
const entry = { id:"receiver",clientId:"client-a",automationId:"research",url:"https://callback.test/completed",secretEnv:"CODEX_CLOUD_CALLBACK_SECRET_TEST" };
const env = { CODEX_CLOUD_CALLBACK_SECRET_TEST:secret }, targets = callbackTargets([entry],env);
async function fixture(check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"codex-callback-test-"));
  const ledger = openRunUsageLedger(path.join(root,"run-usage.sqlite"));
  let clock = Date.now();
  const reopen = () => createExternalTaskStore(ledger.database,{now:()=>clock,ownerAlive:()=>false});
  const store = reopen();
  const input = id => ({ run:{id,clientId:"client-a",automationId:"research",repoId:"repo",status:"queued",startedAt:new Date(clock).toISOString(),prompt:"DO_NOT_DELIVER_PROMPT"},
    execution:{prompt:"PRIVATE_INPUT"},keyHash:createHash("sha256").update(id).digest("hex"),requestHash:"b".repeat(64),ttlMs:10000,callback:targets.binding("client-a","research") });
  const accept = id => store.accept(input(id));
  const complete = (id="1",status="completed") => { accept(id); const claim=store.claim({owner:"model"}); return store.update({...claim.run,status,summary:"DO_NOT_DELIVER_SUMMARY",delivery:{status:"ready"}},claim.claim); };
  try { await check({root,ledger,store,callbacks:store.callbacks,input,accept,complete,reopen,advance:ms=>clock+=ms,now:()=>clock}); }
  finally { ledger.close(); fs.rmSync(root,{recursive:true,force:true}); }
}

test("callback intent and terminal notification commit atomically once with the task", () => fixture(({store,callbacks,input,ledger,complete}) => {
  assert.throws(()=>store.accept({...input("bad"),onAccepted(){throw new Error("rollback");}}),/rollback/);
  assert.equal(store.read("bad"),null); assert.equal(callbacks.status("bad"),null);
  complete(); const before=ledger.database.prepare("SELECT * FROM external_callbacks").get();
  assert.equal(store.accept(input("1")).deduplicated,true);
  assert.deepEqual(ledger.database.prepare("SELECT * FROM external_callbacks").get(),before);
  const payload=JSON.parse(before.body);
  assert.deepEqual(Object.keys(payload).sort(),["created_at","data","id","type"]);
  assert.deepEqual(Object.keys(payload.data).sort(),["automation_id","output_path","result_path","run_id","status"]);
  assert(!before.body.includes("PRIVATE")); assert(!before.body.includes("DO_NOT_DELIVER")); assert(!before.body.includes(secret));
  assert.equal(payload.data.status,"completed"); assert.equal(payload.id,before.event_id);
  store.retain([]); assert(store.read("1"));
}));

test("queued cancellation and lost executors notify without repeating execution", () => fixture(({store,callbacks,accept}) => {
  accept("1"); store.cancel("1",{id:"client-a",automationId:"research"},{});
  assert.equal(callbacks.status("1").status,"pending");
  assert.equal(store.read("1").usage.totalTokens,0);
  accept("2"); store.claim({owner:"exited"}); store.recover();
  const claim=callbacks.claim(); callbacks.finish(claim,{ok:true,code:"http_204"});
  const uncertain=callbacks.claim(); assert.equal(JSON.parse(uncertain.body).data.status,"needs_reconciliation");
  assert.equal(store.claim({owner:"do-not-repeat"}),null);
}));

test("crash leases keep event bytes stable, fence old workers and bound retries", () => fixture(({callbacks,complete,advance}) => {
  complete(); const first=callbacks.claim(); assert.equal(callbacks.claim(),null);
  advance(callbackLimits.leaseMs+1); const next=callbacks.claim();
  assert.equal(first.body,next.body); assert.equal(first.event_id,next.event_id); assert.notEqual(first.lease_id,next.lease_id);
  assert.equal(callbacks.finish(first,{ok:true,code:"http_200"}),false);
  callbacks.finish(next,{code:"http_503"}); assert.equal(callbacks.claim(),null);
  for(let attempt=3;attempt<=5;attempt++){advance(3_600_000);const item=callbacks.claim();assert.equal(item.attempts,attempt);callbacks.finish(item,{code:"network_unavailable"});}
  assert.equal(callbacks.status("1").status,"failed"); assert.equal(callbacks.claim(),null);
}));

test("expiry and retained callback records are swept without pruning pending tasks", () => fixture(({store,callbacks,complete,advance,accept}) => {
  complete(); accept("2"); advance(callbackLimits.lifetimeMs+1); callbacks.sweep();
  assert.equal(callbacks.status("1").status,"failed"); assert.equal(callbacks.status("2").status,"awaiting");
  advance(callbackLimits.retentionMs+1); callbacks.sweep();store.retain([]);
  assert.equal(store.read("1"),null); assert(store.read("2")); assert(callbacks.status("2"));
}));

test("reopen and consistent SQLite backup preserve delivery identity and leases", () => fixture(({root,ledger,callbacks,complete,reopen}) => {
  complete(); const claim=callbacks.claim();
  assert.equal(reopen().callbacks.status("1").eventId,claim.event_id);
  const file=path.join(root,"backup.sqlite");
  const output=execFileSync(process.execPath,[new URL("../ops/backup-usage-ledger.mjs",import.meta.url).pathname,path.join(root,"run-usage.sqlite"),file],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  assert.equal(JSON.parse(output).externalCallbackRows,1);
  const db=new DatabaseSync(file,{readOnly:true});
  try { assert.deepEqual(JSON.parse(JSON.stringify(db.prepare("SELECT * FROM external_callbacks").all())),JSON.parse(JSON.stringify(ledger.database.prepare("SELECT * FROM external_callbacks").all()))); }
  finally {db.close();}
}));

test("inactive clients and changed targets suppress delivery; temporary auth failures retry", async () => {
  await fixture(async ({callbacks,complete}) => {
    complete();let sends=0;
    await createCallbackDispatcher({store:callbacks,targets,authorize:async()=>{throw Object.assign(new Error("revoked"),{statusCode:403});},send:async()=>{sends++;}})();
    assert.equal(sends,0);assert.equal(callbacks.status("1").lastCode,"client_inactive");assert.equal(callbacks.status("1").status,"failed");
  });
  await fixture(async ({callbacks,complete}) => {
    complete();const changed=callbackTargets([{...entry,url:"https://different.test/changed"}],env);
    await createCallbackDispatcher({store:callbacks,targets:changed,authorize:async()=>{},send:async()=>{throw new Error("must not send");}})();
    assert.equal(callbacks.status("1").lastCode,"target_changed");
  });
  await fixture(async ({callbacks,complete}) => {
    complete();await createCallbackDispatcher({store:callbacks,targets,authorize:async()=>{throw new Error("storage unavailable");}})();
    assert.equal(callbacks.status("1").lastCode,"authentication_unavailable");assert.equal(callbacks.status("1").status,"pending");
  });
});

test("registry is operator-only, bounded and rejects unsafe URLs and insecure files", async () => fixture(async ({root}) => {
  assert.equal(callbackTargets([],{}).count,0);
  for(const url of ["http://callback.test/","https://127.1/","https://[::1]/","https://localhost/","https://host.internal/","https://user:pass@callback.test/","https://callback.test/?key=secret","https://callback.test/#fragment","https://callback.test:8443/"]) assert.throws(()=>callbackTargets([{...entry,url}],env));
  assert.throws(()=>callbackTargets([entry,entry],env)); assert.throws(()=>callbackTargets([{...entry,unknown:true}],env));
  for(const key of ["id","clientId","automationId"]) assert.throws(()=>callbackTargets([{...entry,[key]:123}],env));
  assert.throws(()=>callbackTargets([entry],{})); assert.throws(()=>callbackTargets([{...entry,clientId:"legacy-shared"}],env));
  const file=path.join(root,"callbacks.json");fs.writeFileSync(file,JSON.stringify([entry]),{mode:0o600});
  assert.equal((await readCallbackTargets(file,env)).count,1);
  fs.chmodSync(file,0o644);await assert.rejects(()=>readCallbackTargets(file,env));fs.chmodSync(file,0o600);
  fs.symlinkSync(file,file+".link");await assert.rejects(()=>readCallbackTargets(file+".link",env));
  await assert.rejects(()=>readCallbackTargets("relative.json",env));
  fs.writeFileSync(file,"{invalid-SHOULD-NOT-APPEAR");
  await assert.rejects(()=>readCallbackTargets(file,env),error=>error.code==="target_config_invalid"&&!error.message.includes("SHOULD-NOT-APPEAR"));
}));

test("public address policy rejects local, metadata, mapped, translation and special networks", () => {
  for(const address of ["0.1.2.3","10.0.0.1","100.100.100.200","127.0.0.1","169.254.169.254","172.31.0.1","192.168.1.1","192.0.0.9","192.0.2.1","198.18.0.1","198.51.100.1","203.0.113.1","224.0.0.1","255.255.255.255","::1","::ffff:8.8.8.8","64:ff9b::808:808","2001:db8::1","2002:0808:0808::1","3fff::1","fd00:ec2::254","fe80::1","ff02::1","bad",null]) assert.equal(publicCallbackAddress(address),false,String(address));
  for(const address of ["8.8.8.8","1.1.1.1","2001:4860:4860::8888","2606:4700:4700::1111"]) assert.equal(publicCallbackAddress(address),true,address);
});

test("DNS rebinding, mixed answers and revocation after DNS never reach the HTTP sender", () => fixture(async ({callbacks,complete}) => {
  complete();const claim=callbacks.claim(),target=targets.resolve(claim);let requests=0;
  const request=()=>{requests++;throw new Error("not allowed");};
  const mixed=await deliverCallback(claim,target,{authorize:async()=>{},resolve:async()=>["8.8.8.8","127.0.0.1"],request});
  assert.equal(mixed.code,"target_address_rejected");assert.equal(mixed.retryable,false);
  const revoked=await deliverCallback(claim,target,{resolve:async()=>["8.8.8.8"],authorize:async()=>{throw Object.assign(new Error("revoked"),{code:"client_inactive",retryable:false});},request});
  assert.equal(revoked.code,"client_inactive");assert.equal(requests,0);
}));

test("sender pins the verified IP, preserves TLS hostname and sends signed minimal stable bytes", () => fixture(async ({callbacks,complete,now}) => {
  complete();const claim=callbacks.claim(),target=targets.resolve(claim);let resolutions=0;
  const outcome=await deliverCallback(claim,target,{authorize:async()=>{},now,resolve:async()=>{resolutions++;return["8.8.8.8"];},request(url,options,respond){
    assert.equal(url.hostname,"callback.test");assert.equal(options.agent,false);assert.equal(options.family,4);assert.equal(options.autoSelectFamily,false);
    options.lookup(url.hostname,{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,"8.8.8.8");assert.equal(family,4);});
    assert.equal(options.headers["x-codex-event-id"],claim.event_id);
    const timestamp=options.headers["x-codex-timestamp"];
    assert.equal(options.headers["x-codex-signature"],"v1="+createHmac("sha256",secret).update(timestamp+"."+claim.body).digest("hex"));
    const req=new EventEmitter();req.end=body=>{assert.equal(body,claim.body);queueMicrotask(()=>respond({statusCode:204,destroy(){}}));};return req;
  }});
  assert.equal(resolutions,1);assert.equal(outcome.ok,true);
}));

test("local TLS receiver verifies signatures; redirects and permanent HTTP errors are not retried", () => fixture(async ({root,callbacks,complete,now}) => {
  const key=path.join(root,"key.pem"),cert=path.join(root,"cert.pem");
  execFileSync(process.platform === "darwin" ? "/usr/bin/openssl" : "openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=callback.test","-addext","subjectAltName=DNS:callback.test"],{stdio:"pipe",timeout:15000});
  let status=503,calls=0;
  const receiver=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString("utf8"),timestamp=req.headers["x-codex-timestamp"];
    assert.equal(req.headers["x-codex-signature"],"v1="+createHmac("sha256",secret).update(timestamp+"."+body).digest("hex"));
    assert.equal(JSON.parse(body).id,req.headers["x-codex-event-id"]);calls++;res.writeHead(status,{location:"https://must-not-follow.test/"});res.end();
  });
  await new Promise(resolve=>receiver.listen(0,"127.0.0.1",resolve));
  try {
    complete();const claim=callbacks.claim(),target=targets.resolve(claim);
    const options={authorize:async()=>{},now,resolve:async()=>["8.8.8.8"],request:(url,options,respond)=>https.request(url,{...options,port:receiver.address().port,ca:fs.readFileSync(cert),lookup:(_h,_o,done)=>done(null,"127.0.0.1",4)},respond)};
    assert.equal((await deliverCallback(claim,target,options)).retryable,true);
    status=302;const redirect=await deliverCallback(claim,target,options);assert.equal(redirect.ok,false);assert.equal(redirect.retryable,false);assert.equal(calls,2);
    status=403;assert.equal((await deliverCallback(claim,target,options)).retryable,false);
    status=204;assert.equal((await deliverCallback(claim,target,options)).ok,true);assert.equal(calls,4);
  } finally {await new Promise(resolve=>receiver.close(resolve));}
}));

test("independent receiver validates raw bytes, clock window, identity and paths", () => fixture(({callbacks,complete,now}) => {
  complete();const claim=callbacks.claim(),timestamp=String(Math.floor(now()/1000));
  const headers={"x-codex-event-id":claim.event_id,"x-codex-timestamp":timestamp,"x-codex-signature":"v1="+createHmac("sha256",secret).update(timestamp+"."+claim.body).digest("hex")};
  const input={headers,rawBody:Buffer.from(claim.body),secret,now:now()};
  assert.equal(verifyCallback(input).id,claim.event_id);
  for(const change of [{secret:secret+"wrong"},{now:now()+301000},{now:now()-301000},{rawBody:Buffer.from(claim.body+" ")},{headers:{...headers,"x-codex-event-id":"wrong"}},{headers:{...headers,"x-codex-signature":"v1=broken"}}]) assert.throws(()=>verifyCallback({...input,...change}),{statusCode:401});
  const payload=JSON.parse(claim.body);payload.data.result_path="https://private.invalid/";
  const raw=Buffer.from(JSON.stringify(payload));
  assert.throws(()=>verifyCallback({...input,rawBody:raw,headers:{...headers,"x-codex-signature":"v1="+createHmac("sha256",secret).update(timestamp+".").update(raw).digest("hex")}}),{statusCode:401});
}));

test("full callback retention capacity rejects acceptance atomically without dropping older records", () => fixture(({store,ledger,input,now}) => {
  const db=ledger.database;
  db.exec("BEGIN IMMEDIATE");
  const task=db.prepare("INSERT INTO external_tasks VALUES (?,?,'{}',?,'terminal',NULL,NULL,0)");
  const callback=db.prepare("INSERT INTO external_callbacks (run_id,event_id,client_id,automation_id,target_id,fingerprint,state,created_ms,next_ms,delivered_ms) VALUES (?,?,'client-a','research','receiver',?,'delivered',?,?,?)");
  for(let i=0;i<callbackLimits.records;i++){task.run("old-"+i,JSON.stringify({id:"old-"+i,status:"completed"}),now());callback.run("old-"+i,"event-"+i,"a".repeat(64),now(),now(),now());}
  db.exec("COMMIT");
  assert.throws(()=>store.accept(input("new")),{statusCode:503});assert.equal(store.read("new"),null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM external_callbacks").get().n,callbackLimits.records);
  assert.equal(db.prepare("SELECT count(*) AS n FROM external_task_keys").get().n,0);
}));

test("sender deadline closes a stalled request and permits bounded retry", () => fixture(async ({callbacks,complete}) => {
  complete();const claim=callbacks.claim(),target=targets.resolve(claim);let aborted=false;
  // The stub must keep Node 22 alive as a real socket would; AbortSignal.timeout is unref'ed.
  const keepAlive=setInterval(()=>{},1000);
  let outcome;
  try {
    outcome=await deliverCallback(claim,target,{authorize:async()=>{},resolve:async()=>["8.8.8.8"],request(_url,options){
      const req=new EventEmitter();req.end=()=>{};
      options.signal.addEventListener("abort",()=>{aborted=true;req.emit("error",options.signal.reason);},{once:true});
      return req;
    }});
  } finally {clearInterval(keepAlive);}
  assert.equal(aborted,true);assert.equal(outcome.code,"delivery_timeout");assert.equal(outcome.retryable,true);
}));
