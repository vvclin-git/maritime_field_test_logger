const FILES = /* BUILD_FILES */ [];
const VERSION = 'BUILD_VERSION';
const ROOT = self.registration.scope;
const CACHE = `sea-trial-offline:${ROOT}:${VERSION}`;
const urlFor = path => new URL(path, ROOT).href;
async function notify(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.filter(c => c.url.startsWith(ROOT)).forEach(c => c.postMessage(message));
}
async function complete() {
  if (!FILES.length) return false;
  const cache = await caches.open(CACHE);
  return (await Promise.all(FILES.map(path => cache.match(urlFor(path))))).every(r => r?.ok);
}
async function prepare() {
  if (!FILES.length) throw Error('請使用正式建置版本啟用離線快取');
  const cache = await caches.open(CACHE);
  let done = 0;
  for (let i = 0; i < FILES.length; i += 3) {
    const results = await Promise.allSettled(FILES.slice(i, i + 3).map(async path => {
      const url = urlFor(path);
      if (!(await cache.match(url))?.ok) {
        const response = await fetch(url, { cache: 'reload', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw Error(`${path}：HTTP ${response.status}`);
        await cache.put(url, response);
      }
      await notify({ type: 'OFFLINE_PROGRESS', done: ++done, total: FILES.length });
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  if (!await complete()) throw Error('離線檔案不完整，請重試');
}
async function report(target) {
  const message = { type: await complete() ? 'OFFLINE_READY' : 'OFFLINE_ERROR', message: '離線檔案不完整，請連網重試' };
  if (target) target.postMessage(message); else await notify(message);
}
self.addEventListener('install', event => event.waitUntil((async () => {
  try { await prepare(); await self.skipWaiting(); }
  catch (error) { await notify({ type: 'OFFLINE_ERROR', message: error.message }); throw error; }
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  // Preserve earlier bundles and other applications' caches, and never touch IndexedDB.
  await self.clients.claim();
  await report();
})()));
let repairing;
self.addEventListener('message', event => {
  if (event.data?.type === 'OFFLINE_STATUS') event.waitUntil(report(event.source));
  if (event.data?.type === 'OFFLINE_RETRY') event.waitUntil((async () => {
    try {
      repairing ||= prepare().finally(() => { repairing = undefined; });
      await repairing; await report();
    } catch (error) { await notify({ type: 'OFFLINE_ERROR', message: error.message }); }
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(ROOT)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (request.mode === 'navigate') return (await cache.match(urlFor('index.html'))) || fetch(request);
    const cached = await cache.match(request);
    if (cached) return cached;
    return fetch(request); // Missing assets must never be replaced by HTML.
  })());
});
