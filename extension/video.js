// One MAIN-world injection; nothing is installed on the page between clips.
(async () => {
  'use strict';
  const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be']);
  const scalar = value => typeof value === 'string' ? value.trim() : '';
  const asURL = (value, base = location.href) => {
    if (!scalar(value)) return null;
    try { return new URL(value, base); } catch { return null; }
  };
  const secure = u => u?.protocol === 'https:' && !u.username && !u.password && !u.port;
  function videoIdOf(url) {
    if (!secure(url) || !hosts.has(url.hostname)) return '';
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1).replace(/\/$/, '') :
      /^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') :
      /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : '';
  }
  const id = videoIdOf(asURL(location.href));
  if (!id) throw new Error('请在 YouTube 视频页上剪藏。');
  function assertRoute() {
    if (videoIdOf(asURL(location.href)) !== id) throw new Error('视频已切换，请在目标视频页重新剪藏。');
  }
  const watchRoot = () => document.querySelector(`ytd-watch-flexy[video-id="${id}"]:not([hidden])`);
  // The player element itself can also be replaced while waiting for its caption UI.
  function callPlayer(name, ...args) {
    try { return document.querySelector('#movie_player')?.[name]?.(...args); } catch { return undefined; }
  }
  const live = callPlayer('getPlayerResponse');
  const playerData = callPlayer('getVideoData');
  const playerIDs = [live?.videoDetails?.videoId, playerData?.video_id].filter(Boolean);
  const transitioning = playerIDs.some(value => value !== id);
  const current = playerIDs.includes(id) && !transitioning;
  const initial = window.ytInitialPlayerResponse;
  const matching = [live, initial].filter(r => r?.videoDetails?.videoId === id);
  const response = matching[0];
  const blocked = status => status && status !== 'OK';
  const noAccess = blocked(live?.playabilityStatus?.status) || blocked(response?.playabilityStatus?.status) ||
    (!live?.playabilityStatus?.status && !initial?.videoDetails?.videoId && blocked(initial?.playabilityStatus?.status));
  const details = response?.videoDetails || {};
  const micro = response?.microformat?.playerMicroformatRenderer || {};
  const root = !transitioning && watchRoot();
  const head = name => scalar(document.head.querySelector(`meta[property="${name}"]`)?.content);
  // Head tags and document.title often belong to the *previous* video on SPA changes.
  const headIDs = [videoIdOf(asURL(head('og:url'))),
    videoIdOf(asURL(document.head.querySelector('link[rel="canonical"]')?.href)),
    scalar(document.head.querySelector('meta[itemprop="videoId"]')?.content)].filter(Boolean);
  const headMatches = !transitioning && headIDs.length > 0 && headIDs.every(value => value === id);
  const owner = root?.querySelector?.('ytd-video-owner-renderer #channel-name a[href]');
  const fromRuns = value => scalar(value?.simpleText) || (Array.isArray(value?.runs) ? value.runs.map(r => scalarText(r?.text)).join('') : '');
  function scalarText(value) { return typeof value === 'string' ? value : ''; }
  function channelURL(value) {
    const u = asURL(value);
    return secure(u) && hosts.has(u.hostname) && /^\/(?:@[^/]+|(?:channel|user|c)\/[^/]+)\/?$/.test(u.pathname)
      ? `https://www.youtube.com${u.pathname}` : '';
  }
  function thumbnailURL(value) {
    const u = asURL(value);
    // An offered HTTP thumbnail is reference-only; don't replace it with a guessed HTTPS download.
    return u && ['https:','http:'].includes(u.protocol) && !u.username && !u.password && !u.port &&
      (/(?:^|\.)ytimg\.com$/.test(u.hostname) || u.hostname === 'img.youtube.com') ? u.href : '';
  }
  const thumbnails = [...(Array.isArray(details.thumbnail?.thumbnails) ? details.thumbnail.thumbnails : []),
    ...(Array.isArray(micro.thumbnail?.thumbnails) ? micro.thumbnail.thumbnails : [])];
  thumbnails.sort((a, b) => (b?.width || 0) - (a?.width || 0));
  const channelId = scalar(details.channelId) || scalar(micro.externalChannelId);
  const clip = {
    kind: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}`,
    title: scalar(details.title) || fromRuns(micro.title) || (current && scalar(playerData?.title)) ||
      scalar(root?.querySelector?.('ytd-watch-metadata h1')?.textContent) || (headMatches && (head('og:title') || scalar(document.title).replace(/\s*[-–]\s*YouTube$/i, ''))) || '',
    author: scalar(details.author) || scalar(micro.ownerChannelName) || (current && scalar(playerData?.author)) || scalar(owner?.textContent),
    authorUrl: channelURL(micro.ownerProfileUrl) || (/^UC[\w-]{22}$/.test(channelId) ? `https://www.youtube.com/channel/${channelId}` : channelURL(owner?.href)),
    description: scalar(details.shortDescription) || fromRuns(micro.description) || scalar(root?.querySelector?.('ytd-text-inline-expander #attributed-snippet-text, ytd-text-inline-expander #attributed-description')?.textContent) || (headMatches && head('og:description')) || '',
    cover: thumbnails.map(t => thumbnailURL(t?.url)).find(Boolean) || (headMatches && thumbnailURL(head('og:image'))) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    language: '', captionKind: '', cues: []
  };
  if (noAccess || transitioning) return clip;

  const seconds = value => {
    const s = typeof value === 'number' ? value : scalar(value);
    return s !== '' && Number.isFinite(Number(s)) && Number(s) >= 0 ? Number(s) : NaN;
  };
  function clock(value) {
    const s = scalar(value).replace(',', '.');
    return /^(?:\d+:)?\d+:[0-5]\d(?:\.\d+)?$/.test(s) ? s.split(':').reduce((n, v) => n * 60 + Number(v), 0) : NaN;
  }
  const tidy = value => scalarText(value).replace(/[\s\u200b]+/gu, ' ').trim();
  function add(cues, start, raw) {
    const text = tidy(raw);
    if (Number.isFinite(start) && start >= 0 && text) cues.push({start, text});
  }
  function entities(text) {
    const names = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', lrm:'\u200e', rlm:'\u200f'};
    return text.replace(/&(amp|lt|gt|quot|apos|nbsp|lrm|rlm|#\d{1,7}|#x[\da-fA-F]{1,6});/g, (orig, key) => {
      if (key[0] !== '#') return names[key];
      const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : orig;
    });
  }
  function parseTrack(body) {
    const cues = [];
    const data = body.trim();
    if (data.startsWith('{')) {
      const events = JSON.parse(data).events;
      if (Array.isArray(events)) for (const event of events) {
        if (Array.isArray(event?.segs)) add(cues, seconds(event.tStartMs) / 1000, event.segs.map(s => scalarText(s?.utf8)).join(''));
      }
    } else if (/^WEBVTT(?:\s|$)/.test(data)) {
      for (const block of data.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).slice(1)) {
        const lines = block.split('\n');
        if (/^(?:NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0])) continue;
        const i = lines[0].includes('-->') ? 0 : 1;
        const timing = /^(\S+)\s+-->\s+(\S+)/.exec(lines[i] || '');
        if (timing && Number.isFinite(clock(timing[2]))) add(cues, clock(timing[1]), entities(lines.slice(i + 1).join(' ')
          .replace(/<\/?(?:b|i|u|ruby|rt|lang|v|c)(?:[.\s][^<>]*)?>|<\d[\d:.]+>/gi, '')));
      }
    } else if (/^(?:<\?xml[^>]*>\s*)?<(transcript|timedtext)(?:\s|>)/.test(data) && !data.includes('<!')) {
      // Caption XML has two simple grammars: text/start (s), or p/t (ms) with inline s.
      // Tokenize just those, not arbitrary HTML; no DOMParser/innerHTML Trusted Types sink.
      let tag, start, parts;
      for (const [token] of data.matchAll(/<[^<>]*>|[^<>]+|[<>]/g)) {
        const open = /^<(text|p)(?:\s|>)/.exec(token);
        if (open) {
          tag = open[1]; parts = [];
          const val = (tag === 'text' ? /\sstart=["']([\d.]+)["']/ : /\st=["']([\d.]+)["']/).exec(token)?.[1];
          start = seconds(val) / (tag === 'p' ? 1000 : 1);
        } else if (parts && token === `</${tag}>`) {
          const text = parts.join('');
          add(cues, start, tag === 'text' ? entities(text) : text); // legacy text sometimes double-escapes entities
          parts = undefined;
        } else if (parts && /^<br\s*\/?>$/i.test(token)) parts.push(' ');
        else if (parts && !token.startsWith('<')) parts.push(entities(token));
      }
    }
    return cues;
  }

  function captionType(track) {
    const u = offeredURL(track);
    if (u?.searchParams.has('tlang')) return ''; // auto-translation is not the provenance of its source track
    if (track?.kind === 'asr' || u?.searchParams.get('kind') === 'asr' || /^a\./.test(track?.vssId || '')) return 'auto';
    if (['manual', 'standard'].includes(track?.kind) || /^\./.test(track?.vssId || '')) return 'manual';
    return '';
  }
  function use(cues, language = '', captionKind = '') {
    assertRoute();
    clip.cues = cues.sort((a, b) => a.start - b.start).filter((cue, i, all) => !i || cue.start !== all[i - 1].start || cue.text !== all[i - 1].text);
    clip.language = scalar(language);
    clip.captionKind = captionKind;
    return clip;
  }
  function offeredURL(track) {
    const u = asURL(track?.baseUrl);
    if (!secure(u) || !hosts.has(u.hostname) || u.pathname !== '/api/timedtext' || u.searchParams.getAll('v').some(v => v !== id)) return null;
    return u;
  }
  const offered = matching.filter(r => !blocked(r.playabilityStatus?.status)).map(r => r.captions?.playerCaptionsTracklistRenderer?.captionTracks).find(a => Array.isArray(a) && a.length) ||
    (current && callPlayer('getOption', 'captions', 'tracklist')) || [];
  const listed = Array.isArray(offered) ? offered : [];
  const tracks = listed.filter(offeredURL);
  const selected = current && callPlayer('getOption', 'captions', 'track');
  const track = (selected?.vssId && tracks.find(t => t.vssId === selected.vssId)) ||
    tracks.find(t => captionType(t) === 'manual') || tracks[0];

  // Request ONE unmodified page-offered caption URL. No custom client, token generation,
  // alternate endpoint, retry, or redirect. Cross-origin YouTube requests omit credentials.
  let allowNativeOpen = true;
  if (track) {
    const u = offeredURL(track);
    try {
      const res = await fetch(u.href, {credentials: u.origin === location.origin ? 'same-origin' : 'omit',
        referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(5000)});
      if ([401, 403, 407, 429, 451, 503].includes(res.status) || res.headers.has('retry-after')) allowNativeOpen = false;
      const maxBytes = 12 * 1024 * 1024;
      if (res.ok && res.body && Number(res.headers.get('content-length') || 0) <= maxBytes) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const chunks = [];
        let count = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          count += part.value.byteLength;
          if (count > maxBytes) { await reader.cancel(); break; }
          chunks.push(decoder.decode(part.value, {stream: true}));
        }
        if (count <= maxBytes) {
          chunks.push(decoder.decode());
          const cues = parseTrack(chunks.join(''));
          if (cues.length) return use(cues, u.searchParams.get('tlang') || track.languageCode || u.searchParams.get('lang'), captionType(track));
        }
      } else if (res.body) { await res.body.cancel(); }
    } catch { /* Timeout, CORS or unavailable track: only already-rendered text remains. */ }
  }
  assertRoute();
  // Final fallback: only the current watch page's normal transcript surface. Never
  // change playback/CC settings or query a private endpoint.
  const active = watchRoot();
  if (!active || (!current && !headMatches)) return clip;
  const expanded = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  const panelSelector = 'ytd-engagement-panel-section-list-renderer';
  const visible = el => !!el && !el.closest('[hidden], [aria-hidden="true"], [inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
  const isOpen = panel => visible(panel) && (!panel.hasAttribute('visibility') || panel.getAttribute('visibility') === expanded);
  const rowSelector = 'ytd-transcript-segment-renderer, transcript-segment-view-model, yt-transcript-segment-view-model, ytb-transcript-segment-view-model';
  // Modern timeline panels may have no target-id and include chapters. A displayed
  // caption segment component is positive evidence; never use arbitrary timeline text.
  const transcriptPanel = () => Array.from(active.querySelectorAll(panelSelector)).find(panel => isOpen(panel) &&
    ((panel.getAttribute('target-id') || '').includes('transcript') || panel.querySelector(rowSelector)));
  function readPanel(panel) {
    if (!panel || panel.querySelector('input')?.value?.trim()) return null;
    const list = panel.querySelector('ytd-transcript-segment-list-renderer');
    const data = list?.data?.initialSegments || list?.initialSegments;
    const cues = [];
    if (Array.isArray(data)) {
      if (data.some(row => row?.continuationItemRenderer)) return null;
      for (const row of data) {
        const seg = row?.transcriptSegmentRenderer;
        if (seg) add(cues, seconds(seg.startMs) / 1000, fromRuns(seg.snippet));
      }
    }
    if (!cues.length) {
      const rows = panel.querySelectorAll(rowSelector);
      for (const row of rows) {
        const time = row.querySelector('.segment-timestamp, [class*="TranscriptSegmentViewModelTimestamp"]')?.textContent;
        const text = row.querySelector('.segment-text, [class*="TranscriptSegmentViewModelText"], [class*="TranscriptSegmentViewModelSnippet"], :scope > span.ytAttributedStringHost')?.textContent;
        add(cues, clock(time), text);
      }
    }
    if (cues.length) {
      // Only link a panel to a track label that matches uniquely; UI language is not cue language.
      const menu = panel.querySelector('ytd-transcript-footer-renderer #label, ytd-transcript-footer-renderer button[aria-haspopup]');
      const label = tidy(menu?.textContent);
      const matches = label ? listed.filter(t => tidy(fromRuns(t?.name)) === label) : [];
      if (matches.length === 1) return use(cues, matches[0].languageCode || label, captionType(matches[0]));
      const asrLabel = /\s*[(（](?:auto-generated|automatically generated|自动生成|自動生成|自動產生|自動建立|자동 생성됨)[)）]$/iu;
      const language = /^(?:language|choose language|select language|语言|語言)$/iu.test(label) ? '' : label.replace(asrLabel, '');
      return use(cues, language, asrLabel.test(label) ? 'auto' : '');
    }
    return null;
  }
  const alreadyOpen = transcriptPanel();
  if (alreadyOpen) return readPanel(alreadyOpen) || clip;
  // Do not replace another open engagement panel, operate a disabled action, or
  // try a second request after an explicit denial/throttle from the caption endpoint.
  if (!allowNativeOpen || Array.from(active.querySelectorAll(panelSelector)).some(isOpen)) return clip;
  const openName = /^(?:show transcript|open transcript|内容转文字|內容轉文字|显示(?:文字稿|转录稿|转写文稿)|查看(?:文字稿|转录稿)|顯示(?:文字稿|轉錄稿|字幕記錄)|mostrar transcripci[oó]n|afficher la transcription|transkript anzeigen|文字起こしを表示|스크립트 표시)$/iu;
  const closeName = /^(?:close(?: transcript| panel)?|关闭(?:文字稿|转录稿|面板)?|關閉(?:文字稿|轉錄稿|面板)?|cerrar|fermer|schlie(?:ß|ss)en|閉じる|닫기)$/iu;
  function namedButton(scope, selectors, namePattern, requireVisible = true) {
    return Array.from(scope.querySelectorAll(selectors)).find(button =>
      (!requireVisible || visible(button)) && !button.matches(':disabled, [aria-disabled="true"]') &&
      [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].some(label => namePattern.test(tidy(label))));
  }
  const openSelectors = 'ytd-video-description-transcript-section-renderer button, ytd-watch-metadata #description button, button[aria-controls*="transcript"]';
  let opener = namedButton(active, openSelectors, openName);
  // Only reveal the specific current-video description that actually contains a
  // recognized native transcript button. Never click a generic "more" elsewhere.
  const sectionButton = !opener && namedButton(active, 'ytd-watch-metadata #description ytd-video-description-transcript-section-renderer button', openName, false);
  const description = sectionButton?.closest?.('ytd-text-inline-expander#description-inline-expander');
  const toggle = (box, name) => Array.from(box?.querySelectorAll(`button#${name}, tp-yt-paper-button#${name}, [role="button"]#${name}`) || [])
    .find(b => b.closest('ytd-text-inline-expander') === box && visible(b) && !b.matches(':disabled, [aria-disabled="true"]'));
  const expander = !opener && toggle(description, 'expand');
  if (!opener && !expander) return clip;
  const sameSurface = () => {
    if (videoIdOf(asURL(location.href)) !== id || watchRoot() !== active) return false;
    const now = callPlayer('getPlayerResponse');
    return !blocked(now?.playabilityStatus?.status) && [now?.videoDetails?.videoId, callPlayer('getVideoData')?.video_id].every(v => !v || v === id);
  };
  if (!sameSurface()) return clip;
  // Track genuine input across the wait. Never auto-close something the user just
  // interacted with, a different panel, or a surface belonging to a different video.
  const input = new AbortController();
  let touched = false;
  for (const type of ['click', 'keydown', 'pointerdown', 'wheel', 'touchstart']) {
    document.addEventListener(type, e => { if (e.isTrusted) touched = true; }, {capture:true, passive:true, signal:input.signal});
  }
  let didExpand = false, didOpen = false;
  try {
    if (expander) {
      didExpand = true;
      expander.click();
      for (let i = 0; i < 7 && !opener; i++) {
        assertRoute();
        if (touched || !sameSurface()) return clip;
        opener = namedButton(description, 'ytd-video-description-transcript-section-renderer button', openName);
        if (!opener) await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!opener || touched || !sameSurface()) return clip;
    didOpen = true;
    opener.click();
    for (let step = 0; step < 26; step++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      assertRoute();
      if (!sameSurface()) return clip;
      const result = readPanel(transcriptPanel());
      if (result) return result;
      if (touched) break;
    }
  } finally {
    input.abort();
    const opened = sameSurface() && transcriptPanel();
    if (!touched && didOpen && opened?.getAttribute?.('visibility') === expanded) {
      const closer = namedButton(opened, '#visibility-button button, #header button, ytd-engagement-panel-title-header-renderer button', closeName);
      closer?.click();
    }
    if (!touched && didExpand && sameSurface() && active.contains(description)) toggle(description, 'collapse')?.click();
  }
  return clip;
})()
