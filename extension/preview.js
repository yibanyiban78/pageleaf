import {getRootState, getConfig} from './store.js';
import {estimatedRelativePath} from './archive.js';

export function samePage(left, right) {
  try { const a=new URL(left), b=new URL(right); a.hash=b.hash=''; return /^https?:$/.test(a.protocol) && a.href===b.href; }
  catch { return false; }
}
export function videoId(input) {
  const u=new URL(input);
  if(u.protocol!=='https:' || u.port || u.username || u.password || !/^(?:(?:(?:www|m|music)\.)?youtube\.com|(?:www\.)?youtube-nocookie\.com|youtu\.be)$/.test(u.hostname)) return '';
  const id=u.hostname==='youtu.be'?u.pathname.replace(/^\/|\/$/g,''):/^\/watch\/?$/.test(u.pathname)?u.searchParams.get('v'):/^\/(?:shorts|live|embed|v)\/([\w-]+)\/?$/.exec(u.pathname)?.[1];
  return /^[\w-]{11}$/.test(id||'') ? id : '';
}
export const serviceIdentity=config=>JSON.stringify([config?.endpoint||'',config?.model||'']);
export const canWrite=async root=>!!root && await root.queryPermission({mode:'readwrite'}).then(p=>p==='granted',()=>false);
const issued=new WeakSet();

// A draft lives only in this popup's memory. Closing the popup discards it.
export async function preparePreview() {
  const at=Date.now();
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id || !/^https?:\/\//i.test(tab.url||'')) throw new Error('这个页面不支持剪藏。请在文章或 YouTube 视频页点页笺。');
  const target={tabId:tab.id};
  let page;
  try { [page]=await chrome.scripting.executeScript({target,world:'ISOLATED',files:['extract.js']}); }
  catch { throw new Error('无法读取此页。请确认它是允许扩展访问的普通网页。'); }
  let clip=page?.result;
  if(!clip || !page.documentId) throw new Error('没有取得可预览的内容。可选中网页正文再试。');
  if(!samePage(clip.url,tab.url)) throw new Error('原网页已切换，请重新打开预览。');
  if(clip.kind==='youtube') {
    const id=videoId(tab.url);
    const [video]=await chrome.scripting.executeScript({target:{...target,documentIds:[page.documentId]},world:'MAIN',files:['video-preview.js']});
    clip=video?.result;
    if(!id || !clip || clip.kind!=='youtube' || clip.videoId!==id) throw new Error('视频已切换或尚未就绪，请重新预览。');
  } else if(!['article','selection'].includes(clip.kind) || !clip.body?.trim()) throw new Error('未找到正文。请选中要保留的内容后重试。');
  const [{root,revision},config,current]=await Promise.all([getRootState(),getConfig(),chrome.tabs.get(tab.id)]);
  if(!samePage(current.url,tab.url)) throw new Error('原网页已切换，请重新打开预览。');
  const folderName=root?.name || '', folderReady=await canWrite(root);
  const draft={tabId:tab.id,windowId:tab.windowId,documentId:page.documentId,sourceUrl:tab.url,at,clip,root,folderName,folderReady,rootRevision:revision,
    aiReady:!!(config.endpoint && config.model),service:serviceIdentity(config),excerpt:clip.excerpt||clip.description||'',
    estimatedPath:`${folderName?folderName+'/':''}${estimatedRelativePath(clip,new Date(at))}`,
    captionStatus:clip.kind==='youtube'?(clip.cues?.length?'read':clip.captionStatus==='unavailable'?'unavailable':'pending'):''};
  issued.add(draft); return draft;
}

// This is called ONLY from the popup's confirm button. No close/visibility handler submits.
export async function confirmPreview(draft) {
  if(!issued.has(draft) || !draft.folderReady) throw new Error('无法保存这个预览。请重新打开预览并检查目录权限。');
  if(Date.now()-draft.at>15*60_000) throw new Error('预览已过期，请关闭弹窗后重新预览。');
  issued.delete(draft); // At most one submission, even if two clicks arrive before the first await.
  const {tabId,windowId,documentId,sourceUrl,at,clip,rootRevision,service,aiReady,captionStatus}=draft;
  let response;
  try { response=await chrome.runtime.sendMessage({type:'pageleaf.confirm',task:{source:tabId,windowId,documentId,url:sourceUrl,at,clip,rootRevision,service,aiReady,captionStatus}}); }
  catch { throw new Error('任务未能交接，请查看图标状态后重新预览。'); }
  if(!response?.ok) throw new Error(response?.message || '未能开始保存，请关闭后重新预览。');
}
