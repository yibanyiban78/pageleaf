// Same-ID development reload in a new test profile; not a signed Web Store update.
// Args: freshly extracted old extension in .test-tmp/upgrade-*/extension; new extension dir.
// Quick OPFS smoke for prepared unpacked dirs. For clean-checkout ZIP generation,
// real Windows directories, legacy migration, encrypted restart/reload, wrong-pass
// integrity and per-profile authenticated mocks, run: node tests/store-profiles.mjs
import {chromium} from 'playwright';
import {randomBytes} from 'node:crypto';
import {cp,readFile,realpath} from 'node:fs/promises';
import {resolve,relative,sep} from 'node:path';
import assert from 'node:assert/strict';
const [dest,src]=await Promise.all(process.argv.slice(2,4).map(p=>realpath(resolve(p))));
const rel=relative(resolve('.test-tmp'),dest);
assert(rel.startsWith('upgrade-') && rel.endsWith(sep+'extension') && !rel.includes('..')); assert.notEqual(dest,src);
const oldVersion=JSON.parse(await readFile(resolve(dest,'manifest.json'),'utf8')).version;
const newVersion=JSON.parse(await readFile(resolve(src,'manifest.json'),'utf8')).version;
assert(['1.0.0','1.1.0','1.1.1'].includes(oldVersion));
const key=randomBytes(24).toString('hex'),phrase=randomBytes(24).toString('hex');
assert.equal(newVersion,JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version);
assert.notEqual(newVersion,oldVersion);
const ctx=await chromium.launchPersistentContext('',{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});
try{
  const b=await ctx.browser().newBrowserCDPSession(); const {id}=await b.send('Extensions.loadUnpacked',{path:dest});const base=`chrome-extension://${id}/`;
  const page=await ctx.newPage();await page.goto(base+'settings.html');
  await page.evaluate(async key=>{const s=await import('./store.js');await s.setRoot(await (await navigator.storage.getDirectory()).getDirectoryHandle('fixture-root',{create:true}));await s.setConfig({endpoint:'https://fixture.invalid/v1',model:'fixture',key});},key);
  const priorRevision=await page.evaluate(async()=>{const s=await import('./store.js');return s.getRootState ? (await s.getRootState()).revision : 'legacy';});
  const manager=await ctx.newPage();await manager.goto('chrome://extensions/');
  for(const tab of ctx.pages()) if(tab.url().startsWith(base))await tab.close();
  await manager.evaluate(()=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));
  await cp(src,dest,{recursive:true,force:true});await manager.evaluate(id=>chrome.developerPrivate.reload(id,{failQuietly:true}),id);
  // Resolve each asynchronous sample before checking it; wait for actual registration.
  let info; const deadline=Date.now()+9000;
  do { info=await manager.evaluate(async id=>{const list=await chrome.developerPrivate.getExtensionsInfo();const e=list.find(v=>v.id===id);return e && {id:e.id,state:e.state,version:e.version,disableReasons:e.disableReasons};},id);if(info?.state==='ENABLED' && info.version===newVersion)break;await new Promise(r=>setTimeout(r,120));}while(Date.now()<deadline);
  assert.equal(info?.state,'ENABLED',JSON.stringify(info)||'Extension did not re-register');assert.equal(info.version,newVersion);
  // Use the browser's own explicit “Extension options” action after reload.
  const [next]=await Promise.all([ctx.waitForEvent('page',{timeout:8000}),manager.evaluate(async id=>{
    const dp=chrome.developerPrivate;console.log('Opening extension options for',id);
    if(typeof dp.showOptions!=='function') throw new Error('Native options method unavailable; related APIs: '+Object.keys(dp).filter(k=>/option|view/i.test(k)).join(','));
    await dp.showOptions(id);
  },id)]);await next.waitForURL(base+'settings.html',{timeout:6000});await next.waitForLoadState('domcontentloaded');
  const state=await next.evaluate(async()=>{const s=await import('./store.js');const {root,revision}=await s.getRootState(),c=await s.getConfig(),info=await s.getServiceInfo();return {v:chrome.runtime.getManifest().version,folder:root.name,permission:await root.queryPermission({mode:'readwrite'}),revision,service:c.endpoint==='https://fixture.invalid/v1' && c.model==='fixture' && c.key==='',credentialState:info.credentialState,popup:chrome.runtime.getManifest().action.default_popup};});
  assert.deepEqual(state,{v:newVersion,folder:'fixture-root',permission:'granted',revision:priorRevision,service:true,credentialState:'legacy',popup:'popup.html'});
  await next.locator('#vault-state[data-state="legacy"]').waitFor();await next.locator('#vault-pass').fill(phrase);await next.locator('#vault-confirm').fill(phrase);await next.locator('#vault-action').click();
  await next.locator('#vault-state[data-state="unlocked"]').waitFor();assert.equal(await next.locator('#key').inputValue(),'');
  assert(await next.evaluate(async original=>(await (await import('./store.js')).getConfig()).key===original,key),'Original synthetic key must survive migration without re-entry');
  console.log(`PASS ${oldVersion} -> ${newVersion}: same-ID reload, same directory, legacy key gated before migration and recoverable afterwards. Not a store-signed update.`);
}catch(e){console.error(String(e.stack||e).replaceAll(key,'[redacted]').replaceAll(phrase,'[redacted]'));process.exitCode=1;}
finally{await ctx.close();}
