import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const prefix='/maritime_field_test_logger/';
let failRoute=false;
const server=createServer(async(req,res)=>{
 try{
  let path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(!path.startsWith(prefix)){res.writeHead(404).end();return}
  path=path.slice(prefix.length)||'index.html';
  if(failRoute&&path==='routes/S07_B_diagonal_toward.png'){res.writeHead(503).end();return}
  const file=resolve('dist',path);if(!file.startsWith(resolve('dist')+'/')&&!file.startsWith(resolve('dist')+'\\'))throw Error('path');
  const data=await readFile(file);
  res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(data);
 }catch{res.writeHead(404).end()}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}${prefix}`;
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 const context=await browser.newContext({viewport:{width:412,height:915}});const page=await context.newPage();
 await page.goto(url);await page.getByRole('button',{name:'可離線使用',exact:true}).waitFor({timeout:60000});
 console.log('PASS: full production bundle ready under GitHub Pages subpath');
 await page.getByRole('button',{name:'建立新航次'}).click();
 for(const name of ['location','model','fps','recorder','reviewer'])await page.locator(`[name="${name}"]`).fill('offline-test');
 await page.getByRole('button',{name:'儲存設定'}).click();
 await page.getByRole('button',{name:'環境 未設定'}).click();await page.getByRole('button',{name:'儲存為新環境版本'}).click();
 await context.setOffline(true);
 await page.reload();await page.getByRole('heading',{name:'航次進度'}).waitFor();
 await page.getByRole('button',{name:'可離線使用',exact:true}).waitFor({timeout:10000});
 assert.equal(await page.locator('#connection-status').textContent(),'離線');
 const routes=(await readdir('dist/routes')).filter(x=>x.endsWith('.png'));
 const images=await page.evaluate(async paths=>Promise.all(paths.map(path=>new Promise(r=>{const i=new Image();i.onload=()=>r(i.naturalWidth>0);i.onerror=()=>r(false);i.src='routes/'+path}))),routes);
 assert.equal(images.length,14);assert(images.every(Boolean));console.log('PASS: offline reload and all 14 route images');
 await page.locator('.cards [data-pick]').first().click();await page.locator('#light').selectOption('順光');await page.locator('#confirmed').check();
 await page.locator('.mobile-action [data-action="start"]').click();await page.locator('.mobile-action [data-action="end"]').click();
 await page.locator('[data-completed="yes"]').click();await page.locator('#note').fill('離線測試記錄');
 await context.setOffline(false);await context.setOffline(true);assert.equal(await page.locator('#note').inputValue(),'離線測試記錄');
 await page.locator('.mobile-action [data-action="save-result"]').click();await page.reload();
 await page.getByRole('button',{name:'紀錄',exact:true}).click();await page.locator('.cards').getByText(/離線測試記錄/).waitFor();
 console.log('PASS: offline START/END/SAVE and persisted record; reconnect preserves draft');
 await page.close();const cold=await context.newPage();await cold.goto(url);await cold.getByRole('heading',{name:'航次進度'}).waitFor();console.log('PASS: new tab cold start while offline');
 await context.close();
 failRoute=true;const failure=await browser.newContext();const f=await failure.newPage();await f.goto(url);
 await f.getByRole('button',{name:'離線未就緒 · 點此重試'}).waitFor({timeout:60000});
 assert.match(await f.locator('#offline-status').getAttribute('title'),/503/);
 failRoute=false;await f.locator('#offline-status').click();await f.getByRole('button',{name:'可離線使用',exact:true}).waitFor({timeout:60000});
 console.log('PASS: failed route download reports error; retry completes cache');
 await f.evaluate(async()=>{const name=(await caches.keys()).find(x=>x.startsWith('sea-trial-offline:'));const c=await caches.open(name);await c.delete(new URL('routes/S01_A_buoy_approach.png',location.href).href)});
 await f.reload();await f.getByRole('button',{name:'離線未就緒 · 點此重試'}).waitFor({timeout:10000});
 await f.locator('#offline-status').click();await f.getByRole('button',{name:'可離線使用',exact:true}).waitFor({timeout:60000});
 await failure.setOffline(true);await f.reload();
 const missing=await f.evaluate(async()=>{try{const r=await fetch('routes/missing.png');return r.headers.get('content-type')}catch{return 'network-error'}});
 assert.notEqual(missing,'text/html');console.log('PASS: incomplete cache detected and repaired; missing image never returns HTML');
 await failure.close();
}finally{await browser.close();await new Promise(r=>server.close(r))}
