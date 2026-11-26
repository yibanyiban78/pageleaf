import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

// All pages and caption responses are synthetic. Route interception prevents site access;
// chromium.launch() uses an ephemeral profile, not the user's signed-in Chrome session.
const source = await readFile(new URL('../extension/video.js', import.meta.url), 'utf8');
const id = 'aB12cd_34EF';
const otherId = 'New98765_ab';
const videoURL = `https://www.youtube.com/watch?v=${id}`;
const baseUrl = `https://www.youtube.com/api/timedtext?v=${id}&lang=zh-Hans&sig=sample%2B`;
const manual = {baseUrl, languageCode: 'zh-Hans', vssId: '.zh-Hans', name: {simpleText: '简体中文'}};
const automatic = {baseUrl: `${baseUrl}&kind=asr`, languageCode: 'zh-Hans', vssId: 'a.zh-Hans', kind: 'asr'};
const playerResponse = (tracks = []) => ({
  playabilityStatus: {status: 'OK'},
  videoDetails: {videoId: id, title: '夹具标题', shortDescription: '首行\n次行', author: '示例频道',
    channelId: 'UCabcdefghijklmnopqrstuv', thumbnail: {thumbnails: [
      {width: 360, url: `https://i.ytimg.com/vi/${id}/default.jpg`},
      {width: 1280, url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`}] }},
  captions: {playerCaptionsTracklistRenderer: {captionTracks: tracks}}
});
const json = JSON.stringify({events: [
  {tStartMs: 1750, segs: [{utf8: '第二'}, {utf8: '句。'}]},
  {tStartMs: 0, segs: [{utf8: '开场 🎧'}]},
  {tStartMs: 2100, segs: [{utf8: '\n'}]}, {tStartMs: 4500}, {segs: [{utf8: '无有效时间'}]}]});
let browser;
before(async () => {
  const executablePath = [process.env.CHROME_PATH, process.env.CHROMIUM_PATH, chromium.executablePath(),
    `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`,
    `${process.env['ProgramFiles(x86)']}/Google/Chrome/Application/chrome.exe`,
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    .find(path => path && existsSync(path));
  browser = await chromium.launch({executablePath, headless: true});
});
after(() => browser?.close());

async function fixture(t, {url = videoURL, live = playerResponse(), initial, html = '', head = '',
  body = json, status = 200, selected, playerID, duringRequest, observeFetch = false} = {}) {
  const context = await browser.newContext({serviceWorkers: 'block'});
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  await context.route('**/*', async route => {
    const req = route.request();
    if (req.isNavigationRequest() && req.url() === url) {
      await route.fulfill({contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8">${head}</head><body><div id="movie_player"></div>${html}</body></html>`});
    } else {
      requests.push({url: req.url(), type: req.resourceType(), headers: req.headers()});
      if (duringRequest) await duringRequest(page);
      if (new URL(req.url()).pathname === '/api/timedtext') await route.fulfill({status, contentType: 'text/plain; charset=utf-8', body,
        headers: {'access-control-allow-origin': '*'}});
      else await route.abort();
    }
  });
  await page.goto(url);
  await page.evaluate(({live, initial, selected, playerID, observeFetch}) => {
    const player = document.querySelector('#movie_player');
    player.getPlayerResponse = () => live;
    if (playerID) player.getVideoData = () => ({video_id: playerID});
    player.getOption = (api, option) => api === 'captions' && option === 'track' ? selected : undefined;
    window.ytInitialPlayerResponse = initial;
    if (observeFetch) {
      const real = window.fetch.bind(window);
      window.fetch = (url, init) => {
        window.fetchOptions = {credentials: init.credentials, redirect: init.redirect, referrerPolicy: init.referrerPolicy};
        return real(url, init);
      };
    }
  }, {live, initial, selected, playerID, observeFetch});
  return {page, requests, clip: () => page.evaluate(source)};
}
const panel = ({rootID = id, state = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED', query = '', style = ''} = {}) =>
  `<ytd-watch-flexy video-id="${rootID}"><ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="${state}" style="display:block;${style}">
  <input value="${query}"><ytd-transcript-segment-list-renderer><ytd-transcript-segment-renderer><span class="segment-timestamp">1:02:03</span><span class="segment-text"> 面板里的 字幕 </span></ytd-transcript-segment-renderer></ytd-transcript-segment-list-renderer>
  <ytd-transcript-footer-renderer><button aria-haspopup="true">简体中文</button></ytd-transcript-footer-renderer></ytd-engagement-panel-section-list-renderer></ytd-watch-flexy>`;

test('current player wins over stale SPA bootstrap; choose identifiable manual track, preserve signed URL and seconds', async t => {
  const old = playerResponse(); old.videoDetails = {videoId: otherId, title: '旧标题'};
  const f = await fixture(t, {url: `https://www.youtube.com/shorts/${id}?feature=share`, live: playerResponse([automatic, manual]), initial: old});
  const clip = await f.clip();
  assert.deepEqual(clip, {kind:'youtube', videoId:id, url:videoURL, title:'夹具标题', description:'首行\n次行',
    author:'示例频道', authorUrl:'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
    cover:`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, language:'zh-Hans', captionKind:'manual',
    cues:[{start:0, text:'开场 🎧'}, {start:1.75, text:'第二句。'}]});
  assert.deepEqual(f.requests.map(r => r.url), [baseUrl]);
});

test('HTTP cover metadata is reference-only; subtitle HTTPS restrictions are unchanged', async t => {
  const live=playerResponse();live.playabilityStatus.status='UNPLAYABLE';const href=`http://i.ytimg.com/vi/${id}/cover.jpg?asset=fixture`;
  live.videoDetails.thumbnail.thumbnails=[{width:320,url:href}];
  const f=await fixture(t,{live});assert.equal((await f.clip()).cover,href);assert.deepEqual(f.requests,[]);
});

test('honor a selected offered ASR track; mobile cross-origin request omits credentials and redirects', async t => {
  const f = await fixture(t, {url:`https://m.youtube.com/watch?v=${id}`, live:playerResponse([manual, automatic]), selected:automatic, observeFetch:true});
  const clip = await f.clip();
  assert.equal(clip.captionKind, 'auto');
  assert.deepEqual(f.requests.map(r => r.url), [automatic.baseUrl]);
  const options = await f.page.evaluate(() => window.fetchOptions);
  assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
  assert.equal(f.requests[0].headers.cookie, undefined);
});

for (const [label, body, expected] of [
  ['legacy seconds XML', '<?xml version="1.0"?><transcript><text start="0.75" dur="2">I&amp;#39;m &amp; you<br/>👋</text></transcript>', {start:0.75, text:"I'm & you 👋"}],
  ['srv3 milliseconds XML', '<timedtext format="3"><head></head><body><p t="1234" d="1000"><s>你好</s><s>，朋友</s></p></body></timedtext>', {start:1.234,text:'你好，朋友'}],
  ['WebVTT hours, cue ID and annotations', 'WEBVTT\r\n\r\nNOTE omit\r\n\r\ncue1\r\n01:02:03.250 --> 01:02:05.000 align:start\r\n<v Narrator><i>Listen</i> &amp; learn', {start:3723.25,text:'Listen & learn'}]
]) test(`read ${label} as text (no DOM injection)`, async t => {
  const f = await fixture(t, {body, live:playerResponse([{baseUrl, languageCode:'en'}]), head:`<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">`});
  const clip = await f.clip();
  assert.deepEqual(clip.cues, [expected]); assert.equal(clip.captionKind, '');
});

test('no caption offer => empty cues/labels, full metadata, zero network activity', async t => {
  const f = await fixture(t, {url:`https://youtu.be/${id}?t=12`});
  const clip = await f.clip();
  assert.equal(clip.title, '夹具标题'); assert.equal(clip.url, videoURL);
  assert.deepEqual([clip.cues, clip.language, clip.captionKind, f.requests], [[], '', '', []]);
});

test('no eligible endpoint: reject unexpected host/path, userinfo, foreign video and plain HTTP', async t => {
  const invalid = ['https://www.youtube.com.example.invalid/api/timedtext', `${new URL(videoURL).origin}/anything`, `https://name@www.youtube.com/api/timedtext`,
    `https://www.youtube.com/api/timedtext?v=${otherId}`, `http://www.youtube.com/api/timedtext?v=${id}`];
  const f = await fixture(t, {live: playerResponse(invalid.map(baseUrl => ({baseUrl})))});
  assert.deepEqual((await f.clip()).cues, []); assert.deepEqual(f.requests, []);
});

test('LOGIN_REQUIRED does not try available-looking track, old bootstrap, or rendered panel', async t => {
  const live = playerResponse([manual]); live.playabilityStatus.status = 'LOGIN_REQUIRED';
  const f = await fixture(t, {live, initial:playerResponse([automatic]), html:panel()});
  assert.deepEqual((await f.clip()).cues, []); assert.deepEqual(f.requests, []);
});

test('ID-less restricted bootstrap cannot fall through to a manual transcript action', async t => {
  const f = await fixture(t, {live:null, initial:{playabilityStatus:{status:'LOGIN_REQUIRED'}}, head:`<link rel="canonical" href="${videoURL}">`, html:panel()});
  assert.deepEqual((await f.clip()).cues, []); assert.deepEqual(f.requests, []);
});

test('visible transcript language explicitly marked auto-generated is recognized without guessing UI language', async t => {
  const f = await fixture(t, {html:panel().replace('简体中文','English (auto-generated)')});
  const clip = await f.clip();
  assert.deepEqual([clip.language, clip.captionKind], ['English','auto']);
});

test('a stale player and head do not contaminate metadata or reuse a cached transcript', async t => {
  const live = playerResponse([manual]); live.videoDetails.videoId = otherId;
  const f = await fixture(t, {live, playerID:otherId, html:panel(), head:`<link rel="canonical" href="https://www.youtube.com/watch?v=${otherId}"><meta property="og:title" content="旧页"><title>旧页</title>`});
  const clip = await f.clip();
  assert.deepEqual([clip.title, clip.author, clip.description, clip.cues, f.requests], ['', '', '', [], []]);
  assert.equal(clip.url, videoURL);
});

test('429 never retries; already open unfiltered transcript may be saved without mutating UI', async t => {
  const f = await fixture(t, {live:playerResponse([manual, automatic]), status:429, html:panel()});
  const before = await f.page.locator('body').innerHTML();
  const clip = await f.clip();
  assert.deepEqual(clip.cues, [{start:3723, text:'面板里的 字幕'}]);
  assert.equal(clip.language, 'zh-Hans'); assert.equal(clip.captionKind, 'manual');
  assert.equal(await f.page.locator('body').innerHTML(), before);
  assert.equal(f.requests.length, 1);
});

test('read only timestamped caption segments from visible modern mixed timeline with no target-id', async t => {
  const html = `<ytd-watch-flexy video-id="${id}"><ytd-engagement-panel-section-list-renderer visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" style="display:block">
    <timeline-item-view-model><span class="ytAttributedStringHost">chapter title is NOT a subtitle</span></timeline-item-view-model>
    <timeline-item-view-model><transcript-segment-view-model><div class="ytwTranscriptSegmentViewModelTimestamp">01:04</div><div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">64 seconds</div><span class="ytAttributedStringHost ytAttributedStringLinkInheritColor">时间轴里的字幕</span></transcript-segment-view-model></timeline-item-view-model>
    </ytd-engagement-panel-section-list-renderer></ytd-watch-flexy>`;
  const f = await fixture(t, {html});
  const clip = await f.clip();
  assert.deepEqual(clip.cues, [{start:64,text:'时间轴里的字幕'}]);
  assert.deepEqual([clip.language,clip.captionKind], ['', '']);
});

test('skip stale, hidden, collapsed, and search-filtered panels', async t => {
  const f = await fixture(t, {html:panel({rootID:otherId}) + '<ytd-watch-flexy video-id="'+id+'"></ytd-watch-flexy>'});
  for (const opts of [{rootID:otherId}, {style:'display:none'}, {state:'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'}, {query:'一字'}]) {
    await f.page.locator('ytd-watch-flexy').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    await f.page.evaluate(markup => document.body.insertAdjacentHTML('beforeend', markup), panel(opts));
    assert.deepEqual((await f.clip()).cues, []);
  }
});

test('SPA navigation during caption fetch cancels result rather than labeling another video', async t => {
  const f = await fixture(t, {live:playerResponse([manual]), duringRequest:p => p.evaluate(id => history.replaceState(null, '', `/watch?v=${id}`), otherId)});
  await assert.rejects(f.clip, /视频已切换/);
});

const nativeHTML = () => panel({state:'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'}).replace('</ytd-watch-flexy>',
  '<ytd-video-description-transcript-section-renderer><button aria-label="显示文字稿">显示文字稿</button></ytd-video-description-transcript-section-renderer></ytd-watch-flexy>').replace('<input', '<div id="header"><button aria-label="关闭面板">×</button></div><input');
async function wireNative(page, {delay = 20, closeLabel = '关闭面板'} = {}) {
  await page.evaluate(({delay, closeLabel}) => {
    window.actions = [];
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer');
    const close = panel.querySelector('#header button');
    close.setAttribute('aria-label', closeLabel);
    document.querySelector('ytd-video-description-transcript-section-renderer button').onclick = () => {
      window.actions.push('open');
      setTimeout(() => panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'), delay);
    };
    close.onclick = () => { window.actions.push('close'); panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'); };
  }, {delay, closeLabel});
}

test('empty offered track => use a recognized native transcript action and restore only its own panel', async t => {
  const f = await fixture(t, {live:playerResponse([manual]), body:'', html:nativeHTML()});
  await wireNative(f.page);
  const clip = await f.clip();
  assert.deepEqual(clip.cues, [{start:3723, text:'面板里的 字幕'}]);
  assert.equal(clip.language, 'zh-Hans');
  assert.deepEqual(await f.page.evaluate(() => window.actions), ['open','close']);
  assert.equal(await f.page.locator('ytd-engagement-panel-section-list-renderer').getAttribute('visibility'), 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
});

test('user interaction during native fallback => never close their panel', async t => {
  const f = await fixture(t, {html:nativeHTML()});
  await wireNative(f.page, {delay:10});
  const promise = f.clip();
  await f.page.waitForFunction(() => window.actions.length > 0);
  await f.page.keyboard.press('Shift'); // real trusted input generated in the synthetic page
  await promise;
  assert.deepEqual(await f.page.evaluate(() => window.actions), ['open']);
});

const collapsedHTML = () => nativeHTML().replace(/(<ytd-video-description-transcript-section-renderer>.*?<\/ytd-video-description-transcript-section-renderer>)/,
  `<ytd-watch-metadata><div id="description"><ytd-text-inline-expander id="description-inline-expander"><tp-yt-paper-button id="expand">更多</tp-yt-paper-button>
  <div id="structured-description" hidden>$1</div><tp-yt-paper-button id="collapse" hidden>收起</tp-yt-paper-button></ytd-text-inline-expander></div></ytd-watch-metadata>`)
  .replaceAll('显示文字稿', '内容转文字');
async function wireDescription(page) {
  await wireNative(page);
  await page.evaluate(() => {
    const box = document.querySelector('#description-inline-expander');
    for (const name of ['expand', 'collapse']) box.querySelector('#'+name).onclick = () => {
      window.actions.push(name);
      const show = name === 'expand';
      box.querySelector('#expand').hidden = show;
      box.querySelector('#collapse').hidden = !show;
      box.querySelector('#structured-description').hidden = !show;
    };
  });
}

test('hidden verified transcript section => only its own description expands and is restored', async t => {
  const f = await fixture(t, {html:collapsedHTML()});
  await wireDescription(f.page);
  const clip = await f.clip();
  assert.equal(clip.cues.length, 1);
  assert.deepEqual(await f.page.evaluate(() => window.actions), ['expand', 'open', 'close', 'collapse']);
});

test('unrelated hidden section or unknown control must not expand the description', async t => {
  const f = await fixture(t, {html:collapsedHTML().replaceAll('内容转文字','See something else')});
  await wireDescription(f.page);
  assert.deepEqual((await f.clip()).cues, []);
  assert.deepEqual(await f.page.evaluate(() => window.actions), []);
});

test('leave native panel open when its header has no identifiable close control', async t => {
  const f = await fixture(t, {html:nativeHTML()});
  await wireNative(f.page, {closeLabel:'Other'});
  assert.equal((await f.clip()).cues.length, 1);
  assert.deepEqual(await f.page.evaluate(() => window.actions), ['open']);
});

for (const status of [401, 403, 429]) test(`HTTP ${status}: do not click a second native path after denial or rate limit`, async t => {
  const f = await fixture(t, {live:playerResponse([manual]), status, html:nativeHTML()});
  await wireNative(f.page);
  assert.deepEqual((await f.clip()).cues, []);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.page.evaluate(() => window.actions), []);
});

test('never displace a different expanded engagement panel, or guess an unknown action', async t => {
  const f = await fixture(t, {html:nativeHTML()});
  await wireNative(f.page);
  await f.page.evaluate(() => {
    const other = document.createElement('ytd-engagement-panel-section-list-renderer');
    other.style.display='block'; other.textContent='other'; other.id='open-panel';
    other.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    document.querySelector('ytd-watch-flexy').append(other);
  });
  assert.deepEqual((await f.clip()).cues, []);
  await f.page.evaluate(() => {
    document.querySelector('#open-panel').remove();
    const opener = document.querySelector('ytd-video-description-transcript-section-renderer button');
    opener.textContent = 'Other'; opener.removeAttribute('aria-label');
  });
  assert.deepEqual((await f.clip()).cues, []);
  assert.deepEqual(await f.page.evaluate(() => window.actions), []);
});

test('a hanging synthetic request settles via the finite deadline, without alternate endpoints', async t => {
  const f = await fixture(t, {live:playerResponse([manual])});
  await f.page.evaluate(() => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ms => { window.requestDeadline = ms; return nativeTimeout(10); };
    window.fetch = async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true}));
  });
  assert.deepEqual((await f.clip()).cues, []);
  assert.ok(await f.page.evaluate(() => window.requestDeadline > 0 && window.requestDeadline <= 5000));
  assert.deepEqual(f.requests, []);
});
