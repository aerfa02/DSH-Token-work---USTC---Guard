import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UstcGuard } from '../index.js';
import { AdmissionQueue } from '../lib/queue.js';
import { BudgetGuard } from '../lib/budget.js';
import { GuardStore, buildState } from '../lib/store.js';
import { RequestRecord } from '../lib/state.js';

const options = { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'test' }], maxTokens: 1000 };
const drain = async stream => { for await (const chunk of stream) {} };
const finish = () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })();
async function setup(config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'guard-recovery-'));
  const guard = new UstcGuard({ config, stateDirectory: directory });
  await guard.init();
  return { guard, directory, async cleanup() { await guard.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('FIFO cancellation removes waiter without acquiring a slot', async () => {
  let used = 1;
  const queue = new AdmissionQueue({ acquire() { if (used) return { ok: false }; used++; return { ok: true, slot: 'slot' }; }, maxLength: 3, waitMs: 1000 });
  const abort = new AbortController();
  const first = queue.acquireSlot(abort.signal);
  const failure = assert.rejects(first);
  let secondStarted = false;
  const second = queue.acquireSlot().then(() => { secondStarted = true; });
  assert.equal(queue.length, 2);
  abort.abort();
  await failure;
  assert.equal(queue.length, 1);
  assert.equal(used, 1);
  used = 0;
  queue.wake();
  await second;
  assert.ok(secondStarted);
  queue.close();
});

test('30 queued requests obey concurrency and FIFO, then release all slots', async () => {
  let active = 0;
  let peak = 0;
  let id = 0;
  const order = [];
  const queue = new AdmissionQueue({ acquire() {
    if (active >= 20) return { ok: false };
    active++; peak = Math.max(peak, active);
    return { ok: true, slot: ++id };
  }, maxLength: 100, waitMs: 1000 });
  await Promise.all(Array.from({ length: 30 }, (_, i) => (async () => {
    await queue.acquireSlot();
    order.push(i);
    await new Promise(resolve => setImmediate(resolve));
    active--; queue.wake();
  })()));
  assert.equal(peak, 20);
  assert.equal(active, 0);
  assert.deepEqual(order, Array.from({ length: 30 }, (_, i) => i));
  queue.close();
});

test('Guard queue snapshot and abort do not dispatch or reserve', async () => {
  const s = await setup({ maxConcurrency: 1 });
  try {
    const stream = s.guard.handle(options, () => (async function* () { yield { type: 'text-delta', text: 'a' }; })());
    await stream.next();
    const before = s.guard.snapshot();
    const abort = new AbortController();
    let dispatched = false;
    const pending = drain(s.guard.handle({ ...options, signal: abort.signal }, () => { dispatched = true; return finish(); }));
    const failure = assert.rejects(pending);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.guard.snapshot().queue.length, 1);
    abort.abort();
    await failure;
    assert.equal(dispatched, false);
    assert.equal(s.guard.snapshot().rpm.used, before.rpm.used);
    assert.equal(s.guard.snapshot().queue.length, 0);
    await stream.return();
    assert.equal(s.guard.snapshot().concurrency.used, 0);
  } finally { await s.cleanup(); }
});

test('Uncertain reservations expire independently in each budget window', () => {
  let now = 0;
  const budget = new BudgetGuard({ windows: [{ label: 'short', windowMs: 10, limit: 100n }, { label: 'long', windowMs: 20, limit: 100n }], now: () => now });
  budget.reserve({ attemptId: 'a', amount: 80n }); budget.markUncertain('a');
  now = 11;
  assert.equal(budget.usage('short').used, 0n);
  assert.equal(budget.usage('long').used, 80n);
  now = 21;
  assert.equal(budget.uncertainCount(), 0);
  assert.equal(budget.canReserve(100n).allowed, true);
});

test('Monitor mode tracks but never blocks a budget excess', () => {
  const budget = new BudgetGuard({ windows: [{ label: 'test', windowMs: 1000, limit: 1n }], strict: false });
  assert.equal(budget.reserve({ attemptId: 'a', amount: 50n }).ok, true);
  assert.equal(budget.usage('test').used, 50n);
});

test('Write failure prevents provider I/O, leaves other providers usable', async () => {
  const s = await setup();
  try {
    await rm(s.directory, { recursive: true, force: true });
    await writeFile(s.directory, 'not a directory');
    let calls = 0;
    await assert.rejects(drain(s.guard.handle(options, () => { calls++; return finish(); })), { code: 'USTC_GUARD_UNAVAILABLE' });
    assert.equal(calls, 0);
    assert.equal(s.guard.failingClosed, true);
    await drain(s.guard.handle({ provider: 'other' }, () => { calls++; return finish(); }));
    assert.equal(calls, 1);
  } finally { await s.cleanup(); }
});

test('Restart holds unknown upstream concurrency before accepting more requests', async () => {
  const s = await setup();
  const stream = s.guard.handle(options, () => (async function* () { yield { type: 'text-delta', text: 'a' }; })());
  await stream.next();
  const recovered = new UstcGuard({ config: { recoveryHoldMs: 10 }, stateDirectory: s.directory });
  await recovered.init();
  assert.equal(recovered.failingClosed, true);
  assert.equal(recovered.snapshot().concurrency.used, 1);
  await assert.rejects(drain(recovered.handle(options, finish)), { code: 'USTC_GUARD_UNAVAILABLE' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(recovered.failingClosed, false);
  await recovered.dispose();
  await stream.return();
  await s.cleanup();
});

test('Missing output bound does not block advisory budget mode', async () => {
  const s = await setup();
  try {
    let calls = 0;
    await drain(s.guard.handle({ ...options, maxTokens: undefined }, () => { calls++; return finish(); }));
    assert.equal(calls, 1);
    assert.equal(s.guard.snapshot().concurrency.used, 0);
  } finally { await s.cleanup(); }
});

test('Window summaries retain more than 500 completed requests', async () => {
  const s = await setup({ budgetEnabled: false });
  try {
    const records = Array.from({ length: 600 }, (_, i) => {
      const record = new RequestRecord({ attemptId: `history-${i}`, provider: 'ustc', model: 'm', scope: 'ustc', dispatchTimestamp: Date.now() - 1000 });
      record.state = 'completed'; record.inputTokens = 1; record.usageRecorded = true;
      return record.toJSON();
    });
    const store = new GuardStore({ directory: s.directory, filename: 'ustc-guard-state.json' });
    const budget = new BudgetGuard({ windows: [{ label: '3h', windowMs: 10800000, limit: 30000000n }, { label: '12h', windowMs: 43200000, limit: 70000000n }, { label: '24h', windowMs: 86400000, limit: 100000000n }] });
    await store.save(buildState({ limiter: {}, budget: budget.snapshot(), requests: records }));
    const recovered = new UstcGuard({ config: { budgetEnabled: false }, stateDirectory: s.directory });
    await recovered.init();
    await drain(recovered.handle(options, finish));
    assert.equal(recovered.snapshot().observed['24h'].inputTokens, 600);
    await recovered.dispose();
  } finally { await s.cleanup(); }
});

test('Missing budget window fails closed instead of restoring empty history', () => {
  const budget = new BudgetGuard({ windows: [{ label: '3h', windowMs: 1000, limit: 100n }] });
  assert.throws(() => budget.restore({ windows: [], reservations: [] }), /缺失预算窗口/);
});

test('Uncertain budget retryAt reflects the latest blocking window expiry', () => {
  let now = 0;
  const budget = new BudgetGuard({ windows: [{ label: 'short', windowMs: 10, limit: 100n }, { label: 'long', windowMs: 20, limit: 100n }], now: () => now });
  budget.reserve({ attemptId: 'a', amount: 80n }); budget.markUncertain('a');
  assert.equal(budget.nextAvailableAt(50n), 20);
});
