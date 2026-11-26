import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const script = await readFile(new URL('../extension/extract.js', import.meta.url), 'utf8');
let browser;
before(async () => {
  // Playwright always starts a temporary profile. Prefer its pinned browser;
  // on machines without that download, use installed Chrome or an explicit path.
  const executablePath = process.env.PAGELEAF_CHROMIUM || [chromium.executablePath(),
    `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`,
    `${process.env['ProgramFiles(x86)']}/Microsoft/Edge/Application/msedge.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(t, url, content) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  const otherRequests = [];
  await context.route('**/*', r => {
    if (!r.request().isNavigationRequest() || r.request().frame() !== page.mainFrame()) {
      otherRequests.push(r.request().url());
      return r.abort(); // All resources are synthetic; never contact their hosts.
    }
    return r.fulfill({ contentType: 'text/html; charset=utf-8', headers: {
      'Content-Security-Policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; require-trusted-types-for 'script'",
    }, body: '<!doctype html>' + content });
  });
  await page.goto(url);
  const debuggerSession = await context.newCDPSession(page);
  const { frameTree } = await debuggerSession.send('Page.getFrameTree');
  const { executionContextId } = await debuggerSession.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'pageleaf-extraction-test',
  });
  async function extract() {
    const previous = otherRequests.length;
    const response = await debuggerSession.send('Runtime.evaluate', {
      contextId: executionContextId, expression: script, returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    assert.equal(otherRequests.length, previous, 'reading the page issued a resource request');
    return response.result.value;
  }
  return { page, extract, otherRequests };
}

const noncePattern = /^PAGELEAFIMG[0-9a-f]{32}X\d+END$/;
test('article: headings, nested lists, quotes, relative links, localized figure positions', async t => {
  const { extract } = await fixture(t, 'https://notes.test/a/item?edition=2#start', `
    <head><title>Newsroom — a site title</title><base href="https://notes.test/assets/"></head>
    <body><header><nav>Navigation marker</nav></header><main><article>
    <header><h1>An illustrated walk</h1><a rel="author" href="authors/lee">Lee</a></header>
    <h2>On the way</h2><p>An <strong>early</strong> walk by <a href="lake(2)?a=1&amp;b=2">the lake</a>.</p>
    <blockquote><p>Go slowly.</p><p>Look closely.</p></blockquote>
    <ol start="3"><li>First stop<ul><li>Deeper trail</li></ul></li><li>Second stop</li></ol>
    <figure><img alt="Plate 1" data-src="./plates/lake.jpg" src="data:image/gif;base64,AAAA"><figcaption>A quiet shore</figcaption></figure>
    <p>Third stop <img data-lazy-srcset="small.jpg 400w, large.jpg 900w" alt="trail map"> on the way back.</p>
    <div class="recommendations">Recommendation marker</div></article></main><footer>Footer marker</footer></body>`);
  const clip = await extract();
  assert.equal(clip.kind, 'article');
  assert.equal(clip.url, 'https://notes.test/a/item?edition=2#start');
  assert.equal(clip.title, 'An illustrated walk');
  assert.equal(clip.author, 'Lee');
  assert.equal(clip.authorUrl, 'https://notes.test/assets/authors/lee');
  assert.doesNotMatch(clip.body, /^# An illustrated walk|^\[Lee\]/m, 'do not repeat title and byline from metadata');
  assert.match(clip.body, /## On the way/);
  assert.match(clip.body, /\*\*early\*\*/);
  assert.match(clip.body, /\[the lake\]\(https:\/\/notes\.test\/assets\/lake%282%29\?a=1&amp;b=2\)/);
  assert.match(clip.body, /^> Go slowly\./m);
  assert.match(clip.body, /^3\. First stop/m);
  assert.match(clip.body, /^\s+- Deeper trail/m);
  assert.deepEqual(clip.images.map(({url,alt}) => [url,alt]), [
    ['https://notes.test/assets/plates/lake.jpg', 'Plate 1'], ['https://notes.test/assets/large.jpg', 'trail map'],
  ]);
  for (const i of clip.images) { assert.match(i.token, noncePattern); assert.equal(clip.body.split(i.token).length, 2); }
  assert.ok(clip.body.indexOf(clip.images[0].token) < clip.body.indexOf('A quiet shore'));
  assert.match(clip.body, new RegExp(`Third stop ${clip.images[1].token} on the way back`));
  assert.doesNotMatch(clip.body, /Navigation marker|Footer marker|Recommendation marker|!\[|\.jpg/);
  assert.doesNotMatch(clip.plain, /https?:|PAGELEAFIMG|\.jpg|Plate 1|trail map|base64|[\[\]]/);
  assert.match(clip.plain, /An early walk by the lake\./);
  const again = await extract();
  assert.notEqual(again.images[0].token, clip.images[0].token);
});

test('selection: clip text-node offsets and just the selected image, ahead of YouTube', async t => {
  const { page, extract } = await fixture(t, 'https://www.youtube.com/watch?v=abcdefghijk', `
    <title>Selected passage</title><article><h1>Notes on video</h1>
    <p>Outside A <img data-src="/a.jpg"></p><p id="selection">BEFORE wanted <a href="/ref">words</a>
    <img data-src="/b.jpg" alt="Selected diagram"> then AFTER</p><p>Outside C <img data-src="/c.jpg"></p></article>`);
  await page.evaluate(() => {
    const p = document.getElementById('selection'); const r = new Range();
    r.setStart(p.firstChild, 7); r.setEnd(p.lastChild, 5); window.getSelection().addRange(r);
  });
  const clip = await extract();
  assert.equal(clip.kind, 'selection');
  assert.equal(clip.plain, '', 'there is no AI payload for a selection');
  assert.equal(clip.images.length, 1);
  assert.equal(clip.images[0].url, 'https://www.youtube.com/b.jpg');
  assert.equal(clip.body, `wanted [words](https://www.youtube.com/ref) ${clip.images[0].token} then`);
  assert.doesNotMatch(clip.body, /BEFORE|AFTER|Outside|Notes on video/);
});

test('image-only selection is not accidentally promoted to whole-page AI input', async t => {
  const { page, extract } = await fixture(t, 'http://plain.test/doc', `<title>Map</title><p>Sensitive part outside selection</p><img data-original="map.png" alt="Map">`);
  await page.evaluate(() => { const r = new Range(); r.selectNode(document.querySelector('img')); window.getSelection().addRange(r); });
  const out = await extract();
  assert.equal(out.kind, 'selection');
  assert.equal(out.images[0].url, 'http://plain.test/map.png');
  assert.equal(out.body, out.images[0].token);
  assert.equal(out.plain, '');
});

test('a selected form value never falls through to full-page extraction', async t => {
  const { page, extract } = await fixture(t, 'https://forms.test/', '<title>Form values</title><article><p>Not selected.</p></article><input type="password" value="synthetic-value">');
  await page.locator('input').evaluate(el => { el.focus(); el.select(); });
  await assert.rejects(extract, /不剪藏表单输入/);
});

test('privacy: hidden DOM, inputs, non-prose scripts, data attributes and image data stay out', async t => {
  const { extract } = await fixture(t, 'https://privacy.test/', `<head><meta name="csrf-token" content="private-meta"><meta name="author" content="Known author"></head>
    <body><article><h1>Privacy check</h1><script type="application/ld+json">{"name":"private-script"}</script><p data-user-id="private-attr">
    Visible words <span hidden>private-hidden</span><span style="display:none">private-css</span><span aria-hidden="true">private-aria</span> continue.
    Details at https://site.test/secret-query and www.site.test/link. Bytes: data:image/png;base64,QUJDRA==.</p>
    <textarea>private-form</textarea><div contenteditable>private-draft</div><details><summary>Public summary</summary>private-closed</details>
    <p><a href="mailto:private-email@test.invalid">contact</a><img src="data:image/png;base64,QUJDRA==" alt="private-data-alt">
    <img width="1" height="1" data-src="https://tracker.test/pixel"></p></article></body>`);
  const out = await extract();
  assert.equal(out.author, 'Known author');
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].url, 'data:image/png;base64,QUJDRA==');
  assert.doesNotMatch(JSON.stringify(out), /private-(?:meta|script|attr|hidden|css|aria|form|draft|closed|email)|tracker\.test/);
  assert.doesNotMatch(out.plain, /private-data-alt/);
  assert.doesNotMatch(out.plain, /site\.test|secret-query|base64|QUJDRA|Known author/);
  assert.match(out.plain, /Visible words continue/);
});

test('treat source literal Markdown/HTML as text; only generate safe destinations', async t => {
  const { extract } = await fixture(t, 'https://sample.test/', `<title>Markup literals</title><article>
    <p>Literal ![illustration](https://media.test/a) and &lt;img src="https://media.test/b"&gt; and [[note]].</p>
    <p><a href="javascript:void(0)">Disallowed scheme</a>; <a href="https://user:secret@media.test/">Unusable link</a>;
    <a href="/a(b)">Brackets [label]</a>; PAGELEAFIMG00000000000000000000000000000000X0END</p>
    <pre><code>sample\n\u0060\u0060\u0060\nlast line</code></pre></article>`);
  const out = await extract();
  assert.match(out.body, /\\!\\\[illustration\\\]/);
  assert.match(out.body, /&lt;img /);
  assert.doesNotMatch(out.body, /<img|javascript:|user:secret|PAGELEAFIMG|\n```\n\nlast line/);
  assert.match(out.body, /\[Brackets \\\[label\\\]\]\(https:\/\/sample\.test\/a%28b%29\)/);
  assert.match(out.body, /\n````\nsample\n```\nlast line\n````$/);
});

test('video dispatch: exact host, supported route and valid id; no DOM scraping', async t => {
  for (const [url, kind] of [
    ['https://m.youtube.com/watch?v=abcdefghijk', 'youtube'], ['https://www.youtube.com/shorts/abcdefghijk', 'youtube'],
    ['https://youtube.com/live/abcdefghijk', 'youtube'], ['https://youtu.be/abcdefghijk', 'youtube'],
    ['https://youtube.com/watch/?v=123456789ab', 'youtube'], ['https://www.youtube-nocookie.com/embed/abcdefghijk', 'youtube'],
    ['https://youtube.com/v/abcdefghijk', 'youtube'], ['https://youtube.com/watch?v=short', 'article'],
    ['https://www.youtube.com/@channel', 'article'], ['https://www.youtube.com.evil.test/watch?v=abcdefghijk', 'article'],
  ]) {
    const { extract } = await fixture(t, url, '<title>Sentinel title</title><article><h1>Sentinel</h1><p>Sentinel text</p></article>');
    const out = await extract();
    assert.equal(out.kind, kind, url);
    if (kind === 'youtube') assert.deepEqual(out, {kind, url, title: '', author: '', body: '', plain: '', images: []});
  }
});

test('lazy picture extraction is read-only and does not fetch the deferred image', async t => {
  const { page, extract, otherRequests } = await fixture(t, 'https://picture.test/path/', `<title>Atlas</title><article>
    <p>Atlas page. <a href="/private/query">/private/query</a></p><picture>
    <source media="(min-width: 9999px)" data-srcset="skip.jpg 1200w">
    <source data-srcset="assets/large.webp 1200w, assets/small.webp 300w"><img alt="Plate of hills"></picture>
    </article>`);
  const before = await page.content();
  const previous = [...otherRequests];
  const out = await extract();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.content(), before);
  assert.deepEqual(otherRequests, previous);
  assert.deepEqual(out.images.map(i => i.url), ['https://picture.test/path/assets/large.webp']);
  assert.doesNotMatch(out.plain, /private\/query/);
});

test('raster data URLs are image items only; no unsafe image type, no silent alt loss', async t => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cC2sAAAAASUVORK5CYII=';
  const { extract } = await fixture(t, 'https://example.test/', `<title>Images</title><article><p>Test figures</p>
    <figure><img data-src="${png}" alt="Raster label"></figure>
    <img src="data:image/svg+xml,%3Csvg%2F%3E" alt="Vector guide"><img src="blob:https://example.test/id" alt="Temporary figure">
    <img src="${png}" data-src="/high-res.jpg" alt="Published figure"></article>`);
  const out = await extract();
  assert.deepEqual(out.images.map(image => image.url), [png, 'https://example.test/high-res.jpg']);
  assert.match(out.body, /Vector guide；无可用图源/);
  assert.match(out.body, /Temporary figure；无可用图源/);
  assert.doesNotMatch(out.body, /data:image|blob:https/);
  assert.doesNotMatch(out.plain, /PAGELEAFIMG|Raster label|Vector guide|Temporary figure|Published figure|data:image|example.test/);
});

test('article fallback selects the prose column on a page without semantic landmarks', async t => {
  const { extract } = await fixture(t, 'https://old.test/entry', `<title>Classic page</title><div id="masthead">Header sentinel</div>
    <div class="column"><h2>In the archives</h2><p>A substantial paragraph about the public archive, with several sentences.</p>
    <p>Another paragraph describing how paper records are kept.</p><figure><img data-src="shelf.jpg"><figcaption>A paper shelf</figcaption></figure></div>
    <div class="sidebar">Sidebar sentinel</div><div class="pagination">Next sentinel</div>`);
  const clip = await extract();
  assert.equal(clip.title, 'Classic page');
  assert.match(clip.body, /## In the archives/);
  assert.equal(clip.images.length, 1);
  assert.doesNotMatch(clip.body, /sentinel/);
});
