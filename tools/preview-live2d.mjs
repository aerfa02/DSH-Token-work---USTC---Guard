import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildLive2dDocument } from '../plugin/lib/live2d.js';

const core = await readFile(new URL('../temp/live2dcubismcore.min.js', import.meta.url), 'utf8');
const document = await buildLive2dDocument({ core });
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/model') { response.end(document); return; }
  response.end(`<!doctype html><meta charset="utf-8"><title>鲸鱼娘 Live2D 验收</title><style>body{font:16px system-ui;background:#edf5ff;color:#345;margin:24px}iframe{border:0;background:transparent;width:300px;height:400px}.mini iframe{width:50px;height:64px}.box{display:inline-block;border:1px solid #bfd8f5;border-radius:14px;background:#fff;padding:16px}button{margin:12px;padding:8px}</style><h2>鲸鱼娘 Live2D · 真实模型预览</h2><p>移动鼠标看视线跟随，点击角色播放自拍小动作。</p><button onclick="document.querySelector('.box').classList.toggle('mini')">切换最小尺寸</button><div class="box"><iframe title="鲸鱼娘 Live2D" sandbox="allow-scripts" src="/model"></iframe></div><p>角色原作：上善无形；二次设计：ZipZipPipe；Live2D：氵六青。美术 CC BY-NC-SA 4.0。</p>`);
});
server.listen(6768, '127.0.0.1', () => console.log('Live2D preview http://127.0.0.1:6768'));
