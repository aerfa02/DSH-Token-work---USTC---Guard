import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UstcGuard } from '../index.js';

test('failed streams retain cost and safe failure diagnostics across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-diagnostics-'));
  const make = () => new UstcGuard({ stateDirectory: directory });
  let guard = make();
  try {
    await guard.init();
    const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 'private provider response' } } };
    const chunks = [{ type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } }, finish];
    const seen = [];
    for await (const chunk of guard.handle({ provider: 'ustc', model: 'deepseek-flash' }, () => (async function* () { yield* chunks; })())) seen.push(chunk);
    assert.equal(seen[1], finish);
    assert.equal(guard.snapshot().lastRequest.finishKind, 'error');
    assert.equal(guard.snapshot().lastRequest.errorCode, 'TIMEOUT');
    assert.equal(guard.snapshot().concurrency.used, 0);
    assert.equal(guard.snapshot().observed.today.outputTokens, 10);
    await guard.dispose();
    assert.doesNotMatch(await readFile(join(directory, 'ustc-guard-state.json'), 'utf8'), /private provider response/);
    guard = make(); await guard.init();
    assert.equal(guard.snapshot().lastRequest.errorCode, 'TIMEOUT');
  } finally { await guard.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('uncoded upstream exception is rethrown and recorded without its message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-diagnostics-'));
  const guard = new UstcGuard({ stateDirectory: directory });
  try {
    await guard.init();
    const failure = new Error('private upstream data');
    await assert.rejects(async () => {
      for await (const chunk of guard.handle({ provider: 'ustc', model: 'deepseek-flash' }, () => (async function* () { yield { type: 'text-delta', text: 'partial' }; throw failure; })())) {}
    }, error => error === failure);
    assert.equal(guard.snapshot().lastRequest.finishKind, 'error');
    assert.equal(guard.snapshot().lastRequest.errorCode, 'UNKNOWN');
    assert.equal(guard.snapshot().concurrency.used, 0);
  } finally { await guard.dispose(); await rm(directory, { recursive: true, force: true }); }
});
