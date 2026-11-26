// CLIP-007 • Windows desktop, Chrome with Extensions.triggerAction, Node 24+, Python 3.
// npm ci; python tools/package_store.py; node tests/store-profiles.mjs
// Clean checkout without the old ZIP? In PowerShell, from the project:
//   $old = Join-Path $env:TEMP ('pageleaf-tag-' + [guid]::NewGuid())
//   git -c core.autocrlf=false clone --depth 1 --branch v1.1.1-rc.1 https://github.com/yibanyiban78/pageleaf.git $old
//   python (Join-Path $old 'tools/package_store.py')
//   $env:PAGELEAF_OLD_ZIP = Join-Path $old 'release/pageleaf-cws-1.1.1.zip'
// The test verifies the known archive digest before launching; no test performs a clone.
// No sign-in, sync, normal user profile, global keyboard/mouse events or old evidence writes.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const project = fileURLToPath(new URL('../', import.meta.url));
const oldVersion='1.1.1', version='1.2.0', archive=`pageleaf-cws-${version}.zip`;
const oldZip=process.env.PAGELEAF_OLD_ZIP || join(project,'release',`pageleaf-cws-${oldVersion}.zip`);
const oldHash='123b2e7ee993a073e230241427baf67be53973b441c84073d5232525e483a716';
const zip=join(project,'release',archive);
let png; // Reuse the pinned old ZIP’s valid 16px icon as the mock HTTPS raster.
const digest = data => createHash('sha256').update(data).digest('hex');
const index = '剪藏索引.md';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(read, label, ms = 10000) {
  const end = Date.now() + ms;
  do { const value = await read(); if (value) return value; await sleep(80); } while (Date.now() < end);
  throw Error(`Timeout: ${label}`);
}
function fixture(name) {
  const lower = name.toLowerCase();
  return { name, vault: `Vault-${name}`, endpoint: `https://model-${lower}.pageleaf.test/v1`, model: `fixture-${lower}`,
    token: randomBytes(24).toString('hex'), pass:randomBytes(24).toString('hex'),
    notes:[], posts:0, httpsGets:0, httpAttempts:0, violations:0, logLeaks:0, snapshots:{} };
}
const profiles = [fixture('Amber'), fixture('Cobalt')];
const report = {task:'CLIP-007',startedAt:new Date().toISOString(),device:process.env.COMPUTERNAME,
  platform:process.platform,node:process.version,baseline:oldVersion,baselineSha256:oldHash,candidate:archive,version,runs:[]};
const secrets=profiles.flatMap(p=>[p.token,p.pass]);
const redact=text=>secrets.reduce((s,value)=>s.replaceAll(value,'[redacted]'),String(text));
const noSecrets=value=>secrets.every(x=>!String(value).includes(x));
function spec(p,phase) {
  const stem=`article-${p.name.toLowerCase()}.pageleaf.test`, media=phase!=='baseline';
  return {title:`${p.name} ${phase}`, marker:`${p.name}Body${phase}`,summary:`${p.name}Summary${phase}`,
    url:`https://${stem}/entry/${phase}`, media, ai:['baseline','unlocked','reloaded'].includes(phase),
    http:`http://${stem}/original.png?signature=fixture%2B${phase}&page=1`, https:`https://${stem}/allowed-${phase}.png`};
}

// Only address controls owned by the precise CDP browser PID. Never use SendKeys,
// desktop-wide clicks, active window assumptions, the clipboard, or a real profile.
const nativeBase = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes
$procId=[int]$env:CLIP_TEST_PID; $folder=$env:CLIP_TEST_VAULT
$child=[Windows.Automation.TreeScope]::Children; $desc=[Windows.Automation.TreeScope]::Descendants
function prop($p,$v){[Windows.Automation.PropertyCondition]::new($p,$v)}
$pidCond=prop ([Windows.Automation.AutomationElement]::ProcessIdProperty) $procId
function windows(){[Windows.Automation.AutomationElement]::RootElement.FindAll($child,$pidCond)}
function owned($e){$e -and $e.Current.ProcessId -eq $procId}
`;
const nativePicker = String.raw`
Add-Type 'using System;using System.Runtime.InteropServices;public class Picker { [DllImport("user32.dll")]public static extern IntPtr GetDlgItem(IntPtr h,int id); [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,string s,uint flags,uint timeout,out IntPtr result);[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint process);}'
$native=prop ([Windows.Automation.AutomationElement]::ClassNameProperty) '#32770'
$end=(Get-Date).AddSeconds(7)
do {
  foreach($w in (windows)) {
    $d=if($w.Current.ClassName -eq '#32770'){$w}else{$w.FindFirst($desc,$native)}
    if($d){$observed=($d.Current.Name+'; dialog PID='+$d.Current.ProcessId+'; browser PID='+$procId)}
    if(!$d -or $d.Current.Name -notin @('Select where this site can save changes','选择要让此网站将所做更改保存到何处')){continue}
    # Windows can host a picker in a chrome.exe utility child. Prove its process
    # ancestry, not just its title, and recheck the owner of each targeted HWND.
    $dialogPid=$d.Current.ProcessId;$ancestor=$dialogPid
    for($i=0;$i -lt 5 -and $ancestor -ne $procId;$i++){$pr=Get-CimInstance Win32_Process -Filter "ProcessId=$ancestor";if(!$pr -or $pr.Name -ne 'chrome.exe'){break};$ancestor=$pr.ParentProcessId}
    if($ancestor -ne $procId){throw 'Folder picker does not belong to the isolated Chrome process tree'}
    $h=[IntPtr]$d.Current.NativeWindowHandle; $edit=[Picker]::GetDlgItem($h,1152); $ok=[Picker]::GetDlgItem($h,1)
    foreach($c in @($h,$edit,$ok)){$owner=[uint32]0;if($c -eq [IntPtr]::Zero -or ![Picker]::GetWindowThreadProcessId($c,[ref]$owner) -or $owner -ne $dialogPid){throw 'Picker control is missing or not owned by our Chrome'}}
    $out=[IntPtr]::Zero;if(![Picker]::SendMessageTimeout($edit,12,[IntPtr]::Zero,$folder,2,2000,[ref]$out) -or !$out.ToInt64()){throw 'Folder edit failed'}
    if(![Picker]::PostMessage($ok,245,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Folder selection failed'}; 'selected';return
  };Start-Sleep -Milliseconds 80
}while((Get-Date) -lt $end); throw "Exact test Chrome folder picker not found: $observed"
`;
const nativePrompt = String.raw`
$button=prop ([Windows.Automation.AutomationElement]::ControlTypeProperty) ([Windows.Automation.ControlType]::Button)
$end=(Get-Date).AddSeconds(6);$last=@()
do {
  foreach($w in (windows)) {
    $buttons=$w.FindAll($desc,$button);$last=@($buttons|ForEach-Object {$_.Current.Name})
    if($env:CLIP_TEST_HINT){$match=$false;foreach($e in $w.FindAll($desc,[Windows.Automation.Condition]::TrueCondition)){if($e.Current.Name -like ('*'+$env:CLIP_TEST_HINT+'*')){$match=$true;break}};if(!$match){continue}}
    foreach($b in $buttons){if((owned $b) -and $b.Current.Name -in ($env:CLIP_TEST_BUTTONS -split ';') -and $b.Current.IsEnabled){$label=$b.Current.Name;$b.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke();return $label}}
  };Start-Sleep -Milliseconds 100
}while((Get-Date) -lt $end); throw ('Expected consent button not found in isolated Chrome. Controls: '+($last -join '|'))
`;
function native(s, script, dir, buttons = '') {
  const code = Buffer.from(nativeBase+script, 'utf16le').toString('base64');
  try {return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',code],{
    encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:15000, windowsHide:true, env:{...process.env, CLIP_TEST_PID:String(s.pid), CLIP_TEST_VAULT:dir, CLIP_TEST_BUTTONS:buttons, CLIP_TEST_HINT:script===nativePrompt && !buttons.startsWith('Allow;允许')?basename(dir):''}
  }).trim();} catch(e) {throw Error(String(e.stderr||e.code).match(/<S S="Error">(.*?)_x000D_/)?.[1] || String(e.code));}
}
async function tree(root) {
  const rows = {};
  async function visit(base, prefix) {
    for (const ent of (await readdir(base,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = prefix + ent.name, full = join(base,ent.name);
      if (ent.isDirectory()) { rows[path+'/'] = null; await visit(full,path+'/'); }
      else { assert(ent.isFile(),'Unexpected filesystem entry'); rows[path] = digest(await readFile(full)); }
    }
  }
  await visit(root,''); return rows;
}
async function route(s, r) {
  const req = r.request(), u = new URL(req.url());
  const opt = s.active, p = s.profile;
  const api = p.endpoint+'/chat/completions';
  const headers={'access-control-allow-origin':`chrome-extension://${extensionId}`,'access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,OPTIONS'};
  const h=await req.allHeaders(), bad=()=>{p.violations++;return r.abort('blockedbyclient');};
  if(u.protocol==='http:'){p.httpAttempts++;return bad();}
  if(!opt || !noSecrets(u.href) || !noSecrets(req.postData()||'') || !noSecrets(JSON.stringify({...h,authorization:undefined})) || h.cookie) return bad();
  if(u.href===opt.url && req.method()==='GET' && !h.authorization) {
    // Neither data-original URL is requested by the page or upgraded as mixed content by Chrome.
    const images=opt.media?`<p><img alt="HTTP original" width="16" height="16" data-original="${opt.http.replaceAll('&','&amp;')}"> <img alt="HTTPS raster" width="16" height="16" data-original="${opt.https}"></p>`:'';
    const html=`<!doctype html><meta charset=utf-8><link rel=icon href="data:,"><title>${opt.title}</title><article><h1>${opt.title}</h1><p>${opt.marker} 合成观测记录，以独立浏览器资料分别剪藏并校验对应索引，不含任何真实用户内容。</p>${images}</article>`;
    return r.fulfill({contentType:'text/html; charset=utf-8',body:html});
  }
  if(s.confirmed && opt.media && u.href===opt.https && req.method()==='GET' && !h.authorization && !h.referer && req.resourceType()==='fetch'){
    p.httpsGets++;return r.fulfill({headers,contentType:'image/png',body:png});
  }
  if(s.confirmed && opt.ai && u.href===api && req.method()==='OPTIONS' && !h.authorization) return r.fulfill({status:204,headers});
  if(s.confirmed && opt.ai && u.href===api && req.method()==='POST') {
    const body=req.postDataJSON(), text=body?.messages?.filter(m=>m.role==='user').map(m=>m.content).join('\n')||'';
    if(h.authorization===`Bearer ${p.token}` && !h.referer && body.model===p.model && text.includes(opt.marker) && !text.includes(profiles.find(v=>v!==p).name) && !text.includes('signature=') && !text.includes('.png')){
      p.posts++;return r.fulfill({headers,contentType:'application/json',json:{choices:[{message:{role:'assistant',content:opt.summary}}]}});
    }
  }
  return bad();
}
let working, ev, extDir, extensionId, published=false;
const evidenceRoot=join(project,'tests','evidence');
async function launch(p, expectedVersion) {
  const first=expectedVersion===oldVersion;
  const dir=join(working,`Profile-${p.name}`), exe=process.env.PAGELEAF_CHROME || process.env.CHROME_PATH;
  const ctx=await chromium.launchPersistentContext(dir,{
    ...(exe?{executablePath:exe}:{channel:'chrome'}), headless:false, locale:'en-US', ignoreDefaultArgs:['--disable-extensions'],
    args:['--enable-unsafe-extension-debugging','--force-renderer-accessibility=complete','--disable-sync','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']
  });
  try {
    const b=await ctx.browser().newBrowserCDPSession(), cmd=await b.send('Browser.getBrowserCommandLine');
    assert(cmd.arguments.includes(`--user-data-dir=${dir}`),'Not the requested fresh profile');
    const pid=(await b.send('SystemInfo.getProcessInfo')).processInfo.find(i=>i.type==='browser')?.id;
    assert(Number.isSafeInteger(pid)&&pid>0,'Browser PID unavailable');
    const browser=(await b.send('Browser.getVersion')).product;
    assert.match(browser,/^Chrome\//); if(report.browser)assert.equal(browser,report.browser);report.browser=browser;
    const s={ctx,b,pid,profile:p,expectedVersion};
    ctx.on('console',msg=>{if(!noSecrets(msg.text()))p.logLeaks++;});
    ctx.on('weberror',e=>{if(!noSecrets(String(e.error())))p.logLeaks++;});
    await ctx.route(/^https?:\/\//,r=>route(s,r));
    // Native unpacked installation is normally restored on launch; if Chrome uses a
    // session-only unpacked loader, re-register that same path and report it explicitly.
    const manager=await ctx.newPage();await manager.goto('chrome://extensions/');
    const loaded=extensionId && await manager.evaluate(async id=>{const ext=(await chrome.developerPrivate.getExtensionsInfo()).find(e=>e.id===id);return ext?.state==='ENABLED' && ext.version;},extensionId);
    if(first)assert(!loaded,'Supposedly fresh profile already had our extension');
    if(!loaded){const {id}=await b.send('Extensions.loadUnpacked',{path:extDir});if(extensionId)assert.equal(id,extensionId);extensionId=id;}
    s.install=loaded?'already enabled':'loaded from the same unpacked path';
    if(loaded && loaded!==expectedVersion){await reloadInManager(manager,expectedVersion);s.install='reloaded original registration';}
    s.settings=await openSettings(s,manager);await manager.close();
    return s;
  } catch(e) {await ctx.close();throw e;}
}
async function reloadInManager(manager,expectedVersion){
  await manager.evaluate(async id=>{await chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});await chrome.developerPrivate.reload(id,{failQuietly:true});},extensionId);
  await until(()=>manager.evaluate(async ([id,v])=>(await chrome.developerPrivate.getExtensionsInfo()).some(e=>e.id===id && e.state==='ENABLED' && e.version===v),[extensionId,expectedVersion]),'same-ID reload');
}
async function openSettings(s,manager){
  const url=`chrome-extension://${extensionId}/settings.html`;
  await manager.evaluate(id=>chrome.developerPrivate.showOptions(id),extensionId);
  const tab=await until(()=>s.ctx.pages().find(p=>p.url()===url),'native extension options');
  await tab.waitForLoadState('domcontentloaded');
  assert.deepEqual(await tab.evaluate(()=>[chrome.runtime.id,chrome.runtime.getManifest().version]),[extensionId,s.expectedVersion]);
  await tab.waitForFunction(()=>document.getElementById('imgmsg').textContent.length>0);
  return tab;
}
async function stored(s){
  return s.settings.evaluate(async key=>{
    const store=await import('./store.js'),{root,revision}=await store.getRootState(),config=await store.getConfig();
    const info=store.getServiceInfo?await store.getServiceInfo():null;
    return {root:root?.name||null,real:root instanceof FileSystemDirectoryHandle,rw:root?await root.queryPermission({mode:'readwrite'}):null,
      revision,endpoint:config.endpoint,model:config.model,empty:config.key==='',matches:config.key===key,info,
      last:(await chrome.storage.local.get('lastResult')).lastResult?.path||null};
  },s.profile.token);
}
// Read just our extension origin’s live logical stores (not Chrome’s profile files,
// LevelDB tombstones, disk remnants or a claim of forensic erasure). Return no raw values.
async function audit(s){
  return s.settings.evaluate(async ({secrets,key,pass})=>{
    const req=request=>new Promise((yes,no)=>{request.onsuccess=()=>yes(request.result);request.onerror=()=>no(request.error);});
    const encode=(_k,v)=>ArrayBuffer.isView(v)||v instanceof ArrayBuffer?new TextDecoder().decode(v):v;
    const records=[];let service;
    for(const {name} of await indexedDB.databases()){
      const db=await req(indexedDB.open(name));try{
        for(const store of db.objectStoreNames){
          const os=db.transaction(store).objectStore(store);
          const [ks,vs]=await Promise.all([req(os.getAllKeys()),req(os.getAll())]);
          for(const [i,k] of ks.entries()){
            records.push([name,store,k,vs[i]]);
            if(name==='pageleaf-local-v1' && store==='preferences' && k==='service')service=vs[i];
          }
        }
      }finally{db.close();}
    }
    const dbText=JSON.stringify(records,encode), local=JSON.stringify([await chrome.storage.local.get(null),await chrome.storage.sync.get(null),Object.entries(localStorage)]);
    const sessionValues=await chrome.storage.session.get(null),session=JSON.stringify([sessionValues,Object.entries(sessionStorage)]);
    const env=service?.envelope,clean=text=>secrets.every(v=>!text.includes(v));
    let envelopeFingerprint=null,recordFingerprint=null,shape=false;
    if(env){
      const fingerprint=async obj=>{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(obj)));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');};
      envelopeFingerprint=await fingerprint(env);recordFingerprint=await fingerprint(service);
      shape=env.version===1 && env.cipher==='AES-GCM-256' && env.kdf==='PBKDF2-SHA-256' && env.iterations===600000 && atob(env.salt).length===16 && atob(env.iv).length===12 && atob(env.ciphertext).length===new TextEncoder().encode(key).length+16;
    }
    return {idbRecordCount:records.length,legacyKeyIntact:service?.key===key,hasKeyProperty:!!service&&Object.hasOwn(service,'key'),sessionRecordPresent:Object.hasOwn(sessionValues,'pageleafUnlockedService'),recordFingerprint,
      idbClean:clean(dbText),idbNoOtherSecrets:secrets.filter(x=>x!==key).every(x=>!dbText.includes(x)),otherPersistentClean:clean(local),sessionClean:clean(session),sessionHasKey:session.includes(key),sessionHasPass:session.includes(pass),
      sessionNoOtherSecrets:secrets.filter(x=>x!==key).every(x=>!session.includes(x)),shape,envelopeFingerprint};
  },{secrets,key:s.profile.token,pass:s.profile.pass});
}
async function setup(s) {
  const p=s.profile,tab=s.settings, folder=join(ev,p.vault);
  const clean=await stored(s);assert(clean.root===null && !clean.real && !clean.endpoint && !clean.model && clean.empty && !clean.last,'New profile not empty');
  await tab.bringToFront();await tab.locator('#choose').click();native(s,nativePicker,folder);
  s.folderConsent=native(s,nativePrompt,folder,'Allow;Allow access;Save changes;Edit files;Allow this time;Allow on every visit;允许;允许访问;保存更改;编辑文件;仅允许这一次;每次访问时都允许');
  if(!await tab.waitForFunction(name=>document.querySelector('#dirname').textContent===name,p.vault,{timeout:1200}).catch(()=>false)) {
    assert(noSecrets(await tab.locator('#dirmsg').textContent()));
    s.folderWriteConsent=native(s,nativePrompt,folder,'Allow;Allow access;Save changes;Edit files;Allow this time;Allow on every visit;允许;允许访问;保存更改;编辑文件;仅允许这一次;每次访问时都允许');
    await tab.waitForFunction(name=>document.querySelector('#dirname').textContent===name,p.vault,{timeout:4000});
  }
  await tab.locator('#endpoint').fill(p.endpoint);await tab.locator('#model').fill(p.model);await tab.locator('#key').fill(p.token);
  await tab.locator('#save').click();
  s.aiConsent=native(s,nativePrompt,folder,'Allow;允许');
  await tab.waitForFunction(()=>document.querySelector('#aimsg').textContent.includes('设置已保存'),null,{timeout:7000});
  await tab.reload();await tab.waitForFunction(model=>document.querySelector('#model').value===model,p.model);
}
async function confirm(s,phase){
  const p=s.profile,tab=s.settings,opt=s.active=spec(p,phase),images=p.httpsGets;s.confirmed=false;
  const article=await s.ctx.newPage();await article.goto(opt.url);await article.bringToFront();
  const list=async()=>(await s.b.send('Target.getTargets',{filter:[{}]})).targetInfos;
  const source=(await list()).find(t=>t.type==='tab'&&t.url===opt.url);assert(source);
  const before=await tree(join(ev,p.vault)),posts=p.posts;
  await s.b.send('Extensions.triggerAction',{id:extensionId,targetId:source.targetId});
  // Read from a same-extension view. Never navigate a tab to popup.html or call
  // preview/confirm/archive ourselves. The button invokes the actual popup handler.
  const ui=await until(()=>tab.evaluate(()=>{
    const a=chrome.extension.getViews({type:'popup'});if(a.length!==1) return null;
    const q=id=>a[0].document.getElementById(id);return q('confirm')?.disabled===false && {
      title:q('title').textContent,destination:q('destination').textContent,source:q('source').textContent,summary:q('summary').textContent};
  }),`native preview for ${opt.title}`);
  assert.equal(ui.title,opt.title);assert.equal(ui.source,opt.url);assert(ui.destination.startsWith(`${p.vault}/`));
  if(!opt.ai)assert.match(ui.summary,phase==='legacy'?/保护|迁移/:/锁/);
  assert(noSecrets(JSON.stringify(ui)));assert.equal(p.posts,posts);assert.equal(p.httpsGets,images);assert.deepEqual(await tree(join(ev,p.vault)),before);
  s.confirmed=true;await tab.evaluate(()=>{const views=chrome.extension.getViews({type:'popup'});if(views.length!==1)throw Error('Native popup lost');views[0].document.querySelector('#confirm').click();});
  const result=await until(()=>tab.evaluate(async title=>{const {lastResult:r}=await chrome.storage.local.get('lastResult');return r?.path?.endsWith('/'+title+'.md') && {state:r.state,path:r.path};},opt.title),`new note after confirmation for ${opt.title}`,18000);
  assert.equal(result.state,opt.ai?'ok':'warn',`${p.name} ${phase}: result status`);assert.match(result.path,/^\d{4}-\d\d-\d\d\/[^/]+\.md$/);
  assert.equal(p.posts-posts,Number(opt.ai));assert.equal(p.httpsGets-images,Number(opt.media));assert.equal(p.httpAttempts,0);assert.equal(p.violations,0);
  await until(async()=>!(await list()).some(t=>t.url.startsWith(`chrome-extension://${extensionId}/job.html`)||t.url===`chrome-extension://${extensionId}/popup.html`),'job and popup closed');
  p.notes.push({...opt,path:result.path});s.active=null;s.confirmed=false;await article.close();
  return {phase,path:result.path,state:result.state,summaryPreview:ui.summary,verifiedModelPosts:p.posts-posts,httpsGets:p.httpsGets-images,httpAttempts:p.httpAttempts};
}
async function verifyVault(p) {
  const vault=join(ev,p.vault), snapshot=await tree(vault),files=Object.keys(snapshot).filter(k=>snapshot[k]!==null);
  const expected=p.notes.length?[index]:[], other=profiles.find(v=>v!==p);
  for(const n of p.notes){
    const data=await readFile(join(vault,n.path),'utf8');expected.push(n.path);
    assert([n.title,n.marker,n.url].every(x=>data.includes(x)));assert.equal(data.includes(n.summary),n.ai);assert(!data.includes(other.name)&&noSecrets(data));
    if(n.media){
      const links=[...data.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)],plain=links.filter(m=>m[3]===n.http),local=links.filter(m=>m[1]==='!');
      assert.equal(plain.length,1,'HTTP URL and full query must survive as one link');assert.equal(plain[0][1],'');
      assert.equal(local.length,1);assert.match(local[0][3],/^assets\/m-[\da-f]{16}(?:-\d+)?\/\d{2}\.png$/);
      const imagePath=n.path.split('/')[0]+'/'+local[0][3];assert.equal(snapshot[imagePath],digest(png));expected.push(imagePath);
    }
  }
  for(const [file,hash] of Object.entries(p.snapshots))if(hash && file!==index)assert.equal(snapshot[file],hash,'Prior note or asset changed');
  assert.deepEqual(files.toSorted(),expected.toSorted());
  if(p.notes.length){const data=await readFile(join(vault,index),'utf8');const paths=[...data.matchAll(/\]\(([^)]+\.md)\)/g)].map(m=>decodeURIComponent(m[1]));assert.deepEqual(paths.toSorted(),p.notes.map(n=>n.path).toSorted());assert(!data.includes(other.name)&&noSecrets(data));}
  p.snapshots=snapshot;
}

async function checkState(s,state){
  const p=s.profile,cfg=await stored(s),a=await audit(s);
  assert(cfg.real && cfg.root===p.vault && cfg.endpoint===p.endpoint && cfg.model===p.model && cfg.revision===p.revision,'Directory revision, model or endpoint lost/foreign');
  assert.equal(cfg.last,p.notes.at(-1)?.path||null);assert.equal(await s.settings.locator('#key').inputValue(),'');
  const raw=state==='baseline' || state==='legacy', usable=state==='baseline' || state==='unlocked';
  assert.equal(cfg.matches,usable);assert.equal(cfg.empty,!usable);
  if(state!=='baseline'){
    await s.settings.locator(`#vault-state[data-state="${state}"]`).waitFor();
    assert.equal(cfg.info.endpoint,p.endpoint);assert.equal(cfg.info.model,p.model);assert.equal(cfg.info.credentialState,state);
    assert(noSecrets(JSON.stringify(cfg.info)) && !Object.hasOwn(cfg.info,'key'));
  }
  assert(a.idbNoOtherSecrets && a.otherPersistentClean && a.sessionNoOtherSecrets && !a.sessionHasPass);assert.equal(a.sessionHasKey,state==='unlocked');
  assert.equal(a.idbClean,!raw);assert.equal(a.legacyKeyIntact,raw);assert.equal(a.hasKeyProperty,raw);
  assert.equal(a.sessionRecordPresent,state==='unlocked');assert.equal(a.shape,!raw);
  if(!raw){
    assert(a.envelopeFingerprint && a.recordFingerprint);
    if(p.fingerprint){assert.equal(a.envelopeFingerprint,p.fingerprint,'Ciphertext changed');assert.equal(a.recordFingerprint,p.recordFingerprint,'Service record changed');}
    else{p.fingerprint=a.envelopeFingerprint;p.recordFingerprint=a.recordFingerprint;}
  }else assert.equal(a.envelopeFingerprint,null);
  assert(noSecrets(await s.settings.locator('body').innerText()));assert.equal(p.logLeaks,0);
  return {state,logicalIdbRecords:a.idbRecordCount,idbContainsOriginalPlaintext:a.legacyKeyIntact,permanentExtensionStoresClean:a.idbClean&&a.otherPersistentClean,
    verifiedEnvelope:a.shape,envelopeFingerprint:a.envelopeFingerprint,sessionContainsOwnKey:a.sessionHasKey,noPassInPersistentOrSessionStores:a.sessionNoOtherSecrets && a.otherPersistentClean && a.idbNoOtherSecrets,originalGrant:cfg.rw};
}
async function authorizeDir(s){
  const {rw}=await stored(s),p=s.profile;if(rw==='granted')return;
  assert.equal(rw,'prompt');await s.settings.bringToFront();await s.settings.locator('#authorize').click();
  s.restoreConsent=native(s,nativePrompt,join(ev,p.vault),'Allow;Allow access;Allow this time;Allow on every visit;Edit files;允许;允许访问;仅允许这一次;每次访问时都允许;编辑文件');
  await until(async()=>(await stored(s)).rw==='granted','original persisted directory reauthorized');
}
async function vaultAction(s,kind){
  const p=s.profile,tab=s.settings;await tab.bringToFront();
  // Wrong pass comes from the other isolated profile. No method ever re-enters the old API Key.
  await tab.locator('#vault-pass').fill(kind==='wrong'?profiles.find(q=>q!==p).pass:p.pass);
  if(kind==='migrate')await tab.locator('#vault-confirm').fill(p.pass);
  await tab.locator('#vault-action').click();
  if(kind==='wrong')await tab.locator('#aimsg.error').filter({hasText:'未能解锁'}).waitFor();
  else await tab.locator('#vault-state[data-state="unlocked"]').waitFor();
  for(const id of ['#key','#vault-pass','#vault-confirm'])assert.equal(await tab.locator(id).inputValue(),'');
  return checkState(s,kind==='wrong'?'locked':'unlocked');
}
async function saveCheck(s,phase){
  const other=profiles.find(p=>p!==s.profile),before=await tree(join(ev,other.vault));
  const result=await confirm(s,phase);assert.deepEqual(await tree(join(ev,other.vault)),before,'Foreign vault changed');
  for(const target of profiles)await verifyVault(target);
  assert(noSecrets(JSON.stringify(await s.settings.evaluate(()=>chrome.storage.local.get(null)))));
  return result;
}
// Each extraction goes into an empty directory. Reject members outside
// the simple POSIX extension layout (including Windows drive/ADS names).
const unpack = `import sys,zipfile,re,hashlib,pathlib\nz,d=map(pathlib.Path,sys.argv[1:]); expected=set()\nwith zipfile.ZipFile(z) as f:\n for i in f.infolist():\n  n=i.filename; parts=n.split('/')\n  if i.is_dir():continue\n  assert all(re.fullmatch(r'[a-zA-Z0-9_.-]+',p) and p not in {'.','..'} for p in parts) and n not in expected\n  expected.add(n);b=f.read(i);t=d.joinpath(*parts);t.parent.mkdir(parents=True,exist_ok=True);t.open('xb').write(b);assert t.read_bytes()==b\n assert 'manifest.json' in expected`;
try {
  assert.equal(process.platform,'win32','This native-picker test is for Windows desktop');
  assert.equal(digest(await readFile(oldZip)),oldHash,'Wrong baseline ZIP: rebuild from v1.1.1-rc.1');report.sha256=digest(await readFile(zip));
  working=await mkdtemp(join(await realpath(tmpdir()),'pageleaf-store-profiles-'));extDir=join(working,'candidate');
  async function extract(file,v){await mkdir(extDir);execFileSync('python',['-c',unpack,file,extDir]);assert.equal(JSON.parse(await readFile(join(extDir,'manifest.json'),'utf8')).version,v);return tree(extDir);}
  const initial=await extract(oldZip,oldVersion);let extracted;
  png=await readFile(join(extDir,'icons','16.png'));
  // Keep original OS files as evidence, outside Windows’ protected AppData.
  await mkdir(evidenceRoot,{recursive:true});ev=await mkdtemp(join(await realpath(evidenceRoot),`store-profiles-${version}-`));
  for(const p of profiles)await mkdir(join(ev,p.vault));
  for(const stage of ['baseline','migration','restart']){
    if(stage==='migration'){
      // Both old-profile Chrome processes are fully closed. Never mutate a real installation.
      const actual=await realpath(extDir);assert(actual===extDir && dirname(actual)===await realpath(working) && basename(actual)==='candidate');
      assert.deepEqual(await tree(actual),initial);await rm(actual,{recursive:true});extracted=await extract(zip,version);
    }
    for(const p of profiles){
      const v=stage==='baseline'?oldVersion:version,s=await launch(p,v),states=[],saves=[];
      try{
        if(stage==='baseline'){
          await setup(s);p.revision=(await stored(s)).revision;assert(p.revision && p.revision!=='legacy');
          states.push(await checkState(s,'baseline'));saves.push(await saveCheck(s,'baseline'));
        }else if(stage==='migration'){
          states.push(await checkState(s,'legacy'));await authorizeDir(s);saves.push(await saveCheck(s,'legacy'));
          states.push(await vaultAction(s,'migrate'));
        }else{
          states.push(await checkState(s,'locked'));await authorizeDir(s);saves.push(await saveCheck(s,'locked'));
          states.push({after:'wrong pass',...await vaultAction(s,'wrong')});states.push(await vaultAction(s,'unlock'));saves.push(await saveCheck(s,'unlocked'));
          // Same-ID reload in the running process must also lock, not merely keep a cached usable Key.
          const manager=await s.ctx.newPage();await manager.goto('chrome://extensions/');await s.settings.close();
          await reloadInManager(manager,version);s.settings=await openSettings(s,manager);await manager.close();
          states.push({after:'extension reload',...await checkState(s,'locked')});await authorizeDir(s);
          states.push({after:'unlock after reload',...await vaultAction(s,'unlock')});saves.push(await saveCheck(s,'reloaded'));
        }
        assert.equal(p.logLeaks,0);assert.equal(p.violations,0);
        report.runs.push({profile:p.name,stage,version:v,extensionId,registration:s.install,folderConsent:s.folderConsent,aiConsent:s.aiConsent,restoreConsent:s.restoreConsent,
          model:p.model,endpoint:p.endpoint,foreignVaultUnchanged:true,states,saves});console.log(`PASS ${p.name}: ${stage}`);
      }finally{await s.ctx.close();}
    }
  }
  assert.notEqual(profiles[0].fingerprint,profiles[1].fingerprint);assert.notEqual(profiles[0].revision,profiles[1].revision);
  assert.deepEqual(await tree(extDir),extracted);assert.equal(digest(await readFile(zip)),report.sha256);assert.equal(digest(await readFile(oldZip)),oldHash);
  report.network=Object.fromEntries(profiles.map(p=>[p.name,{verifiedModelRequests:p.posts,verifiedHttpsImages:p.httpsGets,httpRequests:p.httpAttempts,unexpectedRequests:p.violations,secretConsoleMessages:p.logLeaks}]));
  report.directory='Distinct real Windows folders selected by the isolated browser’s native picker. Every confirmation used the actual toolbar popup, read back ordinary Markdown links, verified stored PNG bytes, index paths, previous file hashes, and a byte-unchanged foreign vault.';
  report.scope='Two persistent isolated Chrome roots, one temp unpacked path/ID, old ZIP → replacement candidate → browser restart → same-version extension reload. Playwright-served HTTPS articles, images and auth-checked model only; offline DNS. Checked extension-origin live IndexedDB, localStorage, chrome.storage.local/sync/session, rendered UI, observed requests, console and output files. Not a forensic disk-erasure check, signed store install/update, avatar-menu switch, real AI, user profile or MSI test.';
  report.archives=Object.fromEntries(profiles.map(p=>[p.vault,p.snapshots]));report.passed=true;report.finishedAt=new Date().toISOString();
  const text=JSON.stringify(report,null,2)+'\n';assert(noSecrets(text));
  await writeFile(join(ev,'report.json'),text,{flag:'wx'});published=true;console.log(`Evidence (original OS files, only this run): ${ev}`);
} catch(e){console.error(redact(e.stack||e.message));process.exitCode=1;}
finally {
  if(ev&&!published){const path=await realpath(ev);assert(path===ev && dirname(path)===await realpath(evidenceRoot) && basename(path).startsWith(`store-profiles-${version}-`),'Refuse non-run evidence cleanup');await rm(path,{recursive:true,maxRetries:2});}
  if(working){const actual=await realpath(working);assert(actual===working&&dirname(actual)===await realpath(tmpdir())&&/^pageleaf-store-profiles-[\w-]+$/.test(basename(actual)), 'Refuse unsafe cleanup target');await rm(actual,{recursive:true,force:false,maxRetries:5,retryDelay:250});}
}
