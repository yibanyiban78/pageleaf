// Real browser fetch in an isolated page, with synthetic origins and no external DNS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

test('browser image transport: HTTPS can save; HTTP and redirects never fetch a fallback', async () => {
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {channel:'chrome'}),args:['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});
  try {
    const ctx=await browser.newContext({serviceWorkers:'block'});
    const page=await ctx.newPage();
    const base='https://fixture.pageleaf.test', plain='http://fixture-image.pageleaf.test/only-link.png?example=1';
    const code=await readFile(new URL('../extension/network.js',import.meta.url),'utf8');
    const png=await readFile(new URL('./browser-fixtures/map.png',import.meta.url));
    const requests=[];
    await ctx.route('**/*',async route=>{
      const u=route.request().url(); requests.push(u);
      if(u===base+'/page')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Image transport fixture</title><link rel="icon" href="data:,">'});
      if(u===base+'/network.js')return route.fulfill({contentType:'application/javascript',body:code});
      if(u===base+'/ok.png')return route.fulfill({contentType:'image/png',body:png});
      if(u===base+'/redirect-http')return route.fulfill({status:302,headers:{Location:plain}});
      if(u===base+'/redirect-https')return route.fulfill({status:302,headers:{Location:base+'/next.png'}});
      return route.abort('blockedbyclient');
    });
    await page.goto(base+'/page');
    const result=await page.evaluate(async({base,plain})=>{
      const {downloadImage}=await import('./network.js');
      const ok=await downloadImage(base+'/ok.png',location.href);
      const rejected=[];
      for(const url of [plain,base+'/redirect-http',base+'/redirect-https']){
        try{await downloadImage(url,location.href);rejected.push(false);}catch{rejected.push(true);}
      }
      return {ext:ok.ext,size:ok.blob.size,rejected};
    },{base,plain});
    assert.deepEqual(result,{ext:'png',size:png.length,rejected:[true,true,true]});
    assert.deepEqual(requests,[base+'/page',base+'/network.js',base+'/ok.png',base+'/redirect-http',base+'/redirect-https']);
  }finally{await browser.close();}
});
