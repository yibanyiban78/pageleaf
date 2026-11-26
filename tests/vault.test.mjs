import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {sealEnvelope, openEnvelope, validEnvelope} from '../extension/vault.js';

const endpoint = 'https://model.invalid:8443/v1', model = 'fixture-model';
const secret = () => `fixture-${crypto.randomUUID()}`;
const alter = text => (text[0] === 'A' ? 'B' : 'A') + text.slice(1);

test('v1 encrypts with fresh salt/IV/id and authenticates the whole canonical endpoint',async () => {
  const key = secret(), pass = '🪴'.repeat(12);
  const [a,b] = await Promise.all([sealEnvelope(key,endpoint,pass), sealEnvelope(key,endpoint,pass)]);
  assert.equal(a.version,1); assert.equal(a.cipher,'AES-GCM-256'); assert.equal(a.kdf,'PBKDF2-SHA-256'); assert.equal(a.iterations,600000);
  assert.equal(atob(a.salt).length,16); assert.equal(atob(a.iv).length,12); assert.equal(atob(a.ciphertext).length,new TextEncoder().encode(key).length + 16);
  for (const k of ['id','salt','iv','ciphertext']) assert.notEqual(a[k],b[k]);
  assert(!JSON.stringify(a).includes(key)); assert(!JSON.stringify(a).includes(pass));
  assert(await openEnvelope(a,'https://MODEL.invalid:8443/v1/chat/completions/',pass) === key);
  for (const wrong of ['https://other.invalid:8443/v1','https://model.invalid/v1',endpoint+'/other']) {
    await assert.rejects(openEnvelope(a,wrong,pass),/无法解锁/);
  }
  for (const swap of [{id:b.id},{salt:b.salt},{iv:b.iv},{ciphertext:alter(a.ciphertext)}]) {
    await assert.rejects(openEnvelope({...a,...swap},endpoint,pass),/无法解锁/);
  }
  await assert.rejects(openEnvelope(a,endpoint,'🪴'.repeat(11)+'🌱'),/无法解锁/);
  await assert.rejects(sealEnvelope(key,endpoint,'🪴'.repeat(11)),/12 个字符/);
});

test('invalid/mixed envelopes fail validation before derivation; Unicode is never silently rewritten',async () => {
  const key = '合成-'+secret(), pass = '  '+secret()+'  ';
  const e = await sealEnvelope(key,endpoint,pass);
  assert(await openEnvelope(e,endpoint,pass) === key);
  await assert.rejects(openEnvelope(e,endpoint,pass.trim()),/无法解锁/);
  for (const value of [null, {}, [], ...[
    {version:2}, {id:'not-a-uuid'}, {cipher:'AES-CBC'}, {kdf:'other'}, {iterations:1}, {iterations:2**32},
    {salt:e.salt.slice(0,-1)}, {iv:e.salt}, {ciphertext:'not base64'}, {ciphertext:btoa(''.padStart(16))}, {key:'unexpected'},
  ].map(patch => ({...e,...patch}))]) {
    assert.equal(validEnvelope(value),false);
    await assert.rejects(openEnvelope(value,endpoint,pass),/凭据格式/);
  }
  await assert.rejects(sealEnvelope(key,endpoint,'\ud800'.repeat(12)),/口令/);
});

// Real IDB transactions, Web Locks, WebCrypto and extension-only session storage.
// The manifest itself provides a blank extension context, without starting a job
// or relying on a particular settings UI. No external origins are contacted.
test('service lifecycle in two isolated-profile extension tabs',async t => {
  const ctx = await chromium.launchPersistentContext('',{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],
    args:['--enable-unsafe-extension-debugging','--disable-background-networking','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});
  try {
    const cdp = await ctx.browser().newBrowserCDPSession();
    const {id} = await cdp.send('Extensions.loadUnpacked',{path:fileURLToPath(new URL('../extension',import.meta.url))});
    const [a,b] = await Promise.all([ctx.newPage(),ctx.newPage()]);
    for (const page of [a,b]) {
      await page.goto(`chrome-extension://${id}/manifest.json`);
      await page.evaluate(async () => {
        globalThis.service = await import(chrome.runtime.getURL('store.js'));
        await service.getServiceInfo(); // Creates the same database the old extension used.
        const db = await new Promise(resolve => {const r = indexedDB.open('pageleaf-local-v1',1); r.onsuccess = () => resolve(r.result);});
        globalThis.rawService = (...args) => new Promise((resolve,reject) => {
          const tx = db.transaction('preferences',args.length ? 'readwrite' : 'readonly'), s = tx.objectStore('preferences');
          const r = args.length ? s.put(args[0],'service') : s.get('service');
          tx.oncomplete = () => resolve(r.result); tx.onabort = () => reject(tx.error);
        });
      });
    }
    const call = (p,fn,...args) => p.evaluate(([fn,args]) => service[fn](...args),[fn,args]);
    const info = p => call(p,'getServiceInfo');
    const key = secret(), pass = secret(), legacy = {endpoint,model,key};
    let migrated;

    await t.test('empty and keyless services need no passphrase or session key',async () => {
      assert.equal((await info(a)).credentialState,'none');
      assert.equal(await a.evaluate(() => typeof service.setConfig),'undefined');
      const result = await call(a,'saveService',{endpoint,model,key:''});
      assert.equal(result.credentialState,'none'); assert(!Object.hasOwn(result,'key'));
      assert.equal((await call(b,'getConfig')).key,'');
      assert.equal(await b.evaluate(async () => (await rawService()).envelope === null),true);
    });
    await t.test('legacy remains quarantined on invalid passphrase or verification failure',async () => {
      await a.evaluate(raw => rawService(raw),legacy);
      const state = await info(b); assert.equal(state.credentialState,'legacy'); assert(!Object.hasOwn(state,'key'));
      assert.equal((await call(a,'getConfig')).key,'');
      for (const edit of [{model:'other',key:''},{model,key:secret()}]) {
        await assert.rejects(call(b,'saveService',{endpoint,...edit},pass),/旧 Key/);
      }
      await assert.rejects(call(a,'unlockService','short'),/12 个字符/);
      const kept = await a.evaluate(async ({pass,key}) => {
        const subtle = crypto.subtle, decrypt = subtle.decrypt;
        subtle.decrypt = async () => { throw new Error('injected verification failure'); };
        let failed = false;
        try { await service.unlockService(pass); } catch { failed = true; }
        finally { subtle.decrypt = decrypt; }
        return failed && (await rawService()).key === key && (await service.getConfig()).key === '' &&
          !(await chrome.storage.session.get('pageleafUnlockedService')).pageleafUnlockedService;
      },{key,pass});
      assert(kept);
    });
    await t.test('unavailable trusted session never causes migration to fall back to durable storage',async () => {
      assert(await a.evaluate(async ({pass,key}) => {
        const area = chrome.storage.session, original = area.setAccessLevel;
        area.setAccessLevel = async () => { throw new Error('trusted session unavailable'); };
        let failed = false;
        try { await service.unlockService(pass); } catch { failed = true; }
        finally { area.setAccessLevel = original; }
        const durable = JSON.stringify([await chrome.storage.local.get(null),await chrome.storage.sync.get(null)]);
        return failed && (await rawService()).key === key && (await service.getServiceInfo()).credentialState === 'legacy' &&
          !durable.includes(key) && !durable.includes(pass);
      },{pass,key}));
    });
    await t.test('migration CAS does not overwrite a competing legacy write and a retry needs no API Key',async () => {
      const conflict = await a.evaluate(async pass => {
        const subtle = crypto.subtle, decrypt = subtle.decrypt;
        subtle.decrypt = async function(...args) {
          const bytes = await decrypt.apply(this,args);
          // Simulate an external/older writer that does not honor the Web Lock.
          const r = await rawService(); await rawService({...r,model:'competing'});
          return bytes;
        };
        try { await service.unlockService(pass); return false; } catch (e) { return e.message.includes('其他页面'); }
        finally { subtle.decrypt = decrypt; }
      },pass);
      assert(conflict); assert.equal((await info(a)).model,'competing'); assert.equal((await info(a)).credentialState,'legacy');
      assert(await a.evaluate(async key => (await rawService()).key === key && !(await chrome.storage.session.get('pageleafUnlockedService')).pageleafUnlockedService,key));
      migrated = await call(b,'unlockService',pass,(await info(b)).revision);
      assert.equal(migrated.credentialState,'unlocked'); assert(!Object.hasOwn(migrated,'key'));
      assert.equal((await call(a,'getConfig')).revision,migrated.revision);
      assert(await a.evaluate(async ({pass,key}) => {
        const raw = await rawService(), durable = JSON.stringify([raw,await chrome.storage.local.get(null),await chrome.storage.sync.get(null)]);
        const cache = (await chrome.storage.session.get('pageleafUnlockedService')).pageleafUnlockedService;
        return !Object.hasOwn(raw,'key') && !!raw.envelope.ciphertext && !durable.includes(key) && !durable.includes(pass) &&
          !JSON.stringify(cache).includes(pass) && cache.id === raw.envelope.id && cache.key === key && (await service.getConfig()).key === key;
      },{pass,key}));
    });
    await t.test('an aborted durable rekey restores the original envelope and its verified session',async () => {
      assert(await a.evaluate(async ({pass,key,endpoint,model,replacement}) => {
        const prior = await rawService();
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(...args) {
          const request = original.apply(this,args);
          if (args[1] === 'service') this.transaction.abort();
          return request;
        };
        let failed = false;
        try { await service.saveService({endpoint,model,key:replacement},pass,prior.revision); } catch { failed = true; }
        finally { IDBObjectStore.prototype.put = original; }
        const current = await rawService(), info = await service.getConfig();
        return failed && current.envelope.id === prior.envelope.id && current.revision === prior.revision &&
          info.key === key && info.credentialState === 'unlocked';
      },{pass,key,endpoint,model,replacement:secret()}));
    });
    await t.test('blank Key preserves ciphertext and lock state only at the same canonical endpoint',async () => {
      const oldId = await a.evaluate(async () => (await rawService()).envelope.id);
      const alias = endpoint+'/chat/completions/';
      const next = await call(a,'saveService',{endpoint:alias,model:'renamed',key:''},undefined,migrated.revision);
      assert.equal(next.credentialState,'unlocked'); assert.notEqual(next.revision,migrated.revision);
      assert.equal(await a.evaluate(async () => (await rawService()).envelope.id),oldId);
      await assert.rejects(call(b,'forgetService',migrated.revision),/其他页面/);
      await assert.rejects(call(b,'saveService',{endpoint:endpoint+'/other',model,key:''}),/请输入新 Key/);
      assert((await call(b,'getConfig')).key === key);
      assert.equal((await call(a,'lockService')).credentialState,'locked');
      assert.equal((await call(b,'saveService',{endpoint,model,key:''})).credentialState,'locked');
      assert.equal((await call(b,'getConfig')).key,'');
      await assert.rejects(call(a,'unlockService',secret()),/无法解锁/);
      assert.equal((await info(b)).credentialState,'locked');
      assert.equal((await call(b,'unlockService',pass)).credentialState,'unlocked');
      await assert.rejects(call(a,'unlockService',secret()),/无法解锁/); // Even when previously unlocked.
      assert.equal((await info(b)).credentialState,'locked');
    });
    await t.test('competing revisioned writes cannot both commit or reuse a rotated envelope cache',async () => {
      const old = await call(a,'unlockService',pass), newKey = secret(), newPass = secret(), newEndpoint = endpoint+'/new';
      const originalCache = await a.evaluate(async () => (await chrome.storage.session.get('pageleafUnlockedService')).pageleafUnlockedService);
      const next = {endpoint:newEndpoint,model,key:newKey};
      const race = await Promise.allSettled([call(a,'saveService',next,newPass,old.revision),call(b,'saveService',next,newPass,old.revision)]);
      assert.equal(race.filter(r => r.status==='fulfilled').length,1); assert.match(race.find(r=>r.status==='rejected').reason.message,/其他页面/);
      assert((await call(b,'getConfig')).key === newKey);
      await a.evaluate(cache => chrome.storage.session.set({pageleafUnlockedService:cache}),originalCache);
      assert.equal((await call(b,'getConfig')).key,'');
      await assert.rejects(call(a,'unlockService',pass),/无法解锁/);
      assert.equal((await call(b,'unlockService',newPass)).credentialState,'unlocked');
    });
    await t.test('tampered envelopes, mixed legacy records and detached endpoints fail closed even with warm cache',async () => {
      const raw = await a.evaluate(() => rawService());
      for (const patch of [
        {envelope:{...raw.envelope,ciphertext:alter(raw.envelope.ciphertext)}}, {endpoint:'https://detached.invalid/v1'},
        {envelope:{...raw.envelope,iterations:1}}, {key:secret()}, {envelope:undefined},
      ]) {
        await a.evaluate(raw => rawService(raw),{...raw,...patch});
        const cfg = await call(b,'getConfig'); assert.equal(cfg.key,''); assert.equal(cfg.credentialState,'locked');
      }
      assert((await info(b)).malformed);
      await assert.rejects(call(b,'saveService',{endpoint,model,key:''}),/损坏/);
      await assert.rejects(call(b,'unlockService',pass),/损坏/);
      const gone = await call(b,'forgetService',(await info(b)).revision);
      assert.equal(gone.credentialState,'none'); assert.equal(gone.endpoint,'');
      assert.equal(await a.evaluate(async () => !(await chrome.storage.session.get('pageleafUnlockedService')).pageleafUnlockedService),true);
      await assert.rejects(call(a,'saveService',{endpoint,model,key:''},undefined,raw.revision),/其他页面/);
    });
  } finally { await ctx.close(); }
});
