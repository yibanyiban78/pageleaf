// Pure Markdown grammar shared by the archive writer and read-only legacy verifier.
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

export {text, line, plain, decoded, urlOf, relative, link, bodyMarkdown};
