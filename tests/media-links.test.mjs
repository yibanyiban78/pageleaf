import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

// Save through native browser file handles in an empty OPFS, copy the committed
// tree (without consulting the MD) to a disposable disk folder, then move it.
// The reader below uses ordinary file: permissions, not the extension origin.
test('literal Markdown cover and article image destinations decode offline after moving a Unicode vault', async t => {
  const executablePath = [process.env.PAGELEAF_CHROMIUM, process.env.CHROME_PATH, chromium.executablePath(),
    `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`,
    `${process.env['ProgramFiles(x86)']}/Microsoft/Edge/Application/msedge.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].find(path => path && existsSync(path));
  const browser = await chromium.launch({executablePath, headless: true});
  t.after(() => browser.close());
  const source = await browser.newContext({offline: true, serviceWorkers: 'block'});
  const origin = 'https://fixture.invalid';
  await source.route('**/*', r => {
    if (r.request().url() === `${origin}/`) return r.fulfill({contentType: 'text/html', body: '<!doctype html><title>Test</title>'});
    if (r.request().url() === `${origin}/archive.js`) return r.fulfill({contentType: 'text/javascript', path: fileURLToPath(new URL('../extension/archive.js', import.meta.url))});
    return r.abort();
  });
  const writer = await source.newPage(); await writer.goto(origin);
  const {files, notes} = await writer.evaluate(async () => {
    const {saveClip} = await import('/archive.js'), root = await navigator.storage.getDirectory();
    const title = '[讲解] 100% #编程 (上) 🎬 '.repeat(8), author = '频道 (甲)';
    const token = `PAGELEAFIMG${'ab'.repeat(16)}X1END`, url = 'https://images.invalid/fixture';
    const clips = [{kind: 'youtube', title, author, cover: url}, {kind: 'article', title, author, body: token, images: [{token, url, alt: '文章图'}]}];
    const notes = [], files = [];
    for (const clip of clips) {
      const isCover = clip.kind === 'youtube', canvas = document.createElement('canvas');
      canvas.width = isCover ? 32 : 7; canvas.height = isCover ? 18 : 5;
      canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, isCover ? 'image/jpeg' : 'image/png'));
      const result = await saveClip(root, clip, {date: new Date(2026, 1, 3), getImage: () => ({blob, ext: isCover ? 'jpg' : 'png'})});
      notes.push(result);
    }
    async function walk(dir, prefix) {
      for await (const [name, item] of dir.entries()) {
        const path = prefix + name;
        if (item.kind === 'directory') await walk(item, path + '/');
        else files.push([path, [...new Uint8Array(await (await item.getFile()).arrayBuffer())]]);
      }
    }
    await walk(root, ''); return {files, notes};
  });
  await source.close();
  assert.equal(notes.length, 2); assert.ok(notes.every(n => n.indexed && !n.warnings.length));

  const tmpBase = await realpath(tmpdir()), temp = await mkdtemp(join(tmpBase, 'pageleaf-media-'));
  assert.equal(dirname(temp), tmpBase); assert.ok(basename(temp).startsWith('pageleaf-media-'));
  t.after(() => rm(temp, {recursive: true, force: true, maxRetries: 3}));
  const original = join(temp, '原库'), moved = join(temp, '旅行 笔记 (中文) 100% #2');
  for (const [relativePath, bytes] of files) {
    const target = resolve(original, relativePath); assert.ok(target.startsWith(original + sep));
    await mkdir(dirname(target), {recursive: true}); await writeFile(target, Uint8Array.from(bytes), {flag: 'wx'});
  }
  assert.equal(dirname(original), temp); assert.equal(dirname(moved), temp);
  await rename(original, moved); // move the whole archive, not the note alone
  const reader = await browser.newContext({offline: true, serviceWorkers: 'block'}), page = await reader.newPage();
  const day = dirname(join(moved, notes[0].path)), viewer = join(day, '离线 阅读器.html');
  await writeFile(viewer, '<!doctype html><meta charset="utf-8"><title>Local reader</title>', {flag: 'wx'});
  await page.goto(pathToFileURL(viewer).href);
  for (const [i, note] of notes.entries()) {
    const mdFile = join(moved, note.path); assert.equal(dirname(mdFile), day);
    const md = await readFile(mdFile, 'utf8');
    const matches = [...md.matchAll(/^!\[[^\n]*?\]\(([^)\n]+)\)$/gm)]; assert.equal(matches.length, 1);
    const src = matches[0][1]; // no URL decoding, path rewriting or absolute src
    assert.match(src, i === 0 ? /^assets\/[A-Za-z0-9_-]{1,25}\/cover\.jpg$/ : /^assets\/[A-Za-z0-9_-]{1,25}\/01\.png$/);
    const observed = await page.evaluate(async src => {
      const img = new Image(); img.src = src; document.body.replaceChildren(img); await img.decode();
      return [img.currentSrc, img.naturalWidth, img.naturalHeight];
    }, src);
    assert.deepEqual(observed, [pathToFileURL(join(day, src)).href, ...(i === 0 ? [32, 18] : [7, 5])]);
    t.diagnostic(`Chromium ${browser.version()}, file: offline, ${src} decoded ${observed[1]}×${observed[2]}`);
  }
  await reader.close();
});
