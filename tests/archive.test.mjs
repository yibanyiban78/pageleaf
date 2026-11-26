import assert from 'node:assert/strict';
import test from 'node:test';
import { saveClip } from '../extension/archive.js';
import { clipKey, lookupClip } from '../extension/dedup.js';

const DAY = '2026-02-03';
const DATE = new Date(2026, 1, 3, 0, 1);
const INDEX = '剪藏索引.md';
const tkn = n => `PAGELEAFIMG${'ab'.repeat(16)}X${n}END`;
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGo8AAAAASUVORK5CYII=', 'base64'));
const picture = async () => ({blob: new Blob([PNG], {type: 'image/png'}), ext: 'png'});
const clip = (props = {}) => ({kind: 'article', title: '山海之间', url: props.kind === 'youtube' ? 'https://youtu.be/abcdefgh123' : 'https://example.org/p/1', author: '阿岚', body: '正文原文。', images: [], ...props});
const save = (root, props = {}, options = {}) => saveClip(root, clip(props), {date: DATE, ...options});

// Case-insensitive, type-aware FS with commit-on-close and controllable I/O
// failures. No tests access the user's filesystem, network or local timezone settings.
class Dir {
  constructor(path = '', state = {rev: 0, events: []}) { this.kind = 'directory'; this.path = path; this.state = state; this.items = new Map(); }
  async removeEntry(name) { this.items.delete(name.toLowerCase()); }
  async getDirectoryHandle(name, options) { return this.get('directory', name, options); }
  async getFileHandle(name, options) { return this.get('file', name, options); }
  get(kind, name, {create = false} = {}) {
    assert.ok(name && !/[\\/]/.test(name) && name !== '.' && name !== '..', `invalid path segment: ${name}`);
    const key = name.toLowerCase(), path = this.path ? `${this.path}/${name}` : name;
    this.state.fail?.('lookup', path);
    let node = this.items.get(key);
    if (!node && !create) throw new DOMException('Missing', 'NotFoundError');
    if (!node) {
      node = kind === 'directory' ? new Dir(path, this.state) : new MemFile(path, this.state);
      this.items.set(key, node);
    }
    if (node.kind !== kind) throw new DOMException('Wrong kind', 'TypeMismatchError');
    return node;
  }
  at(path) { return path.split('/').reduce((node, n) => node?.items?.get(n.toLowerCase()), this); }
  async text(path) { return (await this.at(path).getFile()).text(); }
}
class MemFile {
  constructor(path, state) { this.kind = 'file'; this.path = path; this.state = state; this.data = new Blob(); this.rev = 0; }
  async isSameEntry(other) { return this === other; }
  async getFile() { return new File([this.data], this.path, {lastModified: this.rev}); }
  async createWritable() {
    let data;
    return {
      write: async input => { this.state.fail?.('write', this.path); data = new Blob([input]); },
      close: async () => {
        this.state.fail?.('close', this.path); this.data = data; this.rev = ++this.state.rev;
        this.state.events.push(this.path);
      },
      abort: async () => {},
    };
  }
}
async function seed(dir, name, data) {
  const file = await dir.getFileHandle(name, {create: true});
  const w = await file.createWritable(); await w.write(data); await w.close(); return file;
}
// Read the destination literally, as a filesystem-based Markdown reader might.
const localImages = note => [...note.matchAll(/!\[(?:\\.|[^\]\\\n])*\]\((assets\/[^)\n]+)\)/g)].map(m => m[1]);
const mediaPath = /^assets\/[A-Za-z0-9_-]{1,25}\/(?:cover|\d+)\.(?:jpg|png|gif|webp|avif)$/;

test('article: preserves the extractor vocabulary, text entities, image positions, captions and summary', async () => {
  const root = new Dir();
  const result = await save(root, {
    title: '散步 (一)', authorUrl: 'https://example.org/author',
    body: `## 天色\n\n**我** &amp; *你*：1 &lt; 2 &amp; 3 &gt; 2；\\[方括号\\]。\n\n[资料 &amp; 地图](https://example.org/r?a=1&amp;b=2)\n\n- 第一点\n  - 子项\n\n> 引文\n\n` +
      `拍摄前。\n\n${tkn(0)}\n\n*图注：大海。*\n\n拍摄后。\n\n行内：\`\` a \` b \`\`。\n\n\`\`\`\`js\nconst n = '\`\`\`';\n\`\`\`\``,
    images: [{token: tkn(0), url: 'https://img.example/a.png', alt: '海面'}], summary: '先看地图，再看海。',
  }, {getImage: picture});
  assert.deepEqual(result, {path: `${DAY}/散步 (一).md`, indexed: true, warnings: []});
  const note = await root.text(result.path);
  assert.match(note, /\*\*我\*\* &amp; \*你\*：1 &lt; 2 &amp; 3 &gt; 2；\\\[方括号\\\]/);
  assert.match(note, /\[资料 &amp; 地图\]\(https:\/\/example\.org\/r\?a=1&b=2\)/);
  assert.match(note, /- 第一点\n  - 子项\n\n> 引文/);
  assert.match(note, /`` a ` b ``/); assert.match(note, /````\nconst n = '```';\n````/);
  assert.match(note, /## 内容摘要\n\n先看地图，再看海/);
  assert.match(note, /拍摄前。\n\n!\[海面\]\(assets\/[^)]+\/01\.png\)\n\n\*图注：大海。\*\n\n拍摄后。/);
  const [relative] = localImages(note);
  assert.match(relative, mediaPath); assert.ok(relative.endsWith('/01.png'));
  assert.deepEqual(new Uint8Array(await (await root.at(`${DAY}/${relative}`).getFile()).arrayBuffer()), PNG);
  const index = await root.text(INDEX); assert.match(index, /散步 \(一\)/); assert.match(index, /阿岚 · 文章/);
  assert.ok(index.includes('%28%E4%B8%80%29.md'));
  assert.deepEqual(root.state.events.slice(-2), [result.path, INDEX]);
});

test('body formatting edge cases: line-initial inline code, hyperlinks with emphasis, HR, literal sentinel', async () => {
  const root = new Dir();
  const body = '``` a `` b ```\n\n[**站点**](https://example.org/)\n\n---\n\nPAGELEAFIM&#71; 是原文，不是图片。';
  const r = await save(root, {body, url: 'http://[::1]/p?a=1&b=2'});
  const note = await root.text(r.path);
  assert.match(note, /``` a `` b ```\n\n\[\*\*站点\*\*\]\(https:\/\/example\.org\/\)\n\n---\n\nPAGELEAFIMG 是原文/);
  assert.ok(note.includes('](http://[::1]/p?a=1&b=2)'));
});

test('selection saves only referenced images inline, never adds a summary or fetches unattached images', async () => {
  const root = new Dir(), called = [];
  const r = await save(root, {kind: 'selection', summary: '禁止出现的摘要', summaryError: '不要显示', body: `- 前${tkn(1)}后`,
    images: [{token: tkn(0), url: 'https://img.example/unselected.png'}, {token: tkn(1), url: 'https://img.example/chosen.png', alt: '选区图'}, {token: tkn(1), url: 'https://img.example/duplicate.png'}],
  }, {getImage: async url => { called.push(url); return picture(); }});
  assert.equal(r.path, `${DAY}/山海之间 - 摘录.md`);
  assert.deepEqual(called, ['https://img.example/chosen.png']);
  const note = await root.text(r.path); assert.doesNotMatch(note, /摘要|不要显示/);
  assert.match(note, /- 前!\[选区图\]\(assets\/.+?\.png\)后/);
  assert.match(await root.text(INDEX), /阿岚 · 摘录/);
});

test('video: cover only, clickable full timestamp transcript, summary above long description', async () => {
  const root = new Dir(), called = [];
  const r = await save(root, {kind: 'youtube', videoId: 'abcdefgh123', title: '小岛', author: '海边', authorUrl: 'https://www.youtube.com/@sea',
    url: 'https://www.youtube.com/watch?v=abcdefgh123', cover: 'https://i.ytimg.com/vi/abcdefgh123/hqdefault.jpg',
    description: '这一期……', summary: '岛上有三处灯塔。', language: 'zh-CN', captionKind: 'manual',
    cues: [{start: 3.9, text: '第一句。'}, {start: 3661.75, text: '最后一句。'}, {start: -1, text: '跳过'}],
    body: tkn(0), images: [{token: tkn(0), url: 'https://example.org/thumbnail'}]}, {getImage: async url => { called.push(url); return picture(); }});
  assert.equal(r.path, `${DAY}/海边 - 小岛.md`);
  assert.deepEqual(called, ['https://i.ytimg.com/vi/abcdefgh123/hqdefault.jpg']);
  const note = await root.text(r.path);
  assert.match(note, /!\[视频封面\]\(assets\/[^)]+\/cover\.png\)/);
  assert.match(note, /频道：\[海边\]\(https:\/\/www\.youtube\.com\/@sea\)/);
  assert.ok(note.indexOf('## 内容摘要') < note.indexOf('## 视频简介'));
  assert.match(note, /人工字幕/);
  assert.match(note, /\[00:03\]\(https:\/\/www\.youtube\.com\/watch\?v=abcdefgh123&t=3s\) 第一句/);
  assert.match(note, /\[1:01:01\]\(https:\/\/www\.youtube\.com\/watch\?v=abcdefgh123&t=3661s\) 最后一句/);
  assert.doesNotMatch(note, /跳过/);
});

test('video without captions suppresses even a supplied summary; article summary failure keeps full body', async () => {
  const root = new Dir();
  const v = await save(root, {kind: 'youtube', summary: '不应凭简介生成的内容', description: '只有简介'});
  const note = await root.text(v.path); assert.match(note, /未取得字幕，未生成内容摘要/); assert.doesNotMatch(note, /不应凭简介/);
  assert.match(note, /只有简介/);
  const a = await save(root, {summaryError: '未配置服务', body: '第一段。\n\n最终段。'});
  assert.match(await root.text(a.path), /摘要生成失败：未配置服务[\s\S]+第一段。\n\n最终段。/);
  assert.equal(root.at(`${DAY}/assets`), undefined);
});

test('image fallbacks are safe links only; rejects unsafe URLs, downloads and extensions without creating assets', async () => {
  const root = new Dir(), called = [];
  const list = ['https://images.test/a(1).jpg', 'javascript:alert(1)', 'file:///private', 'https://images.test/format', 'https://images.test/html', 'https://images.test/mismatch', 'data:image/svg+xml;base64,AAAA'];
  const r = await save(root, {body: list.map((_, i) => tkn(i)).join('\n\n'), images: list.map((url, i) => ({url, token: tkn(i), alt: '图' + i}))}, {
    getImage: async url => {
      called.push(url);
      if (url.includes('format')) return {...await picture(), ext: 'png/../../bad.js'};
      if (url.includes('html')) return {blob: new Blob(['<svg onload="x"></svg>']), ext: 'png'};
      if (url.includes('mismatch')) return {...await picture(), ext: 'jpg'};
      throw new Error('断网');
    },
  });
  assert.equal(r.warnings.length, list.length); assert.equal(called.length, 4); assert.equal(r.indexed, true);
  const note = await root.text(r.path); assert.doesNotMatch(note, /!\[|javascript:|file:\/\/|data:image|<svg|\.js\b/);
  assert.match(note, /\[图0\]\(https:\/\/images.test\/a%281%29.jpg\)（未保存到本地）/);
  assert.match(note, /图1（未保存到本地）/); assert.equal(root.at(`${DAY}/assets`), undefined);
});

test('HTTP media in an article, selection or cover is a plain link, even on the same HTTP origin', async () => {
  const url = 'http://x.example/figure.png?asset=sample&n=2';
  for (const kind of ['article', 'selection', 'youtube']) {
    const root=new Dir(), called=[];
    const r=await save(root,{kind,url:kind === 'youtube' ? 'https://youtu.be/abcdefgh123' : 'http://x.example/page',body:tkn(0),images:[{token:tkn(0),url,alt:'图'}],cover:url},{getImage:async u=>{called.push(u);return picture();}});
    const note=await root.text(r.path);
    assert.deepEqual(called,[]);assert(r.indexed);assert.deepEqual(r.warnings,[]);
    assert(note.includes(`](${url})（HTTP 原图链接，未下载）`));assert(!note.includes('!['));assert(!root.at(`${DAY}/assets`));
  }
});

test('inline raster data becomes a local image; size-limited and never echoed on failure', async () => {
  const root = new Dir(), called = [];
  const data = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
  const oversized = 'data:image/png;base64,' + 'A'.repeat(17 * 1024 * 1024);
  const r = await save(root, {body: `${tkn(0)}\n\n${tkn(1)}\n\n${tkn(2)}`, images: [data, data, oversized].map((url, i) => ({url, token: tkn(i), alt: `图${i}`}))}, {
    getImage: async url => { called.push(url); if (called.length > 1) throw new Error(url); return picture(); },
  });
  assert.deepEqual(called, [data, data]); const note = await root.text(r.path);
  assert.match(note, /!\[图0\]\(assets\//); assert.match(note, /图1（未保存到本地）/); assert.match(note, /图2（未保存到本地）/);
  assert.doesNotMatch(note + r.warnings.join(''), /data:image|iVBORw/);
});

test('untrusted text cannot insert raw HTML, remote embeds, active URLs or index records', async () => {
  const root = new Dir();
  const r = await save(root, {title: 'T]\n## 1900-01-01\n<img src=x>', author: '![evil](https://tracking.test/p)', authorUrl: 'javascript:me()',
    body: '# 测试\n\n<img src=x>\n\n![外图](https://tracking.test/x.png)\n\n![[图]]\n\n[x](javascript:foo)\n\n![][x]\n\n[x]: https://tracking.test/ref.png',
    summary: '![模型图](https://tracking.test/im.png)\n\n<script>不可执行</script>\n\n# 伪标题\n\n[[转入]]',
  });
  const note = await root.text(r.path), idx = await root.text(INDEX);
  assert.doesNotMatch(note + idx, /<img|<script|(?:^|[^\\])!\[|(?<!\\)\]\(javascript:|^# 伪标题|^## 1900/gm);
  assert.match(note, /&lt;img src[\\]?=x&gt;/); assert.match(note, /&lt;script&gt;/);
  assert.ok(!idx.includes('\n## 1900')); assert.equal(idx.match(/^- \[/gm).length, 1);
});

test('local dates, safe Windows filenames and conservative UTF-8 filename lengths', async () => {
  const root = new Dir();
  for (const title of ['con', 'CON.txt', 'NUL... ', 'Com¹.txt', 'lpt9', '../a:b /c\\|*?"<d>', ' . ', '花🌷'.repeat(180)]) {
    const r = await save(root, {title, url:'https://example.org/p/' + encodeURIComponent(title)});
    const [day, name] = r.path.split('/'); assert.equal(day, DAY); assert.equal(r.path.split('/').length, 2);
    assert.doesNotMatch(name, /^[. ]|[<>:"/\\|?*\x00-\x1f]| [.]md$|^(?:CON|NUL|COM[\d¹²³]|LPT\d)[.]/i);
    assert.ok(Buffer.byteLength(name) < 220); assert.equal(r.indexed, true);
  }
});

test('concurrent saves and stale orphaned asset folders never replace notes, directories or resources', async () => {
  const root = new Dir(), day = await root.getDirectoryHandle(DAY, {create: true});
  await seed(day, 'same.md', '不要覆盖');
  await day.getDirectoryHandle('same (2).md', {create: true});
  const assets = await day.getDirectoryHandle('assets', {create: true}), stale = await assets.getDirectoryHandle('same (3)', {create: true});
  await seed(stale, '01.png', '私人资源');
  const r = await Promise.all(Array.from({length: 6}, (_, i) => save(root, {title: 'Same', url:`https://example.org/p/${i}`, body: `任务${i}：${tkn(0)}`, images: [{token: tkn(0), url: 'https://images.test/p.png', alt: '图'}]}, {getImage: picture})));
  assert.equal(new Set(r.map(s => s.path)).size, 6); assert.ok(r.every(s => s.indexed && !s.warnings.length));
  assert.equal(await root.text(`${DAY}/same.md`), '不要覆盖'); assert.equal(await root.text(`${DAY}/assets/same (3)/01.png`), '私人资源');
  const index = await root.text(INDEX); assert.equal(index.match(/^- \[Same\]/gm).length, 6);
  const paths = [];
  for (const [i, result] of r.entries()) {
    const note = await root.text(result.path); assert.ok(note.includes(`任务${i}`));
    const [path] = localImages(note); assert.match(path, mediaPath); paths.push(path); assert.ok(root.at(DAY + '/' + path));
  }
  assert.equal(new Set(paths).size, 6);
});

test('long CJK/emoji titles and punctuation never enter a cover path, even after a media-name collision', async () => {
  const root = new Dir(), title = '[现场] 100% #话题 (精华) 🎬 '.repeat(20), author = '中文 频道 (甲) #1';
  const video = {kind: 'youtube', title, author, cover: 'https://img.example/cover.png'};
  const first = await save(root, video, {getImage: picture});
  assert.deepEqual(first.warnings, []); assert.ok(first.path.startsWith(`${DAY}/${author} - [现场]`));
  const [src] = localImages(await root.text(first.path)); assert.match(src, mediaPath);
  const oldFile = root.at(`${DAY}/${src}`), oldRev = oldFile.rev;
  const [, dir, name] = src.split('/'); assert.equal(name, 'cover.png');
  // User removed only the Markdown. Its old resource directory remains; even a
  // regular file at the first collision suffix must not be opened for writing.
  const day = root.at(DAY), assets = root.at(`${DAY}/assets`);
  day.items.delete(first.path.split('/')[1].toLowerCase());
  await seed(assets, `${dir}-2`, '原样保留');
  const second = await save(root, video, {getImage: picture});
  assert.deepEqual(second.warnings, []); assert.equal(second.path, first.path);
  const [next] = localImages(await root.text(second.path)); assert.match(next, mediaPath);
  assert.notEqual(next.split('/')[1], dir); assert.equal(oldFile.rev, oldRev);
  assert.equal(await root.text(`${DAY}/assets/${dir}-2`), '原样保留');
  assert.deepEqual(new Uint8Array(await (await root.at(`${DAY}/${next}`).getFile()).arrayBuffer()), PNG);
});

test('index dates sort newest first; preserves BOM, CRLF and custom bytes; identical note path is not reindexed', async () => {
  const root = new Dir(); const personal = '\uFEFF# 我的索引\r\n\r\n私人 [资料](notes.md)  \r\n';
  await seed(root, INDEX, personal);
  for (const [i,d] of [4, 1, 7, 5, 5].entries()) await save(root, {title: '图集', url:`https://example.org/p/${i}`}, {date: new Date(2026, 4, d)});
  const file = await root.at(INDEX).getFile();
  const index = new TextDecoder('utf-8', {ignoreBOM: true}).decode(await file.arrayBuffer());
  assert.ok(index.startsWith(personal)); assert.ok(!/(?:^|[^\r])\n/.test(index));
  assert.deepEqual([...index.matchAll(/^## (\S+)\r?$/gm)].map(m => m[1]), ['2026-05-07', '2026-05-05', '2026-05-04', '2026-05-01']);
  // Simulate a user deleting the note but keeping its index entry. A resave can reuse its path.
  root.at('2026-05-07').items.delete('图集.md');
  const r = await save(root, {title: '图集', url:'https://example.org/p/2'}, {date: new Date(2026, 4, 7)});
  assert.ok(r.indexed); assert.equal((await root.text(INDEX)).match(/^- \[/gm).length, 5);
  assert.deepEqual(new Uint8Array(await (await root.at(INDEX).getFile()).arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
});

test('index write failure retains the note; pre-existing malformed/non-UTF8 index blocks writing; original bytes are unchanged', async () => {
  for (const bytes of ['# 私人\r\n<!-- pageleaf:index:v1 -->\r\n', new Uint8Array([0xff, 0xfe, 0x49, 0x00]), '# 锁定的索引']) {
    const root = new Dir(), handle = await seed(root, INDEX, bytes), before = await (await handle.getFile()).arrayBuffer();
    if (bytes === '# 锁定的索引') root.state.fail = (operation, path) => { if (operation === 'close' && path === INDEX) throw new Error('不可写'); };
    if (bytes === '# 锁定的索引') {
      const r = await save(root); assert.equal(r.indexed, false); assert.match(r.warnings.join(''), /笔记已保存/);
      assert.match(await root.text(r.path), /正文原文/);
    } else {
      await assert.rejects(save(root), /无法核实/); assert.equal(root.at(DAY), undefined); assert.equal(root.at('.pageleaf'), undefined);
    }
    assert.deepEqual(await (await handle.getFile()).arrayBuffer(), before);
  }
});

test('same-realm queue still serializes saves when Web Locks are unavailable', async () => {
  const root = new Dir(), nav = globalThis.navigator, descriptor = nav && Object.getOwnPropertyDescriptor(nav, 'locks');
  if (nav) Object.defineProperty(nav, 'locks', {value: undefined, configurable: true});
  try {
    const writes = await Promise.all(Array.from({length: 5}, () => save(root)));
    assert.equal(new Set(writes.map(r => r.path)).size, 1);
    assert.equal(writes.filter(r => r.duplicate).length, 4);
    assert.equal((await root.text(INDEX)).match(/^- \[/gm).length, 1);
  } finally {
    if (nav && descriptor) Object.defineProperty(nav, 'locks', descriptor);
    else if (nav) delete nav.locks;
  }
});

test('note or directory permission failure rejects and never changes the index; a later save still works', async () => {
  const root = new Dir(); await seed(root, INDEX, '已有索引');
  root.state.fail = (operation, path) => { if (operation === 'close' && path.endsWith('/山海之间.md')) throw new Error('磁盘已满'); };
  await assert.rejects(save(root), /磁盘已满/); assert.equal(await root.text(INDEX), '已有索引');
  root.state.fail = (operation, path) => { if (operation === 'lookup' && path.endsWith('/樱花.md')) throw new DOMException('无权限', 'NotAllowedError'); };
  await assert.rejects(save(root, {title: '樱花'}), /无权限/); assert.equal(await root.text(INDEX), '已有索引');
  delete root.state.fail;
  const r = await save(root, {title: '重试'}); assert.ok(r.indexed); assert.ok((await root.text(INDEX)).startsWith('已有索引'));
});

test('duplicate archive protection runs before asset work; immutable preview works across date/title changes and separate roots', async () => {
  const root = new Dir(), other = new Dir(), c = clip({title:'笔记 # [甲]', body:tkn(0), images:[{token:tkn(0),url:'https://images.example/private'}]});
  assert.deepEqual(await lookupClip(root, c), {state:'new'}); assert.equal(root.items.size,0);
  let downloads=0;
  const saves = await Promise.all(Array.from({length:4},()=>saveClip(root,c,{date:DATE,getImage:()=>{downloads++;return picture();}})));
  assert.equal(saves.filter(x=>!x.duplicate).length,1); assert.equal(downloads,1);
  const prior=saves[0], before=root.state.rev;
  const renamed = {...c,title:'另一个标题',url:c.url+'?utm_source=feed#anchor',body:'改过版的正文'};
  assert.equal((await lookupClip(root, renamed)).state,'saved');
  assert.deepEqual(await saveClip(root,renamed,{date:new Date(2029,2,2)}),{path:prior.path,warnings:[],indexed:true,duplicate:true});
  assert.equal(root.state.rev,before); assert.deepEqual(await lookupClip(other, renamed),{state:'new'}); assert.equal(other.items.size,0);
  const selection = {...renamed,kind:'selection'};
  assert.equal((await lookupClip(root,selection)).state,'new'); await saveClip(root,selection,{date:DATE});
  assert.equal((await lookupClip(root,selection)).state,'saved');
  assert.equal((await lookupClip(root,{...selection,body:'另一个摘录'})).state,'new');
});

test('red result remains identifiable without an index across a fresh read; metadata and status contain no raw warning, URL or snippet',async()=>{
  const root=new Dir(), c=clip({body:'PRIVATE selection or article body',url:'https://private.example/p?token=TOKEN_DO_NOT_ECHO'});
  root.state.fail=(op,path)=>{if(op==='close' && path===INDEX) throw Error('mock');};
  const r=await saveClip(root,c,{date:DATE,warningsBeforeSave:['摘要生成失败：PRIVATE_SERVICE_SECRET','字幕补取失败']});
  assert(!r.indexed); delete root.state.fail;
  const key=await clipKey(c), receipt=await root.text(`.pageleaf/${key}.json`);
  assert.deepEqual(JSON.parse(receipt),{format:'pageleaf/receipt/1',key,path:r.path});
  const state=await lookupClip(root,c); assert.equal(state.state,'partial'); assert.equal(state.path,r.path); assert(!state.indexed);
  assert.match(state.message,/摘要/); assert.match(state.message,/字幕/); assert.match(state.message,/索引/);
  assert.doesNotMatch(state.message+receipt,/PRIVATE|TOKEN_DO_NOT|private\.example/);
  const before=root.state.rev, duplicate=await saveClip(root,c); assert(duplicate.duplicate);assert(!duplicate.indexed);assert.equal(root.state.rev,before);
  root.state.fail=(op,p)=>{if(op==='lookup' && p===INDEX) throw Error('PRIVATE_DIR');};
  assert.equal((await lookupClip(root,c)).state,'partial');
  await assert.rejects(lookupClip(root,{...c,url:'https://new.example/'}),e=>/无法核实/.test(e.message)&&!e.message.includes('PRIVATE_DIR'));
});

test('receipt alone is not proof: verify actual note/marker; deleted note permits resave and orphaned pointer never means saved',async()=>{
  const root=new Dir(), c=clip(), r=await saveClip(root,c,{date:DATE});
  assert.equal((await lookupClip(root,c)).state,'saved');
  const dir=root.at(DAY),name=r.path.split('/')[1];dir.items.delete(name.toLowerCase());
  assert.equal((await lookupClip(root,c)).state,'new');
  const again=await saveClip(root,c,{date:DATE}); assert(!again.duplicate);assert.equal(again.path,r.path);
  const previous=await root.text(r.path);
  await seed(dir,name,previous.replace(/pageleaf:clip:v1 [a-f0-9]{64}/,'pageleaf:clip:v1 '+'0'.repeat(64)));
  await assert.rejects(lookupClip(root,c),/无法核实/);
  await seed(dir,name,'不是这篇笔记'); await assert.rejects(lookupClip(root,c),/无法核实/);
});

test('failure to create a receipt never commits a note, preserves unrelated metadata and permits retry after a failed first write',async()=>{
  const root=new Dir(), c=clip(), key=await clipKey(c), name=key+'.json';
  root.state.fail=(op,path)=>{if(op==='close' && path==='.pageleaf/'+name) throw Error('PRIVATE_DEVICE_PATH');};
  await assert.rejects(save(root),e=>/未写入笔记/.test(e.message)&&!e.message.includes('PRIVATE_DEVICE_PATH'));
  assert(!root.at(DAY+'/山海之间.md')); assert(!root.at(INDEX)); assert(!root.at('.pageleaf/'+name));
  delete root.state.fail; assert.equal((await lookupClip(root,c)).state,'new'); assert((await save(root)).indexed);
  const other=new Dir(), dir=await other.getDirectoryHandle('.pageleaf',{create:true});
  await seed(dir,name,'私人数据'); await assert.rejects(save(other),/无法核实/); assert.equal(await other.text('.pageleaf/'+name),'私人数据');
});

test('indexed note marker recovers an exact image-only selection if the local locator was removed',async()=>{
  const root=new Dir(), first=clip({kind:'selection',body:tkn(0),images:[{token:tkn(0),url:'https://a.example/原图.png',alt:'同名图'}]});
  const r=await saveClip(root,first,{date:DATE,getImage:picture}); root.items.delete('.pageleaf');
  const token=`PAGELEAFIMG${'11'.repeat(16)}X3END`, second={...first,body:token,images:[{...first.images[0],token}]};
  assert.equal((await lookupClip(root,second)).path,r.path); assert(!root.at('.pageleaf'));
  assert.equal((await lookupClip(root,{...second,images:[{...second.images[0],url:'https://b.example/原图.png'}]})).state,'new');
});
