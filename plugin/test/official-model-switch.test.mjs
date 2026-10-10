import test from 'node:test';
import assert from 'node:assert/strict';
import { routeCatalog } from '../index.js';
import { uiHarness, htmlOf, exampleSnapshot } from '../../tools/ui-harness.mjs';

const ustc = { current() { return { profiles: new Map([['ustc-route', { baseURL: 'https://api.llm.ustc.edu.cn/v1' }]]), models: { getModels() { return [{ id: 'fish' }]; } } }; } };
const native = (baseURL) => ({ dependencies: { options() { return { baseURL, apiKey: 'SYNTHETIC_NOT_EXPORTED' }; } }, stream() { throw new Error('No model request allowed in route inspection'); } });
const catalog = (adapter) => routeCatalog({ llm: { adapters: new Map([['ustc-route', { adapter: ustc }], ['deepseek-account', { adapter }]]) } });

test('official native adapter exposes known non-USTC address without current snapshot or credentials', () => {
  const routes = catalog(native('https://api.deepseek.com'));
  assert.deepEqual(routes[1], { provider: 'deepseek-account', protected: false, addressKnown: true, models: [] });
  assert.equal(JSON.stringify(routes).includes('SYNTHETIC_NOT_EXPORTED'), false);
});

test('switching USTC to official hides the panel, minimized HUD and open details; switching back restores', async () => {
  const snap = { ...exampleSnapshot, protectedModels: [], routes: catalog(native('https://api.deepseek.com')) };
  for (const mode of [{}, { minimized: true }, { details: true }, { open: true }]) {
    const harness = await uiHarness({ ...mode, snap, selection: { provider: 'ustc-route', model: 'fish' } });
    assert.ok(harness.tree);
    harness.state[4] = { provider: 'deepseek-account', model: 'deepseek-chat' };
    assert.equal(harness.render(), null);
    harness.state[4] = { provider: 'ustc-route', model: 'fish' };
    assert.ok(harness.render());
  }
});

test('native adapter with an actual USTC endpoint remains protected even under an official-looking provider ID', async () => {
  const routes = catalog({ inner: native('https://api.llm.ustc.edu.cn/v1') });
  assert.equal(routes[1].protected, true);
  assert.equal(routes[1].addressKnown, true);
  const harness = await uiHarness({ snap: { ...exampleSnapshot, routes }, selection: { provider: 'deepseek-account', model: 'm' } });
  assert.match(htmlOf(harness), /近 12 小时/);
});

test('unknown, throwing and cyclic native configuration stays unknown without hiding pending UI', async () => {
  const cycle = {}; cycle.inner = cycle;
  for (const adapter of [native(undefined), { dependencies: { options() { throw new Error('pending'); } } }, cycle]) {
    const routes = catalog(adapter);
    assert.equal(routes[1].addressKnown, false);
    const harness = await uiHarness({ snap: { ...exampleSnapshot, protectedModels: [], routes }, selection: { provider: 'deepseek-account', model: 'm' } });
    assert.match(htmlOf(harness), /等待识别 USTC 服务地址/);
  }
});
