import {getRootState,getConfig} from './store.js';
import {summarize,downloadImage} from './network.js';
import {saveClip} from './archive.js';
import {report} from './background.js';
import {canWrite,samePage,serviceIdentity} from './preview.js';

const status=document.querySelector('#step');
const progress=text=>{status.textContent=text;};
async function fillCaptions(task,clip,notes) {
  if(clip.kind!=='youtube' || task.captionStatus!=='pending') return;
  // Never recapture the selection or metadata. Only supplement captions for the confirmed video.
  try {
    const tab=await chrome.tabs.get(task.source);
    if(!samePage(task.url,tab.url)) throw new Error('changed');
    const [item]=await chrome.scripting.executeScript({target:{tabId:task.source,documentIds:[task.documentId]},world:'MAIN',files:['video.js']});
    const v=item?.result;
    if(!v || v.videoId!==clip.videoId || item.documentId!==task.documentId) throw new Error('changed');
    clip.cues=Array.isArray(v.cues)?v.cues:[];
    clip.language=v.language||''; clip.captionKind=v.captionKind||'';
  } catch {notes.push('无法补取原视频字幕，已保留预览中的视频信息。');}
}
async function run(){
  const jobTab=await chrome.tabs.getCurrent(); const rkey=`running:${jobTab.id}`;
  const {task}=(await chrome.runtime.sendMessage({type:'pageleaf.claim',ticket:location.hash.slice(1)}))||{};
  if (!task) {status.textContent='未找到有效的确认，未保存任何内容。请回到原网页重新预览。';return;}
  await chrome.storage.session.set({[rkey]:{source:task.source}});
  let stage='目录';
  try {
    const {root,revision}=await getRootState();
    if(!root || !await canWrite(root) || task.rootRevision!==revision) throw new Error('目录或权限已改变。请在预览中检查目录后重试。');
    const clip=task.clip, notes=[];
    stage='字幕';progress('正在检查可用字幕');await fillCaptions(task,clip,notes);
    stage='摘要';
    if(clip.kind!=='selection' && (clip.kind!=='youtube' || clip.cues?.length)){
      try {
        const config=await getConfig();
        if(task.aiReady && serviceIdentity(config)!==task.service) throw new Error('摘要服务设置已改变，未发送正文。');
        clip.summary=await summarize(clip,task.aiReady?config:null,{onProgress:progress});
      } catch(e){clip.summaryError=e.message;notes.push(`摘要生成失败：${e.message}`);}
    } else if(clip.kind==='youtube') notes.push('未取得字幕，未生成内容摘要。');
    stage='文件'; progress('正在写入 Markdown 与本地图片');
    const result=await saveClip(root,clip,{date:new Date(task.at),getImage:url=>downloadImage(url,task.url,fetch,{cover:clip.kind==='youtube'}),onProgress:progress});
    const warnings=[...new Set([...notes,...result.warnings])];
    const message=(result.indexed?'已保存':'笔记已保存，索引未更新')+`：${result.path}`+(warnings.length?`。${warnings.slice(0,3).join('；')}`:'');
    await report(task.source,warnings.length || !result.indexed?'warn':'ok',message,result.path);
  } catch(e){
    await report(task.source,'error',`剪藏未完成（${stage}）：${String(e.message||e.name).slice(0,260)}`);
  } finally {
    await chrome.storage.session.remove(rkey);
    await chrome.tabs.remove(jobTab.id);
  }
}
run().catch(()=>{status.textContent='任务意外中断。请关闭此页并重新预览。';});
