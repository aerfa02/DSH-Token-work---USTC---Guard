import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetWindow } from '../lib/budget.js';
import { AdmissionQueue } from '../lib/queue.js';

test('concurrent completion order must not retain already expired consumption', () => {
  const window = new BudgetWindow({ label: 'test', windowMs: 1000, limit: 100n });
  window.addConfirmed(900, 10n); // later dispatch finishes first
  window.addConfirmed(100, 20n); // earlier dispatch finishes later
  assert.equal(window.confirmedTotal(1500), 10n);
  assert.equal(window.confirmedTotal(1900), 0n, 'exact expiry boundary is excluded');
});

test('same-time completion and reverse insertion preserve totals and restore', () => {
  const window = new BudgetWindow({ label: 'test', windowMs: 1000, limit: 100n });
  for (const at of [900, 800, 800, 700, 600]) window.addConfirmed(at, 2n);
  assert.equal(window.confirmedTotal(1750), 6n);
  const restored = new BudgetWindow({ label: 'test', windowMs: 1000, limit: 100n });
  restored.restore(window.snapshot());
  assert.equal(restored.confirmedTotal(1900), 0n);
});

test('full queue and disabled queue reject without acquiring new resources', async () => {
  let acquired = 0;
  const queue = new AdmissionQueue({ acquire() { acquired++; return { ok: false, reason: 'concurrency' }; }, maxLength: 1, waitMs: 1000 });
  const abort = new AbortController();
  const pending = queue.acquireSlot(abort.signal);
  const rejected = assert.rejects(pending);
  const before = acquired;
  await assert.rejects(queue.acquireSlot(), { code: 'USTC_QUEUE_FULL' });
  assert.equal(acquired, before);
  abort.abort(); await rejected;
  queue.close();
  await assert.rejects(queue.acquireSlot(), { code: 'USTC_GUARD_UNAVAILABLE' });
  assert.equal(queue.length, 0);
});

test('queue deadline removes its abort listener without granting a slot', async () => {
  let grants = 0, listeners = 0;
  const signal = { aborted: false, addEventListener() { listeners++; }, removeEventListener() { listeners--; } };
  const queue = new AdmissionQueue({ acquire() { return { ok: false, retryAtMs: 1 }; }, maxLength: 2, waitMs: 20 });
  const original = queue.acquire;
  queue.acquire = () => { const result = original(); if (result.ok) grants++; return result; };
  await assert.rejects(queue.acquireSlot(signal), { code: 'USTC_RATE_BLOCKED' });
  assert.equal(queue.length, 0); assert.equal(listeners, 0); assert.equal(grants, 0);
  queue.close();
});

test('closed waiting queue releases every waiter and reopen accepts a fresh request', async () => {
  let available = false, grants = 0;
  const queue = new AdmissionQueue({ acquire() { if (!available) return { ok: false }; grants++; return { ok: true, marker: 'new-slot' }; }, maxLength: 2, waitMs: 1000 });
  const first = assert.rejects(queue.acquireSlot(), { code: 'USTC_GUARD_UNAVAILABLE' });
  const second = assert.rejects(queue.acquireSlot(), { code: 'USTC_GUARD_UNAVAILABLE' });
  queue.close(); await Promise.all([first, second]);
  assert.equal(queue.length, 0); assert.equal(grants, 0);
  const abort = new AbortController(); abort.abort(new Error('already cancelled'));
  queue.reopen(); available = true;
  await assert.rejects(queue.acquireSlot(abort.signal), /already cancelled/);
  assert.equal(grants, 0);
  assert.equal((await queue.acquireSlot()).marker, 'new-slot');
  assert.equal(grants, 1); queue.close();
});
