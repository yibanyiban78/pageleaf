// Vault-scoped identity and read-only checks. Never enumerate a user's folders, fetch
// a URL, persist page content, or turn an inconclusive read into permission to save.
import {bodyMarkdown, decoded, line, link, plain, urlOf} from './markdown.js';

export const INDEX = '剪藏索引.md';
export const BEGIN = '<!-- pageleaf:index:v1 -->', END = '<!-- /pageleaf:index:v1 -->';
export const RECEIPTS = '.pageleaf', FORMAT = 'pageleaf/receipt/1';
export const KINDS = new Map([['article', '文章'], ['selection', '摘录'], ['youtube', 'YouTube 视频']]);
const KEY = /^[0-9a-f]{64}$/;
const IMAGE = /PAGELEAFIMG[a-f\d]{32}X\d+END/g;
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
export const HEADER_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(data))), b => b.toString(16).padStart(2, '0')).join('');
class CheckError extends Error {}
const invalid = () => new CheckError('无法核实剪藏状态。请检查当前库的目录权限、索引和页笺本地记录。');
const ambiguous = () => new CheckError('旧摘录只保留了本地图片或图片说明，无法核实原图是否相同。请在库中核对这条摘录。');
const uncertain = e => e instanceof CheckError ? e : invalid();

function videoId(u) {
  if (u.protocol !== 'https:' || u.port || !/^(?:(?:(?:www|m|music)\.)?youtube\.com|(?:www\.)?youtube-nocookie\.com|youtu\.be)$/.test(u.hostname)) return '';
  const id = u.hostname === 'youtu.be' ? /^\/([^/]+)\/?$/.exec(u.pathname)?.[1] :
    /^\/watch\/?$/.test(u.pathname) && u.searchParams.getAll('v').length === 1 ? u.searchParams.get('v') :
    /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/.exec(u.pathname)?.[1];
  return /^[\w-]{11}$/.test(id || '') ? id : '';
}
function sourceOf(clip) {
  const u = urlOf(clip?.url);
  if (!u || !KINDS.has(clip.kind)) throw new CheckError('无法识别剪藏来源，请重新预览原页面。');
  const id = videoId(u);
  if (clip.kind === 'youtube' && (!id || (clip.videoId && clip.videoId !== id))) throw new CheckError('无法核实该视频的标识，请重新预览。');
  if (id) return 'youtube:' + id;
  // Do not sort, decode and serialize meaningful query strings (signed values,
  // duplicate keys, order and %20 vs + can matter). Drop only known tracking keys.
  const parts = u.search.slice(1).split('&');
  const keep = parts.filter(s => !/^(?:utm_[a-z\d_]+|fbclid|gclid)(?:=|$)/i.test(s));
  if (keep.length !== parts.length) u.search = keep.join('&');
  u.hash = u.hash.split(':~:')[0];
  if (!/[/?=!]/.test(u.hash)) u.hash = '';
  return u.href;
}
function linkedImages(clip) {
  const images = new Map();
  for (const img of clip.images || []) if (img && !images.has(img.token)) images.set(img.token, img);
  return images;
}
export async function clipKey(clip) {
  const source = sourceOf(clip), selection = clip.kind === 'selection';
  let identity = [FORMAT, 'whole', source];
  if (selection) {
    if (typeof clip.body !== 'string' || !clip.body.trim()) throw new CheckError('无法识别空白选段，请重新选择。');
    const images = linkedImages(clip), parts = [];
    const body = clip.body.replace(/\r\n?/g, '\n');
    let start = 0;
    for (const m of body.matchAll(IMAGE)) {
      const image = images.get(m[0]);
      if (!image) continue; // e.g., literal code that resembles a token
      parts.push(body.slice(start, m.index), [image.url, image.alt || '']);
      start = m.index + m[0].length;
    }
    parts.push(body.slice(start));
    identity = [FORMAT, 'selection', source, parts];
  }
  return hash(JSON.stringify(identity));
}
export function withClipLock(key, action) {
  if (!KEY.test(key) || !globalThis.navigator?.locks?.request) throw new CheckError('无法安全协调剪藏任务，请更新浏览器后重试。');
  return navigator.locks.request('pageleaf/clip/v1/' + key, action);
}

export function validPath(path) {
  if (typeof path !== 'string') return false;
  const [day, name, ...rest] = path.split('/');
  return !rest.length && DAY.test(day) && !!name && name.length <= 255 && /\.md$/.test(name) &&
    !/^[. ]|[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(name) &&
    !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|(?:COM|LPT)[\d¹²³]) *(?:\.|$)/i.test(name);
}
export function receiptPath(data, key) {
  if (!data || data.format !== FORMAT || data.key !== key || !KEY.test(key) || !validPath(data.path)) throw invalid();
  return data.path;
}
async function maybe(open) {
  try { return await open(); } catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}
async function readUtf8(blob, max) {
  if (blob.size > max) throw new CheckError('本地记录过大，无法完整核实剪藏状态。');
  const value = new TextDecoder('utf-8', {fatal:true}).decode(await blob.arrayBuffer());
  if (value.includes('\0')) throw invalid();
  return value.replace(/\r\n/g, '\n');
}
async function receipt(root, key) {
  const dir = await maybe(() => root.getDirectoryHandle(RECEIPTS));
  const handle = dir && await maybe(() => dir.getFileHandle(key + '.json'));
  return handle && receiptPath(JSON.parse(await readUtf8(await handle.getFile(), 4096)), key);
}
// Only links bearing the exact writer grammar, inside the writer's fenced
// region and under their matching date, are candidates. Never resolve a URL,
// path traversal, decoded slash, absolute path, nested file, or user prose link.
export function indexEntries(text) {
  const entries = [];
  let phase = 0, day = '', orphanRows = false;
  for (const [raw] of text.replace(/^\uFEFF/, '').matchAll(/[^\n]+/g)) {
    const row = raw.endsWith('\r') ? raw.slice(0,-1) : raw;
    if (row === BEGIN) { if (phase !== 0) throw invalid(); phase = 1; day = ''; continue; }
    if (row === END) { if (phase !== 1) throw invalid(); phase = 2; continue; }
    if (/^\s*<!--\s*\/?pageleaf:index\b/i.test(row)) throw invalid();
    if (row.startsWith('## ') && DAY.test(row.slice(3).trimEnd())) { day = row.slice(3).trimEnd(); continue; }
    if (!row.startsWith('- [')) continue;
    const suffix = / · (文章|摘录|YouTube 视频)(?: <!-- pageleaf:key:([a-f0-9]{64}) -->)?[ \t]*$/.exec(row);
    if (!suffix) {
      if (phase === 1 && row.includes(' <!-- pageleaf:key:')) throw invalid();
      continue;
    }
    if (phase !== 1) { if (day && phase === 0) orphanRows = true; continue; }
    const caption = /^- \[(?:\\.|[^\[\]\\])*\]\(/.exec(row);
    const end = caption ? row.indexOf(') · ', caption[0].length) : -1;
    if (end < 0 || end + 4 >= suffix.index) throw invalid();
    const dest = row.slice(caption[0].length, end).replace(/^<(.+)>$/, '$1');
    // Decode each path component once; never reinterpret a decoded separator.
    const parts = dest.split('/');
    if (parts.length !== 2 || parts[0] !== day || !DAY.test(day)) throw invalid();
    const name = decodeURIComponent(parts[1]), path = `${day}/${name}`;
    if (!validPath(path)) throw invalid();
    entries.push({path, kind:suffix[1], key:suffix[2]});
  }
  if (phase === 1 || (!phase && orphanRows)) throw invalid();
  return entries;
}
async function index(root) {
  const handle = await maybe(() => root.getFileHandle(INDEX));
  return handle ? indexEntries(await readUtf8(await handle.getFile(), 32 * 1024 * 1024)) : [];
}
async function openNote(root, path) {
  if (!validPath(path)) throw invalid();
  const [day, name] = path.split('/');
  const dir = await maybe(() => root.getDirectoryHandle(day));
  const handle = dir && await maybe(() => dir.getFileHandle(name));
  return handle && await handle.getFile(); // a later I/O failure is not a missing note
}
async function header(file, path) {
  // Inspect only an initial slice of unrelated legacy notes. stream:true allows
  // truncation inside a multi-byte character, not malformed bytes before it.
  const prefix = await file.slice(0, HEADER_BYTES).arrayBuffer();
  const s = new TextDecoder('utf-8', {fatal:true}).decode(prefix, {stream:file.size > HEADER_BYTES}).replace(/\r\n/g,'\n');
  const rows = s.split('\n', 8), kind = [...KINDS].find(([, v]) => rows[2] === '- 类型：' + v)?.[0];
  if (!kind || !rows[0]?.startsWith('# ') || rows[1] !== '' || rows[3] !== '- 剪藏日期：' + path.slice(0,10) ||
    !rows[4]?.startsWith(kind === 'youtube' ? '- 频道：' : '- 作者：')) throw invalid();
  const m = /^- 来源：\[((?:\\.|[^\[\]\\])+)\]\((.+)\)$/.exec(rows[5]);
  // The caption contains the ORIGINAL URL (incl literal '#' / '(' / '%');
  // the Markdown destination alone is lossy. Re-encode to verify both halves.
  const url = m && urlOf(decoded(m[1].replace(/\\([!-\/:-@\[-`{-~])/g,'$1')));
  if (!url || rows[5] !== '- 来源：' + link(url.href, url)) throw invalid();
  const marker = /^<!-- pageleaf:clip:v1 ([a-f0-9]{64}) (ok|[sciw]{1,4}) -->$/.exec(rows[6]);
  if (!marker && rows[6] !== '') throw invalid();
  return {kind, source:sourceOf({kind, url:url.href}), marker};
}
export function warningCodes(warnings) {
  return [...new Set(warnings.map(s => /字幕/.test(s) && !/摘要生成失败/.test(s) ? 'c' : /摘要/.test(s) ? 's' : /图片/.test(s) ? 'i' : 'w'))].join('') || 'ok';
}
function status(path, codes, indexed) {
  const reasons = [...codes].map(c => ({s:'摘要未完整生成',c:'字幕未完整取得',i:'图片未完整保存',w:'有步骤未完成'})[c]).filter(Boolean);
  if (!indexed) reasons.push('索引未更新或暂时无法核实');
  return {state:reasons.length ? 'partial' : 'saved', path, indexed,
    message:reasons.length ? '笔记已保存，但' + reasons.join('、') + '。' : '已保存到当前库。'};
}
// Compare the complete old on-disk selection, using the very same renderer.
// Known image fallback URLs can prove identity; successful local downloads lost
// their source URLs. Compare placement, surrounding text, and alt before declaring
// that ambiguity. Never read or hash a local image to guess its remote identity.
function legacySelection(clip, old) {
  const images = linkedImages(clip), placeholders = new Map(), items = [];
  for (const [token, image] of images) { placeholders.set(token, `\x01${items.length}\x01`); items.push(image); }
  const expected = bodyMarkdown(clip.body, placeholders);
  let start = 0, at = 0, unknown = false;
  for (const m of expected.matchAll(/\x01(\d+)\x01/g)) {
    const before = expected.slice(start, m.index);
    if (!old.startsWith(before, at)) return false;
    at += before.length; start = m.index + m[0].length;
    const img = items[Number(m[1])], alt = line(img.alt) || '图片', url = urlOf(img.url);
    const caption = link(alt, url);
    const fallback = [caption + '（未保存到本地）', ...(url?.protocol === 'http:' ? [caption + '（HTTP 原图链接，未下载）'] : [])].find(s => old.startsWith(s, at));
    if (fallback) { at += fallback.length; unknown ||= !url; continue; }
    const local = `![${plain(alt)}](assets/`;
    if (!old.startsWith(local, at)) return false;
    const end = old.indexOf(')', at + local.length);
    if (end < 0 || end - at > local.length + 1024) return false;
    at = end + 1; unknown = true;
  }
  if (old.slice(at) !== expected.slice(start)) return false;
  return unknown ? 'unknown' : true;
}
async function find(root, clip, key) {
  if (!KEY.test(key)) throw invalid();
  const source = sourceOf(clip), path = await receipt(root, key);
  const sameKind = k => k === clip.kind || (source.startsWith('youtube:') && k !== 'selection' && clip.kind !== 'selection');
  if (path) {
    const file = await openNote(root, path);
    // An aborted note write can leave a zero-byte target, which is not a saved
    // Markdown. A nonempty mismatched/replaced note cannot authenticate a receipt.
    if (file?.size) {
      const h = await header(file, path);
      if (h.marker?.[1] !== key || h.source !== source || !sameKind(h.kind)) throw invalid();
      let indexed = false;
      try { indexed = (await index(root)).some(e => e.path === path && e.kind === KINDS.get(h.kind) && (!e.key || e.key === key)); } catch { /* verified Markdown; index uncertain */ }
      return status(path, h.marker[2], indexed);
    }
  }
  const entries = await index(root);
  let unresolved, count = 0;
  for (const e of entries) {
    if (e.key && e.key !== key) continue;
    if (e.kind !== KINDS.get(clip.kind) && !(source.startsWith('youtube:') && clip.kind !== 'selection' && e.kind !== KINDS.get('selection'))) continue;
    if (++count > 4096) throw new CheckError('当前库待核实的旧记录过多，无法确认是否已保存。');
    try {
      const file = await openNote(root, e.path);
      if (!file || (!file.size && e.path === path)) continue;
      const h = await header(file, e.path);
      if (e.key && (h.marker?.[1] !== e.key || h.source !== source || !sameKind(h.kind))) throw invalid();
      if (h.source !== source || !sameKind(h.kind)) continue;
      if (h.marker) { if (h.marker[1] === key) return status(e.path, h.marker[2], true); continue; }
      const old = await readUtf8(file, 32 * 1024 * 1024);
      if (clip.kind === 'selection') {
        const section = '\n\n## 摘录\n\n', pos = old.indexOf(section);
        if (pos < 0) throw invalid();
        const equal = legacySelection(clip, old.slice(pos + section.length).trim());
        if (equal === 'unknown') throw ambiguous();
        if (!equal) continue;
      }
      const codes = (/\n## 内容摘要\n\n摘要生成失败：/.test(old) ? 's' : '') +
        (/\n## 内容摘要\n\n未取得字幕，未生成内容摘要。/.test(old) ? 'c' : '') + (old.includes('（未保存到本地）') ? 'i' : '');
      return status(e.path, codes || 'ok', true);
    } catch (err) { unresolved ||= uncertain(err); }
  }
  if (unresolved) throw unresolved;
  return {state:'new'};
}
export async function lookupClip(root, clip, key) {
  try { return await find(root, clip, key ?? await clipKey(clip)); } catch (e) { throw uncertain(e); }
}
