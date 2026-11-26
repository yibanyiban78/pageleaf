import {getRoot,setRoot,getServiceInfo,saveService,unlockService,lockService,forgetService} from './store.js';
import {apiURL,hostPattern} from './network.js';
const $=s=>document.querySelector(s); const origins=['https://*/*'];
const endpoint=$('#endpoint'), model=$('#model'), key=$('#key');
const pass=$('#vault-pass'), confirmation=$('#vault-confirm');
let directory=null, info=null, allImages=false, busy=false, currentMode='';
function say(id,text,err=false){const el=$(id);el.textContent=text;el.classList.toggle('error',err);}
async function drawDir(){directory=await getRoot();const ok=directory && await directory.queryPermission({mode:'readwrite'}).then(p=>p==='granted',()=>false);$('#dirname').textContent=directory?.name || '未选择文件夹';$('#authorize').hidden=!directory || ok;$('#choose').textContent=directory?'更换文件夹':'选择文件夹';if(directory&&!ok)say('#dirmsg','目录需要重新授权。',true);}
$('#choose').onclick=async()=>{try{const handle=await window.showDirectoryPicker({id:'pageleaf-root',mode:'readwrite'});await setRoot(handle);await drawDir();say('#dirmsg','已设置。之后的笔记将归档到这里。');}catch(e){if(e.name!=='AbortError')say('#dirmsg','无法选择该目录。请选一个专用子文件夹，并允许读写。',true);}};
$('#authorize').onclick=async()=>{try{const p=await directory.requestPermission({mode:'readwrite'});await drawDir();say('#dirmsg',p==='granted'?'已恢复目录读写权限。':'未获授权，未更改保存位置。',p!=='granted');}catch{say('#dirmsg','无法重新授权，请重新选择原文件夹。',true);}};
const fields=[endpoint,model,key,pass,confirmation];
const hints=new Map(fields.map(field=>[field,field.getAttribute('aria-describedby') || '']));
function fieldError(field,message){
  const error=$(`#${field.id}-error`);
  error.textContent=message;error.hidden=!message;field.setCustomValidity(message);
  field.setAttribute('aria-invalid',String(Boolean(message)));
  const description=[hints.get(field),message && error.id].filter(Boolean).join(' ');
  if(description)field.setAttribute('aria-describedby',description);else field.removeAttribute('aria-describedby');
}
function clearSecrets(){for(const field of [key,pass,confirmation]){field.value='';fieldError(field,'');}}
function mode(){
  if(info.malformed)return 'damaged';
  if(info.credentialState==='legacy' || info.credentialState==='locked')return info.credentialState;
  return key.value.trim()?'create':info.credentialState;
}
const restartNote='Key 不写入笔记，不通过 Chrome 同步。Chrome 重启或扩展更新后，Key 仍加密保存在当前资料中，只需解锁，不用重新输入 Key。';
const vaultCopy={
  none:['本地 Key',''],
  create:['为 Key 设置本地口令',restartNote],
  legacy:['旧版 Key 待迁移','已找到此资料中的旧 Key，无需重填。迁移前不会使用它；加密校验成功后才替换旧记录。'],
  locked:['Key 已锁定',restartNote+' 忘记口令无法找回，只能移除服务设置后重新配置。'],
  unlocked:['Key 已解锁',restartNote],
  damaged:['无法读取已保存的 Key','页笺不会使用这条记录。如需重新配置，请移除服务设置；此操作不可撤销。']
};
function drawVault(){
  const next=mode(), creating=next==='create' || next==='legacy', auth=next==='locked' || next==='legacy';
  if(next!==currentMode){for(const field of [pass,confirmation]){field.value='';fieldError(field,'');}currentMode=next;}
  const fixed=next==='legacy' || next==='damaged';
  endpoint.readOnly=model.readOnly=fixed;key.disabled=fixed || next==='locked';
  const existing=info.credentialState==='locked' || info.credentialState==='unlocked';
  key.placeholder=existing?'已加密保存，不会回填':'按服务商要求填写';
  $('#keyhelp').textContent=fixed?'现有 Key 不会显示在此处。':existing?
    '同一 API 地址留空会保留已保存的 Key。'+(next==='locked'?'如需更换 Key，请先解锁。':'输入新 Key 将替换原 Key，并需设置口令。'):
    '不需要 Key 的本地服务可留空。填写 Key 后，需设置本地口令加密保存。';
  $('#vault').hidden=next==='none';$('#vault-state').dataset.state=info.credentialState;
  $('#vault-state').textContent=vaultCopy[next][0];$('#vault-note').textContent=vaultCopy[next][1];
  $('#vault-fields').hidden=!creating && !auth;$('#confirm-row').hidden=!creating;
  $('#pass-label').textContent=next==='locked'?'本地解锁口令':'设置本地口令';
  $('#pass-help').textContent=next==='locked'?'输入在本资料中为 Key 设置的口令。':'至少 12 个字符。请妥善保管，页笺没有云端找回功能。';
  pass.autocomplete=next==='locked'?'current-password':'new-password';
  pass.minLength=creating?12:0;pass.required=creating || auth;pass.disabled=!pass.required;
  confirmation.required=creating;confirmation.disabled=!creating;
  for(const field of [pass,confirmation])field.setAttribute('form',next==='create'?'service':'vault-auth');
  $('#vault-action').hidden=!auth;$('#vault-action').textContent=next==='legacy'?'加密并迁移旧 Key':'解锁 Key';
  $('#vault-lock').hidden=next!=='unlocked';$('#vault-controls').hidden=!auth && next!=='unlocked';
  $('#forget').hidden=!info.endpoint && info.credentialState==='none';$('#save').hidden=fixed;
  for(const id of ['#save','#vault-action','#vault-lock','#forget'])$(id).disabled=busy;
}
function drawService(updated){
  info=updated;endpoint.value=info.endpoint;model.value=info.model;clearSecrets();
  fieldError(endpoint,'');fieldError(model,'');drawVault();
}
function problem(field){
  if(field.disabled || field.readOnly)return '';
  if(field===endpoint){try{apiURL(field.value.trim());}catch(e){return e.message;}}
  if(field===model && !field.value.trim())return '请输入服务商提供的模型名称。';
  if(field===pass){
    if(!field.value)return '请输入本地口令。';
    if(currentMode!=='locked' && Array.from(field.value).length<12)return '本地口令至少需要 12 个字符。';
  }
  if(field===confirmation && (!field.value || field.value!==pass.value))return '两次输入的口令须完全相同，请再输入一次。';
  return '';
}
function validate(list){
  let first=null;
  for(const field of list){const message=problem(field);fieldError(field,message);if(message && !first)first=field;}
  if(first)first.focus();return !first;
}
for(const field of fields){
  field.addEventListener('input',()=>{
    if(!info)return;
    if(field===key)drawVault();
    if(field.validity.customError && !problem(field))fieldError(field,'');
    if(field===pass && confirmation.validity.customError && !problem(confirmation))fieldError(confirmation,'');
    if(field===endpoint)fieldError(key,'');
  });
  // A blur before mouseup must not move a button out from under the pointer.
  // Submit performs the same validation and focuses the first error itself.
  field.addEventListener('blur',event=>{
    if(info && field.value && !busy && !event.relatedTarget?.closest('button'))fieldError(field,problem(field));
  });
}
// Only public metadata is kept between operations. Serialize actions in this tab;
// the store checks the revision as well, in case another settings tab changed it.
async function run(operation,failureText,focusAfter){
  if(busy || !info)return;
  busy=true;drawVault();let succeeded=false;
  try{
    const {updated,message}=await operation();drawService(updated);say('#aimsg',message);succeeded=true;
  }catch{
    clearSecrets();drawVault();
    let message=typeof failureText==='function'?failureText():failureText;
    try{const fresh=await getServiceInfo();if(fresh.revision!==info.revision || fresh.credentialState!==info.credentialState){drawService(fresh);message='当前设置已更改，请检查后重试。';}}catch{/* Do not expose errors containing storage details. */}
    say('#aimsg',message,true);
    if(focusAfter==='#vault-lock' && ['locked','legacy'].includes(currentMode)){
      fieldError(pass,'请重新输入本地口令，再试一次。');pass.focus();
    }
  }finally{busy=false;drawVault();if(succeeded && focusAfter)$(focusAfter).focus();}
}
$('#service').onsubmit=event=>{
  event.preventDefault();if(!info || busy || info.malformed || info.credentialState==='legacy')return;
  drawVault();const creating=currentMode==='create';
  if(!validate(creating?[endpoint,model,pass,confirmation]:[endpoint,model]))return;
  const input=endpoint.value.trim(),url=apiURL(input),newKey=key.value.trim();
  if(info.credentialState!=='none' && !newKey && apiURL(info.endpoint).href!==url.href){
    const message='新地址不能沿用旧 Key。请填写新 Key；若新服务不需要 Key，请先移除旧设置。';
    const field=key.disabled?endpoint:key;fieldError(field,message);field.focus();return;
  }
  const next={endpoint:input,model:model.value.trim(),key:newKey}, phrase=creating?pass.value:undefined;
  let failure='无法保存。请检查设置后重试；已清空凭据输入框。';
  // Invoked synchronously from submit (no await before permissions.request).
  run(async()=>{
    const permission=chrome.permissions.request({origins:[hostPattern(url)]});
    const granted=await permission;
    if(!granted){failure='未获服务访问权限，未保存。已保留原设置；如需 Key，请重新填写 Key 和口令。';throw new Error();}
    const updated=await saveService(next,phrase,info.revision);
    return {updated,message:'设置已保存。'+(updated.credentialState==='locked'?'Key 仍已锁定。':'')};
  },()=>failure);
};
$('#vault-auth').onsubmit=event=>{
  event.preventDefault();if(!info || busy || !['legacy','locked'].includes(currentMode))return;
  const migrating=currentMode==='legacy';if(!validate(migrating?[pass,confirmation]:[pass]))return;
  const phrase=pass.value;
  run(async()=>({updated:await unlockService(phrase,info.revision),message:migrating?'旧 Key 已加密迁移，可在本次会话使用。':'Key 已解锁，可在本次会话使用。'}),
    migrating?'未能完成迁移，请重新输入本地口令后重试。':'未能解锁。请检查本地口令后重试；已保存的 Key 不会被删除。','#vault-lock');
};
$('#vault-lock').onclick=()=>run(async()=>({updated:await lockService(info.revision),message:'Key 已锁定，加密记录仍保存在本地。'}),'未能锁定，请重试。','#vault-pass');
$('#forget').onclick=()=>{
  if(!info || busy || !confirm('确定移除当前 Chrome 资料的 API 地址、模型和 Key？此操作无法撤销，页笺没有云端备份。下次需重新配置，并重新提供 Key（若服务需要）。已归档的笔记不受影响。'))return;
  run(async()=>({updated:await forgetService(info.revision),message:'服务设置和 Key 已移除。如需继续使用摘要，请重新配置。'}),'未能移除，请重试。','#endpoint');
};
window.addEventListener('pagehide',clearSecrets);
// Another settings tab can lock the shared session without changing the envelope.
let refreshSequence=0;
async function refreshService(){
  const before=info,sequence=++refreshSequence;if(!before || busy)return;
  try{
    const fresh=await getServiceInfo();
    if(!busy && sequence===refreshSequence && info===before && (before.revision!==fresh.revision || before.credentialState!==fresh.credentialState)){
      drawService(fresh);say('#aimsg','已显示当前资料最新的服务设置。');
    }
  }catch{/* A later mutation still validates its revision in the store. */}
}
window.addEventListener('focus',refreshService);
async function drawImages(){allImages=await chrome.permissions.contains({origins});$('#images').textContent=allImages?'撤销跨站 HTTPS 图片权限':'允许跨站保存 HTTPS 图片';say('#imgmsg',allImages?'已获 HTTPS 跨站权限。下载配图不会携带网站登录凭据。':'未额外授权；无法读取的图片会在笔记中保留可安全写入的原图链接。');}
$('#images').onclick=async()=>{try{if(allImages){await chrome.permissions.remove({origins});}else{await chrome.permissions.request({origins});}await drawImages();if(!allImages && info?.endpoint && !await chrome.permissions.contains({origins:[hostPattern(apiURL(info.endpoint))]}))say('#aimsg','站点权限已变化。如摘要服务无法连接，请重新保存 AI 设置以授权。');}catch{say('#imgmsg','未能更改站点权限。',true);}};
function drawLast(last){if(!last)return;const el=$('#result');el.dataset.state=last.state;el.textContent=new Date(last.time).toLocaleString('zh-CN')+'\n'+last.message;}
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local' && changes.lastResult)drawLast(changes.lastResult.newValue);
  // Detect the vault slot by name only; never inspect a session change's values.
  if(area==='session' && Object.hasOwn(changes,'pageleafUnlockedService'))refreshService();
});
drawDir().catch(()=>say('#dirmsg','读取目录失败，请重新打开扩展设置。',true));
getServiceInfo().then(drawService).catch(()=>say('#aimsg','读取服务设置失败，请重新打开扩展设置。',true));
drawImages().catch(()=>say('#imgmsg','无法读取站点权限，请重新打开扩展设置。',true));
chrome.storage.local.get('lastResult').then(({lastResult})=>drawLast(lastResult)).catch(()=>say('#result','无法读取最近一次剪藏记录。',true));
