// Optional real-site probe, separate from hermetic acceptance tests. No login, no AI,
// no note, no account or personal Chrome profile. Print counts/status, not article or captions.
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
const js=await readFile(new URL('../extension/video.js',import.meta.url),'utf8');
const extract=await readFile(new URL('../extension/extract.js',import.meta.url),'utf8');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  await Promise.all([
    ['article','https://developer.chrome.com/docs/extensions/develop/concepts/activeTab'],
    ['youtube','https://www.youtube.com/watch?v=UF8uR6Z6KLc']
  ].map(async([mode,url])=>{const ctx=await browser.newContext({locale:'en-US'});try{
    const page=await ctx.newPage();const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
    if(mode==='youtube') await page.waitForFunction(()=>document.querySelector('#movie_player')?.getPlayerResponse?.()?.playabilityStatus,{},{timeout:15000}).catch(()=>{});
    const client=await ctx.newCDPSession(page);let contextId;
    if(mode==='article') {const {frameTree}=await client.send('Page.getFrameTree');({executionContextId:contextId}=await client.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'live-probe'}));}
    const expr=mode==='youtube'?`(async()=>{const c=await ${js.trim().replace(/;$/,'')};return {title:!!c.title,author:!!c.author,cover:!!c.cover,description:!!c.description,cues:c.cues.length,language:c.language,playability:document.querySelector('#movie_player')?.getPlayerResponse?.()?.playabilityStatus?.status||'unknown'};})()`:`(()=>{const c=${extract.trim().replace(/;$/,'')};return {title:!!c.title,kind:c.kind,bodyLength:c.plain.length,images:c.images.length};})()`;
    const result=await client.send('Runtime.evaluate',{expression:expr,...(contextId && {contextId}),awaitPromise:true,returnByValue:true,timeout:20000});
    console.log(JSON.stringify({mode,http:response?.status(),host:new URL(page.url()).hostname,result:result.result?.value,error:result.exceptionDetails?.exception?.description?.split('\n')[0]}));
  }catch(e){console.log(JSON.stringify({mode,unavailable:String(e.message).split('\n')[0]}));}finally{await ctx.close();}}));
}finally{await browser.close();}
