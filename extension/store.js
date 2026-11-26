// Handles require structured cloning (IndexedDB), not JSON or chrome.storage.sync.
let opened;
function database() {
  return opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('pageleaf-local-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('preferences');
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opened = null; }; resolve(db); };
    request.onerror = () => { opened = null; reject(request.error); };
  });
}
async function entry(key, write, value) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('preferences', write ? 'readwrite' : 'readonly');
    const store = tx.objectStore('preferences');
    const request = write ? store.put(value, key) : store.get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('无法访问本地扩展设置。'));
  });
}
export const getRoot = () => entry('root', false);
// Keep the old database and key intact. Existing 1.0 roots have revision 'legacy'.
// The revision prevents a confirmed snapshot from going into a different folder.
export async function getRootState() {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('preferences','readonly'), s=tx.objectStore('preferences');
    const root=s.get('root'), rev=s.get('rootRevision');
    tx.oncomplete=()=>resolve({root:root.result,revision:rev.result || 'legacy'});
    tx.onabort=tx.onerror=()=>reject(tx.error || new Error('读取保存目录失败。'));
  });
}
export async function setRoot(handle) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('preferences','readwrite'), s=tx.objectStore('preferences');
    s.put(handle,'root'); s.put(crypto.randomUUID(),'rootRevision');
    tx.oncomplete=()=>resolve(); tx.onabort=tx.onerror=()=>reject(tx.error || new Error('保存目录设置失败。'));
  });
}
export const getConfig = async () => (await entry('service', false)) || {endpoint:'', model:'', key:''};
export const setConfig = ({endpoint, model, key}) => entry('service', true, {endpoint,model,key});
