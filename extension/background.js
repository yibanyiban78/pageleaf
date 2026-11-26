import {getRootState} from './store.js';
import {canWrite,samePage} from './preview.js';
import {paintIndicator} from './indicator.js';
import {rememberResult,statusFromResult} from './capture-state.js';

const pending=new Map();
const SLOT='pageleafTabIndicators';
const busySlot=t=>`clipBusy:${t.rootRevision}:${t.key}`;
const validKey=k=>typeof k==='string' && /^[0-9a-f]{64}$/.test(k);
const titles={new:'未保存',saved:'已保存',partial:'笔记已保存，有异常',error:'保存或核对异常',pending:'正在保存',unknown:'预览剪藏'};
const routeHash=async url=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url))),b=>b.toString(16).padStart(2,'0')).join('');
// Serialize updates so a slow icon or lookup for an earlier page cannot finish
// painting *after* a navigation reset. Only previously interacted tabs are bound.
let tail=Promise.resolve();
const queued=fn=>{const r=tail.then(fn);tail=r.catch(()=>{});return r;};
const getBindings=async()=> (await chrome.storage.session.get(SLOT))[SLOT] || {};
const putBindings=map=>chrome.storage.session.set({[SLOT]:map});
const paint=(tab,state)=>paintIndicator(tab,state,`页笺：${titles[state]||titles.unknown}`).catch(()=>{});
async function forgetTab(id,removed=false){
  const map=await getBindings();if(!Object.hasOwn(map,id))return;
  delete map[id];await putBindings(map);if(!removed)await paint(id,'unknown');
}
async function bindPreview(m,problem=false){
  if(!Number.isInteger(m.tabId))return;
  const tab=await chrome.tabs.get(m.tabId).catch(()=>null);
  if(!tab || (tab.url||'')!==m.url || (!problem && (!validKey(m.key) || !Object.hasOwn(titles,m.state))))return;
  if(!problem){
    const {revision}=await getRootState();if(revision!==m.rootRevision)return;
    // A reload of the same URL is a different document.
    const alive=await chrome.scripting.executeScript({target:{tabId:m.tabId,documentIds:[m.documentId]},func:()=>true}).catch(()=>[]);
    if(alive[0]?.documentId!==m.documentId)return;
  }
  const map=await getBindings();map[m.tabId]={key:problem?'':m.key,rootRevision:problem?'':m.rootRevision,documentId:problem?'':m.documentId,route:await routeHash(m.url)};
  await putBindings(map);await paint(m.tabId,problem?'error':m.state);
}
async function reflect(task,state){
  if(!validKey(task?.key))return;
  const {revision}=await getRootState();if(revision!==task.rootRevision)return;
  const map=await getBindings();
  await Promise.all(Object.entries(map).filter(([,v])=>v.key===task.key && v.rootRevision===task.rootRevision).map(async([tabId,v])=>{
    const id=Number(tabId),t=await chrome.tabs.get(id).catch(()=>null);
    if(!t?.url || await routeHash(t.url)!==v.route)return;
    await paint(id,state);
  }));
}
async function complete(task,state,message,path=''){
  const result=await rememberResult(task,state,message,path);
  await queued(()=>reflect(task,statusFromResult(result).state));
}
// Never persist an unconfirmed preview or the queued article/subtitle/selection.
async function startConfirmed(task){
  if(!Number.isInteger(task?.source)||!task.documentId||!validKey(task.key)||!['article','selection','youtube'].includes(task.clip?.kind)||!Number.isFinite(task.at)||Date.now()-task.at>900000)throw Error('预览已失效，请重新打开。');
  const tab=await chrome.tabs.get(task.source).catch(()=>null);
  if(!tab||!samePage(tab.url,task.url))throw Error('页面已经切换，本次未保存。请重新预览。');
  const checked=await chrome.scripting.executeScript({target:{tabId:task.source,documentIds:[task.documentId]},func:()=>location.href}).catch(()=>[]);
  if(checked[0]?.documentId!==task.documentId||!samePage(checked[0]?.result,task.url))throw Error('预览对应的页面已变更，本次未保存。请重新预览。');
  const {root,revision}=await getRootState();if(revision!==task.rootRevision||!await canWrite(root))throw Error('保存目录或权限已改变。请检查目录并重新预览。');
  const ticket=crypto.randomUUID(),timer=setTimeout(()=>pending.delete(ticket),60000);pending.set(ticket,{task,timer});
  try{await queued(()=>reflect(task,'pending'));await chrome.tabs.create({url:chrome.runtime.getURL(`job.html#${ticket}`),active:false,windowId:tab.windowId});return {ok:true};}
  catch{clearTimeout(timer);pending.delete(ticket);await complete(task,'error','无法启动保存任务。');throw Error('无法启动保存任务，请重新预览。');}
}
if(typeof ServiceWorkerGlobalScope!=='undefined' && self instanceof ServiceWorkerGlobalScope){
  chrome.runtime.onMessage.addListener((m,sender,reply)=>{
    if(sender.id!==chrome.runtime.id)return;
    const popup=sender.url===chrome.runtime.getURL('popup.html');
    const job=sender.url?.startsWith(chrome.runtime.getURL('job.html#')) && Number.isInteger(sender.tab?.id);
    let work;
    if(popup && m?.type==='pageleaf.confirm')work=startConfirmed(m.task);
    else if(popup && ['pageleaf.previewState','pageleaf.previewProblem'].includes(m?.type))work=queued(()=>bindPreview(m,m.type==='pageleaf.previewProblem'));
    else if(job && m?.type==='pageleaf.claim' && /^[\da-f-]{36}$/.test(m.ticket) && sender.url===chrome.runtime.getURL(`job.html#${m.ticket}`)){
      const r=pending.get(m.ticket);pending.delete(m.ticket);if(r)clearTimeout(r.timer);reply({ok:!!r,task:r?.task});return true;
    }else if(job && m?.type==='pageleaf.finished'){
      work=(async()=>{const running=(await chrome.storage.session.get(`running:${sender.tab.id}`))[`running:${sender.tab.id}`];if(running && running.key===m.key)await reflectAfterSave(running,m);})();
    }else return;
    Promise.resolve(work).then(value=>reply(value ?? {ok:true}),e=>reply({ok:false,message:e?.message||'本次操作未完成。'}));return true;
  });
  chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading'||typeof change.url==='string')queued(()=>forgetTab(id)).catch(()=>{});});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session' && Object.hasOwn(changes,'pageleafRootEpoch'))queued(async()=>{
    const map=await getBindings();await putBindings({});await Promise.all(Object.keys(map).map(k=>paint(Number(k),'unknown')));
  }).catch(()=>{});});
  chrome.tabs.onRemoved.addListener(async id=>{
    queued(()=>forgetTab(id,true)).catch(()=>{});
    const name=`running:${id}`,r=(await chrome.storage.session.get(name))[name];if(!r)return;
    await chrome.storage.session.remove(name);
    const slot=busySlot(r);if((await chrome.storage.session.get(slot))[slot]?.jobTabId===id)await chrome.storage.session.remove(slot);
    await complete(r,'error','保存任务被关闭，请核对笔记与索引后重试。');
  });
}
async function reflectAfterSave(task,m){
  // Only decoration here: the job records the outcome before notifying the worker.
  if(!['ok','warn','error'].includes(m.state))return;
  await queued(()=>reflect(task,statusFromResult(m).state));
}
