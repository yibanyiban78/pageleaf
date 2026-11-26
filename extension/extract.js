// MV3, Chrome 122+. Inject files: ['extract.js'], world: 'ISOLATED'. No dependencies.
// The completion value, not a global or a message, is returned to executeScript().
(() => {
  'use strict';

  const actualURL = new URL(location.href);
  actualURL.username = actualURL.password = '';
  const result = { kind: 'article', title: '', url: actualURL.href, author: '', body: '', plain: '', images: [] };
  const selection = window.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  const active = document.activeElement;
  if (active?.matches('input,textarea') && active.selectionStart !== active.selectionEnd) {
    // A selection in a control isn't an article. Don't read drafts, autofill or passwords.
    throw new Error('不剪藏表单输入；请在网页正文中选择文字。');
  }
  function isVideoPage(url) {
    const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'];
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) return false;
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1).replace(/\/$/, '') :
      /^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') : /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return /^[\w-]{11}$/.test(id || '');
  }
  if (range) result.kind = 'selection';
  else if (isVideoPage(new URL(location.href))) {
    result.kind = 'youtube';
    return result; // Don't read YouTube player globals, DOM, metadata or captions here.
  }

  // Keep the DOM read-only. In particular, cloning a range containing img/iframe
  // elements into the active document can itself initiate resource loads.
  const omitted = 'head,script,style,noscript,template,iframe,object,embed,canvas,svg,math,video,audio,form,input,select,option,textarea,button,dialog,[role="dialog"],[contenteditable]:not([contenteditable="false" i])';
  const furniture = 'nav,aside,footer,.sr-only,.visually-hidden,.screen-reader-text,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="search"],[role="menu"],[role="menubar"],[role="toolbar"]';
  const noisyName = /(?:^|[\s_-])(?:nav(?:igation|bar)?|footer|sidebar|breadcrumb[s]?|comments?|related(?:posts?)?|recommended|recommendations?|promoted|advert(?:s|isement|ising)?|ads?|share(?:bar|buttons?)?|social(?:links)?|newsletter|subscribe|cookie(?:banner)?|paywall|pagination|toolbar|masthead)(?:$|[\s_-])/i;
  const block = /^(?:address|article|aside|blockquote|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|ol|p|pre|section|summary|table|tr|ul)$/;
  const candidates = 'article,main,section,div,body,[role="main"],[itemprop~="articleBody"]';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes); // Works on plain HTTP too, unlike crypto.randomUUID().
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const imagePrefix = 'PAGELEAFIMG' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') + 'X';
  const hidden = new WeakMap();
  function skip(el) {
    if (hidden.has(el)) return hidden.get(el);
    let hide = el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || el.matches(omitted) || el.hidden || el.inert ||
      el.getAttribute('aria-hidden')?.toLowerCase() === 'true' ||
      (el.parentElement?.matches('details:not([open])') && !el.matches('summary:first-of-type'));
    if (!range && !hide) {
      hide = el.matches(furniture) || noisyName.test(`${el.id} ${el.className}`) ||
        (el.localName === 'header' && !el.closest('article,main,[role="main"]') && !el.querySelector('h1'));
    }
    if (!hide) {
      const style = getComputedStyle(el);
      hide = style.display === 'none' || /^hidden|collapse$/.test(style.visibility) || style.contentVisibility === 'hidden' || style.opacity === '0';
    }
    hidden.set(el, Boolean(hide));
    return Boolean(hide);
  }
  function children(el) {
    if (el.matches('details:not([open])')) {
      // Closed details can have bare Text children as well as hidden elements.
      const summary = el.querySelector(':scope > summary');
      return summary ? [summary] : [];
    }
    return el.childNodes;
  }
  function visibleAncestry(el) {
    for (; el; el = el.parentElement) if (skip(el)) return false;
    return true;
  }
  const safeChars = s => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  const words = s => safeChars(s).replace(/\s+/gu, ' ').trim();
  function mdText(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/[\\`*_{}\[\]#!~|$%]/g, '\\$&').replace(/^(\s*)([-+=])/g, '$1\\$2')
      .replace(/^(\s*\d{1,9})([.)])(?=\s|$)/g, '$1\\$2')
      .replace(/PAGELEAFIMG/g, 'PAGELEAFIM&#71;');
  }
  function httpURL(value) {
    if (!value || value.length > 8192 || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return '';
    try {
      const u = new URL(value.trim(), document.baseURI);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
    } catch { return ''; }
  }
  function mdURL(url) {
    // Parentheses delimit Markdown destinations. Ampersands can begin character
    // references (including &#41;); escape only the HTML meaning, not query delimiters.
    return url.replace(/[()<>"'`\[\]\\]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase()).replace(/&/g, '&amp;');
  }

  let budget;
  function visit(depth) {
    if (--budget < 0 || depth > 180) throw new Error('页面结构过于复杂，请选择要剪藏的正文后重试。');
  }
  function articleRoot() {
    budget = 200000;
    let best = document.body, bestScore = -1;
    // Score visible, non-linked prose from the bottom up (one pass, not
    // textContent on every candidate). Prefer the narrower root in a tie.
    function score(node, depth) {
      visit(depth);
      if (node.nodeType === 3) return [node.length, 0, 0];
      if (node.nodeType !== 1 || skip(node)) return [0, 0, 0];
      let text = 0, links = 0, paragraphs = 0;
      for (const child of children(node)) {
        const [t, l, p] = score(child, depth + 1);
        text += t; links += l; paragraphs += p;
      }
      if (node.localName === 'a') links = text;
      if (node.localName === 'p' && text - links > 12) paragraphs++;
      if (node.matches(candidates)) {
        const prose = Math.max(0, text - links * 1.5);
        const semantic = node.matches('article,[itemprop~="articleBody"]') ? 3 : node.matches('main,[role="main"]') ? 1.8 : 1;
        const weight = node.localName === 'body' ? 0.7 : 1;
        const quality = (Math.sqrt(prose) + Math.min(30, paragraphs) * 1.5) * semantic * weight;
        if ((text || semantic > 1) && quality > bestScore) { best = node; bestScore = quality; }
      }
      return [text, links, paragraphs];
    }
    score(document.body, 0);
    return best;
  }
  function rangeRoot(r) {
    let el = r.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    while (el?.parentElement && !block.test(el.localName)) el = el.parentElement;
    if (el?.matches('li') && el.parentElement?.matches('ol,ul')) el = el.parentElement;
    return el;
  }
  if (!document.body) throw new Error('当前页面没有可剪藏的正文。');
  const root = range ? rangeRoot(range) : articleRoot();
  const scope = root?.closest('article,main,[role="main"]') || root || document.body;
  // Metadata is a small allowlist, not a dump of head, script state, data-* or JSON-LD.
  function label(el, max) {
    if (!el || !visibleAncestry(el)) return '';
    let text = '', remaining = 800;
    function walk(n, d) {
      if (remaining-- < 1 || d > 60 || text.length > max * 3) return;
      if (n.nodeType === 3) text += n.data.slice(0, max * 3);
      else if (n.nodeType === 1 && !skip(n)) for (const c of children(n)) walk(c, d + 1);
    }
    walk(el, 0);
    return words(text).slice(0, max);
  }
  function firstLabel(base, selector, max) {
    for (const el of base.querySelectorAll(selector)) {
      const text = label(el, max);
      if (text) return [text, el];
    }
    return ['', null];
  }
  const [heading, headingEl] = firstLabel(scope, 'h1', 350);
  result.title = heading || words(document.title).slice(0, 350) || actualURL.hostname;
  const authorSelector = 'a[rel~="author" i],[itemprop~="author"],.byline,.author-name,.author';
  let [byline, authorEl] = firstLabel(scope, authorSelector, 180);
  if (!byline && scope !== document.body) [byline, authorEl] = firstLabel(document.body, 'a[rel~="author" i]', 180);
  result.author = byline || words(document.head?.querySelector('meta[name="author" i]')?.content || '').slice(0, 180);
  const authorLink = authorEl?.matches('a') ? authorEl : authorEl?.querySelector('a[rel~="author" i],a[itemprop~="url"]');
  const authorURL = authorLink && visibleAncestry(authorLink) && httpURL(authorLink.getAttribute('href'));
  if (authorURL) result.authorUrl = authorURL;

  function fromSet(set) {
    if (!set || set.length > 16384) return '';
    // Read the non-space URL as one token (commas may be part of a URL).
    // Never split a data: URL's base64 payload into a bogus relative request.
    let i = 0, best = '', bestSize = -1;
    while (i < set.length) {
      while (i < set.length && /[\s,]/.test(set[i])) i++;
      const start = i;
      while (i < set.length && !/\s/.test(set[i])) i++;
      let raw = set.slice(start, i), descriptor = '';
      if (raw.endsWith(',')) raw = raw.replace(/,+$/, '');
      else {
        const d = i;
        while (i < set.length && set[i] !== ',') i++;
        descriptor = set.slice(d, i).trim();
      }
      const url = httpURL(raw);
      if (!url || (descriptor && !/^\d+(?:\.\d+)?[wx]$/.test(descriptor))) continue;
      const size = parseFloat(descriptor) || 1;
      if (size > bestSize) { bestSize = size; best = url; }
    }
    return best;
  }
  function imageURL(el) {
    for (const name of ['data-src', 'data-original', 'data-lazy-src', 'data-original-src', 'data-actualsrc']) {
      const url = httpURL(el.getAttribute(name));
      if (url) return url;
    }
    let lazyPicture = '';
    if (el.parentElement?.localName === 'picture') for (const source of el.parentElement.children) {
      if (source === el) break;
      if (source.localName !== 'source' || (source.media && !matchMedia(source.media).matches)) continue;
      lazyPicture = fromSet(source.getAttribute('data-srcset')) || fromSet(source.getAttribute('data-lazy-srcset'));
      if (lazyPicture) break;
    }
    const remote = lazyPicture || fromSet(el.getAttribute('data-srcset')) || fromSet(el.getAttribute('data-lazy-srcset')) ||
      httpURL(el.currentSrc) || fromSet(el.getAttribute('srcset')) || httpURL(el.getAttribute('src'));
    if (remote) return remote;
    // Never interpret HTML, SVG, blob/object or arbitrary data URLs. Archive validates the bytes again.
    for (const value of [el.getAttribute('data-src'), el.getAttribute('data-original'), el.currentSrc, el.getAttribute('src')]) {
      if (value && value.length < 17 * 1024 * 1024 && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value;
    }
    return '';
  }
  // A pair keeps link destinations, image alt/URLs, formatting and metadata out of
  // the AI input by construction. Only visible text nodes feed the second string.
  const pair = (md = '', plain = '') => ({ md, plain });
  const paragraph = s => s.trim() ? `\n\n${s.trim()}\n\n` : '';
  const finishText = s => s.split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const inline = (s, wrap) => (/^\s/.test(s) ? ' ' : '') + wrap(s.trim()) + (/\s$/.test(s) ? ' ' : '');
  const stripURLs = s => s
    .replace(/(?:\b(?:https?|ftp|file):\/\/|\b(?:www\.|blob:|mailto:)|(?<!\w)\/\/(?=[\w.-]+\.))[^\s<>，。；！？、（）「」]+/gi, '')
    .replace(/\bdata:[^\s<>，。；！？、（）「」]+/gi, '');
  const listNumbers = new WeakMap();
  function numberList(list) {
    const items = Array.from(list.children).filter(child => child.localName === 'li');
    let ordinal = list.hasAttribute('start') ? list.start : list.reversed ? items.length : 1;
    for (const item of items) {
      if (item.hasAttribute('value')) ordinal = item.value;
      listNumbers.set(item, Math.min(999999999, Math.max(0, ordinal)));
      ordinal += list.reversed ? -1 : 1;
    }
  }
  const imageNodes = new WeakSet();
  let inputChars = 0, imageChars = 0;
  function render(node, depth = 0, verbatim = false) {
    visit(depth);
    if (range && !range.intersectsNode(node)) return pair();
    if (node.nodeType === 3) {
      const text = node.data.slice(range?.startContainer === node ? range.startOffset : 0, range?.endContainer === node ? range.endOffset : undefined);
      if ((inputChars += text.length) > 2000000) throw new Error('正文超过剪藏长度，请分段选择。');
      const str = verbatim ? safeChars(text) : safeChars(text).replace(/\s+/gu, ' ');
      return pair(verbatim ? str : mdText(str), str);
    }
    if (node.nodeType !== 1 || skip(node)) return pair();
    const tag = node.localName;
    if (tag === 'img') {
      if (verbatim || imageNodes.has(node)) return pair();
      const url = imageURL(node);
      const pixel = ['width', 'height'].some(k => /^[01](?:px)?$/.test(node.getAttribute(k)?.trim() || ''));
      if (pixel) return pair();
      const alt = words(node.getAttribute('alt') || '').slice(0, 300);
      if (!url) return pair(alt ? `（图片：${mdText(alt)}；无可用图源）` : '（图片无可用图源）');
      if ((imageChars += url.length) > 48 * 1024 * 1024 || result.images.length >= 3000) {
        throw new Error('页面图片过多或过大，请分段剪藏。');
      }
      const token = `${imagePrefix}${result.images.length}END`;
      result.images.push({ token, url, alt });
      imageNodes.add(node);
      return pair(token);
    }
    if (tag === 'br') return pair('\n', '\n');
    if (tag === 'hr') return pair('\n\n---\n\n', '\n\n');
    const code = tag === 'pre' || tag === 'code';
    let md = '', plain = '';
    for (const child of children(node)) {
      if (/^(?:ul|ol|dl|table|tr|thead|tbody|tfoot)$/.test(tag) && child.nodeType === 3 && !child.data.trim()) continue;
      const p = render(child, depth + 1, verbatim || code);
      if (!verbatim && !code && md.endsWith('`') && p.md.startsWith('`')) md += ' ';
      md += p.md; plain += p.plain;
    }
    if (verbatim) return pair(md, plain);
    if (code) {
      // Fence longer than any source backtick run; no source-derived language or attributes.
      const longest = (md.match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
      if (tag === 'pre') {
        const fence = '`'.repeat(Math.max(3, longest + 1));
        return pair(`\n\n${fence}\n${md.trimEnd()}\n${fence}\n\n`, paragraph(plain));
      }
      const fence = '`'.repeat(Math.max(1, longest + 1));
      return md.trim() ? pair(`${fence} ${md.replace(/\s+/g, ' ')} ${fence}`, plain) : pair();
    }
    if (!range && !md.includes(imagePrefix) && ((node === headingEl && words(plain) === result.title) ||
      (node === authorEl && words(plain) === result.author))) return pair();
    if (tag === 'td' || tag === 'th') return pair(`${md.trim()}  `, `${plain.trim()} `);
    if (!md.trim() && !plain.trim()) return pair(md, plain);
    if (tag === 'a') {
      const url = httpURL(node.getAttribute('href'));
      // Let the archive own image Markdown entirely, without wrapping it in a nested link.
      if (url && !md.includes(imagePrefix)) md = inline(md, s => `[${s.replace(/\s+/g, ' ')}](${mdURL(url)})`);
      // A human label is prose; a visible URL/path used as the label isn't.
      const label = plain.trim();
      if (url && (label === node.getAttribute('href') || label === url.replace(/^https?:\/\//i, ''))) plain = ' ';
    } else if (tag === 'strong' || tag === 'b') md = inline(md, s => `**${s}**`);
    else if (tag === 'em' || tag === 'i') md = inline(md, s => `*${s}*`);
    else if (/^h[1-6]$/.test(tag)) md = `${'#'.repeat(Number(tag[1]))} ${md.trim().replace(/\s+/g, ' ')}`;
    else if (tag === 'blockquote') md = finishText(md).split('\n').map(line => `> ${line}`).join('\n');
    else if (tag === 'li') {
      const list = node.parentElement;
      let marker = '- ';
      if (list?.localName === 'ol') {
        if (!listNumbers.has(node)) numberList(list);
        marker = `${listNumbers.get(node)}. `;
      }
      md = finishText(md).split('\n').map((line, i) => (i === 0 ? marker : line ? ' '.repeat(marker.length) : '') + line).join('\n');
      return pair(md + '\n', plain.trim() + '\n');
    }
    return block.test(tag) ? pair(paragraph(md), paragraph(plain)) : pair(md, plain);
  }
  budget = 200000;
  if (root && visibleAncestry(root)) {
    const { md, plain } = render(root);
    result.body = finishText(md);
    // Small local preview, including for selections whose AI payload is deliberately empty.
    result.excerpt = plain.trimStart().slice(0, 700).replace(/\s+/gu, ' ').trim().slice(0, 220);
    result.plain = result.kind === 'selection' ? '' : finishText(stripURLs(plain)).replace(/[ \t]{2,}/g, ' ');
  }
  return result;
})();
