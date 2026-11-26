import { preparePreview, confirmPreview, refreshCaptureStatus } from './preview.js';

const el = id => document.getElementById(id);
const kindNames = { article: '整篇文章', selection: '选段摘录', youtube: 'YouTube 视频' };
const stateLabels = {checking:'正在核对', unknown:'尚未核实', pending:'正在保存', new:'未剪藏', saved:'已剪藏', partial:'剪藏不完整', error:'剪藏失败'};
let draft;
let submitting = false, spent = false, refreshing = false, dirty = false;
let openingSignals = new Set();

function showState(state) {
  const node = el('capture-state');
  node.dataset.state = state;
  node.textContent = stateLabels[state];
}

function canConfirm(data) {
  const capture = data?.captureStatus;
  return data?.folderReady === true && !spent && !submitting && !refreshing && !dirty &&
    (capture?.state === 'new' || (capture?.state === 'error' && capture.retryable === true));
}

function savedDate(capture) {
  // An archive's YYYY-MM-DD folder is a *local calendar date*, not UTC midnight.
  const day = /^(\d{4}-\d{2}-\d{2})\//.exec(capture.path || '')?.[1];
  if (day) return day;
  const at = capture.savedAt;
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  if (typeof at !== 'string' && typeof at !== 'number') return '';
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-') : '';
}

function status(message, error = false) {
  const node = el('status');
  if (node.textContent !== message) node.textContent = message;
  node.dataset.tone = error ? 'error' : '';
}

function brief(value, limit = 68) {
  const chars = Array.from((value || '').replace(/\s+/gu, ' ').trim());
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
}

function render(data) {
  const { clip, captionStatus } = data;
  const video = clip.kind === 'youtube';
  const selection = clip.kind === 'selection';
  const cues = video && Array.isArray(clip.cues) ? clip.cues.length : 0;

  el('kind').textContent = kindNames[clip.kind];
  el('title').textContent = clip.title || '无标题';
  el('byline-label').textContent = video ? '频道' : '作者';
  el('author').textContent = clip.author || (video ? '未识别频道' : '未识别作者');
  el('source').textContent = clip.url || data.sourceUrl || '未取得地址';
  el('excerpt-label').textContent = video ? '视频简介' : selection ? '选段预览' : '正文预览';
  el('excerpt').textContent = brief(video ? clip.description : data.excerpt) || (video ? '未读到简介。' : '暂无可预览的文字。');

  el('images-row').hidden = video;
  el('cover-row').hidden = !video;
  el('captions-row').hidden = !video;
  if (video) {
    el('cover').textContent = /^http:/i.test(clip.cover || '') ? 'HTTP 封面仅保留原图链接。' : clip.cover ? '可尝试保存' : '未找到封面';
    el('captions').textContent = cues ? `已读到 ${cues} 条，可保存带时间戳的字幕。`
      : captionStatus === 'pending' ? '待检查，取得后才保存。' : '未读到可用字幕。';
  } else {
    const count = Array.isArray(clip.images) ? clip.images.length : 0;
    const refs = (clip.images || []).filter(image => /^http:/i.test(image.url)).length;
    el('images').textContent = refs ? `共 ${count} 张，其中 ${refs} 张 HTTP 图片只留链接。` : count ? `${count} 张，可尝试保存到本地。` : '0 张';
  }

  el('preview').hidden = false;
  renderCapture(data);
}

function renderCapture(data) {
  const capture = data.captureStatus || {};
  const state = Object.hasOwn(stateLabels, capture.state) ? capture.state : 'unknown';
  const existing = state === 'saved' || state === 'partial';
  const {clip, aiReady, captionStatus} = data;
  const video = clip.kind === 'youtube';
  const cues = video && clip.cues?.length;
  let summary;
  if (clip.kind === 'selection') summary = '选段不调用 AI。';
  else if (existing) summary = '保留已有笔记，不会再次请求摘要。';
  else if (state === 'pending') summary = '后台正在处理，此次预览不另行请求摘要。';
  else if (!aiReady) summary = data.aiHold || 'AI 服务未就绪，不生成摘要。';
  else if (!video) summary = '确认后将正文发给已配置的 AI 服务，尝试生成摘要。';
  else if (cues) summary = '确认后将字幕发给已配置的 AI 服务，尝试生成摘要。';
  else if (captionStatus === 'pending') summary = '取得字幕后才会发送给 AI，尝试生成摘要。';
  else summary = '没有可用字幕，不生成摘要。';
  el('summary').textContent = summary;

  const hasFolder = Boolean(data.folderName || data.root);
  // On a duplicate the existing note is the answer, not a footnote below the excerpt.
  const place = el('destination').parentElement;
  if (existing && place.previousElementSibling !== el('title-toggle')) el('title-toggle').after(place);
  else if (!existing && place.nextElementSibling) preview.append(place);
  el('destination-label').textContent = existing ? '已有笔记位置' : '预计保存位置';
  el('destination').textContent = existing ? (capture.path || '未能取得原笔记路径')
    : hasFolder ? (data.estimatedPath || data.folderName) : '尚未选择保存文件夹';
  const date = existing ? savedDate(capture) : '';
  el('saved-date').hidden = !date;
  el('saved-at').textContent = date;
  el('saved-at').dateTime = date;
  // A warning can include long file names. Keep its full text in the scrollable
  // preview, not in the footer where it could push the actions off screen.
  const detail = state === 'partial' || (state === 'error' && capture.retryable) ? capture.message : '';
  el('capture-detail').textContent = detail || '';
  el('capture-detail').hidden = !detail;
  showState(state);
  el('confirm').textContent = ({saved:'已保存', partial:'已写入笔记', pending:'正在保存'})[state]
    || (state === 'error' && capture.retryable && !spent ? '重试保存' : '确认保存');
  el('confirm').disabled = !canConfirm(data);
  if (state === 'saved') status('当前文件夹已有这份笔记，不会重复保存。');
  else if (state === 'partial') status('笔记已写入，但剪藏不完整。请查看已有笔记，不会重复保存。', true);
  else if (state === 'pending') status('这份剪藏正在后台保存，请稍候。');
  else if (state === 'error') status(capture.retryable ? '上次保存失败，未写入笔记。可以重试保存。' : capture.message || '无法继续剪藏。请检查后重新打开预览。', true);
  else if (!data.folderReady) status(hasFolder ? '当前文件夹没有写入权限。请到设置重新授权。' : '尚未选择保存文件夹。请到设置选择文件夹。', true);
  else if (state === 'new') status(spent ? '尚未保存。这份预览已失效，请重新打开预览再保存。' : '当前文件夹尚未保存这份剪藏。确认后将在后台保存。');
  else status(capture.message || '尚未核实剪藏状态。请关闭后重新预览。');
}

// Chrome 122 does not yet put scroll containers in the tab order automatically.
const preview = el('preview');
new ResizeObserver(() => {
  preview.tabIndex = preview.scrollHeight > preview.clientHeight ? 0 : -1;
}).observe(preview);

// Long titles remain fully accessible, including to keyboard and touch users.
const title = el('title'), toggle = el('title-toggle');
title.dataset.folded = 'true';
new ResizeObserver(() => {
  if (title.dataset.folded === 'true') toggle.hidden = title.scrollHeight <= title.clientHeight + 1;
}).observe(title);
toggle.addEventListener('click', () => {
  const expand = title.dataset.folded === 'true';
  title.dataset.folded = String(!expand);
  toggle.setAttribute('aria-expanded', String(expand));
  toggle.textContent = expand ? '收起标题' : '展开完整标题';
});

// Recheck only this identity in this archive. Neither notification values nor
// another tab's global lastResult are authoritative about the open draft.
const busyKey = (key, rootRevision) => `clipBusy:${rootRevision}:${key}`;
function affectsDraft(signals, data) {
  return signals.has('pageleafRootEpoch') || signals.has(busyKey(data.key, data.rootRevision));
}
async function refresh() {
  if (refreshing || submitting || !draft || !dirty) return;
  const current = draft;
  refreshing = true;
  showState('checking');
  el('confirm').disabled = true;
  try {
    do {
      dirty = false;
      try { current.captureStatus = await refreshCaptureStatus(current); }
      catch (error) { current.captureStatus = error?.captureStatus || {state:'unknown', message:'无法核实当前剪藏，请重新打开预览。'}; }
      // A newer change landed mid-read: do not expose the intermediate result.
    } while (dirty && draft === current && !submitting);
  } finally {
    refreshing = false;
    if (draft === current && !submitting) renderCapture(current);
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  const signals = new Set();
  if (area === 'session') {
    for (const key of Object.keys(changes)) if (key === 'pageleafRootEpoch' || key.startsWith('clipBusy:')) signals.add(key);
  } else if (area === 'local') {
    const result = changes.lastResult?.newValue;
    if (result?.key && result.rootRevision) signals.add(busyKey(result.key, result.rootRevision));
  }
  if (openingSignals) {
    for (const key of signals) openingSignals.add(key);
  } else if (draft && affectsDraft(signals, draft)) {
    dirty = true;
    void refresh();
  }
});

el('cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.close();
});

el('settings').addEventListener('click', async () => {
  try {
    await chrome.runtime.openOptionsPage();
    window.close();
  } catch {
    status('无法打开设置。请右击页笺图标，选择「选项」。', true);
  }
});

el('confirm').addEventListener('click', async () => {
  if (!canConfirm(draft) || el('confirm').disabled) return;
  submitting = true;
  el('confirm').disabled = true;
  el('cancel').disabled = true;
  el('settings').disabled = true;
  el('confirm').textContent = '正在提交…';
  showState('pending');
  status('正在提交剪藏任务…');
  try {
    await confirmPreview(draft);
    window.close();
  } catch (error) {
    // Do not treat a lost response or stale document as proof of no note. Only
    // retry when the confirmer explicitly vouches for this same snapshot.
    const capture = error?.captureStatus || {state:'error'};
    draft.captureStatus = {...capture, message: capture.message || error?.message || '无法确认提交结果，请重新打开预览。'};
    spent = !(capture.state === 'error' && capture.retryable === true);
    submitting = false;
    el('cancel').disabled = false;
    el('settings').disabled = false;
    renderCapture(draft);
    if (spent && capture.state === 'error') draft = null; // Invalid source, permission or archive.
    else if (dirty) void refresh();
  }
});

async function load() {
  try {
    const snapshot = await preparePreview();
    draft = snapshot;
    dirty = affectsDraft(openingSignals, draft);
    openingSignals = null;
    render(snapshot);
    if (dirty) void refresh();
  } catch (error) {
    openingSignals = null;
    draft = null;
    el('confirm').disabled = true;
    showState(error?.captureStatus?.state === 'error' ? 'error' : 'unknown');
    status(error?.captureStatus?.message || error?.message || '无法读取此页。请回到要剪藏的网页，重新打开页笺。', true);
  }
}

load();
