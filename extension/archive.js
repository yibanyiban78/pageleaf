// The only module that writes into the user's chosen directory. No network access here.
const INDEX = '剪藏索引.md';
const BEGIN = '<!-- pageleaf:index:v1 -->';
const END = '<!-- /pageleaf:index:v1 -->';
const KINDS = new Map([['article', '文章'], ['selection', '摘录'], ['youtube', 'YouTube 视频']]);
const TOKEN = /^PAGELEAFIMG[a-f\d]{32}X\d+END$/;
const encoder = new TextEncoder();
let queue = Promise.resolve();

function locked(work) {
  // A handle loaded from IndexedDB is not object-identical across windows. One
  // origin-wide lock covers filename allocation AND the index read/modify/write.
  if (globalThis.navigator?.locks?.request) return navigator.locks.request('pageleaf/archive/v1', work);
  const next = queue.then(work);
  queue = next.catch(() => {});
  return next;
}

function text(v) {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\bdata:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^\s<>"')\]]*/gi, '［内嵌图片］').toWellFormed() : '';
}
const line = v => text(v).replace(/\s+/g, ' ').trim();
const htmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// & / angle brackets are escaped, not removed: literal HTML stays readable.
// A backslash in untrusted input cannot escape our generated Markdown delimiters.
const plain = v => htmlEscape(text(v)).replace(/[\\`*_{}\[\]#!|~^$%=+\-]/g, '\\$&')
  .replace(/^(\s*\d+)([.)])/gm, '$1\\$2');
// Undo precisely the extractor's single layer of text entities before re-escaping.
const decoded = s => s.replace(/&(amp|lt|gt);/g, (_, key) => ({amp: '&', lt: '<', gt: '>'})[key]);

function urlOf(v) {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v) || /[\s\x00-\x1f\x7f\\]/u.test(v)) return null;
  try {
    const url = new URL(v);
    return url.hostname && !url.username && !url.password ? url : null;
  } catch { return null; }
}
const hex = c => '%' + c.charCodeAt(0).toString(16).toUpperCase();
// Encode segment-by-segment, including Markdown punctuation left raw by encodeURIComponent.
const relative = path => path.split('/').map(s => encodeURIComponent(s).replace(/[!'()*]/g, hex)).join('/');
const remote = url => url.origin + url.href.slice(url.origin.length).replace(/[()<>"'`\[\]\\]/g, hex)
  .replace(/&(?=(?:#\w+|[a-z]\w*);)/ig, '&amp;'); // keep IPv6 brackets in the authority
const link = (caption, url) => url ? `[${plain(caption)}](${remote(url)})` : plain(caption);

function truncate(s, bytes) {
  let used = 0, out = '';
  for (const ch of s) {
    used += encoder.encode(ch).length;
    if (used > bytes) break;
    out += ch;
  }
  return out;
}
function filename(s, budget = 148) {
  let name = line(s).normalize('NFC').replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '');
  name = truncate(name, budget).replace(/[. ]+$/, '') || '无标题';
  // Windows treats device basenames with any extension as reserved (even COM¹.txt).
  if (/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|(?:COM|LPT)[\d¹²³]) *(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function stemFor(kind, title, author) {
  if (kind === 'youtube') return `${filename(author, 56)} - ${filename(title, 100)}`;
  if (kind === 'selection') return `${filename(title)} - 摘录`;
  return filename(title);
}
function localDay(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getFullYear() < 1 || date.getFullYear() > 9999)
    throw new TypeError('剪藏日期无效');
  return [String(date.getFullYear()).padStart(4, '0'), ...[date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0'))].join('-');
}

// Read-only estimate: use the writer's filename rules without creating folders or files.
export function estimatedRelativePath(clip, date) {
  return `${localDay(date)}/${stemFor(clip.kind, line(clip.title) || '无标题', line(clip.author) || '未知频道')}.md`;
}

async function occupied(dir, name) {
  try { await dir.getFileHandle(name); return true; }
  catch (error) {
    if (error.name === 'TypeMismatchError') return true; // A directory with this name counts too.
    if (error.name === 'NotFoundError') return false;
    throw error; // A permission/IO error must never mean “safe to overwrite”.
  }
}
async function unused(dir, base, suffix = '') {
  for (let n = 1; n <= 100000; n++) {
    const name = (n === 1 ? base : `${base} (${n})`) + suffix;
    if (!await occupied(dir, name)) return name;
  }
  throw new Error('重名文件过多，无法分配新名称');
}
async function writeFile(handle, data) {
  const stream = await handle.createWritable({mode: 'exclusive'});
  try {
    // getFileHandle({create:true}) has no exclusive-create option. Protect a
    // nonempty file even if an external writer wins the small check/create race.
    if ((await handle.getFile()).size) throw new Error('目标文件已存在，未覆盖');
    await stream.write(data); await stream.close();
  }
  catch (error) { try { await stream.abort(); } catch {} throw error; }
}

async function raster({blob, ext} = {}) {
  if (!(blob instanceof Blob) || typeof ext !== 'string' || !/^\.?(?:png|jpe?g|webp|gif|avif)$/i.test(ext)) throw new Error('非受支持的图片');
  const b = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const ascii = (start, size) => String.fromCharCode(...b.subarray(start, start + size));
  let format;
  if ([137,80,78,71,13,10,26,10].every((v, i) => b[i] === v)) format = 'png';
  else if (b[0] === 255 && b[1] === 216 && b[2] === 255) format = 'jpg';
  else if (/^GIF8[79]a$/.test(ascii(0, 6))) format = 'gif';
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') format = 'webp';
  else if (ascii(4, 4) === 'ftyp') {
    for (let i = 8; i + 4 <= b.length; i += 4) if (i !== 12 && /^(?:avif|avis)$/.test(ascii(i, 4))) { format = 'avif'; break; }
  }
  if (format !== ext.toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg')) throw new Error('图片格式不符');
  return {blob, ext: format};
}

// Recognize the extractor's small Markdown vocabulary. Only code we generate can
// emit a link destination or image. Escaped text, raw HTML, references, autolinks
// and wiki/transclusion syntax never bypass this boundary.
function inline(s, images) {
  const atoms = /\\[!-\/:-@\[-`{-~]|PAGELEAFIMG[a-f\d]{32}X\d+END|\[((?:\\.|[^\[\]\\\n])*)\]\((https?:\/\/[^\s<>()\\]+)\)|`+/g;
  // Dynamic backtick spans can contain shorter runs. Index closing runs once
  // instead of repeatedly searching the rest of the line for an equal-length run.
  const next = new Map(), last = new Map();
  for (const run of s.matchAll(/`+/g)) {
    if (last.has(run[0].length)) next.set(last.get(run[0].length), run.index);
    last.set(run[0].length, run.index);
  }
  const literal = str => plain(decoded(str.replace(/PAGELEAFIM&#71;/g, 'PAGELEAFIMG'))).replace(/\\\*/g, '*'); // retain extractor's emphasis
  let result = '', start = 0, match;
  while ((match = atoms.exec(s))) {
    result += literal(s.slice(start, match.index));
    const [atom, label, href] = match;
    if (atom[0] === '\\') result += plain(atom.slice(1));
    else if (atom[0] === '`' && next.has(match.index)) {
      const end = next.get(match.index) + atom.length;
      const span = s.slice(match.index, end);
      result += /^`+\s*\$?=/.test(span) ? plain(span) : span;
      atoms.lastIndex = end;
    } else if (href) {
      const hasImage = [...label.matchAll(/PAGELEAFIMG[a-f\d]{32}X\d+END/g)].some(m => images.has(m[0]));
      const target = urlOf(decoded(href)), caption = inline(label, images);
      result += hasImage || !target ? caption : `[${caption}](${remote(target)})`;
    } else result += images.get(atom) ?? plain(atom);
    start = atoms.lastIndex;
  }
  return result + literal(s.slice(start));
}
function bodyMarkdown(source, images) {
  const lines = text(source).split('\n'), out = [];
  let fence = null, code = [];
  function emitCode() {
    // Fixed-format, no source-provided info string (e.g. a Markdown plugin's language).
    let size = 3;
    for (const row of code) for (const m of row.matchAll(/`+/g)) size = Math.max(size, m[0].length + 1);
    const delim = '`'.repeat(size);
    out.push(delim, code.join('\n'), delim); fence = null; code = [];
  }
  for (const row of lines) {
    const delim = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(row);
    if (fence) {
      if (delim && delim[1][0] === fence[0] && delim[1].length >= fence.length && !delim[2].trim()) emitCode();
      else code.push(row);
      continue;
    }
    // An inline span may begin a line with 3+ backticks. A backtick in
    // the putative info string disqualifies it as a CommonMark opening fence.
    if (delim && (delim[1][0] !== '`' || !delim[2].includes('`'))) { fence = delim[1]; continue; }
    // Prefixes are reconstructed from a fixed grammar rather than trusting a line.
    const match = /^((?: {0,3}>[ \t]?)*)( *)(#{1,6}[ \t]+|[-+*][ \t]+|\d{1,9}[.)][ \t]+)?(.*)$/.exec(row);
    const [, quotes, indent, prefix = '', rest] = match;
    out.push(quotes + indent + prefix + (rest === '---' && !prefix ? '---' : inline(rest, images)));
  }
  if (fence) emitCode();
  return out.join('\n').trim();
}

function timestamp(seconds) {
  const m = Math.floor(seconds / 60), s = String(seconds % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}
function renderNote(clip, {title, author, day, images, cover}) {
  const video = clip.kind === 'youtube', source = urlOf(clip.url);
  const rows = [`# ${plain(title)}`, '', `- 类型：${KINDS.get(clip.kind)}`, `- 剪藏日期：${day}`,
    `- ${video ? '频道' : '作者'}：${link(author, urlOf(clip.authorUrl))}`,
    `- 来源：${source ? link(source.href, source) : '未提供有效链接'}`];
  const section = (name, content) => rows.push('', '## ' + name, '', content);
  if (cover) rows.push('', cover);
  const cues = video && Array.isArray(clip.cues) ? clip.cues.filter(c => c && typeof c.start === 'number' && c.start >= 0 && Number.isSafeInteger(Math.floor(c.start)) && line(c.text)) : [];
  if (clip.kind !== 'selection') {
    let summary;
    if (video && !cues.length) summary = '未取得字幕，未生成内容摘要。';
    else if (text(clip.summary).trim()) summary = plain(clip.summary).trim();
    else if (line(clip.summaryError)) summary = `摘要生成失败：${plain(line(clip.summaryError))}`;
    else summary = '未生成内容摘要。';
    section('内容摘要', summary);
  }
  if (video) {
    if (text(clip.description).trim()) section('视频简介', plain(clip.description).trim());
    const kind = clip.captionKind === 'manual' ? '人工字幕' : clip.captionKind === 'auto' ? '自动字幕' : line(clip.captionKind);
    const details = [line(clip.language), kind]
      .filter(v => typeof v === 'string' && v).map(plain).join(' · ');
    const videoURL = typeof clip.videoId === 'string' && /^[\w-]{11}$/.test(clip.videoId)
      ? new URL(`https://www.youtube.com/watch?v=${clip.videoId}`) : source;
    const transcript = cues.map(cue => {
      const sec = Math.floor(cue.start), at = videoURL && new URL(videoURL.href);
      if (at) at.searchParams.set('t', `${sec}s`);
      return `- ${link(timestamp(sec), at)} ${plain(line(cue.text))}`;
    }).join('\n');
    section('字幕全文', [details, transcript || '未获取到可用字幕。'].filter(Boolean).join('\n\n'));
  } else {
    section(clip.kind === 'selection' ? '摘录' : '正文', bodyMarkdown(clip.body, images));
  }
  return rows.join('\n') + '\n';
}

// Keep the on-disk names identical to their Markdown destinations, even for
// readers that treat % escapes literally. A hash is a short label, not proof
// of uniqueness: an orphaned, colliding or user-created entry must be skipped.
async function unusedMediaFolder(parent, stem) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(stem)), 0, 8);
  const base = 'm-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  for (let n = 1; n <= 100000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!await occupied(parent, name)) return name;
  }
  throw new Error('重名图片目录过多');
}

async function imagesFor(clip, dateDir, stem, getImage, report, warnings) {
  const images = new Map();
  let folder, folderName, cover = '', seq = 0;
  const source = text(clip.body);
  const tokens = new Set(source.match(/PAGELEAFIMG[a-f\d]{32}X\d+END/g) || []);
  const items = clip.kind === 'youtube' ? (clip.cover ? [{url: clip.cover, alt: '视频封面'}] : []) : (Array.isArray(clip.images) ? clip.images : []);
  for (const item of items) {
    if (clip.kind !== 'youtube' && (!item || !TOKEN.test(item.token) || !tokens.has(item.token) || images.has(item.token))) continue;
    const alt = line(item.alt) || (clip.kind === 'youtube' ? '视频封面' : '图片');
    const url = urlOf(item.url);
    const dataImage = typeof item.url === 'string' && item.url.length <= 17 * 1024 * 1024 &&
      /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z\d+/]+={0,2}$/i.test(item.url);
    seq++;
    // Plain links never trigger a reader-side image load. Do not even invoke a
    // downloader for HTTP (including same-origin and loopback); this is intentional.
    if (url?.protocol === 'http:') {
      const reference = `${link(alt, url)}（HTTP 原图链接，未下载）`;
      if (clip.kind === 'youtube') cover = reference; else images.set(item.token, reference);
      continue;
    }
    report(`正在保存第 ${seq} 张图片…`);
    let markdown;
    try {
      if ((!url && !dataImage) || !getImage) throw new Error('图片不可访问');
      const {blob, ext} = await raster(await getImage(url?.href ?? item.url));
      if (!folder) {
        const parent = await dateDir.getDirectoryHandle('assets', {create: true});
        folderName = await unusedMediaFolder(parent, stem);
        folder = await parent.getDirectoryHandle(folderName, {create: true});
      }
      const name = `${clip.kind === 'youtube' ? 'cover' : String(seq).padStart(2, '0')}.${ext}`;
      if (await occupied(folder, name)) throw new Error('目标图片已存在，未覆盖');
      const handle = await folder.getFileHandle(name, {create: true});
      await writeFile(handle, blob);
      markdown = `![${plain(alt)}](assets/${folderName}/${name})`;
    } catch {
      markdown = `${link(alt, url)}（未保存到本地）`;
      warnings.push(`第 ${seq} 张图片未保存到本地${url ? '，已保留原图链接' : '，已保留图片说明'}。`);
    }
    if (clip.kind === 'youtube') cover = markdown;
    else images.set(item.token, markdown);
  }
  return {images, cover};
}

// This is an insert-only edit, not a re-render of the user's index. Preserve
// leading BOM, CRLF, custom paragraphs and user edits even inside our region.
function insertEntry(old, day, path, entry) {
  const dest = relative(path);
  if ([dest, path].some(h => old.includes(`](${h})`) || old.includes(`](<${h}>)`))) return old;
  const nl = old.includes('\r\n') ? '\r\n' : '\n';
  const starts = [...old.matchAll(/^<!-- pageleaf:index:v1 -->\r?$/gm)];
  const ends = [...old.matchAll(/^<!-- \/pageleaf:index:v1 -->\r?$/gm)];
  if (!starts.length && !ends.length) {
    const prefix = old ? old + (old.endsWith('\n') ? nl : nl + nl) : `# 剪藏索引${nl}${nl}`;
    return `${prefix}${BEGIN}${nl}${nl}## ${day}${nl}${nl}${entry}${nl}${nl}${END}${nl}`;
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) throw new Error('索引标记不完整');
  const from = starts[0].index, end = ends[0].index;
  for (const heading of old.slice(from, end).matchAll(/^## (\d{4}-\d\d-\d\d)[ \t]*\r?\n/gm)) {
    if (heading[1] === day) {
      const i = from + heading.index + heading[0].length;
      return old.slice(0, i) + nl + entry + nl + old.slice(i);
    }
    if (heading[1] < day) {
      const i = from + heading.index;
      return old.slice(0, i) + `## ${day}${nl}${nl}${entry}${nl}${nl}` + old.slice(i);
    }
  }
  return old.slice(0, end) + `## ${day}${nl}${nl}${entry}${nl}${nl}` + old.slice(end);
}
async function addToIndex(root, day, path, title, author, kind) {
  const handle = await root.getFileHandle(INDEX, {create: true});
  const existing = await handle.getFile();
  if (existing.size > 32 * 1024 * 1024) throw new Error('索引过大');
  const old = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await existing.arrayBuffer());
  if (old.includes('\u0000')) throw new Error('索引不是 UTF-8 Markdown 文本');
  const entry = `- [${plain(title)}](${relative(path)}) · ${plain(author)} · ${KINDS.get(kind)}`;
  const result = insertEntry(old, day, path, entry);
  if (result === old) return;
  const stream = await handle.createWritable({mode: 'exclusive'});
  try {
    const current = await handle.getFile();
    if (current.size !== existing.size || current.lastModified !== existing.lastModified) throw new Error('索引正被修改');
    await stream.write(result);
    await stream.close();
  } catch (error) { try { await stream.abort(); } catch {} throw error; }
}

/** Save a clip; only a note-write failure rejects. Image/index failures are warnings. */
export async function saveClip(root, clip, {date = new Date(), getImage, onProgress} = {}) {
  if (!KINDS.has(clip?.kind)) throw new TypeError('未知的剪藏类型');
  const day = localDay(date), title = line(clip.title) || '无标题', author = line(clip.author) || (clip.kind === 'youtube' ? '未知频道' : '未知作者');
  const report = message => { try { onProgress?.(message); } catch {} };
  return locked(async () => {
    const warnings = [];
    const dateDir = await root.getDirectoryHandle(day, {create: true});
    const base = stemFor(clip.kind, title, author);
    let name = await unused(dateDir, base, '.md');
    const media = await imagesFor(clip, dateDir, name.slice(0, -3), getImage, report, warnings);
    report('正在写入笔记…');
    // An external program might have created the note during the downloads.
    if (await occupied(dateDir, name)) name = await unused(dateDir, base, '.md');
    const note = renderNote(clip, {title, author, day, ...media});
    const handle = await dateDir.getFileHandle(name, {create: true});
    await writeFile(handle, note);
    const path = day + '/' + name;
    report('正在更新剪藏索引…');
    try {
      await addToIndex(root, day, path, title, author, clip.kind);
      return {path, indexed: true, warnings};
    } catch {
      warnings.push('笔记已保存，但剪藏索引未更新。请检查索引文件是否为可写的 UTF-8 文本，以及自动索引标记是否完整。');
      return {path, indexed: false, warnings};
    }
  });
}
