import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageHistory, dayKey, validateHistory } from '../lib/history.js';
import { GuardStore, buildState } from '../lib/store.js';
import { RequestRecord } from '../lib/state.js';
import { BudgetGuard } from '../lib/budget.js';
import { UstcGuard } from '../index.js';

const at = date => Date.parse(date);
test('time bins are disjoint, cross midnight, expose zero intervals and exclude future requests', () => {
  const now = at('2026-10-04T00:07:00Z');
  const history = new UsageHistory('Asia/Shanghai', now - 86400000);
  const rows = [record('2026-10-03T15:59:59Z'), record('2026-10-03T16:00:00Z'), record('2026-10-04T00:00:00Z'), record('2026-10-04T00:08:00Z')];
  const bins = history.snapshot(rows, now).timeline;
  assert.equal(bins.length, 192);
  assert.equal(bins.reduce((sum, b) => sum + b.totalTokens, 0), 1290);
  assert.equal(bins.filter(b => b.totalTokens > 0).length, 3);
  assert.equal(bins.at(-1).totalTokens, 430);
  assert.equal(bins.at(-1).partial, true);
  assert.ok(bins.some(b => !b.partial && b.totalTokens === 0));
  assert.ok(bins.slice(1).every((b, i) => b.at === bins[i].end));
  const recent = new UsageHistory('Asia/Shanghai', now - 60000).snapshot([], now).timeline;
  assert.equal(recent.length, 1); // do not manufacture zeros before recording started
});
function record(date, extra = {}) {
  const row = new RequestRecord({ attemptId: date, provider: 'ustc', model: 'm', scope: 'ustc', dispatchTimestamp: at(date) });
  Object.assign(row, { state: 'completed', usageRecorded: true, inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 10, reasoningTokens: 5, totalTokens: 430, cost: 200n, costSource: 'estimated', ...extra });
  return row;
}
test('daily attribution crosses Shanghai midnight; weeks start Monday and months follow calendar', () => {
  const history = new UsageHistory('Asia/Shanghai', at('2026-08-30T15:00:00Z'));
  const rows = [record('2026-08-30T15:59:59Z'), record('2026-08-30T16:00:00Z'), record('2026-08-31T16:00:00Z')];
  const snapshot = history.snapshot(rows, at('2026-09-02T00:00:00Z'));
  assert.deepEqual(snapshot.daily.map(row => row.date), ['2026-08-30', '2026-08-31', '2026-09-01']);
  assert.deepEqual(snapshot.weekly.map(row => [row.date, row.totalTokens]), [['2026-08-24', 430], ['2026-08-31', 860]]);
  assert.deepEqual(snapshot.monthly.map(row => [row.date, row.totalTokens]), [['2026-08', 860], ['2026-09', 430]]);
  assert.equal(snapshot.monthly[0].reasoningTokens, 10); // not added to total
});
test('compaction and restart preserve all token types without double counting', () => {
  const history = new UsageHistory('Asia/Shanghai', at('2026-08-01T00:00:00Z'));
  const old = record('2026-08-10T00:00:00Z');
  const current = record('2026-09-01T00:00:00Z');
  history.archive(old);
  const recovered = new UsageHistory(); recovered.restore(history.toJSON());
  const result = recovered.snapshot([current], at('2026-09-02T00:00:00Z'));
  assert.equal(result.daily.length, 2);
  assert.equal(result.daily[0].totalTokens, 430);
  assert.equal(result.daily[0].cacheWriteTokens, 10);
  assert.equal(result.daily[1].totalTokens, 430);
  assert.equal(recovered.toJSON().days.length, 1, 'snapshots do not archive live records');
});
test('failed requests with usage remain recorded, missing usage is disclosed and future rows excluded', () => {
  const history = new UsageHistory('Asia/Shanghai', at('2026-09-01T00:00:00Z'));
  const result = history.snapshot([
    record('2026-09-01T01:00:00Z', { finishKind: 'error' }),
    record('2026-09-01T02:00:00Z', { state: 'unknown', usageRecorded: false }),
    record('2026-09-01T03:00:00Z', { state: 'queued', usageRecorded: false }),
    record('2026-09-03T01:00:00Z'),
  ], at('2026-09-02T00:00:00Z'));
  assert.equal(result.daily[0].requests, 2);
  assert.equal(result.daily[0].missingUsage, 1);
  assert.equal(result.daily[0].totalTokens, 430);
});
test('history rejects corrupt dates, duplicates, future coverage, negative counts and timezone changes', () => {
  const history = new UsageHistory('Asia/Shanghai', at('2026-09-01T00:00:00Z'));
  history.archive(record('2026-09-01T01:00:00Z'));
  const now = at('2026-09-02T00:00:00Z');
  for (const mutate of [
    x => { x.days[0].date = '2026-02-30'; }, x => { x.days.push({ ...x.days[0] }); },
    x => { x.days[0].inputTokens = -1; }, x => { x.startedAt = now + 5000; },
    x => { x.timezone = 'invalid'; }, x => { x.days[0].totalTokens = Number.MAX_SAFE_INTEGER + 1; },
  ]) { const bad = structuredClone(history.toJSON()); mutate(bad); assert.throws(() => validateHistory(bad, now)); }
  assert.throws(() => new UsageHistory('UTC').restore(history.toJSON()), /时区/);
  assert.equal(dayKey(at('2026-09-01T16:00:00Z')), '2026-09-02');
});
test('v1 migration creates exact rollback backup before writing v2 state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-history-migration-'));
  try {
    const file = join(directory, 'state.json');
    const legacy = { ...buildState({ limiter: {}, budget: {}, requests: [] }), schemaVersion: 1, savedAt: Date.now() }; delete legacy.history;
    const raw = JSON.stringify(legacy); await writeFile(file, raw);
    const store = new GuardStore({ directory, filename: 'state.json' });
    const loaded = await store.load(); assert.equal(loaded.schemaVersion, 1);
    await store.save({ ...loaded, history: new UsageHistory().toJSON() });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 2);
    const backup = (await readdir(directory)).find(name => name.includes('.pre-2.0-'));
    assert.equal(await readFile(join(directory, backup), 'utf8'), raw);
    const broken = JSON.parse(await readFile(file, 'utf8')); delete broken.history;
    await writeFile(file, JSON.stringify(broken));
    await assert.rejects(store.load(), /历史账本缺失/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Guard compacts old legacy requests atomically and history survives repeated restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-history-runtime-'));
  let guard;
  try {
    const old = record(new Date(Date.now() - 72 * 3600_000).toISOString());
    const legacy = { ...buildState({ limiter: {}, budget: new BudgetGuard({ windows: ['3h', '12h', '24h'].map(label => ({ label, windowMs: parseInt(label) * 3600_000, limit: 100000000n })) }).snapshot(), requests: [old.toJSON()] }), schemaVersion: 1, savedAt: Date.now() }; delete legacy.history;
    await writeFile(join(directory, 'ustc-guard-state.json'), JSON.stringify(legacy));
    guard = new UstcGuard({ config: {}, stateDirectory: directory }); await guard.init();
    const options = { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'test' }], maxTokens: 100 };
    const next = () => (async function* () { yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 10, totalTokens: 430 } }; yield { type: 'finish', reason: { kind: 'stop' } }; })();
    for await (const chunk of guard.handle(options, next)) {}
    assert.equal(guard.snapshot().history.daily.reduce((sum, row) => sum + row.totalTokens, 0), 860);
    await guard.dispose(); guard = undefined;
    const state = JSON.parse(await readFile(join(directory, 'ustc-guard-state.json'), 'utf8'));
    assert.equal(state.history.days[0].totalTokens, 430);
    assert.equal(state.requests.length, 1);
    for (let i = 0; i < 2; i++) {
      guard = new UstcGuard({ config: {}, stateDirectory: directory }); await guard.init();
      assert.equal(guard.failingClosed, false);
      assert.equal(guard.snapshot().history.daily.reduce((sum, row) => sum + row.totalTokens, 0), 860);
      await guard.dispose(); guard = undefined;
    }
  } finally { await guard?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('unconfirmed reservations do not become observed spending or a misleading zero-cost estimate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-spending-'));
  const guard = new UstcGuard({ config: {}, stateDirectory: directory });
  try {
    await guard.init();
    const options = { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'test' }], maxTokens: 10000 };
    for await (const chunk of guard.handle(options, () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })())) {}
    const snap = guard.snapshot();
    assert.ok(Number(snap.uncertain.amount) > 0);
    assert.equal(Number(snap.observed['3h'].cost), 0);
    assert.equal(snap.observed['3h'].costSource, 'unknown');
    assert.equal(snap.observed['3h'].missingUsage, 1);
    assert.equal(snap.history.daily[0].missingUsage, 1);
    assert.equal(snap.history.daily[0].totalTokens, 0);
  } finally { await guard.dispose(); await rm(directory, { recursive: true, force: true }); }
});
