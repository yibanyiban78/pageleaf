import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

// Synthetic pages, no persistent profile or real site. Every browser-context request is intercepted.
const source = await readFile(new URL('../extension/video-preview.js', import.meta.url), 'utf8');
const id = 'uZ12_abcdEF', old = 'aB34_cdEF78';
const watch = `https://www.youtube.com/watch?v=${id}`;
const offered = `https://www.youtube.com/api/timedtext?v=${id}&lang=en&fmt=vtt`;
const channel = 'UCabcdefghijklmnopqrstuv';
const en = {baseUrl:offered, languageCode:'en', vssId:'.en'};
const reply = () => ({playabilityStatus:{status:'OK'}, videoDetails:{videoId:id, title:'当前视频 🎧', author:'演示频道',
  channelId:channel, shortDescription:'第一行\n第二行', lengthSeconds:'300', thumbnail:{thumbnails:[
    {width:320, url:`https://i.ytimg.com/vi/${id}/default.jpg`}, {width:1280, url:`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`}] }},
  captions:{playerCaptionsTracklistRenderer:{captionTracks:[en]}}});
const panel = `<ytd-watch-flexy video-id="${id}"><ytd-watch-metadata><h1>DOM 标题</h1><button>Show transcript</button></ytd-watch-metadata>
  <ytd-engagement-panel-section-list-renderer visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" target-id="engagement-panel-searchable-transcript">
    <input type="search"><ytd-transcript-segment-list-renderer><ytd-transcript-segment-renderer>
    <span class="segment-timestamp">0:00</span><span class="segment-text">A single visible row</span></ytd-transcript-segment-renderer>
    </ytd-transcript-segment-list-renderer></ytd-engagement-panel-section-list-renderer></ytd-watch-flexy>`;
const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\n<i>One &amp; two</i>\n\n00:01.750 --> 00:03.000\n<v speaker> 后一句 🎧 </v>\n';
let browser;
before(async () => {
  const executablePath = [process.env.CHROME_PATH, process.env.CHROMIUM_PATH, chromium.executablePath(),
    `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`, `${process.env['ProgramFiles(x86)']}/Google/Chrome/Application/chrome.exe`,
    '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));
  browser = await chromium.launch({executablePath, headless:true});
});
after(() => browser?.close());

async function fixture(t, {live = reply(), initial, playerData, head = '', html = panel, routeURL = watch, trackBody = vtt} = {}) {
  const context = await browser.newContext({serviceWorkers:'block'});
  t.after(() => context.close());
  const requests = [];
  await context.route('**/*', async route => {
    const req = route.request();
    if (req.isNavigationRequest() && req.url() === routeURL) return route.fulfill({contentType:'text/html; charset=utf-8',
      body:`<!doctype html><meta charset="utf-8">${head}<body><div id="movie_player"><video></video></div>${html}</body>`});
    requests.push(req.url());
    if (new URL(req.url()).pathname === '/api/timedtext') return route.fulfill({contentType:'text/vtt; charset=utf-8',body:trackBody});
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(routeURL);
  await page.evaluate(({live, initial, playerData}) => {
    const player = document.querySelector('#movie_player');
    window.fixtureLive = live;
    player.getPlayerResponse = () => window.fixtureLive;
    player.getVideoData = () => playerData;
    window.ytInitialPlayerResponse = initial;
    window.attempts = [];
    function forbidden(name) { return () => { window.attempts.push(name); throw new Error(`Unexpected preview action: ${name}`); }; }
    for (const name of ['setOption','loadModule','playVideo','pauseVideo','seekTo','getOption']) player[name] = forbidden(name);
    window.fetch = forbidden('fetch');
    XMLHttpRequest.prototype.open = forbidden('xhr');
    navigator.sendBeacon = forbidden('beacon');
    HTMLElement.prototype.click = forbidden('click');
    Element.prototype.scrollIntoView = forbidden('scrollIntoView');
    window.scrollTo = forbidden('scrollTo');
    HTMLMediaElement.prototype.play = forbidden('play');
    HTMLMediaElement.prototype.pause = forbidden('pause');
  }, {live, initial, playerData});
  return {page,
    // The test, never the preview, optionally loads a synthetic VTT in advance.
    preload: async (href = offered) => {
      await page.evaluate(href => new Promise((resolve, reject) => {
        const el = document.createElement('track');
        el.kind = 'captions'; el.srclang = 'en'; el.src = href;
        el.onload = resolve; el.onerror = () => reject(new Error('Fixture VTT failed to load'));
        document.querySelector('video').append(el); el.track.mode = 'hidden';
      }), href);
      assert.equal(requests.at(-1), href);
    },
    preview: async () => {
      const beforeRequests = requests.length;
      const state = () => page.evaluate(() => {
        const media = document.querySelector('video');
        return [document.body.innerHTML, window.scrollX, window.scrollY, media.paused, media.currentTime, [...media.textTracks].map(t => t.mode)];
      });
      const before = await state();
      const clip = await page.evaluate(source);
      assert.deepEqual(await state(), before);
      assert.deepEqual(await page.evaluate(() => window.attempts), []);
      assert.deepEqual(requests.slice(beforeRequests), []);
      return clip;
    }};
}
function status(clip, expected = 'pending') {
  assert.deepEqual([clip.captionStatus, clip.cues, clip.language, clip.captionKind], [expected, [], '', '']);
}

test('preview returns current video metadata and canonical URL, not bootstrap or stale head; an offered track alone stays pending', async t => {
  const stale = reply(); stale.videoDetails = {videoId:old, title:'旧标题'};
  const f = await fixture(t, {initial:stale, routeURL:`https://m.youtube.com/shorts/${id}?feature=share`,
    head:`<title>上一个视频 – YouTube</title><meta property="og:url" content="https://www.youtube.com/watch?v=${old}">`});
  assert.deepEqual(await f.preview(), {kind:'youtube',videoId:id,url:watch,title:'当前视频 🎧',author:'演示频道',
    authorUrl:`https://www.youtube.com/channel/${channel}`,description:'第一行\n第二行',cover:`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    cues:[],language:'',captionKind:'',captionStatus:'pending'});
});

test('no player offers, plain, filtered, paginated or virtualized panel rows never imply no captions or a complete transcript', async t => {
  const live = reply(); delete live.captions;
  const f = await fixture(t, {live});
  for (const variant of ['plain','search','pagination','virtual','bootstrap-only','collapsed']) {
    await f.page.evaluate(variant => {
      const panel = document.querySelector('ytd-engagement-panel-section-list-renderer');
      panel.setAttribute('visibility', variant === 'collapsed' ? 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN' : 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
      panel.querySelector('input').value = variant === 'search' ? 'only' : '';
      const data = [{transcriptSegmentRenderer:{startMs:'0',snippet:{simpleText:'partial model'}}}];
      if (variant === 'pagination') data.push({continuationItemRenderer:{}});
      const list = panel.querySelector('ytd-transcript-segment-list-renderer');
      list.data = variant === 'plain' ? undefined : {initialSegments:data};
      list.setAttribute('aria-setsize',variant === 'virtual' ? '500' : '-1');
    }, variant);
    status(await f.preview());
  }
});

test('read a complete, already loaded, ID-matching static file without changing hidden track mode or initiating a second request', async t => {
  const f = await fixture(t);
  await f.preload();
  const clip = await f.preview();
  assert.equal(clip.captionStatus,'read'); assert.deepEqual(clip.cues,[{start:0,text:'One & two'},{start:1.75,text:'后一句 🎧'}]);
  assert.deepEqual([clip.language,clip.captionKind],['en','manual']);
});

test('prefer the already showing track and current access state over a stale, same-ID denied bootstrap', async t => {
  const live = reply(), stale = reply(); stale.playabilityStatus.status = 'LOGIN_REQUIRED';
  const automatic = `${offered.replace('lang=en','lang=de')}&kind=asr`;
  live.captions.playerCaptionsTracklistRenderer.captionTracks.push({baseUrl:automatic, languageCode:'de', kind:'asr'});
  const f = await fixture(t, {live, initial:stale});
  await f.preload(); await f.preload(automatic);
  await f.page.evaluate(() => { document.querySelectorAll('track')[1].track.mode = 'showing'; });
  const clip = await f.preview();
  assert.deepEqual([clip.captionStatus,clip.language,clip.captionKind], ['read','de','auto']);
});

test('a disabled external track stays disabled; in-band programmatic cues do not certify a whole file', async t => {
  const f = await fixture(t);
  await f.page.evaluate(href => {
    const media = document.querySelector('video');
    const track = document.createElement('track'); track.src = href; media.append(track);
    const inBand = media.addTextTrack('captions','en','en'); inBand.mode = 'hidden'; inBand.addCue(new VTTCue(0,1,'not a static file'));
  }, offered);
  status(await f.preview());
});

test('loaded but mismatched, scoped, segmented, or live-stream caption sources remain pending', async t => {
  const f = await fixture(t);
  const foreign = offered.replace(id,old);
  await f.preload(foreign);
  status(await f.preview());
  for (const tail of ['&start=90','&continuation=abc','&sq=4','&lang=de']) {
    const href = offered + tail;
    await f.page.evaluate(href => {
      document.querySelector('track')?.remove();
      window.fixtureLive.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl = href;
    }, href);
    await f.preload(href); status(await f.preview());
  }
  await f.page.evaluate(href => {
    document.querySelector('track').remove(); window.fixtureLive.videoDetails.isLiveContent = true;
    window.fixtureLive.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl = href;
  }, offered);
  await f.preload(); status(await f.preview());
});

test('over-budget or empty cues never produce a partial read or omit the rest silently', async t => {
  const f = await fixture(t, {trackBody:vtt+'\n00:04.000 --> 00:05.000\n'+'x'.repeat(16385)+'\n'});
  await f.preload(); status(await f.preview());
});

test('explicit current access denial outweighs an available-looking, fully loaded track and a matching older bootstrap', async t => {
  const live = reply(); live.playabilityStatus.status = 'LOGIN_REQUIRED';
  const f = await fixture(t,{live,initial:reply()});
  await f.preload(); status(await f.preview(),'unavailable');
  await f.page.evaluate(() => { window.fixtureLive.playabilityStatus.status = 'UNRECOGNIZED'; });
  status(await f.preview());
});

test('identity-less denial is not proof of the current restriction; never read through it', async t => {
  const f = await fixture(t,{live:{playabilityStatus:{status:'LOGIN_REQUIRED'}},initial:reply()});
  await f.preload(); status(await f.preview());
});

test('SPA transition with conflicting player identities never reuses old owner, metadata, or loaded cues', async t => {
  const f = await fixture(t, {playerData:{video_id:old,title:'上一个视频'},head:`<link rel="canonical" href="${watch}"><title>旧网页标题</title>`});
  await f.preload();
  const clip = await f.preview(); status(clip);
  assert.deepEqual([clip.videoId,clip.url,clip.title,clip.author,clip.description,clip.cover],[id,watch,'','','',`https://i.ytimg.com/vi/${id}/hqdefault.jpg`]);
});

test('head fallback requires consistent current identity, rejects foreign thumbnail ID and unsafe link', async t => {
  const f = await fixture(t,{live:null,html:'',head:`<link rel="canonical" href="${watch}"><title>合成标题 - YouTube</title><meta property="og:description" content="合成简介">
    <meta property="og:image" content="https://i.ytimg.com/vi/${old}/old.jpg">`});
  const clip = await f.preview();
  assert.deepEqual([clip.title,clip.description,clip.cover],['合成标题','合成简介',`https://i.ytimg.com/vi/${id}/hqdefault.jpg`]);
  await f.page.evaluate(id => { const meta = document.createElement('meta'); meta.setAttribute('property','og:url');
    meta.content = `https://foreign.invalid/watch?v=${id}`; document.head.append(meta); },id);
  assert.equal((await f.preview()).title,'');
});

test('invalid/ambiguous route fails before reading player or any page data', async t => {
  const f = await fixture(t,{routeURL:watch+'&v='+old});
  await assert.rejects(f.preview,/YouTube 视频页/);
});
