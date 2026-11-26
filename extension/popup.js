import { preparePreview, confirmPreview } from './preview.js';

const el = id => document.getElementById(id);
const kindNames = { article: '整篇文章', selection: '选段摘录', youtube: 'YouTube 视频' };
let draft;
let submitting = false;

function status(message, error = false) {
  el('status').textContent = message;
  el('status').dataset.tone = error ? 'error' : '';
}

function brief(value, limit = 68) {
  const chars = Array.from((value || '').replace(/\s+/gu, ' ').trim());
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
}

function render(data) {
  const { clip, captionStatus, aiReady } = data;
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

  let summary;
  if (selection) summary = '选段不调用 AI。';
  else if (!aiReady) summary = data.aiHold || 'AI 服务未就绪，不生成摘要。';
  else if (!video) summary = '确认后将正文发给已配置的 AI 服务，尝试生成摘要。';
  else if (cues) summary = '确认后将字幕发给已配置的 AI 服务，尝试生成摘要。';
  else if (captionStatus === 'pending') summary = '取得字幕后才会发送给 AI，尝试生成摘要。';
  else summary = '没有可用字幕，不生成摘要。';
  el('summary').textContent = summary;

  const hasFolder = Boolean(data.folderName || data.root);
  el('destination').textContent = hasFolder ? (data.estimatedPath || data.folderName) : '尚未选择保存文件夹';
  el('preview').hidden = false;
  el('confirm').disabled = data.folderReady !== true;
  if (data.folderReady === true) status('尚未保存。确认后将在后台剪藏。');
  else if (hasFolder) status('当前文件夹没有写入权限。请到设置重新授权。', true);
  else status('尚未选择保存文件夹。请到设置选择文件夹。', true);
}

// Chrome 122 does not yet put scroll containers in the tab order automatically.
const preview = el('preview');
new ResizeObserver(() => {
  preview.tabIndex = preview.scrollHeight > preview.clientHeight ? 0 : -1;
}).observe(preview);

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
  if (!draft || draft.folderReady !== true || submitting || el('confirm').disabled) return;
  submitting = true;
  el('confirm').disabled = true;
  el('cancel').disabled = true;
  el('settings').disabled = true;
  el('confirm').textContent = '正在提交…';
  status('正在提交剪藏任务…');
  try {
    await confirmPreview(draft);
    window.close();
  } catch (error) {
    // Do not retry the same snapshot after its source or permission may have changed.
    draft = null;
    el('cancel').disabled = false;
    el('settings').disabled = false;
    el('confirm').textContent = '确认保存';
    status(error?.message || '未能开始保存。请关闭后重新预览。', true);
  }
});

async function load() {
  try {
    const snapshot = await preparePreview();
    render(snapshot);
    draft = snapshot;
  } catch (error) {
    el('confirm').disabled = true;
    status(error?.message || '无法读取此页。请回到要剪藏的网页，重新打开页笺。', true);
  }
}

load();
