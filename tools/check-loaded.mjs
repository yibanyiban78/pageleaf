// Smoke-test a freshly unzipped release, not the working tree. Dedicated temporary profile.
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const p=resolve(process.argv[2]);const manifest=JSON.parse(await readFile(resolve(p,'manifest.json'),'utf8'));
const ctx=await chromium.launchPersistentContext('',{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});
try{const dev=await ctx.browser().newBrowserCDPSession();const {id}=await dev.send('Extensions.loadUnpacked',{path:p});assert.equal(manifest.action.default_popup,'popup.html');for(const f of ['popup.html','popup.js','popup.css','preview.js','video-preview.js']) assert((await readFile(resolve(p,f))).length>0);assert(!ctx.pages().some(t=>t.url()===`chrome-extension://${id}/settings.html`),'Options should not launch on install');const page=await ctx.newPage();await page.goto(`chrome-extension://${id}/settings.html`);await page.waitForFunction(()=>document.querySelector('#dirname')?.textContent==='未选择文件夹');assert.equal(await page.title(),'剪藏设置 · 页笺');assert.equal(await page.locator('#choose').isEnabled(),true);assert.equal(await page.evaluate(()=>chrome.runtime.getManifest().version),manifest.version);console.log('Freshly unpacked release loads and initializes settings in '+(await dev.send('Browser.getVersion')).product);}finally{await ctx.close();}
