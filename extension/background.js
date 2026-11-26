import {getRootState} from './store.js';
import {canWrite,samePage} from './preview.js';

export async function badge(tabId, text, title, color='#245566') {
  if (!Number.isInteger(tabId)) return;
  await Promise.allSettled([chrome.action.setBadgeText({tabId,text}),chrome.action.setBadgeBackgroundColor({tabId,color}),chrome.action.setTitle({tabId,title:`页笺：${title}`})]);
}
export async function report(tabId,state,message,path='') {
  await chrome.storage.local.set({lastResult:{state,message,path,time:Date.now()}});
  await badge(tabId,{ok:'✓',warn:'!',error:'×'}[state], message,state==='ok'?'#246052':state==='warn'?'#875120':'#933e42');
}

// No onClicked/onInstalled action starts a job or opens options. Chrome opens the native popup.
// The only route that creates a task accepts an explicit confirmation from our popup.
const pending=new Map();
async function startConfirmed(task) {
  if (!Number.isInteger(task?.source) || !task.documentId || !['article','selection','youtube'].includes(task.clip?.kind) || !Number.isFinite(task.at) || Date.now()-task.at>900000) throw new Error('预览已失效，请重新打开。');
  const tab=await chrome.tabs.get(task.source).catch(()=>null);
  if(!tab || !samePage(tab.url,task.url)) throw new Error('页面已经切换，本次未保存。请重新预览。');
  // Same URL after a reload is still a different document. Verify the specific previewed document.
  let checked;
  try { [checked]=await chrome.scripting.executeScript({target:{tabId:task.source,documentIds:[task.documentId]},func:()=>location.href}); } catch { /* Navigated/reloaded */ }
  if(!checked || checked.documentId!==task.documentId || !samePage(checked.result,task.url)) throw new Error('预览对应的页面已变更，本次未保存。请重新预览。');
  const {root,revision}=await getRootState();
  if(revision!==task.rootRevision || !await canWrite(root)) throw new Error('保存目录或权限已改变。请检查目录并重新预览。');
  const ticket=crypto.randomUUID();
  // In-memory transfer, never a durable cache of the user's article, selection or API key.
  // Single-use. A worker/browser restart fails closed rather than replaying a confirmed job.
  const timer=setTimeout(()=>pending.delete(ticket),60000);
  pending.set(ticket,{task,timer});
  try {
    await badge(task.source,'…','已确认，正在保存');
    await chrome.tabs.create({url:chrome.runtime.getURL(`job.html#${ticket}`),active:false,windowId:tab.windowId});
    return {ok:true};
  } catch { clearTimeout(timer); pending.delete(ticket); await report(task.source,'error','无法启动保存任务。'); throw new Error('无法启动保存任务，请重新预览。'); }
}
if (typeof ServiceWorkerGlobalScope!=='undefined' && self instanceof ServiceWorkerGlobalScope) {
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id) return;
    if(message?.type==='pageleaf.confirm' && sender.url===chrome.runtime.getURL('popup.html')) {
      startConfirmed(message.task).then(reply,e=>reply({ok:false,message:e.message})); return true;
    }
    if(message?.type==='pageleaf.claim' && /^[\da-f-]{36}$/.test(message.ticket) && Number.isInteger(sender.tab?.id) && sender.url===chrome.runtime.getURL(`job.html#${message.ticket}`)) {
      const r=pending.get(message.ticket); pending.delete(message.ticket);
      if(r)clearTimeout(r.timer); reply({ok:!!r,task:r?.task});
    }
  });
  chrome.tabs.onRemoved.addListener(async id=>{
    const k=`running:${id}`, r=(await chrome.storage.session.get(k))[k];
    if(r){await chrome.storage.session.remove(k); await report(r.source,'error','保存任务被关闭，请检查文件后重试。');}
  });
}
