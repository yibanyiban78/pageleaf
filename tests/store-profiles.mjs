// CLIP-004 • Windows desktop + full Chrome with Extensions.triggerAction, Python 3.
// From the project: node tests/store-profiles.mjs
// Only a local, already-built candidate is used. New profiles only; no sign-in, sync,
// installed extension modifications, global key/mouse events, or old evidence writes.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const project = fileURLToPath(new URL('../', import.meta.url));
const version = '1.1.1', archive = `pageleaf-cws-${version}.zip`;
const zip = join(project, 'release', archive);
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
    token: randomBytes(24).toString('hex'), notes: [], posts: 0, violations: 0, snapshots: {} };
}
const profiles = [fixture('Amber'), fixture('Cobalt')];
const report = { task: 'CLIP-004', startedAt: new Date().toISOString(), device: process.env.COMPUTERNAME,
  platform: process.platform, node: process.version, candidate: archive, version, runs: [] };
const redact = text => profiles.reduce((s,p) => s.replaceAll(p.token,'[redacted]'),String(text));
const noTokens = value => !profiles.some(p => String(value).includes(p.token));
const spec = (p,n) => ({ title: `${p.name} ${n}`, marker:`${p.name}Body${n}`, summary:`${p.name}Summary${n}`,
  url:`https://article-${p.name.toLowerCase()}.pageleaf.test/entry/${n}` });

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
  const headers = {'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'POST,OPTIONS'};
  const h = await req.allHeaders();
  if (!opt || !noTokens(u.href) || !noTokens(req.postData()||'') || !noTokens(JSON.stringify({...h,authorization:undefined}))) {p.violations++;return r.abort();}
  if (u.href===opt.url && req.method()==='GET' && !h.authorization) {
    const html = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,"><title>${opt.title}</title><article><h1>${opt.title}</h1><p>${opt.marker} 合成观测记录，以独立浏览器资料分别剪藏并校验对应索引，不含任何真实用户内容。</p></article>`;
    return r.fulfill({contentType:'text/html; charset=utf-8',body:html});
  }
  if (u.href===api && req.method()==='OPTIONS' && !h.authorization) return r.fulfill({status:204,headers});
  if (u.href===api && req.method()==='POST') {
    const body=req.postDataJSON(), text=body?.messages?.filter(m=>m.role==='user').map(m=>m.content).join('\n')||'';
    if (h.authorization===`Bearer ${p.token}` && body.model===p.model && text.includes(opt.marker) && !text.includes(profiles.find(v=>v!==p).name)) {
      p.posts++; return r.fulfill({headers,contentType:'application/json',json:{choices:[{message:{role:'assistant',content:opt.summary}}]}});
    }
  }
  p.violations++; return r.abort('blockedbyclient');
}
let working, ev, extDir, extensionId, published=false;
const evidenceRoot=join(project,'tests','evidence');
async function launch(p, first) {
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
    const s={ctx,b,pid,profile:p}; await ctx.route(/^https?:\/\//,r=>route(s,r));
    // Native unpacked installation is normally restored on launch; if Chrome uses a
    // session-only unpacked loader, re-register that same path and report it explicitly.
    const manager=await ctx.newPage();await manager.goto('chrome://extensions/');
    const loaded = extensionId && await manager.evaluate(async id => (await chrome.developerPrivate.getExtensionsInfo()).find(e=>e.id===id)?.state==='ENABLED',extensionId);
    if(first)assert(!loaded,'Supposedly fresh profile already had our extension');
    if(!loaded){const {id}=await b.send('Extensions.loadUnpacked',{path:extDir});if(extensionId)assert.equal(id,extensionId);extensionId=id;}
    s.install=loaded?'already enabled':'loaded from the same unpacked path';
    s.settings=await ctx.newPage();await s.settings.goto(`chrome-extension://${extensionId}/settings.html`);await manager.close();
    assert.deepEqual(await s.settings.evaluate(()=>[chrome.runtime.id,chrome.runtime.getManifest().version]),[extensionId,version]);
    await s.settings.waitForFunction(()=>document.getElementById('imgmsg').textContent.length>0);
    return s;
  } catch(e) {await ctx.close();throw e;}
}
async function stored(s) {
  return s.settings.evaluate(async ({key})=>{
    const {getRoot,getConfig}=await import('./store.js');const root=await getRoot(),conf=await getConfig();
    return {root:root?.name||null,real:root instanceof FileSystemDirectoryHandle,rw:root?await root.queryPermission({mode:'readwrite'}):null,
      endpoint:conf.endpoint,model:conf.model,hasKey:Boolean(conf.key),keyMatches:conf.key===key,last:(await chrome.storage.local.get('lastResult')).lastResult?.path||null};
  },{key:s.profile.token});
}
async function setup(s) {
  const p=s.profile,tab=s.settings, folder=join(ev,p.vault);
  assert.deepEqual(await stored(s),{root:null,real:false,rw:null,endpoint:'',model:'',hasKey:false,keyMatches:false,last:null});
  await tab.bringToFront();await tab.locator('#choose').click();native(s,nativePicker,folder);
  s.folderConsent=native(s,nativePrompt,folder,'Allow;Allow access;Save changes;Edit files;Allow this time;Allow on every visit;允许;允许访问;保存更改;编辑文件;仅允许这一次;每次访问时都允许');
  if(!await tab.waitForFunction(name=>document.querySelector('#dirname').textContent===name,p.vault,{timeout:1200}).catch(()=>false)) {
    const status=await tab.locator('#dirmsg').textContent();console.log('Folder picker step:',s.folderConsent, 'Status:',status);
    s.folderWriteConsent=native(s,nativePrompt,folder,'Allow;Allow access;Save changes;Edit files;Allow this time;Allow on every visit;允许;允许访问;保存更改;编辑文件;仅允许这一次;每次访问时都允许');
    await tab.waitForFunction(name=>document.querySelector('#dirname').textContent===name,p.vault,{timeout:4000});
  }
  await tab.locator('#endpoint').fill(p.endpoint);await tab.locator('#model').fill(p.model);await tab.locator('#key').fill(p.token);
  await tab.locator('#save').click();
  s.aiConsent=native(s,nativePrompt,folder,'Allow;允许');
  await tab.waitForFunction(()=>document.querySelector('#aimsg').textContent.includes('设置已保存'),null,{timeout:7000});
  await tab.reload();await tab.waitForFunction(model=>document.querySelector('#model').value===model,p.model);
}
async function confirm(s,n) {
  const p=s.profile, tab=s.settings, opt=s.active=spec(p,n);
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
  assert.equal(ui.title,opt.title);assert.equal(ui.source,opt.url);assert(ui.destination.startsWith(`${p.vault}/`));assert.match(ui.summary,/AI/);
  assert(noTokens(JSON.stringify(ui)));assert.equal(p.posts,posts);assert.deepEqual(await tree(join(ev,p.vault)),before);
  await tab.evaluate(()=>{const views=chrome.extension.getViews({type:'popup'});if(views.length!==1)throw Error('Native popup lost');views[0].document.querySelector('#confirm').click();});
  const result=await until(()=>tab.evaluate(async title=>{const {lastResult:r}=await chrome.storage.local.get('lastResult');return r?.path?.endsWith('/'+title+'.md') && {state:r.state,path:r.path};},opt.title),`new note after confirmation for ${opt.title}`,18000);
  assert.equal(result.state,'ok');assert.match(result.path,/^\d{4}-\d\d-\d\d\/[^/]+\.md$/);assert.equal(p.posts,posts+1);assert.equal(p.violations,0);
  await until(async()=>!(await list()).some(t=>t.url.startsWith(`chrome-extension://${extensionId}/job.html`)||t.url===`chrome-extension://${extensionId}/popup.html`),'job and popup closed');
  p.notes.push({...opt,path:result.path});return {preview:ui.destination,path:result.path};
}
async function verifyVault(p) {
  const vault=join(ev,p.vault), snapshot=await tree(vault),files=Object.keys(snapshot).filter(k=>snapshot[k]!==null);
  assert.deepEqual(files.sort(),p.notes.length?[index,...p.notes.map(n=>n.path)].sort():[]);
  const other=profiles.find(v=>v!==p);
  for(const n of p.notes){const data=await readFile(join(vault,n.path),'utf8');assert([n.title,n.marker,n.summary,n.url].every(x=>data.includes(x)));assert(!data.includes(other.name)&&noTokens(data));if(p.snapshots[n.path])assert.equal(snapshot[n.path],p.snapshots[n.path]);}
  if(p.notes.length){const data=await readFile(join(vault,index),'utf8');const paths=[...data.matchAll(/\]\(([^)]+\.md)\)/g)].map(m=>decodeURIComponent(m[1]));assert.deepEqual(paths.sort(),p.notes.map(n=>n.path).sort());assert(!data.includes(other.name)&&noTokens(data));}
  p.snapshots=snapshot;
}

// Extraction is once per run, into an empty unique directory. Reject members outside
// the simple POSIX extension layout (including Windows drive/ADS names).
const unpack = `import sys,zipfile,re,hashlib,pathlib\nz,d=map(pathlib.Path,sys.argv[1:]); expected=set()\nwith zipfile.ZipFile(z) as f:\n for i in f.infolist():\n  n=i.filename; parts=n.split('/')\n  if i.is_dir():continue\n  assert all(re.fullmatch(r'[a-zA-Z0-9_.-]+',p) and p not in {'.','..'} for p in parts) and n not in expected\n  expected.add(n);b=f.read(i);t=d.joinpath(*parts);t.parent.mkdir(parents=True,exist_ok=True);t.open('xb').write(b);assert t.read_bytes()==b\n assert 'manifest.json' in expected`;
try {
  assert.equal(process.platform,'win32','This native-picker test is for Windows desktop');
  report.sha256=digest(await readFile(zip));
  working=await mkdtemp(join(await realpath(tmpdir()),'pageleaf-store-profiles-'));extDir=join(working,'candidate');await mkdir(extDir);
  execFileSync('python',['-c',unpack,zip,extDir]);
  assert.equal(JSON.parse(await readFile(join(extDir,'manifest.json'),'utf8')).version,version);
  const extracted=await tree(extDir);
  // Keep the original OS files as evidence, outside Windows' protected AppData.
  await mkdir(evidenceRoot,{recursive:true});ev=await mkdtemp(join(await realpath(evidenceRoot),`store-profiles-${version}-`));
  for(const p of profiles)await mkdir(join(ev,p.vault));
  // A, B, then reopen A and B after all Chrome windows from each previous run close.
  for(const n of [1,2]) for(const p of profiles) {
    const s=await launch(p,n===1);try {
      if(n===1)await setup(s);
      let cfg=await stored(s);
      assert.equal(cfg.last,p.notes.at(-1)?.path||null);assert(cfg.real&&cfg.root===p.vault&&cfg.endpoint===p.endpoint&&cfg.model===p.model&&cfg.keyMatches);
      assert.equal(await s.settings.locator('#key').inputValue(),'');assert(noTokens(await s.settings.locator('body').innerText()));
      if(cfg.rw!=='granted'){
        assert(n===2 && cfg.rw==='prompt','Unexpected disk access state');await s.settings.locator('#authorize').click();
        s.restoreConsent=native(s,nativePrompt,join(ev,p.vault),'Allow;Allow access;Allow this time;Allow on every visit;Edit files;允许;允许访问;仅允许这一次;每次访问时都允许;编辑文件');
        await until(async()=>(await stored(s)).rw==='granted','reauthorization of original persisted directory');
      }
      const other=profiles.find(v=>v!==p),before=await tree(join(ev,other.vault));const saved=await confirm(s,n);
      assert.deepEqual(await tree(join(ev,other.vault)),before,'Foreign vault changed');for(const target of profiles)await verifyVault(target);
      assert(noTokens(JSON.stringify(await s.settings.evaluate(()=>chrome.storage.local.get('lastResult')))));
      report.runs.push({profile:p.name,pass:n,extensionId,registration:s.install,originalGrant:cfg.rw,folderConsent:s.folderConsent,
        restoreConsent:s.restoreConsent,aiConsent:s.aiConsent,model:p.model,endpoint:p.endpoint,correctFixtureKey:true,keyFieldBlank:true,
        expectedOwnPreviousResult:cfg.last,foreignVaultUnchanged:true,...saved});
      console.log(`PASS ${p.name} ${n}: ${saved.path}`);
    } finally {await s.ctx.close();}
  }
  assert.deepEqual(await tree(extDir),extracted);assert.equal(digest(await readFile(zip)),report.sha256);
  report.network=Object.fromEntries(profiles.map(p=>[p.name,{verifiedModelRequests:p.posts,unexpectedRequests:p.violations}]));
  report.directory='Real distinct Windows folders, selected in Chrome’s native filesystem picker. Settings, popup and job use unmodified File System Access/IndexedDB and real OS files. Node verified each complete tree and Markdown/index links after every confirmation.';
  report.scope='Two independent new persistent Chrome user-data roots, one unpacked candidate path/ID, and an actual browser process restart for each profile. Actual Chrome toolbar popup; test activates its real confirmation button through the DOM. Synthetic HTTPS article and model served by Playwright routing; no live model, Chrome account, signed store install, native avatar-menu switch, store update, or MSI machine was tested.';
  report.archives=Object.fromEntries(profiles.map(p=>[p.vault,p.snapshots]));report.passed=true;report.finishedAt=new Date().toISOString();
  const text=JSON.stringify(report,null,2)+'\n';assert(noTokens(text));
  await writeFile(join(ev,'report.json'),text,{flag:'wx'});published=true;console.log(`Evidence (original OS files, only this run): ${ev}`);
} catch(e){console.error(redact(e.stack||e.message));process.exitCode=1;}
finally {
  if(ev&&!published){const path=await realpath(ev);assert(path===ev && dirname(path)===await realpath(evidenceRoot) && basename(path).startsWith(`store-profiles-${version}-`),'Refuse non-run evidence cleanup');await rm(path,{recursive:true,maxRetries:2});}
  if(working){const actual=await realpath(working);assert(actual===working&&dirname(actual)===await realpath(tmpdir())&&/^pageleaf-store-profiles-[\w-]+$/.test(basename(actual)), 'Refuse unsafe cleanup target');await rm(actual,{recursive:true,force:false,maxRetries:5,retryDelay:250});}
}
