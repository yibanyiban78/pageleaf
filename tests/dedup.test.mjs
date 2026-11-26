import assert from 'node:assert/strict';
import test from 'node:test';
import {clipKey, lookupClip, withClipLock} from '../extension/dedup.js';

const page = (url, kind='article', body='正文') => ({kind, url, body});
const url = 'https://journal.example/p/(a)?id=1&name=%23标签#footnote';
const day = '2026-01-02', path = `${day}/# 标题 [一].md`, index = '剪藏索引.md';
const sentinel = n => `PAGELEAFIMG${n.repeat(32)}X${n.charCodeAt(0)}END`;
const source = new URL(url).href;
const sourceLine = '- 来源：[https://journal.example/p/(a)?id\\=1&amp;name\\=\\%23\\%E6\\%A0\\%87\\%E7\\%AD\\%BE\\#footnote](https://journal.example/p/%28a%29?id=1&name=%23%E6%A0%87%E7%AD%BE#footnote)';
const head = (kind, src=sourceLine) => `# \\# 标题 \\[一\\]\n\n- 类型：${kind}\n- 剪藏日期：${day}\n- ${kind==='YouTube 视频'?'频道':'作者'}：A\n${src}\n`;
const indexRow = (kind, dest=`${day}/${encodeURIComponent('# 标题 [一].md')}`, suffix='') => `- [\\# 标题 \\[一\\]](${dest}) · A · ${kind}${suffix}`;
const region = content => `# 私人目录\n\n<!-- pageleaf:index:v1 -->\n\n## ${day}\n\n${content}\n\n<!-- /pageleaf:index:v1 -->\n`;
// A strictly read-only synthetic vault. It has no directory iterator or writer,
// records every handle access and rejects missing / forbidden / non-segment paths.
function vault(files, forbidden=[]) {
  const reads=[];
  function open(prefix, name, options, folder) {
    assert(!options?.create); assert(!/[\\/]/.test(name) && !['.','..'].includes(name));
    const dest = prefix + name; reads.push(dest);
    if(forbidden.includes(dest)) throw new DOMException('private scrub-me', 'NotAllowedError');
    if(folder && Object.keys(files).some(k=>k.startsWith(dest+'/'))) return dir(dest+'/');
    if(!folder && Object.hasOwn(files, dest)) return {getFile:async()=>new Blob([files[dest]])};
    throw new DOMException('missing','NotFoundError');
  }
  function dir(prefix) { return {getDirectoryHandle:async(n,o)=>open(prefix,n,o,true),getFileHandle:async(n,o)=>open(prefix,n,o,false)}; }
  return Object.assign(dir(''),{reads});
}

test('ordinary identities ignore tracking and document anchors but retain meaningful routes and exact queries', async()=>{
  const key = u=>clipKey(page(u));
  const canonical = 'https://site.example/p?a=b%20c&a=d';
  for(const u of ['https://SITE.example:443/p?a=b%20c&a=d&utm_campaign=x#part',canonical+'#:~:text=selected',canonical+'#heading:~:text=selected']) assert.equal(await key(u),await key(canonical));
  for(const change of ['https://site.example/p?a=d&a=b%20c','https://site.example/p?a=b+c&a=d',canonical+'#/article/2',canonical+'#!/article/3',canonical+'#id=33',canonical+'&edition=2',canonical.replace('https:', 'http:')]) assert.notEqual(await key(change),await key(canonical));
  assert.notEqual(await key('https://site.example/#/a'),await key('https://site.example/#/b'));
  await assert.rejects(key('https://user:pass@private.example/'), /来源/);
});
test('video IDs are canonical only for the documented hosts and URL forms', async()=>{
  const key = u=>clipKey(page(u,'youtube')), id='PageLeaf001';
  const expected=await key(`https://www.youtube.com/watch?v=${id}`);
  for(const u of [`https://m.youtube.com/shorts/${id}?t=9`,`https://youtu.be/${id}?si=test&t=30`,`https://www.youtube-nocookie.com/embed/${id}`,`https://www.youtube.com/live/${id}#t=3`]) assert.equal(await key(u),expected);
  assert.notEqual(await key('https://youtu.be/PageLeaf002'),expected);
  for(const u of [`https://youtu.be.fake.example/${id}`,`https://www.youtube.com/watch?v=${id}&v=PageLeaf002`]) await assert.rejects(key(u));
});
test('selection hashes cover full structure, links, inline-image identity/order/location, not random tokens or snippets',async()=>{
  const common='前'.repeat(1200), img=(id,url,alt='示意图')=>({token:sentinel(id),url,alt});
  const build=(id,url,tail='末尾',href='https://links.example/1',prefix=true)=>({...page(source,'selection'),excerpt:'相同'.repeat(110),plain:'',body:`${common}[资料](${href})${prefix?sentinel(id)+tail:tail+sentinel(id)}`,images:[img(id,url),img('c','https://unused.example')]});
  const base=await clipKey(build('a','https://img.example/1'));
  assert.match(base,/^[\da-f]{64}$/); assert.equal(await clipKey(build('b','https://img.example/1')),base);
  for(const c of [build('a','https://img.example/2'),build('a','https://img.example/1','另一尾段'),build('a','https://img.example/1','末尾','https://links.example/2'),build('a','https://img.example/1','末尾','https://links.example/1',false),page(source)]) assert.notEqual(await clipKey(c),base);
  const only=(id,url)=>({...page(source,'selection',sentinel(id)),images:[img(id,url)]});
  assert.equal(await clipKey(only('a','data:image/png;base64,iVBORw==')),await clipKey(only('b','data:image/png;base64,iVBORw==')));
  assert.notEqual(await clipKey(only('a','https://img.example/a')),await clipKey(only('a','https://img.example/b')));
});
test('legacy recognized only from managed rows AND stamped notes, including escaped source/title/CRLF/custom text',async()=>{
  const files = {[index]:('\uFEFF前言 [外部](other.md)\n'+region('说明 [其他](secret.md)\n'+indexRow('文章'))+'\n'+indexRow('文章','private.md')).replace(/\n/g,'\r\n'),[path]:(head('文章')+'\n## 内容摘要\n\n正文提要\n\n## 正文\n\n内容。\n').replace(/\n/g,'\r\n')};
  const root=vault(files,['secret.md','private.md','other.md']);
  assert.equal((await lookupClip(root,page(source))).path,path);
  assert.deepEqual(await lookupClip(root,page(source,'selection','内容。')),{state:'new'});
  assert.deepEqual(await lookupClip(root,page(source.replace('id=1','id=2'))),{state:'new'});
  delete files[path]; assert.deepEqual(await lookupClip(root,page(source)),{state:'new'});
  assert(!root.reads.some(r=>['secret.md','private.md','other.md'].includes(r)));
});
test('legacy selection matches the entire writer-rendered Markdown, not a prefix or a matching body subsection',async()=>{
  const start='长'.repeat(850), body=start+'\n\n# 第二部分\n\n\\[甲\\] &amp; [引用](https://links.example/a)';
  const note=head('摘录')+'\n## 摘录\n\n'+body+'\n';
  const root=vault({[index]:region(indexRow('摘录')),[path]:note});
  assert.equal((await lookupClip(root,page(source,'selection',body))).state,'saved');
  for(const b of [start,body.replace('/a)','/b)'),body+'。',body.slice(body.indexOf('# 第二部分'))]) assert.equal((await lookupClip(root,page(source,'selection',b))).state,'new');
});
test('legacy image selection disambiguates known remote URLs; only indistinguishable local images give uncertainty',async()=>{
  const token=sentinel('a'), clip=(url='https://pic.example/p.png',alt='图',suffix='乙')=>({...page(source,'selection',`甲${token}${suffix}`),images:[{token,url,alt}]});
  const setup=body=>vault({[index]:region(indexRow('摘录')),[path]:head('摘录')+'\n## 摘录\n\n'+body+'\n'});
  const local=setup('甲![图](assets/m-0123456789abcdef/01.png)乙');
  await assert.rejects(lookupClip(local,clip()),/无法核实原图/);
  await assert.rejects(lookupClip(local,clip('https://pic.example/different')),/无法核实原图/);
  for(const different of [clip(undefined,undefined,'丙'),clip(undefined,'手绘图')]) assert.equal((await lookupClip(local,different)).state,'new');
  assert(!local.reads.some(r=>r.includes('assets')));
  const v1=setup('甲![图](assets/%E5%8E%86%E5%8F%B2%E6%A0%87%E9%A2%98/01.webp)乙');
  await assert.rejects(lookupClip(v1,clip()),/无法核实原图/);
  const earlyHttp=setup('甲[图](http://pic.example/old.png)（未保存到本地）乙');
  assert.equal((await lookupClip(earlyHttp,clip('http://pic.example/old.png'))).state,'partial');
  const remote=setup('甲[图](https://pic.example/p.png)（未保存到本地）乙');
  assert.equal((await lookupClip(remote,clip())).state,'partial');
  assert.equal((await lookupClip(remote,clip('https://pic.example/other'))).state,'new');
});
test('unsafe links/receipts and failed or inconsistent reads never expose data or resolve out of the library',async()=>{
  const key=await clipKey(page(source)), receipt=`.pageleaf/${key}.json`;
  for(const dest of ['../secret.md',`${day}/..%2Fprivate.md`,`${day}/a%5Cb.md`,`${day}/a.txt`,`${day}/a.md:stream`,`${day}/NUL.md`,'https://private.example/n.md']) {
    const root=vault({[index]:region(indexRow('文章',dest))});
    await assert.rejects(lookupClip(root,page(source)),/无法核实/); assert.deepEqual(root.reads,['.pageleaf',index]);
  }
  for(const broken of [region(indexRow('文章')).replaceAll('pageleaf:index:v1','pageleaf:index:v2'),`${day}\n## ${day}\n${indexRow('文章')}`,region(indexRow('文章',undefined,' <!-- pageleaf:key:bad -->'))]) {
    await assert.rejects(lookupClip(vault({[index]:broken}),page(source)),/无法核实/);
  }
  for(const data of ['{','{}',JSON.stringify({format:'pageleaf/receipt/1',key,path:'../private.md'})]) {
    const root=vault({[receipt]:data}); await assert.rejects(lookupClip(root,page(source)),/无法核实/); assert(!root.reads.some(r=>r.includes('private.md')));
  }
  for(const root of [vault({[index]:region(indexRow('文章')),[path]:'私人文件'},[path]),vault({[index]:region(indexRow('文章')),[path]:'私人文件'}),vault({[index]:new Uint8Array([0xfe])})]) {
    await assert.rejects(lookupClip(root,page(source)),e=>/无法核实/.test(e.message)&&!/scrub|私人文件|journal/.test(e.message));
  }
});
test('per-identity Web Lock spans completion, including errors, and a later attempt obtains the lock',async t=>{
  if(!navigator.locks) return t.skip('Web Locks not provided');
  const key=await clipKey(page(source)), calls=[];
  let signal, unlock; const started=new Promise(r=>signal=r), gate=new Promise(r=>unlock=r);
  const first=withClipLock(key,async()=>{calls.push('first');signal();await gate;throw Error('test');});
  await started; const second=withClipLock(key,()=>{calls.push('second');});
  assert.deepEqual(calls,['first']); unlock(); await assert.rejects(first,/test/); await second; assert.deepEqual(calls,['first','second']);
});
