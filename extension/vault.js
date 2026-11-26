// On-disk format v1. The algorithm/parameter whitelist is fixed per version:
// a corrupt record must not select an algorithm or request unbounded KDF work.
import {apiURL} from './network.js';

const VERSION = 1, CIPHER = 'AES-GCM-256', KDF = 'PBKDF2-SHA-256', ROUNDS = 600_000;
const fields = ['version', 'id', 'cipher', 'kdf', 'iterations', 'salt', 'iv', 'ciphertext'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});
const MAX_KEY_BYTES = 4096 * 4; // Existing settings accept at most 4096 UTF-16 code units.
const random = n => crypto.getRandomValues(new Uint8Array(n));
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const invalid = () => new Error('凭据格式无效；未使用或覆盖已保存的 Key。');
export const isVaultId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

function validBytes(text, min, max) {
  if (typeof text !== 'string' || text.length < Math.ceil(min / 3) * 4 || text.length > Math.ceil(max / 3) * 4) return false;
  try {
    const bytes = unb64(text);
    return bytes.length >= min && bytes.length <= max && b64(bytes) === text;
  } catch { return false; }
}
export function validEnvelope(e) {
  return e !== null && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length === fields.length && fields.every(k => Object.hasOwn(e,k)) &&
    e.version === VERSION && isVaultId(e.id) && e.cipher === CIPHER && e.kdf === KDF && e.iterations === ROUNDS &&
    validBytes(e.salt,16,16) && validBytes(e.iv,12,12) && validBytes(e.ciphertext,17,MAX_KEY_BYTES + 16);
}
// Bind a cached plaintext to the *entire* verified envelope, not just its id.
// A syntactically valid but tampered ciphertext must invalidate an existing unlock.
export async function envelopeTag(e) {
  const bytes = encoder.encode(JSON.stringify(fields.map(k => e[k])));
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase].length < 12 || !passphrase.isWellFormed()) {
    throw new Error('请使用至少 12 个字符的本地口令。');
  }
}
async function derive(passphrase, e) {
  checkPassphrase(passphrase);
  const bytes = encoder.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({name:'PBKDF2', hash:'SHA-256', iterations:ROUNDS, salt:unb64(e.salt)},
      material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
  } finally { bytes.fill(0); }
}
function params(endpoint, e) {
  const additionalData = encoder.encode(JSON.stringify(['pageleaf:service',VERSION,e.id,apiURL(endpoint).href]));
  return {name:'AES-GCM', iv:unb64(e.iv), additionalData, tagLength:128};
}
export async function openEnvelope(e, endpoint, passphrase) {
  if (!validEnvelope(e)) throw invalid();
  checkPassphrase(passphrase);
  try {
    const derived = await derive(passphrase,e);
    const bytes = new Uint8Array(await crypto.subtle.decrypt(params(endpoint,e), derived, unb64(e.ciphertext)));
    try {
      const key = decoder.decode(bytes);
      if (!key.trim() || key.length > 4096) throw invalid();
      return key;
    } finally { bytes.fill(0); }
  } catch { throw new Error('无法解锁：本地口令不正确或凭据已损坏。'); }
}
export async function sealEnvelope(key, endpoint, passphrase) {
  checkPassphrase(passphrase);
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || !key.isWellFormed()) throw invalid();
  const e = {version:VERSION, id:crypto.randomUUID(), cipher:CIPHER, kdf:KDF, iterations:ROUNDS, salt:b64(random(16)), iv:b64(random(12))};
  const derived = await derive(passphrase,e), bytes = encoder.encode(key);
  try {
    e.ciphertext = b64(new Uint8Array(await crypto.subtle.encrypt(params(endpoint,e), derived, bytes)));
  } finally { bytes.fill(0); }
  // Read the serialized envelope through the real unlock path before the old
  // record can be replaced. No passphrase, plaintext, or derived key goes to IDB.
  if (await openEnvelope(e,endpoint,passphrase) !== key) throw invalid();
  return e;
}
