let label='離線準備中…',detail='正在檢查啟動程式與所有航跡圖',ready=false,retryable=false;
let timer:ReturnType<typeof setTimeout>;
function paint(){const b=document.querySelector<HTMLButtonElement>('#offline-status');if(!b)return;b.textContent=label;b.title=detail;b.classList.toggle('good',ready);b.disabled=!retryable;b.onclick=()=>void startOffline(true)}
export function offlineStatusHTML(){return `<button id="offline-status" class="status-pill ${ready?'good':''}" type="button" ${retryable?'':'disabled'}></button>`}
export function refreshConnection(){const e=document.querySelector('#connection-status');if(e){e.textContent=navigator.onLine?'線上':'離線';e.classList.toggle('good',navigator.onLine)}paint()}
function fail(message:string){clearTimeout(timer);ready=false;retryable=true;label='離線未就緒 · 點此重試';detail=message;paint()}
function watchTimeout(){clearTimeout(timer);timer=setTimeout(()=>fail('離線準備逾時，請保持連線後重試'),45000)}
function requestStatus(){navigator.serviceWorker.controller?.postMessage({type:'OFFLINE_STATUS'})}
export async function startOffline(retry=false){
 if(import.meta.env.DEV){label='開發模式 · 未提供離線';detail='請使用正式建置的 HTTPS 網站進行離線測試';paint();return}
 if(!window.isSecureContext||!('serviceWorker'in navigator)){fail('此瀏覽器或網址不支援離線快取，請使用 HTTPS');return}
 ready=false;retryable=false;label='離線準備中…';paint();watchTimeout();
 try{const registration=await navigator.serviceWorker.register(import.meta.env.BASE_URL+'sw.js',{updateViaCache:'none'});
 if(retry){await registration.update();if(!registration.installing&&!registration.waiting)registration.active?.postMessage({type:'OFFLINE_RETRY'})}
 else if(!registration.installing&&!registration.waiting)requestStatus();
 }catch(error){fail(error instanceof Error?error.message:'無法建立離線快取')}
}
if('serviceWorker'in navigator){
 navigator.serviceWorker.addEventListener('controllerchange',requestStatus);
 navigator.serviceWorker.addEventListener('message',event=>{const d=event.data;
 if(d?.type==='OFFLINE_PROGRESS'){ready=false;retryable=false;label=`離線下載 ${d.done}/${d.total}`;watchTimeout();paint()}
 else if(d?.type==='OFFLINE_READY'){clearTimeout(timer);ready=true;retryable=false;label='可離線使用';detail='啟動程式與所有航跡圖已完整保存；Windy 更新仍需網路';paint()}
 else if(d?.type==='OFFLINE_ERROR')fail(d.message||'離線準備失敗');
 });
}
