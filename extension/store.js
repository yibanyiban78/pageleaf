// Handles require structured cloning (IndexedDB), not JSON or chrome.storage.sync.
let opened;
function database() {
  return opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('pageleaf-local-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('preferences');
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opened = null; }; resolve(db); };
    request.onerror = () => { opened = null; reject(request.error); };
  });
}
async function entry(key, write, value) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('preferences', write ? 'readwrite' : 'readonly');
    const store = tx.objectStore('preferences');
    const request = write ? store.put(value, key) : store.get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('无法访问本地扩展设置。'));
  });
}
export const getRoot = () => entry('root', false);
// Keep the old database and key intact. Existing 1.0 roots have revision 'legacy'.
// The revision prevents a confirmed snapshot from going into a different folder.
export async function getRootState() {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('preferences','readonly'), s=tx.objectStore('preferences');
    const root=s.get('root'), rev=s.get('rootRevision');
    tx.oncomplete=()=>resolve({root:root.result,revision:rev.result || 'legacy'});
    tx.onabort=tx.onerror=()=>reject(tx.error || new Error('读取保存目录失败。'));
  });
}
export async function setRoot(handle) {
  const db=await database();
  const revision=crypto.randomUUID();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('preferences','readwrite'), s=tx.objectStore('preferences');
    s.put(handle,'root'); s.put(revision,'rootRevision');
    tx.oncomplete=()=>resolve(); tx.onabort=tx.onerror=()=>reject(tx.error || new Error('保存目录设置失败。'));
  });
  // Never carry the previous folder's green/orange dot over to a different library.
  await chrome.storage.session.set({pageleafRootEpoch:revision}).catch(()=>{});
}
// All public credential operations, including reads, share one origin-wide lock.
// IndexedDB transactions alone cannot span WebCrypto and chrome.storage.session.
import {apiURL} from './network.js';
import {isVaultId, validEnvelope, envelopeTag, sealEnvelope, openEnvelope} from './vault.js';

const locked = action => navigator.locks.request('pageleaf:service:v1', action);
const readService = () => entry('service', false);
const SLOT = 'pageleafUnlockedService';
const empty = {endpoint:'', model:''};
const stale = () => new Error('服务设置已在其他页面更改。请重新读取后再试。');
const damaged = () => new Error('凭据记录损坏，已停止使用。请先确认移除原服务设置。');
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));

function describe(raw) {
  if (raw === undefined) return {...empty,revision:'absent',credentialState:'none',malformed:false};
  const bad = {...empty,revision:'malformed',credentialState:'locked',malformed:true};
  const old = exact(raw,['endpoint','model','key']);
  if (!old && !(exact(raw,['endpoint','model','revision','envelope']) && isVaultId(raw.revision))) return bad;
  const {endpoint,model} = raw;
  if (typeof endpoint !== 'string' || typeof model !== 'string') return bad;
  let state;
  if (old) {
    if (typeof raw.key !== 'string') return bad;
    state = raw.key ? 'legacy' : 'none';
  } else if (raw.envelope === null) state = 'none';
  else if (validEnvelope(raw.envelope)) state = 'locked';
  else return bad;
  if (endpoint !== '' || model !== '' || state !== 'none') {
    try { apiURL(endpoint); } catch { return bad; }
    if (!model.trim()) return bad;
  }
  return {endpoint,model,revision:old ? `old-${state}` : raw.revision,credentialState:state,malformed:false};
}
function checkRevision(info, expectedRevision) {
  if (expectedRevision !== undefined && info.revision !== expectedRevision) throw stale();
}
function sameSnapshot(before, now) {
  const a = describe(before), b = describe(now);
  if (a.revision !== b.revision || a.credentialState !== b.credentialState || a.endpoint !== b.endpoint || a.model !== b.model) return false;
  // Malformed records can ONLY be discarded by an explicit forget operation.
  if (a.malformed || a.credentialState === 'none') return true;
  if (a.credentialState === 'legacy') return before.key === now.key;
  return Object.keys(before.envelope).every(k => before.envelope[k] === now.envelope[k]);
}
// Check the actual old record and replace it in one IDB transaction (including
// the original unversioned plaintext shape). No async computation inside it.
async function replaceService(before, after) {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction('preferences','readwrite'), store = tx.objectStore('preferences');
    const read = store.get('service');
    let conflict = false;
    read.onsuccess = () => {
      if (!sameSnapshot(before,read.result)) { conflict = true; tx.abort(); return; }
      store.put(after,'service');
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(conflict ? stale() : new Error('写入服务设置失败；原凭据未被替换。'));
  });
}
async function sessionArea() {
  // No local/sync fallback. Explicitly restrict the area before touching a key.
  const session = chrome.storage.session;
  await session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  return session;
}
async function cacheFor(raw, key) {
  return {id:raw.envelope.id, endpoint:apiURL(raw.endpoint).href, tag:await envelopeTag(raw.envelope), key};
}
async function cachedKey(raw, cache) {
  if (!exact(cache,['id','endpoint','tag','key']) || cache.id !== raw.envelope.id || cache.endpoint !== apiURL(raw.endpoint).href ||
      typeof cache.key !== 'string' || !cache.key.trim() || cache.key.length > 4096) return '';
  return cache.tag === await envelopeTag(raw.envelope) ? cache.key : '';
}
async function view(raw, withKey=false) {
  const info = describe(raw);
  let key = '';
  if (info.credentialState === 'locked' && !info.malformed) {
    try { key = await cachedKey(raw, (await (await sessionArea()).get(SLOT))[SLOT]); }
    catch { /* An unavailable trusted session is locked, never anonymous. */ }
    if (key) info.credentialState = 'unlocked';
  }
  if (!withKey) return info;
  const {endpoint,model,revision,credentialState} = info;
  return {endpoint,model,revision,credentialState,key};
}
export const getServiceInfo = () => locked(async () => view(await readService()));
export const getConfig = () => locked(async () => view(await readService(),true));

// Stage the verified cache before the atomic durable replacement. A crash
// between the two leaves an unusable cache (id + endpoint + tag do not match),
// never a lost legacy record. A normal write failure rolls the cache back.
async function commit(before, after, cache) {
  const session = await sessionArea();
  const previous = (await session.get(SLOT))[SLOT];
  if (cache) await session.set({[SLOT]:cache}); else await session.remove(SLOT);
  try { await replaceService(before,after); }
  catch (error) {
    const original = describe(before);
    if (original.credentialState === 'locked' && !original.malformed && await cachedKey(before,previous) && sameSnapshot(before, await readService())) {
      await session.set({[SLOT]:previous});
    } else await session.remove(SLOT);
    throw error;
  }
}
export const saveService = ({endpoint,model,key=''}, passphrase, expectedRevision) => locked(async () => {
  const before = await readService(), info = describe(before);
  checkRevision(info,expectedRevision);
  if (info.malformed) throw damaged();
  if (info.credentialState === 'legacy') throw new Error('请先为旧 Key 设置本地口令，或确认移除原服务设置。');
  if (typeof endpoint !== 'string' || typeof model !== 'string' || !model.trim() || typeof key !== 'string') throw new Error('请填写有效的服务地址和模型名称。');
  endpoint = endpoint.trim(); model = model.trim(); key = key.trim();
  const url = apiURL(endpoint).href;
  if (!key && before?.envelope && apiURL(info.endpoint).href !== url) throw new Error('服务地址已变更。请输入新 Key，或先移除旧服务设置。');
  const envelope = key ? await sealEnvelope(key,endpoint,passphrase) : before?.envelope ?? null;
  const next = {endpoint,model,revision:crypto.randomUUID(),envelope};
  if (key) await commit(before,next,await cacheFor(next,key));
  else await replaceService(before,next); // Same verified envelope: preserve the existing lock state.
  return view(next);
});
export const unlockService = (passphrase, expectedRevision) => locked(async () => {
  const before = await readService(), info = describe(before);
  checkRevision(info,expectedRevision);
  if (info.malformed) throw damaged();
  if (info.credentialState === 'none') throw new Error('没有可解锁的 Key。');
  if (info.credentialState === 'legacy') {
    const {endpoint,model} = info;
    const next = {endpoint,model,revision:crypto.randomUUID(),envelope:await sealEnvelope(before.key,endpoint,passphrase)};
    await commit(before,next,await cacheFor(next,before.key));
    return view(next);
  }
  const session = await sessionArea();
  await session.remove(SLOT); // A rejected unlock does not leave an older unlock usable.
  const key = await openEnvelope(before.envelope,before.endpoint,passphrase);
  if (!sameSnapshot(before,await readService())) throw stale();
  await session.set({[SLOT]:await cacheFor(before,key)});
  return view(before);
});
export const lockService = expectedRevision => locked(async () => {
  const info = describe(await readService());
  checkRevision(info,expectedRevision);
  await (await sessionArea()).remove(SLOT);
  return info;
});
export const forgetService = expectedRevision => locked(async () => {
  const before = await readService();
  checkRevision(describe(before),expectedRevision);
  // Fresh empty revision prevents a stale pre-forget form from resurrecting a key.
  const next = {...empty,revision:crypto.randomUUID(),envelope:null};
  await commit(before,next,null);
  return describe(next);
});
