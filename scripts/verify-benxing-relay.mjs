import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer,request as httpRequest} from 'node:http';
import test from 'node:test';
import express from 'express';

// Register only the actual Benxing helpers/routes. Never import/start the full
// server, read its configuration, or contact any real Cloud/Sites service.
const source=readFileSync(new URL('../server/index.mjs',import.meta.url),'utf8');
const start=source.indexOf('function isTrustedLocalBenxingRequest(');
const end=source.indexOf('\napp.use("/api",',start);
assert.ok(start>=0&&end>start,'本型转接源码边界已变化，请更新隔离入口');
const register=new Function('app','benxingSiteOrigin','benxingSitesBypassBearerToken','maxUploadBytes','fetch',source.slice(start,end));
const token='a'.repeat(64),bypass='isolated-not-a-real-site-credential';
const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
const listen=async server=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;};
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});

test('本型请求头在任务公开摘要中脱敏，含JSON下载清单',()=>{
  const begin=source.indexOf('function redactAutomationPrompt('),end=source.indexOf('\nconst automationCompletionContractVersion',begin);
  assert.ok(begin>=0&&end>begin);
  const redact=new Function(`${source.slice(begin,end)};return redactAutomationPrompt;`)();
  for(const value of [`-H 'x-benxing-job-token: ${token}'`,JSON.stringify({headers:{'x-benxing-job-token':token}}),
    JSON.stringify({headers:{'x-benxing-job-token':token}},null,2),`{'x-benxing-job-token':'${token}'}`]) {
    const publicText=redact(value);assert.ok(!publicText.includes(token),'下载清单不得在公开任务摘要中留下令牌');
    assert.ok(publicText.includes('x-benxing-job-token'));assert.match(publicText,/<redacted>/);
  }
  assert.deepEqual(JSON.parse(redact(JSON.stringify({url:'http://127.0.0.1/input',headers:{'x-benxing-job-token':token}}))),
    {url:'http://127.0.0.1/input',headers:{'x-benxing-job-token':'<redacted>'}});
});

test('本型转接：请求头、兼容、归属入口与禁止跳转的隔离HTTP验收',async t=>{
  let targetCalls=0,targetCredentials=0,targetBodies=0,redirectCode=0;const requests=[];
  const target=createServer(async(req,res)=>{targetCalls++;if(req.headers['oai-sites-authorization']||req.headers['x-benxing-job-token'])targetCredentials++;
    let size=0;for await(const chunk of req)size+=chunk.length;if(size)targetBodies++;res.end('不应收到凭据或正文的本机目标');});
  const targetUrl=await listen(target);
  const upstream=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks),method:req.method});
    if(redirectCode){res.writeHead(redirectCode,{Location:targetUrl});res.end();return;}
    res.setHeader('Cache-Control','public, max-age=300');
    res.setHeader('Content-Type',req.method==='GET'?'image/png':'application/json');
    res.end(req.method==='GET'?bytes:JSON.stringify({ok:true}));
  });
  let relay;
  try{
    const app=express();app.use(express.json({limit:'1mb'}));
    register(app,await listen(upstream),bypass,1024*1024,fetch);
    app.use((error,_req,res,_next)=>res.status(500).json({error:error.message}));
    relay=createServer(app);const origin=await listen(relay);
    const input='/api/integrations/benxing/jobs/local-job/inputs/local-photo';
    const complete='/api/integrations/benxing/jobs/local-job/complete';
    const get=(search='',headers={'x-benxing-job-token':token})=>fetch(origin+input+search,{headers,redirect:'manual'});
    for(const [label,search,headers] of [['只用请求头','',{'x-benxing-job-token':token}],
      ['旧查询兼容',`?token=${token}`,{}],['同值兼容',`?token=${token}`,{'x-benxing-job-token':token}]]) {
      await t.test(label,async()=>{
        const result=await get(search,headers);assert.equal(result.status,200);
        assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes);
        const received=requests.at(-1);assert.equal(new URL(received.url,origin).search,'');
        assert.equal(received.headers['x-benxing-job-token'],token);
        assert.equal(received.headers['oai-sites-authorization'],`Bearer ${bypass}`);
        assert.match(result.headers.get('cache-control'),/private.*no-store/);
        assert.equal(result.headers.get('referrer-policy'),'no-referrer');
      });
    }
    for(const [label,search,headers] of [['缺少凭据','',{}],['非法头不回退查询',`?token=${token}`,{'x-benxing-job-token':'bad'}],
      ['空头不回退查询',`?token=${token}`,{'x-benxing-job-token':''}],['重复查询',`?token=${token}&token=${token}`,{}],
      ['头与查询冲突',`?token=${'0'.repeat(64)}`,{'x-benxing-job-token':token}],['多值头','',{'x-benxing-job-token':`${token},${token}`}]]) {
      await t.test(label,async()=>{const before=requests.length;const result=await get(search,headers);
        assert.equal(result.status,400);assert.equal(requests.length,before);await result.arrayBuffer();});
    }
    const beforeDenied=requests.length,forwarded=await get('',{'x-forwarded-for':'203.0.113.1','x-benxing-job-token':token});
    assert.equal(forwarded.status,403);await forwarded.arrayBuffer();
    const badHost=await new Promise((resolve,reject)=>{const request=httpRequest(origin+input,{headers:{host:'not-local.invalid','x-benxing-job-token':token}},response=>{
      response.resume();response.once('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end();});
    assert.equal(badHost,403);assert.equal(requests.length,beforeDenied);
    const json=await fetch(origin+complete,{method:'POST',headers:{'content-type':'application/json','x-benxing-job-token':token},body:JSON.stringify({status:'progress',stage:'reading_inputs'})});
    assert.equal(json.status,200);await json.arrayBuffer();assert.deepEqual(JSON.parse(requests.at(-1).body),{status:'progress',stage:'reading_inputs'});
    const body=Buffer.from('--local\r\nContent-Disposition: form-data; name="audit"\r\n\r\n{}\r\n--local--\r\n');
    const multipart=await fetch(origin+complete,{method:'POST',headers:{'content-type':'multipart/form-data; boundary=local','x-benxing-job-token':token},body});
    assert.equal(multipart.status,200);await multipart.arrayBuffer();assert.deepEqual(requests.at(-1).body,body);
    for(const method of ['GET','POST'])for(const code of [301,302,303,307,308]) {
      await t.test(`${method}上游${code}不跟随`,async()=>{
        redirectCode=code;const before=targetCalls;
        const result=method==='GET'?await get(`?token=${token}`):await fetch(origin+complete,{method,headers:{'content-type':'application/json','x-benxing-job-token':token},body:'{"status":"progress"}',redirect:'manual'});
        assert.equal(result.status,502);await result.arrayBuffer();assert.equal(targetCalls,before);
      });
    }
    console.log(JSON.stringify({范围:'仅本型实际转接源码，三个127.0.0.1临时HTTP服务；无真实配置、照片、云任务或外网',
      跳转目标请求数:targetCalls,跳转目标收到虚构凭据:targetCredentials,跳转目标收到虚构正文:targetBodies}));
    assert.equal(targetCalls,0);
  }finally{if(relay)await close(relay);await close(upstream);await close(target);}
});
