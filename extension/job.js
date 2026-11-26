import {getRootState,getConfig,getServiceInfo} from './store.js';
import {summarize,downloadImage} from './network.js';
import {saveClip} from './archive.js';
import {clipKey,withClipLock} from './dedup.js';
import {busySlot,canConfirm,rememberResult,resolveCapture} from './capture-state.js';
import {aiUnavailable,canWrite,samePage,serviceIdentity} from './preview.js';

const status=document.querySelector('#step');
const progress=text=>{status.textContent=text;};
async function fillCaptions(task,clip,notes) {
  if(clip.kind!=='youtube' || task.captionStatus!=='pending') return;
  try {
    const tab=await chrome.tabs.get(task.source);
    if(!samePage(task.url,tab.url)) throw Error('changed');
    const [item]=await chrome.scripting.executeScript({target:{tabId:task.source,documentIds:[task.documentId]},world:'MAIN',files:['video.js']});
    const v=item?.result;
    if(!v || v.videoId!==clip.videoId || item.documentId!==task.documentId) throw Error('changed');
    clip.cues=Array.isArray(v.cues)?v.cues:[];clip.language=v.language||'';clip.captionKind=v.captionKind||'';
  } catch {notes.push('无法补取原视频字幕，已保留预览中的视频信息。');}
}
async function currentRoot(task){
  const {root,revision}=await getRootState();
  if(!root || revision!==task.rootRevision || !await canWrite(root))throw Error('目录或权限已改变，请检查后重新预览。');
  return root;
}
async function archive(task,jobTabId,slot){
  const root=await currentRoot(task),clip=task.clip;
  // Two native popups can both preview an unsaved item. Only the winner reaches
  // external I/O: hold this identity's lock until the note and its receipt commit.
  const found=await resolveCapture(root,clip,task.key,task.rootRevision,{checkBusy:false});
  if(found.state==='saved'||found.state==='partial')return {state:found.state==='saved'?'ok':'warn',path:found.path,message:`未重复保存：${found.path}`+(found.state==='partial'?'。'+(found.message||'原笔记有未完成的项目。'):'')};
  if(!canConfirm(found))throw Error(found.message||'无法核实保存状态。');
  await chrome.storage.session.set({[slot]:{jobTabId}});
  const notes=[];
  progress('正在检查可用字幕');await fillCaptions(task,clip,notes);
  if(clip.kind!=='selection' && (clip.kind!=='youtube' || clip.cues?.length)){
    try {
      if(!task.aiReady)throw Error(task.aiHold||'预览时 AI 服务未就绪，未发送内容。');
      const config=await getConfig(),hold=aiUnavailable(config);
      if(hold)throw Error(hold);
      if(serviceIdentity(config)!==task.service)throw Error('摘要服务设置已改变，未发送内容。');
      clip.summary=await summarize(clip,config,{onProgress:progress,beforeRequest:async()=>{
        const current=await getServiceInfo();
        if(aiUnavailable(current)||serviceIdentity(current)!==task.service)throw Error('Key 已锁定或服务设置已改变，已停止后续摘要请求。');
      }});
    }catch(e){clip.summaryError=e.message;notes.push(`摘要生成失败：${e.message}`);}
  }else if(clip.kind==='youtube')notes.push('未取得字幕，未生成内容摘要。');
  progress('正在写入 Markdown 与本地图片');await currentRoot(task);
  const result=await saveClip(root,clip,{date:new Date(task.at),warningsBeforeSave:notes,getImage:url=>downloadImage(url,task.url,fetch,{cover:clip.kind==='youtube'}),onProgress:progress});
  const warnings=[...new Set([...notes,...result.warnings])];
  return {state:warnings.length||!result.indexed?'warn':'ok',path:result.path,message:(result.duplicate?'未重复保存':result.indexed?'已保存':'笔记已保存，索引未更新')+`：${result.path}`+(warnings.length?`。${warnings.slice(0,3).join('；')}`:'')};
}
async function run(){
  const job=await chrome.tabs.getCurrent();
  const {task}=(await chrome.runtime.sendMessage({type:'pageleaf.claim',ticket:location.hash.slice(1)}))||{};
  if(!task){progress('未找到有效的确认，未保存任何内容。请回到原网页重新预览。');return;}
  const {key,rootRevision,source}=task, rkey=`running:${job.id}`,slot=busySlot(rootRevision,key);
  await chrome.storage.session.set({[rkey]:{key,rootRevision,source}});
  const failed=e=>({state:'error',message:`剪藏未完成：${String(e?.message||'请检查文件夹后重试。').slice(0,260)}`,path:''});
  const finish=async out=>{
    // Disk is authoritative. A failure updating browser UI/storage cannot turn
    // a committed Markdown into a second save or a false 'no note' error.
    try{await rememberResult(task,out.state,out.message,out.path);}finally{
      await chrome.runtime.sendMessage({type:'pageleaf.finished',key,state:out.state,path:out.path}).catch(()=>{});
    }
  };
  let finished=false;
  try{
    if(await clipKey(task.clip)!==key)throw Error('剪藏内容已改变，请重新预览。');
    await withClipLock(key,async()=>{
      let out;try{out=await archive(task,job.id,slot);}catch(e){out=failed(e);}
      finished=true;
      try{await finish(out);}finally{await chrome.storage.session.remove(slot);}
    });
  }catch(e){if(!finished)await finish(failed(e));}finally{
    await chrome.storage.session.remove(rkey);
    await chrome.tabs.remove(job.id);
  }
}
run().catch(()=>progress('处理已中断。请重新打开页笺，核对归档状态。'));
