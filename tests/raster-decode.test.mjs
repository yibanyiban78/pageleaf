// Decode with the real desktop browser. A magic header alone cannot make a local image viewable.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const source=await readFile(new URL('../extension/network.js',import.meta.url),'utf8');
test('browser detects truncated JPEG and writes a genuinely decodable JPEG for WebP covers only',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const p=await browser.newPage();await p.route('**/*',route=>new URL(route.request().url()).pathname==='/network.js'?route.fulfill({contentType:'text/javascript',body:source}):route.fulfill({contentType:'text/html',body:'<!doctype html><title>Local test</title>'}));
    await p.goto('https://media-test.example/');
    const r=await p.evaluate(async()=>{
      const {downloadImage}=await import('/network.js');
      const make=async(type)=>{const c=new OffscreenCanvas(4,3);const g=c.getContext('2d');g.fillStyle='orange';g.fillRect(0,0,4,3);return c.convertToBlob({type});};
      const url='https://media-test.example/cover.jpg';const src=await make('image/webp');
      const convert=cover=>downloadImage(url,url,async()=>new Response(src),{cover});
      const cover=await convert(true), other=await convert(false);
      const jpeg=await createImageBitmap(cover.blob);let failed=false;
      try{await downloadImage(url,url,async()=>new Response(Uint8Array.from([255,216,255,1])));}catch{failed=true;}
      const bytes=Array.from(new Uint8Array(await cover.blob.slice(0,3).arrayBuffer()));
      const result={cover:cover.ext,other:other.ext,mime:cover.blob.type,dx:jpeg.width,dy:jpeg.height,failed,bytes,unchanged:(await other.blob.arrayBuffer()).byteLength===src.size};jpeg.close();return result;
    });
    assert.deepEqual(r,{cover:'jpg',other:'webp',mime:'image/jpeg',dx:4,dy:3,failed:true,bytes:[255,216,255],unchanged:true});
  }finally{await browser.close();}
});
