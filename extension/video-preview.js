// One synchronous MAIN-world snapshot. Never initiate loading, enable CC, or operate the page.
(() => {
  'use strict';
  const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be']);
  const text = (value, limit = 4096) => typeof value === 'string' && value.length <= limit ? value.trim() : '';
  function url(value) {
    if (!text(value, 16384)) return null;
    try {
      const u = new URL(value, location.href);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u : null;
    } catch { return null; }
  }
  function videoID(value) {
    const u = url(value);
    if (!u || !hosts.has(u.hostname)) return '';
    const id = u.hostname === 'youtu.be' ? /^\/([^/]+)\/?$/.exec(u.pathname)?.[1] :
      /^\/watch\/?$/.test(u.pathname) && u.searchParams.getAll('v').length === 1 ? u.searchParams.get('v') :
      /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/.exec(u.pathname)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : '';
  }
  const id = videoID(location.href);
  if (!id) throw new Error('请在 YouTube 视频页上预览。');
  const clip = {kind:'youtube', videoId:id, url:`https://www.youtube.com/watch?v=${id}`, title:'', author:'', authorUrl:'',
    description:'', cover:`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, cues:[], language:'', captionKind:'', captionStatus:'pending'};
  function snapshot() {
    if (videoID(location.href) !== id) throw new Error('视频已切换，请在目标视频页重新预览。');
    return clip;
  }
  function readPlayer(player, getter) {
    try { return player?.[getter]?.(); } catch { return undefined; }
  }
  const player = document.querySelector('#movie_player');
  const live = readPlayer(player, 'getPlayerResponse');
  const playerData = readPlayer(player, 'getVideoData');
  const ids = [live?.videoDetails?.videoId, playerData?.video_id, player?.closest('ytd-watch-flexy')?.getAttribute('video-id')].filter(Boolean);
  if (ids.some(value => value !== id)) return snapshot(); // SPA in transition: no unscoped head/DOM fallbacks.
  const currentPlayer = [live?.videoDetails?.videoId, playerData?.video_id].includes(id);
  const initial = window.ytInitialPlayerResponse;
  const response = [live, initial].find(r => r?.videoDetails?.videoId === id);
  const details = response?.videoDetails;
  const micro = response?.microformat?.playerMicroformatRenderer;
  const root = document.querySelector(`ytd-watch-flexy[video-id="${id}"]:not([hidden]):not([aria-hidden="true"])`);
  const head = selector => document.head?.querySelector(selector);
  const meta = key => head(`meta[property="${key}"]`)?.content;
  const headIDs = [];
  for (const href of [meta('og:url'), head('link[rel="canonical"]')?.href]) if (href) headIDs.push(videoID(href));
  const headID = head('meta[itemprop="videoId"]')?.content;
  if (headID) headIDs.push(headID);
  const headMatches = headIDs.length > 0 && headIDs.every(value => value === id);
  // A route string alone is not evidence that document.title or the description was replaced.
  const metadata = (currentPlayer || headMatches) && root?.querySelector('ytd-watch-metadata');
  const owner = (currentPlayer || headMatches) && root?.querySelector('ytd-video-owner-renderer #channel-name a[href]');
  function richText(value, limit) {
    if (text(value?.simpleText, limit)) return text(value.simpleText, limit);
    if (!Array.isArray(value?.runs) || value.runs.length > 256) return '';
    let result = '';
    for (const run of value.runs) {
      if (typeof run?.text !== 'string' || result.length + run.text.length > limit) return '';
      result += run.text;
    }
    return result.trim();
  }
  function channelURL(value) {
    const u = url(value);
    return u && hosts.has(u.hostname) && /^\/(?:@[^/]+|(?:channel|user|c)\/[^/]+)\/?$/.test(u.pathname)
      ? `https://www.youtube.com${u.pathname}` : '';
  }
  function thumbnail(value) {
    const u = url(value);
    if (!u || !(/(?:^|\.)ytimg\.com$/.test(u.hostname) || u.hostname === 'img.youtube.com')) return '';
    const embeddedID = /^\/(?:vi|vi_webp|vi_live|an_webp)\/([^/]+)\//.exec(u.pathname)?.[1];
    return embeddedID && embeddedID !== id ? '' : u.href;
  }
  let bestWidth = -1;
  for (const set of [details?.thumbnail?.thumbnails, micro?.thumbnail?.thumbnails]) {
    if (!Array.isArray(set) || set.length > 64) continue;
    for (const t of set) {
      const w = Number(t?.width || 0), image = thumbnail(t?.url);
      if (image && Number.isFinite(w) && w > bestWidth) { clip.cover = image; bestWidth = w; }
    }
  }
  if (bestWidth < 0 && headMatches) clip.cover = thumbnail(meta('og:image')) || clip.cover;
  clip.title = text(details?.title) || richText(micro?.title, 4096) || (currentPlayer && text(playerData?.title)) ||
    text(metadata?.querySelector?.('h1')?.textContent) || (headMatches && (text(meta('og:title')) || text(document.title).replace(/\s*[-–]\s*YouTube$/i, ''))) || '';
  clip.author = text(details?.author) || text(micro?.ownerChannelName) || (currentPlayer && text(playerData?.author)) || text(owner?.textContent);
  const channel = text(details?.channelId) || text(micro?.externalChannelId);
  clip.authorUrl = channelURL(micro?.ownerProfileUrl) || (/^UC[\w-]{22}$/.test(channel) ? `https://www.youtube.com/channel/${channel}` : channelURL(owner?.href));
  clip.description = text(details?.shortDescription, 32768) || richText(micro?.description, 32768) ||
    text(metadata?.querySelector?.('ytd-text-inline-expander #attributed-description, ytd-text-inline-expander #attributed-snippet-text')?.textContent, 32768) ||
    (headMatches && text(meta('og:description'), 32768)) || '';

  // A missing track list (or an unrecognized player state) never means "no captions".
  // An ID-less denial blocks caption access but cannot establish the status of THIS video.
  const denials = new Set(['LOGIN_REQUIRED', 'AGE_CHECK_REQUIRED', 'CONTENT_CHECK_REQUIRED', 'UNPLAYABLE', 'ERROR', 'LIVE_STREAM_OFFLINE']);
  const liveStatus = live?.playabilityStatus?.status;
  const status = liveStatus ? (currentPlayer && liveStatus) : response?.playabilityStatus?.status;
  if (denials.has(status)) {
    clip.captionStatus = 'unavailable';
    return snapshot();
  }
  const duration = Number(details?.lengthSeconds);
  if (liveStatus !== 'OK' || live?.videoDetails?.videoId !== id || details?.isLiveContent || playerData?.isLive ||
      !Number.isFinite(duration) || duration <= 0) return snapshot();

  // Transcript panel rows, search results, virtual windows, initialSegments, activeCues
  // and in-band textTracks do NOT establish completeness, even if there is no "more" UI.
  // A static external <track> instead has an explicit, browser-owned LOADED state. Accept
  // only a whole-file VOD track that the current response offered for this very video.
  const offers = live.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(offers) || !offers.length || offers.length > 128) return snapshot();
  const videos = player.querySelectorAll('video');
  if (videos.length !== 1) return snapshot();
  const trackElements = videos[0].querySelectorAll(':scope > track');
  if (trackElements.length > 128) return snapshot();
  // Fail closed on new or window/range/search/paging parameters. Never follow the URL.
  const wholeTrackParams = new Set('v lang fmt name kind tlang caps expire sig signature key sparams ip ipbits ei hl opi xoaf xowf xospf'.split(' '));
  function wholeTrackURL(value) {
    const u = url(value);
    if (!u || !hosts.has(u.hostname) || u.pathname !== '/api/timedtext' || u.hash || u.searchParams.get('v') !== id || !u.searchParams.get('lang')) return null;
    const seen = new Set();
    for (const key of u.searchParams.keys()) {
      if (!wholeTrackParams.has(key) || seen.has(key)) return null;
      seen.add(key);
    }
    return u;
  }
  const byURL = new Map();
  for (const offer of offers) {
    const href = wholeTrackURL(offer?.baseUrl)?.href;
    if (href) byURL.set(href, byURL.has(href) ? null : offer);
  }
  let best;
  for (const el of trackElements) {
    if (el.readyState !== HTMLTrackElement.LOADED || !['captions','subtitles'].includes(el.kind)) continue;
    const src = wholeTrackURL(el.src), offer = src && byURL.get(src.href);
    if (!offer) continue;
    // Read only; setting mode (even to 'hidden') can itself issue a request.
    const native = el.track, list = native.mode !== 'disabled' && native.cues;
    if (!list?.length || list.length > 12000) continue;
    const translated = src.searchParams.get('tlang');
    const captionKind = translated ? '' : offer.kind === 'asr' || src.searchParams.get('kind') === 'asr' || /^a\./.test(text(offer.vssId)) ? 'auto' :
      ['manual','standard'].includes(offer.kind) || /^\./.test(text(offer.vssId)) ? 'manual' : '';
    const rank = (native.mode === 'showing' ? 2 : 0) + (captionKind === 'manual' ? 1 : 0);
    if (!best || rank > best.rank) best = {list, rank, captionKind, language:text(translated || offer.languageCode || el.srclang || src.searchParams.get('lang'), 128)};
  }
  if (!best) return snapshot();
  const cues = [];
  let chars = 0;
  for (const cue of best.list) {
    if (!(cue instanceof VTTCue) || !Number.isFinite(cue.startTime) || cue.startTime < 0 || !Number.isFinite(cue.endTime) ||
        cue.endTime <= cue.startTime || cue.text.length > 16384 || (chars += cue.text.length) > 1024 * 1024) return snapshot();
    // The browser's VTT parser decodes entities and removes voice/style/timestamp tags;
    // the inert fragment is never installed on the page.
    const line = cue.getCueAsHTML().textContent.replace(/[\s\u200b]+/gu, ' ').trim();
    if (!line) return snapshot(); // Never label a truncated prefix as read.
    cues.push({start:cue.startTime, text:line});
  }
  Object.assign(clip, {cues, language:best.language, captionKind:best.captionKind, captionStatus:'read'});
  return snapshot();
})()
