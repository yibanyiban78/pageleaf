// Run from the project: node tests/browser.mjs. Requires installed desktop Chrome
// supporting CDP Extensions.triggerAction; PAGELEAF_CHROME may name an alternative
// full Chrome executable. Playwright creates/removes a new, empty temporary profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { posix, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const extension = process.env.PAGELEAF_EXTENSION || fileURLToPath(new URL('../extension/', import.meta.url));
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
// Keep the already-delivered 1.1.0 evidence intact. New runs write to their version's directory.
const evidence = join(here, 'evidence', expectedVersion);
const fixture = name => readFile(join(here, 'browser-fixtures', name), 'utf8');
const [articleHTML, videoHTML, captionJSON] = await Promise.all(['article.html', 'youtube.html', 'timedtext.json'].map(fixture));
const articleURL = 'https://journal.pageleaf.test/field/tide';
const videoURL = 'https://www.youtube.com/watch?v=Stream00001';
const noVideoURL = 'https://www.youtube.com/watch?v=NoTrack0001';
const api = 'https://model.pageleaf.test/v1';
const model = 'fixture-summary';
const token = 'not-a-real-key-pageleaf-fixture';
const answer = '模拟摘要：观测资料记录了样点变化。';
const pictures = Object.fromEntries(await Promise.all(['map','shore','cover'].map(async name=>[name,await readFile(join(here,'browser-fixtures',name+'.png'))])));
const hash = data => createHash('sha256').update(data).digest('hex');
// Pin the exact unpacked build tested, independent of the temporary profile.
async function buildFingerprint(){
  const records=[];
  async function visit(prefix){for(const entry of await readdir(join(extension,prefix),{withFileTypes:true})){
    const name=prefix+entry.name;if(entry.isDirectory())await visit(name+'/');else if(entry.isFile())records.push(name+'\t'+hash(await readFile(join(extension,name))));
  }}
  await visit('');return hash(records.sort().join('\n'));
}
const cors = {'access-control-allow-origin':'*','access-control-allow-headers':'authorization, content-type','access-control-allow-methods':'GET, POST, OPTIONS'};
const report = {device:process.platform, runAt:new Date().toISOString(), node:process.version, trigger:'CDP Extensions.triggerAction on the source tab → Chrome toolbar popup. Inputs target that native popup (verified using chrome.extension.getViews), not a popup.html tab.', directory:'A real, named extension-origin OPFS directory is returned by a test-only picker substitute. OS picker and physical disk permissions are not exercised.', network:'All provided https pages, assets, captions and chat completions intercepted locally; unrecognized requests blocked.', checks:[]};
const checked = s => {report.checks.push(s); console.log('PASS:', s);};
async function until(read, label, timeout=6000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,80));}
  throw Error(`Timed out waiting for ${label}`);
}
// Playwright does not expose a toolbar popup in context.pages(). Attach to its
// actual renderer via CDP's nested-session transport; never replace the source tab.
async function nativePopup(browser, targetId) {
  const {sessionId}=await browser.send('Target.attachToTarget',{targetId,flatten:false});
  let sequence=0, closed=false;
  const pending=new Map();
  function receive(event){
    if(event.sessionId!==sessionId)return;
    const message=JSON.parse(event.message), call=pending.get(message.id);
    if(!call)return;
    pending.delete(message.id); clearTimeout(call.timer);
    if(message.error)call.reject(Error(message.error.message)); else call.resolve(message.result);
  }
  function detach(event){
    if(event.sessionId!==sessionId)return;
    closed=true; browser.off('Target.receivedMessageFromTarget',receive); browser.off('Target.detachedFromTarget',detach);
    for(const call of pending.values()){clearTimeout(call.timer);call.reject(Error('Native popup target closed'));} pending.clear();
  }
  browser.on('Target.receivedMessageFromTarget',receive); browser.on('Target.detachedFromTarget',detach);
  function send(method,params={}){
    if(closed)return Promise.reject(Error('Native popup target closed'));
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('Native popup CDP timeout: '+method));},4000);
      pending.set(id,{resolve,reject,timer});
      browser.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(e=>{clearTimeout(timer);pending.delete(id);reject(e);});
    });
  }
  async function evaluate(expression){
    const {result,exceptionDetails}=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(exceptionDetails)throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
  // The targeted button/key may destroy the popup before the renderer can
  // respond. Only a proven detach is allowed, and callers independently check effects.
  async function finalEvent(action){try{await action();}catch(e){if(!closed)throw e;}}
  async function click(selector){
    const [x,y]=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();if(e.disabled||!r.width||!r.height)throw Error('Button unavailable');return [r.x+r.width/2,r.y+r.height/2]})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
    await finalEvent(()=>send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1}));
  }
  return {evaluate,click,send,targetId,finalEvent};
}

let ctx, settingsShot, narrowShot, previewShot;
const chromePath = process.env.CHROME_PATH || process.env.PAGELEAF_CHROME;
try {
  ctx = await chromium.launchPersistentContext('', {
    ...(chromePath ? {executablePath:chromePath} : {channel:'chrome'}),
    headless:true, locale:'zh-CN', viewport:{width:1280,height:900},
    ignoreDefaultArgs:['--disable-extensions'],
    // No global/browser installation changes, network proxy, private user profile or CDP TCP port.
    args:['--enable-unsafe-extension-debugging','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  const browser = await ctx.browser().newBrowserCDPSession();
  report.browser = (await browser.send('Browser.getVersion')).product;
  let failAI = false, failImage = false, concurrentGate = null;
  assert.match(report.browser,/^Chrome\/158\./,'This acceptance run targets full Chrome 158');
  let captionRequests = 0, assetRequests = 0;
  const calls = [], blocked = [], unexpectedAuth = [], routeErrors = [], scriptErrors = [];
  ctx.on('page', p=>p.on('pageerror', e=>scriptErrors.push(String(e.message).slice(0,350))));
  await ctx.route(/^https?:\/\//, async r=>{
    const q = r.request(), u = new URL(q.url());
    try {
      const auth = (await q.allHeaders()).authorization;
      if (auth && !(u.origin === new URL(api).origin && u.pathname === '/v1/chat/completions')) unexpectedAuth.push(u.origin);
      if (q.method() === 'OPTIONS') return await r.fulfill({status:204,headers:cors});
      if (u.href === articleURL) return await r.fulfill({contentType:'text/html; charset=utf-8',body:articleHTML});
      if ([videoURL,noVideoURL].includes(u.href)) return await r.fulfill({contentType:'text/html; charset=utf-8',body:videoHTML});
      if (u.origin === 'https://www.youtube.com' && u.pathname === '/api/timedtext') {
        captionRequests++;
        return await r.fulfill({contentType:'application/json',headers:cors,body:captionJSON});
      }
      if ((['https://journal.pageleaf.test','https://www.youtube.com'].includes(u.origin) && /^\/media\/(?:map|shore)\.png$/.test(u.pathname)) || (u.origin === 'https://i.ytimg.com' && /^\/vi\/(?:Stream00001|NoTrack0001)\/cover\.png$/.test(u.pathname))) {
        assetRequests++;
        return await r.fulfill({status:failImage && u.pathname==='/media/shore.png'?404:200,headers:cors,contentType:'image/png',body:pictures[posix.basename(u.pathname,'.png')]});
      }
      if (u.href === api + '/chat/completions' && q.method() === 'POST') {
        calls.push({body:q.postDataJSON(),validHeader:auth===`Bearer ${token}`});
        if(concurrentGate){const gate=concurrentGate;gate.arrivals++;if(gate.arrivals===2)gate.release();await gate.promise;}
        return await r.fulfill({status:failAI?503:200,headers:cors,contentType:'application/json',json:failAI?{error:{message:'fixture offline'}}:{choices:[{message:{role:'assistant',content:answer}}]}});
      }
      blocked.push(u.origin + u.pathname);
      return await r.abort('blockedbyclient');
    } catch(e) { routeErrors.push(e.message); await r.abort('failed').catch(()=>{}); }
  });
  report.extensionFingerprint=await buildFingerprint();
  const {id} = await browser.send('Extensions.loadUnpacked',{path:extension});
  const ext = `chrome-extension://${id}`;
  await ctx.addInitScript(origin=>{
    if (location.origin !== origin) return;
    window.showDirectoryPicker = async ()=>(await navigator.storage.getDirectory()).getDirectoryHandle('Pageleaf 验收目录',{create:true});
  }, ext);
  const worker=ctx.serviceWorkers().find(w=>w.url().startsWith(ext+'/')) || await ctx.waitForEvent('serviceworker',w=>w.url().startsWith(ext+'/'));
  await until(()=>worker.evaluate(()=>Boolean(globalThis.chrome?.runtime?.getManifest)),'extension worker runtime initialization');
  const manifest=await worker.evaluate(()=>chrome.runtime.getManifest());
  report.extensionVersion=manifest.version;
  assert.equal(manifest.version,expectedVersion);assert.equal(manifest.action.default_popup,'popup.html');
  assert.deepEqual(manifest.permissions.toSorted(),['activeTab','scripting','storage']);assert.deepEqual(manifest.host_permissions||[],[]);
  assert.deepEqual(manifest.optional_host_permissions.toSorted(),['https://*/*','http://localhost/*','http://127.0.0.1/*','http://[::1]/*'].toSorted());
  const optionsURL=ext+'/settings.html', jobURL=ext+'/job.html';
  const tabTargets={settings:new Set(),jobs:new Set()}, activeSettings=new Set();let settingsActivations=0;
  // Track transient page navigations and activations of an existing options tab,
  // not just a final snapshot of currently open tabs.
  const record=({targetInfo:t})=>{
    if(t.type==='tab' && t.url===optionsURL){
      if(t.embedderData?.tabActive){if(!activeSettings.has(t.targetId))settingsActivations++;activeSettings.add(t.targetId);}
      else activeSettings.delete(t.targetId);
    }
    if(t.type!=='page')return;
    if(t.url===optionsURL)tabTargets.settings.add(t.targetId);if(t.url.startsWith(jobURL))tabTargets.jobs.add(t.targetId);
  };
  browser.on('Target.targetCreated',record);browser.on('Target.targetInfoChanged',record);
  await browser.send('Target.setDiscoverTargets',{discover:true,filter:[{}]});
  const allTargets=async()=>(await browser.send('Target.getTargets',{filter:[{}]})).targetInfos;
  const article=await ctx.newPage(); await article.goto(articleURL);
  // The observer runs in the isolated extension process, not an options tab. It
  // reads the entire OPFS tree (including empty directories), never creating fixtures.
  async function effects(){
    const state=await worker.evaluate(async()=>{
      const entries=[], digests={};
      async function walk(dir,prefix){for await(const [name,handle] of dir.entries()){
        const path=prefix+name;entries.push(path+(handle.kind==='directory'?'/':''));
        if(handle.kind==='directory')await walk(handle,path+'/');
        else {const f=await handle.getFile(),bytes=await crypto.subtle.digest('SHA-256',await f.arrayBuffer());digests[path]=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
      }}
      await walk(await navigator.storage.getDirectory(),'');
      const {lastResult}=await chrome.storage.local.get('lastResult');
      return {entries:entries.sort(),digests,lastResult:lastResult||null};
    });
    return {...state,jobs:tabTargets.jobs.size,settings:tabTargets.settings.size,settingsActivations,assetRequests,captionRequests,chatPosts:calls.length};
  }
  async function unchanged(before,label){
    // Allow asynchronous tab creation/storage/network callbacks to arrive, not
    // just synchronous button side effects; observers remain active for the run.
    await new Promise(r=>setTimeout(r,220));assert.deepEqual(await effects(),before,label);
  }
  async function openPreview(p, ready=true){
    await p.bringToFront();
    const targets=await allTargets(),matches=targets.filter(t=>t.type==='tab'&&t.url===p.url());
    assert.equal(matches.length,1,'Fixture URL must identify exactly one source tab');
    assert(!targets.some(t=>t.type==='page'&&t.url===ext+'/popup.html'),'Previous popup still open');
    await browser.send('Extensions.triggerAction',{id,targetId:matches[0].targetId});
    const target=await until(async()=>(await allTargets()).find(t=>t.type==='page'&&t.url===ext+'/popup.html'),'toolbar popup target');
    const popup=await nativePopup(browser,target.targetId);
    assert(await popup.evaluate("chrome.extension.getViews({type:'popup'}).includes(window)"),'Not a native toolbar popup');
    const state=()=>popup.evaluate(`(()=>{const q=id=>document.getElementById(id);return {${['title','kind','destination','status','source','author','byline-label','excerpt','images','cover','captions','summary'].map(id=>`${JSON.stringify(id)}:q(${JSON.stringify(id)})?.textContent`).join(',')},disabled:q('confirm')?.disabled,settingsVisible:q('settings')?.checkVisibility()}})()`);
    const ui=await until(async()=>{const ui=await state();return (ready?ui.disabled===false:ui.disabled&&ui.settingsVisible&&ui.status&&!ui.status.includes('正在读取'))&&ui;},'popup preview '+(ready?'ready':'blocked')).catch(async e=>{throw Error(e.message+'; UI='+JSON.stringify(await state()));});
    return Object.assign(popup,{ui,state,waitClosed:async()=>{try{await until(async()=>!(await allTargets()).some(t=>t.targetId===target.targetId),'native popup renderer destruction');}catch(e){throw Error(e.message+'; '+await popup.evaluate(`JSON.stringify({viewport:[innerWidth,innerHeight],button:document.querySelector('#cancel').getBoundingClientRect(),status:document.querySelector('#status').textContent,focus:document.activeElement.id})`));}}});
  }
  async function confirm(popup){
    await popup.click('#confirm');
    await popup.waitClosed().catch(async e=>{throw Error(e.message+'; popup status='+(await popup.state()).status);});
  }
  async function clip(p,options={}){
    await worker.evaluate(()=>chrome.storage.local.remove('lastResult'));
    const before=await effects(),preview=await openPreview(p);
    options.verify?.(preview.ui);
    if(options.beforeConfirm)await options.beforeConfirm(preview);
    await unchanged(before,'Preview before confirm must have no side effects');
    if(options.double){
      // Deliberately activate twice in ONE renderer turn, before async handoff.
      // This exercises the button's real listener, including its synchronous lock.
      await preview.finalEvent(()=>preview.evaluate("(()=>{const button=document.querySelector('#confirm');button.click();button.click();})()"));
      await preview.waitClosed();
    } else await confirm(preview);
    const lastResult=await until(()=>worker.evaluate(async()=>(await chrome.storage.local.get('lastResult')).lastResult),'confirmed toolbar job',18000);
    assert(!JSON.stringify(lastResult).includes(token),'Secret in user-facing result');
    await until(async()=>!(await allTargets()).some(t=>t.url.startsWith(jobURL)),'job tab to close');
    assert.equal(tabTargets.jobs.size-before.jobs,1,'Exactly one job target per confirmation');
    assert.equal(tabTargets.settings.size,before.settings,'Save must not open settings');
    assert.equal(settingsActivations,before.settingsActivations,'Save must not focus the options tab');
    return lastResult;
  }
  const fresh=await effects();assert.deepEqual(fresh.entries,[]);assert.equal(fresh.jobs,0);assert.equal(fresh.settings,0);
  const missing=await openPreview(article,false);
  assert.match(missing.ui.destination,/未选择/);assert.match(missing.ui.summary,/未.*就绪|不生成摘要/);
  assert.match(missing.ui.status,/目录|文件夹|授权/);assert.equal(missing.ui.disabled,true);assert.equal(missing.ui.title,'潮间带观测手记');
  await unchanged(fresh,'Missing root must not create a task, a settings tab, files or requests');
  await missing.click('#cancel');await missing.waitClosed();await unchanged(fresh,'Missing-root cancellation');
  checked('Native toolbar popup (verified Chrome popup view): missing directory shows a disabled confirm and an in-popup explanation; no note, folder, index, AI, extra asset request, task or settings tab');
  const unsupported=await ctx.newPage();await unsupported.goto('chrome://version/');
  const blockedPreview=await openPreview(unsupported,false);
  assert.match(blockedPreview.ui.status,/不支持|普通网页|无法读取/);assert.equal(blockedPreview.ui.disabled,true);
  await unchanged(fresh,'Unsupported tab must not redirect or save');
  await blockedPreview.click('#cancel');await blockedPreview.waitClosed();await unchanged(fresh,'Unsupported cancellation');await unsupported.close();
  checked('Unsupported chrome:// page: popup explains why saving is unavailable; no job, options redirect or archive side effects');
  const goSettings=await openPreview(article,false);await unchanged(fresh,'Before intentional settings click');
  await goSettings.click('#settings');await goSettings.waitClosed();
  const settings=await until(()=>ctx.pages().find(p=>p.url()===optionsURL),'user-requested settings tab');
  await settings.locator('#choose').waitFor();assert.equal(tabTargets.settings.size,fresh.settings+1);
  checked('Only clicking 去设置 opens the real options page');
  await settings.bringToFront();
  await settings.locator('#choose').click();
  await until(()=>settings.evaluate(async()=> (await (await import('./store.js')).getRoot())?.name === 'Pageleaf 验收目录'),'OPFS root to persist');
  await settings.evaluate(()=>chrome.storage.local.remove('lastResult')); // clean setup screenshot after the explicit no-root test
  await settings.reload();
  await settings.waitForFunction(()=>document.body.innerText.includes('Pageleaf 验收目录'));
  assert(await settings.evaluate(async()=> (await (await import('./store.js')).getRoot()) instanceof FileSystemDirectoryHandle));
  checked('Settings directory button persists a real, writable FileSystemDirectoryHandle across reload');
  assert.equal(await settings.locator('#key').inputValue(),'');
  assert(!(await settings.locator('body').innerText()).includes(token));
  settingsShot = await settings.screenshot({fullPage:true});
  await settings.setViewportSize({width:390,height:844});
  assert(await settings.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
  narrowShot = await settings.screenshot({fullPage:true});
  await settings.setViewportSize({width:1280,height:900});
  checked('Settings screenshots captured before any fixture key was entered; no horizontal overflow at 390 px');

  // An OS/chrome-level permission bubble cannot be answered with a page click in
  // headless. Limit the stand-in to this one UI document + one test origin;
  // do not modify any browser permission, content script, worker, or job page.
  await settings.bringToFront();
  await settings.evaluate(pattern=>{
    window.fixtureConsent=false;
    window.fixtureRequests=[];
    chrome.permissions.request=async request=>{
      window.fixtureRequests.push(request);
      if(request.origins?.length!==1 || request.origins[0]!==pattern || request.permissions?.length)throw Error('Unexpected permission request');
      return window.fixtureConsent;
    };
  },new URL(api).origin+'/*');
  await settings.locator('#endpoint').fill(api);
  await settings.locator('#model').fill(model);
  const fillVault = async () => {
    await settings.locator('#key').fill(token);
    await settings.locator('#vault-pass').fill('field notes temporary fixture');
    await settings.locator('#vault-confirm').fill('field notes temporary fixture');
  };
  await fillVault();
  await settings.locator('#save').click();
  await settings.waitForFunction(()=>document.querySelector('#aimsg').textContent.includes('未获'));
  assert.equal(await settings.evaluate(async()=>(await (await import('./store.js')).getConfig()).endpoint),'');
  await settings.evaluate(()=>{window.fixtureConsent=true;});
  await fillVault();
  await settings.locator('#save').click();
  await until(()=>settings.evaluate(async arg=>{const v=await (await import('./store.js')).getConfig();return v.key===arg.key && v.model===arg.model && v.endpoint===arg.endpoint;},{endpoint:api,model,key:token}),'settings form to persist');
  assert.deepEqual(await settings.evaluate(()=>window.fixtureRequests),[{origins:[new URL(api).origin+'/*']},{origins:[new URL(api).origin+'/*']}]);
  await settings.reload(); // discards the permissions.request stub
  await settings.waitForFunction(expected=>document.querySelector('#model').value===expected,model);
  assert.equal(await settings.locator('#key').inputValue(),'');
  report.aiSetup='Real settings form: first denied, then saved with a page-local test consent callback scoped to the exact fixture API host. After reload the key is not displayed. Native host permission bubble not exercised; mock server supports CORS.';
  checked(report.aiSetup);

  async function files() {
    return settings.evaluate(async()=>{
      const {getRoot}=await import('./store.js'); const out={};
      async function visit(dir,prefix){for await(const [n,h] of dir.entries()){
        const path=prefix+n;
        if (h.kind==='directory') {await visit(h,path+'/');continue;}
        const f=await h.getFile();
        if (/\.md$/i.test(n)) {out[path]={text:await f.text()};continue;}
        const bitmap=await createImageBitmap(f); // decode the saved bytes, without a network URL
        out[path]={size:f.size,width:bitmap.width,height:bitmap.height,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')};bitmap.close();
      }}
      await visit(await getRoot(),''); return out;
    });
  }
  const paths=[];
  const saved = async(p,status,expectedImages,options)=>verifySaved(await clip(p,options),status,expectedImages);
  async function verifySaved(r, status, nImages) {
    assert.equal(r.state,status,r.message); assert.match(r.path,/^\d{4}-\d{2}-\d{2}\/[^/]+\.md$/);
    const vault=await files(), text=vault[r.path]?.text;
    const expectedDate=await settings.evaluate(time=>{const d=new Date(time); return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');},r.time);
    assert(r.path.startsWith(expectedDate+'/'),'Not filed under local date');
    assert(text,'Status path does not exist'); assert(!paths.includes(r.path),'Reused filename'); paths.push(r.path);
    const images=[...text.matchAll(/!\[[^\n]*?\]\(([^)]+)\)/g)].map(m=>m[1]);
    assert.equal(images.length,nImages.length,text);
    for(const [i,src] of images.entries()){assert(!/^(?:[a-z]+:|\/)/i.test(src),`Non-relative embedded image: ${src}`); const path=posix.join(posix.dirname(r.path),decodeURIComponent(src.replace(/^<|>$/g,'')));assert.equal(vault[path]?.sha256,hash(pictures[nImages[i]]),`Wrong or missing image ${path}`);}
    assert(!text.includes(token));
    return {r,text};
  }
  const plainInput = i=>{const {body,validHeader}=calls[i];assert(validHeader,'Wrong or missing fixture credential');assert.equal(body.model,model);const users=body.messages.filter(m=>m.role==='user'); assert.equal(users.length,1);assert.equal(typeof users[0].content,'string');return users[0].content;};
  function articlePreview(ui){
    assert.equal(ui.kind,'整篇文章'); assert.equal(ui.title,'潮间带观测手记');assert.equal(ui.author,'林青');assert.equal(ui.source,articleURL);
    assert.match(ui.excerpt,/标记正文/);assert.match(ui.images,/2 张/);assert.match(ui.destination,/Pageleaf 验收目录\/\d{4}-\d{2}-\d{2}\/.*\.md/);
    assert.match(ui.summary,/正文.*AI|AI.*正文/);assert.match(ui.status,/尚未保存/);assert.equal(ui.disabled,false);
  }
  const empty=await effects();assert.deepEqual(empty.entries,['Pageleaf 验收目录/']);assert.equal(empty.chatPosts,0);assert.equal(empty.jobs,0);
  for(const action of ['取消','Escape','切换标签']){
    const preview=await openPreview(article);articlePreview(preview.ui);
    if(!previewShot){
      await preview.evaluate('document.fonts.ready.then(()=>true)');
      report.popupViewport=await preview.evaluate(`(()=>{const rect=id=>document.querySelector(id).getBoundingClientRect();return {width:innerWidth,height:innerHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,buttonVisible:rect('#confirm').bottom<=innerHeight+1,destinationAboveFooter:rect('#destination').bottom<=rect('footer').top+1}})()`);
      assert.equal(report.popupViewport.horizontalOverflow,false);assert.equal(report.popupViewport.buttonVisible,true);
      previewShot=Buffer.from((await preview.send('Page.captureScreenshot',{format:'png'})).data,'base64');
      report.articlePreview=preview.ui;
    }
    await unchanged(empty,`${action}: opening preview has no side effects`);
    if(action==='取消')await preview.click('#cancel');
    else if(action==='Escape')await preview.finalEvent(()=>preview.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}));
    else await ctx.pages().find(p=>p.url()==='about:blank').bringToFront(); // browser closes popup on focus loss
    await preview.waitClosed();await unchanged(empty,`${action}: dismissing the popup must not save or submit`);
    checked(`Native ${action}: popup renderer closed. OPFS still contains only the empty chosen folder; no AI, asset/caption fetch, index, job or settings tab`);
  }
  // Changing a source URL via page script does not dismiss Chrome's popup. A
  // stale click must fail closed rather than saving content under the wrong URL.
  const stale=await openPreview(article);
  await article.evaluate(()=>history.replaceState(null,'','?different-source=1'));
  await stale.click('#confirm');
  const changed=await until(async()=>{const ui=await stale.state();return ui.disabled&&/切换|变更|重新预览/.test(ui.status)&&ui;},'rejection of stale source');
  assert.match(changed.status,/重新预览/);await unchanged(empty,'Stale source confirmation did not save');
  await stale.click('#cancel');await stale.waitClosed();await article.evaluate(url=>history.replaceState(null,'',url),articleURL);
  checked('Changed the source URL while the native preview remained open: explicit confirmation was rejected; neither a job nor a note was created');
  const switched=await openPreview(article);
  await settings.evaluate(async()=>{const {getRoot,setRoot}=await import('./store.js');window.qaOriginalRoot=await getRoot();await setRoot(await (await navigator.storage.getDirectory()).getDirectoryHandle('Second fixture root',{create:true}));});
  const swapped=await effects();assert.deepEqual(swapped.entries,['Pageleaf 验收目录/','Second fixture root/']);
  await switched.click('#confirm');
  await until(async()=>{const ui=await switched.state();return ui.disabled&&/目录.*改变|目录.*变更/.test(ui.status);},'rejection of stale directory');
  await switched.click('#cancel');await switched.waitClosed();await unchanged(swapped,'Stale folder confirmation did not write to either directory');
  await settings.evaluate(async()=>{await (await import('./store.js')).setRoot(window.qaOriginalRoot);delete window.qaOriginalRoot;});
  checked('Changed the persisted directory handle after preview: confirmation rejected, both real OPFS directories stayed empty, and no job or settings redirect occurred');
  const full=await saved(article,'ok',['map','shore'],{double:true,verify:articlePreview});
  assert.deepEqual(Object.keys(await files()).filter(s=>s.endsWith('.md')).sort(),[full.r.path,'剪藏索引.md'].sort());
  checked('Two same-turn confirm button activations in the actual popup produced exactly one job tab, one note and one index entry');
  for(const expect of ['潮间带观测手记','林青',articleURL,'## 样点与潮线','**观察芦苇**','图一：盐沼样点的潮线。',answer]) assert(full.text.includes(expect),`Missing article field: ${expect}`);
  assert(!full.text.includes('NOISE_')); assert.equal(calls.length,1);
  assert.match(plainInput(0),/标记正文/);assert.match(plainInput(0),/未选标记/);assert.doesNotMatch(plainInput(0),/NOISE_|https?:|<img|!\[|\*\*|Bearer|PAGELEAFIMG/);
  checked('Article: native toolbar → clean formatted Markdown, author/source/caption, two byte-identical local assets and plain-text-only mock Chinese summary');
  async function selectExcerpt(p){await p.locator('#excerpt').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);});}
  await selectExcerpt(article);
  const sel=await saved(article,'ok',['map'],{
    verify:ui=>{assert.equal(ui.kind,'选段摘录');assert.match(ui.excerpt,/选区标记/);assert.match(ui.images,/1 张/);assert.match(ui.summary,/不调用 AI/);},
    beforeConfirm:async()=>{await article.evaluate(()=>{const replacement=document.querySelector('h2');const r=document.createRange();r.selectNodeContents(replacement);const s=getSelection();s.removeAllRanges();s.addRange(r);});assert.equal(await article.evaluate(()=>getSelection().toString()),'样点与潮线');}
  });
  assert.match(sel.text,/选区标记/);assert.match(sel.text,/\*\*观察芦苇\*\*/);assert.match(sel.text,/https:\/\/journal\.pageleaf\.test\/reference\/field-guide/);assert.doesNotMatch(sel.text,/标记正文|未选标记|模拟摘要/);assert.equal(calls.length,1);
  checked('Selection snapshot: changed the source highlight while the popup stayed open; confirmation saved the originally previewed formatted selection and its image, with no AI request');
  const video=await ctx.newPage();await video.goto(videoURL);
  await selectExcerpt(video);const videoSel=await saved(video,'ok',['map']);
  assert.match(videoSel.text,/视频选区标记/);assert.doesNotMatch(videoSel.text,/字幕起点|视频简介标记/);assert.equal(calls.length,1);assert.equal(captionRequests,0);
  checked('YouTube selection takes precedence over video logic; no transcript or AI request');
  await video.evaluate(()=>getSelection().removeAllRanges());
  const yt=await saved(video,'ok',['cover'],{verify:ui=>{assert.equal(ui.kind,'YouTube 视频');assert.equal(ui.title,'山溪观测');assert.equal(ui.author,'水文工作室');assert.equal(ui.source,videoURL);assert.match(ui.excerpt,/视频简介标记/);assert.match(ui.cover,/可.*保存/);assert.match(ui.captions,/待/);assert.match(ui.summary,/字幕.*AI/);report.videoPreview=ui;}});
  for (const expected of ['水文工作室','https://www.youtube.com/channel/UC','视频简介标记','字幕起点','字幕尾点',answer]) assert(yt.text.includes(expected),`Missing video field: ${expected}`);
  assert.match(yt.text,/https:\/\/www\.youtube\.com\/watch\?v=Stream00001(?:&amp;|&)t=74s?/);assert.equal(calls.length,2);assert(captionRequests>=1);
  const transcript=plainInput(1);assert.match(transcript,/字幕起点/);assert.match(transcript,/字幕尾点/);assert.doesNotMatch(transcript,/简介|山溪观测|水文工作室|https?:/);
  checked('YouTube player → real JSON3 request → full captions + 74s jump link, linked channel, description, local cover; AI receives captions only');
  await video.goto(noVideoURL);const none=await saved(video,'warn',['cover']);
  assert.match(none.r.message,/字幕/);assert.doesNotMatch(none.text,/模拟摘要|字幕起点/);assert.match(none.text,/视频简介标记/);assert.equal(calls.length,2);
  checked('Video without subtitles: metadata + local cover saved with warning, zero AI requests and no invented summary');
  failAI=true;failImage=true;
  await article.evaluate(()=>getSelection().removeAllRanges());
  const degraded=await saved(article,'warn',['map']);
  assert.match(degraded.text,/标记正文/);assert.match(degraded.text,/https:\/\/journal\.pageleaf\.test\/media\/shore\.png/);assert.match(degraded.r.message,/503/);assert.equal(calls.length,3);assert.notEqual(degraded.r.path,full.r.path);
  checked('AI 503 + image 404: full note still saved under a new name, original image URL recorded; original note not overwritten');
  failAI=false;failImage=false;
  await settings.evaluate(()=>{window.pairedResults=[];chrome.storage.onChanged.addListener((delta,area)=>{if(area==='local' && delta.lastResult?.newValue)window.pairedResults.push(delta.lastResult.newValue);});});
  const pair={arrivals:0}; pair.promise=new Promise(resolve=>{pair.release=resolve;});concurrentGate=pair;
  try {
    await confirm(await openPreview(article));
    await until(()=>pair.arrivals===1,'first confirmed job to reach mock API');
    await confirm(await openPreview(article));
    await until(()=>pair.arrivals===2,'both independent jobs to reach the mock API concurrently');
    const results=await until(()=>settings.evaluate(()=>window.pairedResults.length===2 && window.pairedResults),'both concurrent notes');
    for(const result of results)await verifySaved(result,'ok',['map','shore']);
  } finally {pair.release();concurrentGate=null;}
  checked('Two overlapping native toolbar jobs reached the API before either was released: both notes, separate local media directories and index entries survived');
  const vault=await files();assert.equal(vault[full.r.path].text,full.text);
  const index=vault['剪藏索引.md']?.text; assert(index,'Missing root index');
  const indexTargets=[...index.matchAll(/\[[^\n]*?\]\(([^)]+\.md)\)/g)].map(m=>decodeURIComponent(m[1]));
  assert.deepEqual(indexTargets.sort(),paths.toSorted());
  assert(!JSON.stringify(vault).includes(token)); assert.deepEqual(unexpectedAuth,[]);assert.deepEqual(routeErrors,[]);assert.deepEqual(scriptErrors,[]);
  checked('Root index links resolve exactly once to each saved note, all relative asset links resolve under the vault, and no fixture credential leaked to output or other hosts');
  report.archive={paths,files:vault};
  // Use another newly created OPFS root; the verified archive above stays unchanged.
  await settings.evaluate(async()=>{
    const {setRoot}=await import('./store.js'), dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('Index collision fixture',{create:true});
    await dir.getDirectoryHandle('剪藏索引.md',{create:true});await setRoot(dir);
  });
  await selectExcerpt(article);
  const indexFailure=await clip(article);assert.equal(indexFailure.state,'warn',indexFailure.message);assert.match(indexFailure.message,/笔记已保存[，,]索引未更新/);
  assert.match((await files())[indexFailure.path]?.text,/选区标记/);
  checked('Real OPFS index path collision: note remains readable; native completion explicitly distinguishes note saved from index not updated');
  assert.deepEqual(unexpectedAuth,[]);assert.deepEqual(routeErrors,[]);assert.deepEqual(scriptErrors,[]);assert.deepEqual(blocked,[]);
  assert.equal(await buildFingerprint(),report.extensionFingerprint,'Unpacked extension files changed during this run; rerun against one build');
  report.indexFailure=indexFailure;report.networkCounts={chatPosts:calls.length,captionRequests,assetRequests,blockedUnrecognized:blocked};report.passed=true;
} catch(e) {report.passed=false;report.failure=String(e.message).replaceAll(token,'[redacted]').slice(0,2500);console.error(String(e.stack ?? report.failure).replaceAll(token,'[redacted]'));process.exitCode=1;}
finally {await ctx?.close(); await mkdir(evidence,{recursive:true});if(previewShot)await writeFile(join(evidence,'popup-article.png'),previewShot);if(settingsShot)await writeFile(join(evidence,'settings-desktop.png'),settingsShot);if(narrowShot)await writeFile(join(evidence,'settings-mobile.png'),narrowShot);await writeFile(join(evidence,'browser.json'),JSON.stringify(report,null,2)+'\n');}
