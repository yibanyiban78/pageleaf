import test from 'node:test';
import assert from 'node:assert/strict';
import {apiURL,hostPattern,downloadImage,summarize} from '../extension/network.js';
const cfg={endpoint:'https://api.example.org/v1',model:'model-a',key:'test-key'};
const ok=t=>Response.json({choices:[{message:{content:t}}]});
test('HTTP images never reach fetch, including same-origin, loopback, queries, and mixed-case schemes',async()=>{
  const seen=[];
  for(const url of ['http://img.example/a?token=fixture','HtTp://same.example/a','http://localhost:8444/x','http://[::1]/x']) {
    await assert.rejects(downloadImage(url,'http://same.example/article',async u=>{seen.push(u);throw Error('unexpected image fetch');}),/地址/);
  }
  assert.deepEqual(seen,[]);
});
test('仅允许 HTTPS 或明确回环服务，区分 Chrome 权限与真实端口',()=>{assert.equal(apiURL('http://127.0.0.1:8080/v1/').href,'http://127.0.0.1:8080/v1/chat/completions');assert.equal(hostPattern(apiURL('http://127.0.0.1:8080')),'http://127.0.0.1/*');assert.equal(apiURL('https://s.x/base/chat/completions/').pathname,'/base/chat/completions');for(const s of ['http://external.org','https://a:b@a.com','https://x.z/?key=aa','file:///x'])assert.throws(()=>apiURL(s));});
test('选段、无字幕视频不调用 AI；正文不夹带图片地址和元信息',async()=>{let calls=0;const fetcher=async(u,i)=>{calls++;assert.equal(u,'https://api.example.org/v1/chat/completions');assert.equal(i.redirect,'error');assert.equal(i.credentials,'omit');assert.equal(i.headers.Authorization,'Bearer test-key');assert.equal(JSON.parse(i.body).messages.at(-1).content,'正文');return ok('中文摘要');};for(const kind of ['selection','youtube'])assert.equal(await summarize({kind,plain:'正文',cues:[]},cfg,{fetcher}),'');assert.equal(await summarize({kind:'article',plain:'正文',body:'图片',author:'作者'},cfg,{fetcher}),'中文摘要');assert.equal(calls,1);});
test('long summaries stop before the next POST if the local credential is locked',async()=>{
  let calls=0,checks=0;
  await assert.rejects(summarize({kind:'article',plain:'a'.repeat(9000)},cfg,{
    beforeRequest:async()=>{if(++checks>1)throw Error('locked locally');},fetcher:async()=>{calls++;return ok('sample');}
  }),/locked locally/);assert.equal(checks,2);assert.equal(calls,1);
});
test('长字幕每段均参与，最后综合；达到安全上限不会静默截断',async()=>{let requests=[];let notes=await summarize({kind:'youtube',cues:[{text:'a'.repeat(8500)},{text:'最后一段'}]},cfg,{fetcher:async(u,i)=>{requests.push(JSON.parse(i.body).messages.at(-1).content);return ok('测试摘要');}});assert.equal(notes,'测试摘要');assert.equal(requests.length,3);assert.match(requests[1],/最后一段/);await assert.rejects(summarize({kind:'article',plain:'b'.repeat(160001)},cfg),/上限/);});
test('服务错误不在结果中回显响应或密钥',async()=>{await assert.rejects(summarize({kind:'article',plain:'正文'},cfg,{fetcher:async()=>new Response('secret from server',{status:401})}),{message:'AI 服务返回 HTTP 401；请检查模型、Key、额度或服务状态。'});});
test('异常服务在结果中回显 Key 时丢弃摘要',async()=>{await assert.rejects(summarize({kind:'article',plain:'正文'},cfg,{fetcher:async()=>ok('错误回复 '+cfg.key)}),/凭据/);});
test('过大的分段模型输出触发费用上限',async()=>{let n=0;await assert.rejects(summarize({kind:'article',plain:'a'.repeat(128000)},cfg,{fetcher:async()=>{n++;return ok('长'.repeat(15000));}}),/费用保护/);assert.equal(n,16);});
test('只保存可识别的位图，不使用 Key 和 cookie',async()=>{const {ext,blob}=await downloadImage('https://img.example.org/x','https://article.example.org',async(u,i)=>{assert.equal(i.credentials,'omit');assert.equal(i.redirect,'error');assert.equal(i.headers,undefined);return new Response(Uint8Array.from([137,80,78,71,13,10,26,10]));},{decode:async()=>({width:1,height:1,close(){}})});assert.equal(ext,'png');assert.equal(blob.size,8);await assert.rejects(downloadImage('https://img.example.org/x','https://e.t',async()=>new Response('<html>')),/位图/);for(const u of ['https://user:pass@img.net/p','http://192.168.0.1/x','http://localhost/x','file:///x'])await assert.rejects(downloadImage(u,'https://page.example'),/地址/);});
