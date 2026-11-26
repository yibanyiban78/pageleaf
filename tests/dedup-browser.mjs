// Helpers used by browser.mjs inside the same isolated Chrome process. Nothing
// here is loaded by, or packaged with, the extension.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const videoAliases=['https://www.youtube.com/watch?v=Stream00001&t=570s','https://youtu.be/Stream00001?t=42','https://www.youtube.com/shorts/Stream00001'];
export function articleFixtures(base,html){
  const fixtures=new Map([[base,html]]);
  for(const [suffix,description] of [['-storm','风暴之后的泥沙变化'],['-east','东岸样点的新记录'],['-west','西岸堤坡的独立巡查'],['-race','同一个采样批次的独立记录']]){
    let body=html.replace('退潮后，我们沿着潮线记录盐沼植物。',description+'。');
    // The race intentionally has exactly ONE unique asset. Browser page loads
    // finish before counters start, so a duplicate downloader would be visible.
    if(suffix==='-race')body=body.replace(/<figure>[\s\S]*?<\/figure>/,'');
    fixtures.set(base+suffix,body);
  }
  return fixtures;
}

export function observeCaptures({openPreview,effects,unchanged,until,report,evidence,readIcon}){
  const words={new:/未剪藏/,saved:/已剪藏/,partial:/不完整|异常/,pending:/正在保存/,error:/失败/};
  const titles={new:/未保存/,saved:/已保存/,partial:/异常|不完整/,pending:/正在保存/,error:/异常|失败/};
  const captured=new Set();
  return async function observe(page,state,result){
    const before=await effects(),p=await openPreview(page,state),ui=p.ui;
    assert.match(ui['capture-state'],words[state]);
    assert.equal(ui.disabled,!['new','error'].includes(state));
    if(result?.path){assert.equal(ui.destination,result.path);assert.equal(ui['saved-at'],result.path.split('/')[0]);assert.equal(ui.savedAt,ui['saved-at']);}
    const color=await p.evaluate("getComputedStyle(document.querySelector('#capture-state'),'::before').backgroundColor");
    const [red,green,blue]=color.match(/\d+/g).map(Number);
    if(state==='saved')assert(green>red && green>blue,`Saved dot: ${color}`);
    if(state==='partial' || state==='error')assert(red>green*1.5 && red>blue*1.5,`Error dot: ${color}`);
    if(state==='new')assert(red>green && green>blue*2,`New dot: ${color}`);
    const action=await until(async()=>{const a=await p.evaluate(`(async()=>{const [t]=await chrome.tabs.query({active:true,currentWindow:true});return {id:t.id,title:await chrome.action.getTitle({tabId:t.id}),badge:await chrome.action.getBadgeText({tabId:t.id})}})()`);return titles[state].test(a.title)&&a;},'per-tab toolbar '+state);
    assert.equal(action.badge,'');
    const icon=await readIcon(action.id);
    assert(icon,'Native setIcon must have completed');
    if(state==='pending')assert(icon.neutral && !icon.rgb,'Pending must restore the original, undotted icon');
    else {const [r,g,b,a]=icon.rgb||[];assert.equal(a,255,'Toolbar dot must be opaque');if(state==='saved')assert(g>r&&g>b);else if(state==='new')assert(r>g&&g>b*2);else assert(r>g*1.5&&r>b*1.5);}
    if(!captured.has(state)){
      captured.add(state);await mkdir(evidence,{recursive:true});
      await writeFile(join(evidence,`popup-${state}.png`),Buffer.from((await p.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
      (report.indicators??={})[state]={color,toolbarIcon:icon,title:action.title,popupLabel:ui['capture-state'],disabled:ui.disabled,path:result?.path||'',date:ui['saved-at']};
    }
    await unchanged(before,'Opening '+state+' preview must be read-only');await p.click('#cancel');await p.waitClosed();await unchanged(before,'Cancelling '+state+' preview must be read-only');
    return {...ui,actionTab:action.id};
  };
}

export async function runDedupChecks({article,other,articleURL,settings,files,clip,openPreview,confirm,observe,effects,unchanged,holdPosts,verifySaved,switchRoot,selectExcerpt,until,checked,report,full,mutations,waitNeutral}){
  const raceURL=articleURL+'-race';
  // Chrome only keeps one native toolbar popup open. Delay the transport of
  // the first real click (not extraction or validation). Both source tabs,
  // documents, activeTab grants and popup-issued snapshots remain genuine.
  await article.goto(raceURL);await other.goto(raceURL+'#survey');
  await observe(article,'new');
  const first=await openPreview(article);assert.equal(first.ui.capture,'new');
  await first.evaluate(`(()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(m,...rest)=>{if(m.type!=='pageleaf.confirm')return send(m,...rest);window.heldConfirm=structuredClone(m);return new Promise(()=>{});};})()`);
  await first.click('#confirm');const held=await until(()=>first.evaluate('window.heldConfirm'),'first actual clicked confirmation to reach its transport');
  assert.equal(held.type,'pageleaf.confirm');assert.equal(held.task.url,raceURL);
  await other.bringToFront();await first.waitClosed();
  const second=await openPreview(other);assert.equal(second.ui.capture,'new');
  await second.evaluate(`(()=>{const first=${JSON.stringify(held)},send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(m,...rest)=>{if(m.type!=='pageleaf.confirm')return send(m,...rest);if(first.task.source===m.task.source||first.task.documentId===m.task.documentId||first.task.key!==m.task.key)throw Error('Race fixtures are not independent same-identity documents');return Promise.all([send(first),send(m,...rest)]).then(out=>out[1]);};})()`);
  await settings.evaluate(()=>{window.pairedResults=[];});
  const base=await effects(),mutationStart=mutations.length,gate=holdPosts();
  let staleTabs;
  try{
    await confirm(second);await until(()=>gate.arrivals()===1,'only first same-identity job to reach API');
    const left=await observe(article,'pending'),right=await observe(other,'pending');staleTabs=[left.actionTab,right.actionTab];
    // Change both documents' current URL WITHOUT triggering another load of
    // fixture assets, while their genuine jobs are still held at the first POST.
    await Promise.all([article,other].map((p,i)=>p.evaluate(i=>history.pushState(null,'','/left-race/'+i),i)));
    await Promise.all(staleTabs.map(waitNeutral));
  }finally{gate.release();}
  const results=await until(()=>settings.evaluate(()=>window.pairedResults.length>=2&&window.pairedResults),'both same-identity completions',15000);
  assert.equal(results.length,2);assert.deepEqual(results.map(r=>r.state),['ok','ok']);assert.equal(results[0].path,results[1].path);
  assert(results.some(r=>/已存在|不重复|已有|重复保存|未重复/.test(r.message)),'Second completion must report the duplicate');
  const winner=await verifySaved(results[0],'ok',['map']);
  const after=await effects();assert.equal(after.chatPosts-base.chatPosts,1);assert.equal(after.assetRequests-base.assetRequests,1);
  const extra=after.entries.filter(k=>!base.entries.includes(k));assert.equal(extra.filter(x=>/\.md$/i.test(x)).length,1);assert.equal(extra.filter(x=>/\.png$/i.test(x)).length,1);
  const index=(await files())['剪藏索引.md'].text;
  assert.equal([...index.matchAll(/\[[^\n]*?\]\(([^)]+\.md)\)/g)].filter(m=>decodeURIComponent(m[1])===winner.r.path).length,1);
  const writes=mutations.slice(mutationStart);assert.equal(new Set(writes.map(w=>w.job)).size,1,'No writable stream or create intent from the duplicate job');
  const indexWrites=writes.filter(w=>w.operation==='createWritable'&&w.name==='剪藏索引.md').length;assert.equal(indexWrites,1,'Existing index must be written once');
  report.race={mutatingJobs:1,indexWrites,sourceTabs:2,confirmedSnapshots:2,delivery:'Transport-only barrier in actual native popup; both genuine click messages released together to unmodified worker and job pages.',jobTargets:after.jobs-base.jobs,chatPosts:after.chatPosts-base.chatPosts,mediaGets:after.assetRequests-base.assetRequests,newNotes:1,newPNGs:1,indexLinksToOriginal:1,results:results.map(r=>({state:r.state,path:r.path,message:r.message}))};
  // Await the job-tab teardown, not just storage: a late report must not
  // recolor either unrelated SPA route that replaced the confirmed source.
  await until(()=>settings.evaluate(async()=>!(await chrome.tabs.query({})).some(t=>t.url?.startsWith(chrome.runtime.getURL('job.html#')))),'race jobs to close');
  await Promise.all(staleTabs.map(waitNeutral));await other.goto(raceURL);
  const raceSaved=await observe(other,'saved',winner.r);
  checked('Two stale, independently previewed and clicked native snapshots: concurrent delivery created one note, one PNG, one media GET, one AI POST and one index entry; duplicate job reported original path; pending was neutral/disabled');

  await other.goto(articleURL+'#section');await waitNeutral(raceSaved.actionTab); // checked before any new toolbar invocation
  checked('Normal navigation cleared a green icon/title before the next toolbar click. Two SPA route changes during an AI hold also stayed neutral through both late job completions');
  await observe(other,'saved',full.r);
  await switchRoot('Second fixture root');await observe(other,'new');
  await switchRoot('Pageleaf 验收目录');await observe(other,'saved',full.r);
  checked('New source tab, fragment alias, empty second root, then original root: status follows the selected library and original path rather than tab or lastResult');

  // Only a test popup sees this permission override: OPFS itself always grants
  // access and cannot model native OS revocation. Reload its real code, keeping
  // the persisted handle and genuine folder contents intact.
  const beforeDenied=await effects(),denied=await openPreview(other,'saved');
  await denied.send('Page.enable');await denied.send('Page.addScriptToEvaluateOnNewDocument',{source:`FileSystemDirectoryHandle.prototype.queryPermission=async()=> 'denied';window.permissionFixture=true;window.fixturePermissionRequests=0;FileSystemDirectoryHandle.prototype.requestPermission=async()=>{window.fixturePermissionRequests++;return 'denied';};`});
  await denied.send('Page.reload');
  const deniedUI=await until(async()=>{const ui=await denied.state();return ui.disabled&&['unknown','error'].includes(ui.capture)&&/权限|授权/.test(ui.status)&&ui;},'denied folder permission in real popup').catch(async e=>{throw Error(e.message+'; UI='+JSON.stringify(await denied.state())+' override='+await denied.evaluate('String(window.permissionFixture)'));});
  assert.notEqual(deniedUI.capture,'new');assert.equal(await denied.evaluate('window.fixturePermissionRequests'),0);await denied.click('#cancel');await denied.waitClosed();await unchanged(beforeDenied,'Denied preview');
  checked('Existing saved source with denied folder rights (test-popup-only queryPermission substitute): non-orange, disabled confirmation, no permission request or writes');

  // Feed the actual old Markdown + its old index rows, not current-generated
  // markers/receipts. No other directory is opened; these are synthetic notes.
  const old=JSON.parse(await readFile(new URL('./browser-fixtures/v1.2.0-history.json',import.meta.url),'utf8'));
  const oldFiles=Object.entries(old.files).map(([path,text])=>({path,text}));
  for(const [note,i] of old.paths.map((p,i)=>[p,i])){
    const matches=[...old.files[note].matchAll(/!\[[^\n]*?\]\((assets\/[^)]+)\)/g)];
    for(const [n,m] of matches.entries())oldFiles.push({path:note.split('/')[0]+'/'+m[1],bytes:[...await readFile(new URL(`./browser-fixtures/${i===0?['map','shore'][n]:'cover'}.png`,import.meta.url))]});
  }
  const seed=async list=>settings.evaluate(async list=>{const root=await (await import('./store.js')).getRoot();for(const {path,text,bytes} of list){let dir=root;const parts=path.split('/'),name=parts.pop();for(const p of parts)dir=await dir.getDirectoryHandle(p,{create:true});const w=await (await dir.getFileHandle(name,{create:true})).createWritable();await w.write(text??new Uint8Array(bytes));await w.close();}},list);
  await switchRoot('Synthetic v1.2.0 archive');await seed(oldFiles);
  await other.goto(articleURL);await observe(other,'saved',{path:old.paths[0]});
  await other.goto(videoAliases[1]);await observe(other,'saved',{path:old.paths[1]});
  assert(!(await effects()).entries.some(s=>s.startsWith('Synthetic v1.2.0 archive/.pageleaf')));
  checked('Unmodified v1.2.0 article/video note bytes and their historical index rows resolved in a fresh root, including the youtu.be alias; no backfill, migration, network request or timestamp change');

  // The original historical fixture and this test could run on the same day.
  // A dated copy forces the UI to show the ARCHIVE date, not today's estimate.
  await switchRoot('Earlier calendar date');const day0=old.paths[0].slice(0,10),earlier='2019-04-07';
  await seed(oldFiles.map(f=>({...f,path:f.path.replace(day0,earlier),text:f.text?.replaceAll(day0,earlier)})));
  await other.goto(articleURL);const prior=await observe(other,'saved',{path:old.paths[0].replace(day0,earlier)});
  assert.equal(prior['saved-at'],earlier);report.historicalDisplay={date:prior['saved-at'],path:prior.destination};
  checked('A separately backdated synthetic archive displays its 2019 archive date and existing relative path instead of today’s estimate');

  await switchRoot('Date path failure');await article.goto(articleURL);await selectExcerpt(article);
  const day=await settings.evaluate(()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');});
  await settings.evaluate(async day=>{const r=await (await import('./store.js')).getRoot();await r.getFileHandle(day,{create:true});},day);
  const beforeFail=await effects(),failed=await clip(article);assert.equal(failed.state,'error',failed.message);assert(!failed.path);
  const afterFail=await effects();assert.deepEqual(afterFail.entries,beforeFail.entries);assert.deepEqual(afterFail.digests,beforeFail.digests);assert.equal(afterFail.chatPosts,beforeFail.chatPosts);assert.equal(afterFail.assetRequests,beforeFail.assetRequests);
  await observe(article,'error');checked('A file at the date-directory path prevented writing any note: real job returned error/no path, unlike partial; a fresh native preview is red and permits an explicit retry');
  await switchRoot('Pageleaf 验收目录');
}
