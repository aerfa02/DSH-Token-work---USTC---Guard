/** Local React preview with synthetic usage only. Run after placing React 18 UMD files in temp/. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { UsageHistory } from '../plugin/lib/history.js';
import { exampleSnapshot } from './ui-harness.mjs';
import { buildLive2dDocument } from '../plugin/lib/live2d.js';
const live2dHtml = await buildLive2dDocument({ core: await readFile(new URL('../temp/live2dcubismcore.min.js', import.meta.url), 'utf8') });

// Development-only libraries, never shipped with the plugin. First preview downloads pinned official npm packages.
await mkdir(new URL('../temp/', import.meta.url), { recursive: true });
for (const pkg of ['react', 'react-dom']) {
  const destination = new URL('../temp/' + pkg + '.production.min.js', import.meta.url);
  try { await readFile(destination); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch('https://registry.npmjs.org/' + pkg + '/-/' + pkg + '-18.3.1.tgz');
    if (!response.ok) throw new Error('React preview download failed');
    const tar = gunzipSync(Buffer.from(await response.arrayBuffer())); let offset = 0, found = false;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512), name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8); offset += 512;
      if (name === 'package/umd/' + pkg + '.production.min.js') { await writeFile(destination, tar.subarray(offset, offset + size)); found = true; break; }
      offset += Math.ceil(size / 512) * 512;
    }
    if (!found) throw new Error('React preview UMD not found');
  }
}

const now = Date.now(), history = new UsageHistory('Asia/Shanghai', now - 120 * 86400_000);
for (let i = 119; i >= 0; i--) {
  const inputTokens = 31000 + (i * 7919) % 85000, outputTokens = 12000 + (i * 1259) % 41000;
  const cacheReadTokens = 80000 + (i * 3529) % 220000, cacheWriteTokens = i % 4 === 0 ? 16000 : 0;
  history.archive({ dispatchTimestamp: now - i * 86400_000, usageRecorded: true, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens: Math.round(outputTokens * .3), totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens });
}
const timelineRecords = Array.from({ length: 80 }, (_, i) => ({ dispatchTimestamp: now - i * 15 * 60000, usageRecorded: true, inputTokens: 1000 + (i % 7) * 5000, outputTokens: 500, cacheReadTokens: (i % 5) * 7000, cacheWriteTokens: 0, totalTokens: 1500 + (i % 7) * 5000 + (i % 5) * 7000 }));
const snap = { ...structuredClone(exampleSnapshot), lastSync: now, history: history.snapshot(timelineRecords, now) };
for (const [key, hours] of [['today', 8], ['3h', 3], ['6h', 6], ['12h', 12], ['24h', 24]]) Object.assign(snap.observed[key], { inputTokens: hours * 15231, outputTokens: hours * 4691, cacheReadTokens: hours * 45712, cacheWriteTokens: hours * 1832, reasoningTokens: hours * 1100, totalTokens: hours * 67466, cost: (hours * .28).toFixed(6) });
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>USTC 2.0 界面验收（模拟数据）</title>
<style>body{color-scheme:dark;margin:0;background:#111c2d;color:#d8e5f8;font:14px/1.7 system-ui}main{padding:35px;max-width:520px}button{cursor:pointer}#error{color:#ff9a9a}#fixture-controls{display:flex;gap:10px;flex-wrap:wrap}#fixture-controls button{padding:8px 12px;border:1px solid #334763;border-radius:8px;background:#1d2d44;color:#d8e5f8}h1{font-size:26px}</style>
<main><small>OFFLINE PREVIEW · SYNTHETIC DATA</small><h1>USTC API Guard 2.0</h1><p>此页用真实 React 渲染插件 Client，全部数据为模拟数据；不连接 DSH 或在线模型。</p><div id="fixture-controls"><button id="theme">切换背景</button><button id="provider">切换到其他平台</button><button id="connection">模拟连接失败</button></div><p id="error"></p></main><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script>
let plugin; window.__ModuleLoader__={load({factory}){plugin=factory(name=>React)}};
window.addEventListener('error',event=>document.getElementById('error').textContent=event.message);
window.addEventListener('unhandledrejection',event=>document.getElementById('error').textContent=String(event.reason));
</script><script src="/client.js"></script><script>
const sample=${JSON.stringify(snap)};
let selected={provider:'alias',model:'fish'},failed=false;const listeners=new Set();
const directory={store:{getSnapshot(){return {current:selected}},subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn)}},async load(){}};
const ctx={remote:{async $mount(){}},get(){return {async live2d(){return {ok:true,value:await (await fetch('/live2d')).text()}},async snapshot(){if(failed)throw new Error('模拟连接中断');return {ok:true,value:sample}}}},effect(fn){fn()},sessions:{list:{getSnapshot(){return {byId:{demo:{id:'demo',retainedBy:{mainView:1}}}}},subscribe(){return ()=>{}}}},modelDirectories:{directoryFor(){return directory}},slots:{inject(_,fn){fn()},register(_,render){ReactDOM.createRoot(document.getElementById('root')).render(render())}}};
plugin.apply(ctx).catch(e=>document.getElementById('error').textContent=String(e));
document.getElementById('theme').onclick=()=>document.body.style.background=document.body.style.background==='rgb(238, 245, 255)'?'#111c2d':'#eef5ff';
document.getElementById('provider').onclick=event=>{selected=selected.provider==='alias'?{provider:'other',model:'m'}:{provider:'alias',model:'fish'};event.target.textContent=selected.provider==='alias'?'切换到其他平台':'切换到 USTC';listeners.forEach(fn=>fn())};
document.getElementById('connection').onclick=event=>{failed=!failed;event.target.textContent=failed?'恢复连接':'模拟连接失败'};
</script></html>`;
const routes = {
  '/live2d': () => Buffer.from(live2dHtml),
  '/': () => Buffer.from(html),
  '/client.js': () => readFile(new URL('../plugin/client.js', import.meta.url)),
  '/react.js': () => readFile(new URL('../temp/react.production.min.js', import.meta.url)),
  '/react-dom.js': () => readFile(new URL('../temp/react-dom.production.min.js', import.meta.url)),
};
createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname, get = routes[path];
    if (!get) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(await get());
  } catch (error) { response.writeHead(500); response.end(error.code ?? 'ERROR'); }
}).listen(8766, '127.0.0.1', () => console.log('PREVIEW http://127.0.0.1:8766'));
