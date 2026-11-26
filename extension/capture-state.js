// In browser-local storage keep bounded errors from confirmed jobs and the last
// result, not URLs or selected content from merely visited/previewed pages.
import {lookupClip} from './dedup.js';

const FAILURES='pageleafFailedCaptures';
const validKey=k=>typeof k==='string' && /^[0-9a-f]{64}$/.test(k);
const failureId=(revision,key)=>`${revision}:${key}`;
export const busySlot=(revision,key)=>`clipBusy:${revision}:${key}`;
export const canConfirm=s=>s?.state==='new' || (s?.state==='error' && s.retryable===true);
export async function resolveCapture(root,clip,key,revision,{checkBusy=true}={}) {
  if(!validKey(key))return {state:'error',message:'无法识别这次剪藏，请重新预览。'};
  try {
    if(checkBusy){
      const slot=busySlot(revision,key), task=(await chrome.storage.session.get(slot))[slot];
      const job=Number.isInteger(task?.jobTabId) && await chrome.tabs.get(task.jobTabId).catch(()=>null);
      // A concurrent writer may have created (but not closed) its locator. Do
      // not briefly turn that into an error or present a second confirmation.
      if(job && job.url?.startsWith(chrome.runtime.getURL('job.html#')))return {state:'pending',message:'同一内容正在保存，请稍候。'};
    }
    const disk=await lookupClip(root,clip,key);
    if(disk.state==='saved' || disk.state==='partial')return disk;
    if(disk.state!=='new')throw Error('无法核对当前目录，未开始保存。');
    const failures=(await chrome.storage.local.get(FAILURES))[FAILURES] || {};
    const failed=failures[failureId(revision,key)];
    if(failed)return {state:'error',retryable:true,message:failed.message || '上次未保存成功，可以重试。'};
    return {state:'new'};
  } catch(e){return {state:'error',retryable:false,message:e?.message || '无法核对这个剪藏目录。请检查目录权限后重新打开。'};}
}
export async function rememberResult(task,state,message,path='') {
  const {rootRevision,key}=task, time=Date.now();
  const result={state,message:String(message||'').slice(0,600),path,time,key,rootRevision};
  await navigator.locks.request('pageleaf:capture-results',async()=>{
    const values=await chrome.storage.local.get(FAILURES), failures=values[FAILURES]||{};
    if(validKey(key) && typeof rootRevision==='string'){
      const id=failureId(rootRevision,key);
      delete failures[id];
      if(state==='error' && !path) failures[id]={time,message:result.message};
      const keys=Object.keys(failures);for(const old of keys.slice(0,Math.max(0,keys.length-128)))delete failures[old];
    }
    await chrome.storage.local.set({[FAILURES]:failures,lastResult:result});
  });
  return result;
}
export const statusFromResult = r => ({state:r.path ? (r.state==='ok'?'saved':'partial') : 'error', path:r.path || '',message:r.message,retryable:r.state==='error' && !r.path});
