import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardStore, buildState } from '../lib/store.js';
import { RequestRecord, REQUEST_STATE_NAMES } from '../lib/state.js';
import { UstcGuard } from '../index.js';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'guard-store-validation-'));
  const store = new GuardStore({ directory, filename: 'state.json' });
  const record = new RequestRecord({ attemptId: 'test', provider: 'ustc', model: 'm', scope: 'ustc', dispatchTimestamp: Date.now() });
  const state = buildState({ limiter: {}, budget: {}, requests: [record.toJSON()] });
  try { await run(store, state); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('invalid persisted request state is rejected without rewriting the original ledger', () => fixture(async (store, state) => {
  state.requests[0].state = 'future-or-corrupted-state';
  await store.save(state);
  const original = await readFile(store.path, 'utf8');
  await assert.rejects(store.load(), /状态|state/);
  assert.equal(store.trusted, false);
  assert.equal(await readFile(store.path, 'utf8'), original);
}));

test('structural validation failure marks the store untrusted with a diagnostic', () => fixture(async (store, state) => {
  delete state.limiter;
  await store.save(state);
  await assert.rejects(store.load(), /limiter/);
  assert.equal(store.trusted, false);
  assert.match(store.corruptionReason, /limiter/);
  assert.equal(store.loaded, false);
}));

test('all supported persisted request states including unknown remain compatible', () => fixture(async (store, state) => {
  state.requests = REQUEST_STATE_NAMES.map((name, index) => ({ ...state.requests[0], attemptId: `test-${index}`, state: name }));
  await store.save(state);
  const loaded = await store.load();
  assert.deepEqual(loaded.requests.map(item => item.state), REQUEST_STATE_NAMES);
  assert.equal(store.trusted, true);
  assert.equal(store.loaded, true);
}));

test('invalid restored request state isolates USTC without blocking another endpoint', () => fixture(async (store, state) => {
  state.requests[0].state = 'invalid';
  await store.save(state);
  const original = await readFile(store.path, 'utf8');
  const guard = new UstcGuard({ config: { storeFilename: 'state.json' }, stateDirectory: join(store.path, '..') });
  await guard.init();
  const drain = async stream => { for await (const chunk of stream) {} };
  let calls = 0;
  const next = () => { calls++; return (async function* () { yield { type: 'text', text: 'passed' }; })(); };
  try {
    assert.equal(guard.failingClosed, true);
    await drain(guard.handle({ provider: 'ustc', baseURL: 'https://example.com/v1' }, next));
    assert.equal(calls, 1);
    await assert.rejects(drain(guard.handle({ provider: 'ustc', baseURL: 'https://api.llm.ustc.edu.cn/v1' }, next)), { code: 'USTC_GUARD_UNAVAILABLE' });
    assert.equal(calls, 1);
  } finally { await guard.dispose(); }
  assert.equal(await readFile(store.path, 'utf8'), original);
}));
