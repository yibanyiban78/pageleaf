// Pure rendering entry point. Only the caller knows whether a status still belongs
// to the current document/root; never discover tabs or install listeners here.
const base = Object.freeze({16:'icons/16.png', 32:'icons/32.png', 48:'icons/48.png', 128:'icons/128.png'});
const dots = {saved:'#19834c', new:'#d66a0b', partial:'#c5323d', error:'#c5323d'};
const labels = {saved:'已剪藏', new:'未剪藏', partial:'剪藏不完整', error:'剪藏失败', pending:'正在保存', checking:'正在核对', unknown:'剪藏状态未核实'};
const rendered = new Map(); // At most three variants, shared across tabs. No page data.
const writes = new Map();

function dottedIcons(color) {
  if (!rendered.has(color)) {
    const images = Promise.all(Object.entries(base).map(async ([key, file]) => {
      const size = Number(key);
      // Extension resources only; never decode a favicon or any page-provided URL.
      const response = await fetch(chrome.runtime.getURL(file));
      if (!response.ok) throw new Error('找不到页笺图标。');
      const bitmap = await createImageBitmap(await response.blob());
      try {
        const ctx = new OffscreenCanvas(size, size).getContext('2d');
        ctx.drawImage(bitmap, 0, 0, size, size);
        // A white keyline separates the dot from both the cover and dark toolbars.
        for (const [radius, fill] of [[.275, '#fff'], [.21, color]]) {
          ctx.beginPath();
          ctx.arc(size * .72, size * .72, size * radius, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();
        }
        return [key, ctx.getImageData(0, 0, size, size)];
      } finally { bitmap.close(); }
    })).then(Object.fromEntries);
    rendered.set(color, images);
    images.catch(() => rendered.delete(color));
  }
  return rendered.get(color);
}

// Serialize per-tab writes: a slow first PNG decode must never paint an old
// result over a newer navigation reset. Calls for different tabs are independent.
export async function paintIndicator(tabId, state, title) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const write = (writes.get(tabId) || Promise.resolve()).then(async () => {
    if (writes.get(tabId) !== write) return;
    const color = Object.hasOwn(dots, state) ? dots[state] : null;
    let icon = {path:base}; // Unknown/checking/pending => original, unmarked icon.
    if (color) {
      try { icon = {imageData: await dottedIcons(color)}; } catch { /* Keep neutral + textual status. */ }
    }
    if (writes.get(tabId) !== write) return;
    const text = title || (Object.hasOwn(labels, state) ? labels[state] : labels.unknown);
    // An already closed tab is harmless and must not fail the capture job.
    await Promise.allSettled([
      chrome.action.setIcon({tabId, ...icon}),
      chrome.action.setTitle({tabId, title: text.startsWith('页笺：') ? text : `页笺：${text}`}),
      chrome.action.setBadgeText({tabId, text:''})
    ]);
  });
  writes.set(tabId, write);
  try { await write; } finally { if (writes.get(tabId) === write) writes.delete(tabId); }
}
