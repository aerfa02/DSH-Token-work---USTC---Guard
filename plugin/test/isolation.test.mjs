import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UstcGuard, routeBaseURL, protectedModels, routeCatalog } from '../index.js';
import { identifyProvider, adapterWithMethod } from '../lib/identity.js';

test('actual address overrides aliases and exact host prevents false matches', () => {
  assert.equal(identifyProvider({ provider: 'ustc', baseURL: 'https://example.com/v1' }).protected, false);
  assert.equal(identifyProvider({ provider: 'my-route', baseURL: 'https://api.llm.ustc.edu.cn/v1' }).protected, true);
  assert.equal(identifyProvider({ provider: 'ustc', baseURL: 'https://evil.api.llm.ustc.edu.cn/v1' }).protected, false);
  assert.equal(identifyProvider({ provider: 'ustc', baseURL: null }).protected, false);
});

test('Host reads model endpoint overrides without exporting secrets', () => {
  const models = [{ id: 'fish', baseUrl: 'https://api.llm.ustc.edu.cn/v1' }, { id: 'other', baseUrl: 'https://example.com/v1' }];
  const ctx = { llm: { adapters: new Map([['alias', { adapter: { current() { return {
    profiles: new Map([['alias', { baseURL: 'https://example.com/v1', apiKey: 'never-export' }]]),
    models: { getModel(_, id) { return models.find(m => m.id === id); }, getModels() { return models; } },
  }; } } }]]) } };
  assert.equal(routeBaseURL(ctx, 'alias', 'fish'), models[0].baseUrl);
  assert.deepEqual(protectedModels(ctx), [{ provider: 'alias', model: 'fish' }]);
  assert.equal(routeBaseURL(ctx, 'missing', 'fish'), null);
});

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'guard-audit-'));
  const guard = new UstcGuard({ config: {}, stateDirectory: directory });
  await guard.init();
  try { await fn(guard, directory); } finally { await guard.dispose(); await rm(directory, { recursive: true, force: true }); }
}
const options = { provider: 'ustc', model: 'm', maxTokens: 1000, messages: [{ role: 'user', content: 'hello' }] };
const drain = async stream => { for await (const chunk of stream) {} };

test('ambiguous downstream failure retains budget and releases concurrency', () => fixture(async guard => {
  await assert.rejects(drain(guard.handle(options, () => { throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); })), { code: 'ECONNRESET' });
  assert.equal(guard.snapshot().uncertain.count, 1);
  assert.equal(guard.snapshot().concurrency.used, 0);
}));

test('malformed usage cannot settle a dispatched request at zero cost', () => fixture(async guard => {
  await drain(guard.handle(options, () => (async function* () {
    yield { type: 'usage', usage: { inputTokens: -1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })()));
  assert.equal(guard.snapshot().uncertain.count, 1);
}));

test('a later valid usage repairs an earlier malformed usage', () => fixture(async guard => {
  await drain(guard.handle(options, () => (async function* () {
    yield { type: 'usage', usage: {} };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })()));
  assert.equal(guard.snapshot().uncertain.count, 0);
  assert.equal(guard.snapshot().observed.today.totalTokens, 20);
}));

test('duplicate persisted window cannot erase an existing budget ledger', () => fixture(async (guard, directory) => {
  await drain(guard.handle(options, () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })()));
  const files = await import('node:fs/promises');
  const filename = (await files.readdir(directory)).find(name => name.endsWith('.json'));
  const actual = join(directory, filename);
  const state = JSON.parse(await readFile(actual, 'utf8'));
  state.budget.windows.push({ ...state.budget.windows[0], confirmed: [] });
  await writeFile(actual, JSON.stringify(state));
  const restored = new UstcGuard({ config: {}, stateDirectory: directory });
  await restored.init();
  assert.equal(restored.snapshot().failingClosed, true);
  await restored.dispose();
}));

test('over-budget requests keep streaming under legacy strict configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-advisory-'));
  const guard = new UstcGuard({ config: { budgetMode: 'strict' }, stateDirectory: directory });
  await guard.init();
  try {
    let calls = 0;
    const downstream = () => { calls++; return (async function* () {
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20_000_000 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(); };
    const pricedOptions = { ...options, model: 'deepseek-flash' };
    await drain(guard.handle(pricedOptions, downstream));
    assert.ok(guard.snapshot().windows['3h'].ratio > 1);
    await drain(guard.handle(pricedOptions, downstream));
    assert.equal(calls, 2);
    assert.equal(guard.snapshot().policy.budgetMode, 'monitor');
    assert.equal(guard.snapshot().concurrency.used, 0);
  } finally { await guard.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('configured USTC endpoints survive unavailable model discovery and arbitrary aliases', () => {
  for (const address of ['https://api.llm.ustc.edu.cn/', 'https://api.llm.ustc.edu.cn/v1']) {
    const ctx = { llm: { adapters: new Map([['tokenworks-custom', { adapter: { current() { return {
      profiles: new Map([['tokenworks-custom', { baseURL: address, apiKey: 'do-not-export' }]]),
      models: { getModel() { throw new Error('catalog pending'); }, getModels() { throw new Error('catalog pending'); } },
    }; } } }]]) } };
    assert.equal(routeBaseURL(ctx, 'tokenworks-custom', 'anything'), address);
    assert.deepEqual(routeCatalog(ctx), [{ provider: 'tokenworks-custom', protected: true, addressKnown: true, models: [] }]);
    assert.equal(JSON.stringify(routeCatalog(ctx)).includes('do-not-export'), false);
  }
});

test('delegated adapters resolve actual endpoints without guessing names or looping', () => {
  const base = { current() { return { profiles: new Map(), models: { getModels() { return [{ id: 'm', baseUrl: 'https://api.llm.ustc.edu.cn/' }]; }, getModel() { return { baseUrl: 'https://api.llm.ustc.edu.cn/' }; } } }; } };
  const wrapped = { inner: { inner: base } };
  const ctx = { llm: { adapters: new Map([['custom', { adapter: wrapped }]]) } };
  assert.equal(routeBaseURL(ctx, 'custom', 'm'), 'https://api.llm.ustc.edu.cn/');
  assert.equal(routeCatalog(ctx)[0].models[0].protected, true);
  assert.equal(routeCatalog(ctx)[0].addressKnown, false);
  const cycle = {}; cycle.inner = cycle;
  assert.equal(adapterWithMethod(cycle, 'current'), null);
  assert.equal(adapterWithMethod({}, 'current'), null);
});
