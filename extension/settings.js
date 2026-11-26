import {getRoot,setRoot,getConfig,setConfig} from './store.js';
import {apiURL,hostPattern} from './network.js';
const $=s=>document.querySelector(s); const origins=['http://*/*','https://*/*'];
let directory=null, config={endpoint:'',model:'',key:''}, allImages=false;
function say(id,text,err=false){const el=$(id);el.textContent=text;el.classList.toggle('error',err);}
async function drawDir(){directory=await getRoot();const ok=directory && await directory.queryPermission({mode:'readwrite'}).then(p=>p==='granted',()=>false);$('#dirname').textContent=directory?.name || '未选择文件夹';$('#authorize').hidden=!directory || ok;$('#choose').textContent=directory?'更换文件夹':'选择文件夹';if(directory&&!ok)say('#dirmsg','目录需要重新授权。',true);}
$('#choose').onclick=async()=>{try{const handle=await window.showDirectoryPicker({id:'pageleaf-root',mode:'readwrite'});await setRoot(handle);await drawDir();say('#dirmsg','已设置。之后的笔记将归档到这里。');}catch(e){if(e.name!=='AbortError')say('#dirmsg','无法选择该目录。请选一个专用子文件夹，并允许读写。',true);}};
$('#authorize').onclick=async()=>{try{const p=await directory.requestPermission({mode:'readwrite'});await drawDir();say('#dirmsg',p==='granted'?'已恢复目录读写权限。':'未获授权，未更改保存位置。',p!=='granted');}catch{say('#dirmsg','无法重新授权，请重新选择原文件夹。',true);}};
function drawService(){ $('#endpoint').value=config.endpoint;$('#model').value=config.model;$('#key').value='';$('#key').placeholder=config.key?'已保存，留空可保留':'按服务商要求填写';$('#forget').hidden=!config.endpoint; }
$('#service').onsubmit=async event=>{
  event.preventDefault();const field=$('#endpoint');let url;
  try{url=apiURL(field.value.trim());}catch(e){field.setCustomValidity(e.message);field.reportValidity();return;}
  const model=$('#model').value.trim();if(!model){$('#model').setCustomValidity('请输入服务商提供的模型名称。');$('#model').reportValidity();return;}
  const sameEndpoint=config.endpoint && apiURL(config.endpoint).href===url.href;
  const key=$('#key').value.trim() || (sameEndpoint ? config.key : '');
  if(!sameEndpoint && config.key && !key){say('#aimsg','服务地址已变更，不会沿用旧 Key。请输入新 Key；如新服务不需 Key，请先移除旧设置。',true);$('#key').focus();return;}
  $('#save').disabled=true;
  try{const granted=await chrome.permissions.request({origins:[hostPattern(url)]});if(!granted){say('#aimsg','未获服务访问权限，已保留原设置。',true);return;}
    const next={endpoint:field.value.trim(),model,key};await setConfig(next);config=next;drawService();say('#aimsg',`设置已保存。摘要仅发送至 ${url.origin}。`);
  }catch{say('#aimsg','无法保存。请检查 API 地址和站点权限。',true);}finally{$('#save').disabled=false;}
};
for(const id of ['#endpoint','#model']) $(id).addEventListener('input',e=>e.target.setCustomValidity(''));
$('#forget').onclick=async()=>{if(!confirm('移除此浏览器中已保存的 API 地址、模型和 Key？已归档的笔记不受影响。'))return;try{await setConfig({endpoint:'',model:'',key:''});config=await getConfig();drawService();say('#aimsg','服务设置和 Key 已移除。');}catch{say('#aimsg','移除失败，请重试。',true);}};
async function drawImages(){allImages=await chrome.permissions.contains({origins});$('#images').textContent=allImages?'撤销跨站图片权限':'允许跨站保存图片';say('#imgmsg',allImages?'已获跨站权限。仍不会携带网站登录凭据下载配图。':'未额外授权；无法读取的图片会在笔记中保留原图链接。');}
$('#images').onclick=async()=>{try{if(allImages){await chrome.permissions.remove({origins});}else{await chrome.permissions.request({origins});}await drawImages();if(!allImages && config.endpoint && !await chrome.permissions.contains({origins:[hostPattern(apiURL(config.endpoint))]}))say('#aimsg','站点权限已变化。如摘要服务无法连接，请重新保存 AI 设置以授权。');}catch{say('#imgmsg','未能更改站点权限。',true);}};
function drawLast(last){if(!last)return;const el=$('#result');el.dataset.state=last.state;el.textContent=new Date(last.time).toLocaleString('zh-CN')+'\n'+last.message;}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && changes.lastResult)drawLast(changes.lastResult.newValue);});
async function init(){await drawDir();config=await getConfig();drawService();await drawImages();drawLast((await chrome.storage.local.get('lastResult')).lastResult);}
init().catch(()=>say('#dirmsg','读取设置失败，请重新打开扩展设置。',true));
