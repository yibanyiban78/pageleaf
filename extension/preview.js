import {getRootState, getServiceInfo} from './store.js';
import {estimatedRelativePath} from './archive.js';
import {clipKey} from './dedup.js';
import {resolveCapture,canConfirm} from './capture-state.js';

export function samePage(left, right) {
  try { const a=new URL(left), b=new URL(right); return /^https?:$/.test(a.protocol) && a.href===b.href; }
  catch { return false; }
}
export function videoId(input) {
  const u=new URL(input);
  if(u.protocol!=='https:' || u.port || u.username || u.password || !/^(?:(?:(?:www|m|music)\.)?youtube\.com|(?:www\.)?youtube-nocookie\.com|youtu\.be)$/.test(u.hostname)) return '';
  const id=u.hostname==='youtu.be'?u.pathname.replace(/^\/|\/$/g,''):/^\/watch\/?$/.test(u.pathname)?u.searchParams.get('v'):/^\/(?:shorts|live|embed|v)\/([\w-]+)\/?$/.exec(u.pathname)?.[1];
  return /^[\w-]{11}$/.test(id||'') ? id : '';
}
export const serviceIdentity=config=>JSON.stringify([config?.endpoint||'',config?.model||'',config?.revision||'']);
export function aiUnavailable(config) {
  if (config?.malformed || config?.credentialState==='invalid') return 'AI 配置无法读取；未发送正文或字幕，请在设置中检查。';
  if (config?.credentialState==='legacy') return '旧 Key 等待保护；请在设置中为原 Key 设置本地口令。';
  if (config?.credentialState==='locked') return 'Key 已锁定；请在设置中输入本地口令解锁。';
  if (!config?.endpoint || !config?.model || !['none','unlocked'].includes(config.credentialState)) return 'AI 服务未就绪，不生成摘要。';
  return '';
}
export const canWrite=async root=>!!root && await root.queryPermission({mode:'readwrite'}).then(p=>p==='granted',()=>false);
const issued=new WeakSet();

// A draft lives only in this popup's memory. Closing the popup discards it.
export async function preparePreview() {
  const at=Date.now();
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  try { return await previewTab(tab,at); }
  catch(error) {
    const message=error?.message || '无法读取这个页面，请重新打开预览。';
    if(tab?.id) await chrome.runtime.sendMessage({type:'pageleaf.previewProblem',tabId:tab.id,url:tab.url||''}).catch(()=>{});
    throw Object.assign(new Error(message),{captureStatus:{state:'error',retryable:false,message}});
  }
}
async function previewTab(tab,at) {
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
  // Preview can describe the vault, but never needs the actual credential.
  const [{root,revision},config,current]=await Promise.all([getRootState(),getServiceInfo().catch(()=>({malformed:true})),chrome.tabs.get(tab.id)]);
  const aiHold=aiUnavailable(config);
  if(!samePage(current.url,tab.url)) throw new Error('原网页已切换，请重新打开预览。');
  const folderName=root?.name || '', folderReady=await canWrite(root);
  const draft={tabId:tab.id,windowId:tab.windowId,documentId:page.documentId,sourceUrl:tab.url,at,clip,root,folderName,folderReady,rootRevision:revision,
    aiReady:!aiHold,aiHold,service:serviceIdentity(config),excerpt:clip.excerpt||clip.description||'',
    estimatedPath:`${folderName?folderName+'/':''}${estimatedRelativePath(clip,new Date(at))}`,
    captionStatus:clip.kind==='youtube'?(clip.cues?.length?'read':clip.captionStatus==='unavailable'?'unavailable':'pending'):''};
  draft.key=await clipKey(clip);
  issued.add(draft);
  await refreshCaptureStatus(draft);
  return draft;
}

// No recapture or writes to the user's folder. A displayed selection stays the
// original immutable snapshot, even if the source highlight later changes.
export async function refreshCaptureStatus(draft) {
  const {root,revision}=await getRootState();
  const tab=await chrome.tabs.get(draft.tabId).catch(()=>null);
  let state;
  if (!tab || !samePage(draft.sourceUrl,tab.url)) state={state:'error',message:'原网页已切换，请关闭并重新预览。'};
  else if (revision!==draft.rootRevision) state={state:'error',message:'保存目录已改变，请关闭并重新预览。'};
  else if (!root) state={state:'error',message:'尚未选择保存文件夹。请先到设置选择目录。'};
  else if (!await canWrite(root)) state={state:'error',message:'文件夹需要重新授权；无法核实保存状态。'};
  else state=await resolveCapture(root,draft.clip,draft.key,revision);
  draft.captureStatus=state;
  // Changes to optional toolbar decoration must never block archiving.
  if(tab && samePage(draft.sourceUrl,tab.url) && revision===draft.rootRevision){
    await chrome.runtime.sendMessage({type:'pageleaf.previewState',tabId:draft.tabId,documentId:draft.documentId,url:draft.sourceUrl,key:draft.key,rootRevision:revision,state:state.state}).catch(()=>{});
  }
  return state;
}

// This is called ONLY from the popup's confirm button. No close/visibility handler submits.
export async function confirmPreview(draft) {
  if(!issued.has(draft) || !draft.folderReady) throw new Error('无法保存这个预览。请重新打开预览并检查目录权限。');
  if(Date.now()-draft.at>15*60_000) throw new Error('预览已过期，请关闭弹窗后重新预览。');
  issued.delete(draft); // At most one submission, even if two clicks arrive before the first await.
  const state=await refreshCaptureStatus(draft);
  if(!canConfirm(state)){
    const error=new Error(state.message || (state.path ? '已保存，无需重复剪藏。' : '当前不能保存，请重新预览。'));
    error.captureStatus=state;throw error;
  }
  const {tabId,windowId,documentId,sourceUrl,at,clip,rootRevision,service,aiReady,aiHold,captionStatus,key}=draft;
  let response;
  try { response=await chrome.runtime.sendMessage({type:'pageleaf.confirm',task:{source:tabId,windowId,documentId,url:sourceUrl,at,clip,rootRevision,service,aiReady,aiHold,captionStatus,key}}); }
  catch { throw new Error('任务未能交接，请查看图标状态后重新预览。'); }
  if(!response?.ok) throw new Error(response?.message || '未能开始保存，请关闭后重新预览。');
}
