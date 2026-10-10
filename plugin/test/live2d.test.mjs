import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLive2dDocument, live2dDocument } from '../lib/live2d.js';
import { uiHarness } from '../../tools/ui-harness.mjs';

const core = '/* Live2DCubismCore ' + 'x'.repeat(10001) + ' */';
test('Live2D document embeds every referenced model byte and restricts iframe resources', async () => {
  const html = await buildLive2dDocument({ core });
  const assets = JSON.parse(html.match(/const ASSETS=(\{[^\n]+\});\/\*/)[1]);
  for (const [path, data] of Object.entries(assets)) assert.deepEqual(Buffer.from(data, 'base64'), await readFile(new URL('../assets/live2d/whale/' + path, import.meta.url)));
  assert.ok(Object.keys(assets).length >= 50);
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('name="color-scheme" content="light"'));
  assert.ok(html.includes('color-scheme:light;background:transparent!important'));
  assert.equal((html.match(/<script>/g) ?? []).length, 3);
  assert.ok(html.includes('beforeModelUpdate'));
});
test('late Live2D document after unmount creates no iframe and removes message listener', async () => {
  let finish, handler, created = 0;
  const harness = await uiHarness({ services: { guardHost: { live2d: () => new Promise(resolve => { finish = resolve; }) } } });
  harness.environment.window.addEventListener = (_, fn) => { handler = fn; };
  harness.environment.window.clearTimeout = () => {};
  harness.environment.window.removeEventListener = (name, fn) => { if (name === 'message') { assert.equal(fn, handler); handler = null; } };
  harness.environment.document.createElement = () => { created++; return {}; };
  const find = node => {
    if (!node || typeof node !== 'object') return null;
    const resolved = harness.resolve(node);
    if (resolved?.props?.className?.startsWith('ustc-guard__mascot')) return resolved;
    for (const child of resolved?.children ?? []) { const result = find(child); if (result) return result; }
    return null;
  };
  const mascot = find(harness.tree); assert.ok(mascot);
  mascot.props.ref({ dataset: {}, appendChild() { throw new Error('disposed node'); } });
  assert.equal(typeof handler, 'function'); mascot.props.ref(null);
  finish({ ok: true, value: '<html></html>' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, 0); assert.equal(handler, null);
});
test('Core network errors and invalid responses reject without inventing a model', async () => {
  await assert.rejects(buildLive2dDocument({ fetchCore: async () => ({ ok: false }) }), /下载失败/);
  await assert.rejects(buildLive2dDocument({ fetchCore: async () => ({ ok: true, text: async () => '<html>invalid</html>' }) }), /内容无效/);
  const html = await buildLive2dDocument({ fetchCore: async () => ({ ok: true, text: async () => core }) });
  assert.ok(html.includes('const MODEL='));
});
test('portrait loads without old image, floats outside clipping, resizes by mode and cleans up', async () => {
  const harness = await uiHarness({ services: { guardHost: { live2d: async () => ({ ok: true, value: '<html></html>' }) } } });
  const handlers = new Map(); let appended = 0, removed = 0, mini = false;
  Object.assign(harness.environment.window, {
    addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); },
    clearTimeout() {}, setTimeout() { return 1; },
  });
  const frame = { style: { setProperty(name, value) { this[name] = value; } }, dataset: {}, contentWindow: {}, setAttribute() {}, remove() { removed++; } };
  harness.environment.document.createElement = () => frame;
  harness.environment.document.body = { appendChild(element) { assert.equal(element, frame); appended++; } };
  const find = node => {
    if (!node || typeof node !== 'object') return null;
    const resolved = harness.resolve(node);
    if (resolved?.props?.className?.startsWith('ustc-guard__mascot')) return resolved;
    for (const child of resolved?.children ?? []) { const result = find(child); if (result) return result; }
    return null;
  };
  const node = { dataset: {}, closest() { return mini ? {} : null; }, getBoundingClientRect() { return { left: 250, bottom: 270 }; } };
  const mascot = find(harness.tree); mascot.props.ref(node);
  assert.equal(node.dataset.live2d, 'loading');
  assert.ok(harness.css.includes('.ustc-guard__mascot .ustc-guard__pose{visibility:hidden}'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(appended, 1);
  assert.equal(frame.style['color-scheme'], 'light');
  assert.equal(frame.style['background-color'], 'transparent');
  assert.equal(frame.style.width, '160px'); assert.equal(frame.style.height, '184px');
  assert.ok(parseFloat(frame.style.left) < 250);
  handlers.get('message')({ source: {}, data: { type: 'ustc-live2d-ready' } });
  assert.equal(node.dataset.live2d, 'loading');
  handlers.get('message')({ source: frame.contentWindow, data: { type: 'ustc-live2d-ready' } });
  assert.equal(node.dataset.live2d, 'ready'); assert.equal(frame.style.opacity, '1');
  mini = true; handlers.get('resize')(); assert.equal(frame.style.width, '144px');
  mini = false; harness.environment.window.innerWidth = 390; handlers.get('resize')();
  assert.equal(frame.style.width, '144px');
  assert.ok(parseFloat(frame.style.left) >= 6 && parseFloat(frame.style.left) + 144 <= 384);
  mascot.props.ref(null); assert.equal(removed, 1); assert.equal(handlers.size, 0);
});
test('cached Core gives one reusable document without network or ledger changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'guard-live2d-'));
  const previous = process.env.DSH_HOME, originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  try {
    const cache = join(home, 'ustc-guard/live2d-cache'); await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'live2dcubismcore.min.js'), core);
    globalThis.fetch = () => { throw new Error('network forbidden in cache test'); };
    const first = live2dDocument(), second = live2dDocument();
    assert.equal(first, second); assert.ok((await first).includes('const MODEL='));
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
