import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

export const exampleSnapshot = {
  runtimeVersion: '1.0.0', protectedModels: [{ provider: 'alias', model: 'fish' }],
  observed: Object.fromEntries(['today', '3h', '6h', '12h', '24h'].map(label => [label, { cost: '18.86', totalTokens: 146820, costSource: 'estimated' }])),
  windows: { '3h': { limit: '30', ratio: .63 }, '12h': { limit: '70', ratio: .27 } },
  rpm: { used: 4, limit: 20 }, concurrency: { used: 2, limit: 20 },
  queue: { length: 0, limit: 100 }, uncertain: { count: 0 }, budgetStatus: { level: 'normal' }, policy: {}, displayTimezone: 'Asia/Shanghai',
};

/** Runs the actual Client component with deterministic hook state, without DSH I/O. */
export async function uiHarness({ open = false, details = false, period = 'daily', page = 0, metric = 'totalTokens', axis = 'tokens', selectedDate = null, minimized, savedMinimized = false, snap = exampleSnapshot, selection = { provider: 'alias', model: 'fish' }, width = 900, height = 700, services = {}, runEffects = false, snapshot } = {}) {
  let plugin, element, cursor = 0, refCursor = 0;
  const state = [open, snap, null, null, selection, minimized, details, period, page, metric, selectedDate, '24h', axis];
  const storage = new Map(savedMinimized ? [['ustc-guard.minimized', 'true']] : []);
  const effects = [], timers = new Map();
  const refs = [{ current: true }, { current: false }, { current: { offsetWidth: 286, offsetHeight: open ? 420 : 340, getBoundingClientRect() { return { left: 600, top: 300 }; } } }, { current: null }];
  const React = {
    Fragment: 'fragment', createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) { const index = cursor++; if (state[index] === undefined) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
    useRef() { return refs[refCursor++]; }, useCallback(fn) { return fn; }, useEffect(fn) { if (runEffects && !effects.done) effects.push(fn); },
  };
  const env = {
    window: { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load({ factory }) { plugin = factory(() => React); } } },
    setInterval(fn, ms) { timers.set(ms, fn); return ms; }, clearInterval(id) { timers.delete(id); },
    localStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
  };
  runInNewContext(await readFile(new URL('../plugin/client.js', import.meta.url), 'utf8'), env);
  let css;
  env.document = { createElement() { return { setAttribute() {}, remove() {} }; }, head: { appendChild(style) { css = style.textContent; } } };
  const ctx = {
    ...services,
    remote: { async $mount() {} }, get() { return services.guardHost ?? { snapshot: snapshot ?? (async () => ({ ok: true, value: snap })) }; },
    effect(fn) { fn(); }, slots: { inject(_, fn) { fn(); }, register(_, render) { element = render(); } },
  };
  await plugin.apply(ctx);
  const render = () => { cursor = 0; refCursor = 0; return element.type(element.props); };
  const tree = render();
  const cleanup = effects.map(fn => fn()); effects.done = true;
  return { tree, render, state, storage, css, timers, environment: env, cleanup() { cleanup.forEach(fn => fn?.()); }, resolve(node) { return typeof node?.type === 'function' ? node.type(node.props) : node; } };
}

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function htmlOf(harness, node = harness.tree) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(item => htmlOf(harness, item)).join('');
  if (typeof node !== 'object') return escape(node);
  if (typeof node.type === 'function') return htmlOf(harness, harness.resolve(node));
  const children = node.children.map(item => htmlOf(harness, item)).join('');
  if (node.type === 'fragment') return children;
  const attributes = Object.entries(node.props).filter(([key, value]) => !key.startsWith('on') && key !== 'ref' && value != null).map(([key, value]) => {
    if (key === 'style') value = Object.entries(value).map(([property, v]) => `${property.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}:${typeof v === 'number' && !['flexGrow', 'flexShrink', 'opacity', 'zIndex', 'lineHeight'].includes(property) ? v + 'px' : v}`).join(';');
    return ` ${key === 'className' ? 'class' : key === 'strokeWidth' ? 'stroke-width' : key === 'strokeLinecap' ? 'stroke-linecap' : key}="${escape(value)}"`;
  }).join('');
  return `<${node.type}${attributes}>${children}</${node.type}>`;
}
