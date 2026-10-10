import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = new URL('../assets/live2d/', import.meta.url);
const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
let documentPromise;
const scriptSafe = text => text.replaceAll('</', '<\\/');

/** Self-contained model document; Core is acquired for local use, never packaged. */
export async function buildLive2dDocument({ core, fetchCore = fetch } = {}) {
  if (!core) {
    const response = await fetchCore(CORE_URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Live2D Core 下载失败');
    core = await response.text();
  }
  if (core.length < 10000 || core.length > 2000000 || !core.includes('Live2DCubismCore') || /^\s*</.test(core)) throw new Error('Live2D Core 内容无效');
  const model = JSON.parse(await readFile(new URL('whale/c_0120.model3.json', root), 'utf8'));
  const refs = model.FileReferences;
  const paths = [refs.Moc, ...refs.Textures, refs.Physics, refs.DisplayInfo,
    ...Object.values(refs.Motions).flat().map(item => item.File), ...refs.Expressions.map(item => item.File)];
  const assets = {};
  for (const path of new Set(paths)) {
    if (!/^[\w./-]+$/.test(path) || path.includes('..')) throw new Error('模型资源路径无效');
    assets[path] = (await readFile(new URL(`whale/${path}`, root))).toString('base64');
  }
  const vendor = await readFile(new URL('vendor.js', root), 'utf8');
  const renderer = await readFile(new URL('renderer.js', root), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src blob: data:; worker-src blob:"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#stage{margin:0;width:100%;height:100%;overflow:hidden;color-scheme:light;background:transparent!important}canvas{width:100%;height:100%;display:block}#error{font:11px system-ui;color:#456}</style></head><body><div id="stage"></div><div id="error"></div><script>${scriptSafe(core)}</script><script>${scriptSafe(vendor)}</script><script>const MODEL=${scriptSafe(JSON.stringify(model))};const ASSETS=${scriptSafe(JSON.stringify(assets))};${scriptSafe(renderer)}</script></body></html>`;
}

export function live2dDocument() {
  documentPromise ??= (async () => {
    const directory = resolve(process.env.DSH_HOME ?? process.cwd(), 'ustc-guard', 'live2d-cache');
    const path = resolve(directory, 'live2dcubismcore.min.js');
    let core;
    try {
      core = await readFile(path, 'utf8');
      if (core.length < 10000 || core.length > 2000000 || !core.includes('Live2DCubismCore') || /^\s*</.test(core)) core = undefined;
    } catch {}
    if (!core) {
      const response = await fetch(CORE_URL, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Live2D Core 下载失败');
      core = await response.text();
      // Validate before writing any cache file.
      if (core.length < 10000 || core.length > 2000000 || !core.includes('Live2DCubismCore') || /^\s*</.test(core)) throw new Error('Live2D Core 内容无效');
      await mkdir(directory, { recursive: true });
      await writeFile(`${path}.tmp`, core, 'utf8'); await rename(`${path}.tmp`, path);
    }
    return buildLive2dDocument({ core });
  })().catch(error => { documentPromise = undefined; throw error; });
  return documentPromise;
}
