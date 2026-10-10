import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness, htmlOf, exampleSnapshot } from '../../tools/ui-harness.mjs';

const now = Date.parse('2026-10-05T09:00:00+08:00');
const row = { date: '2026-10-05', inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 2000000, cacheWriteTokens: 250000, reasoningTokens: 900000, totalTokens: 3750000, missingUsage: 0 };
async function view(value = row, metric = 'totalTokens', period = 'daily') {
  const snap = structuredClone(exampleSnapshot);
  snap.lastSync = now;
  snap.history = { timezone: 'Asia/Shanghai', startedAt: now - 25 * 3600000, daily: [value], weekly: [{ ...value, date: '2026-10-05' }], monthly: [{ ...value, date: '2026-10' }], timeline: [] };
  return htmlOf(await uiHarness({ details: true, snap, metric, period }));
}
test('details estimate classified costs without charging reasoning again, independently of filters', async () => {
  for (const metric of ['totalTokens', 'cacheReadTokens', 'reasoningTokens']) {
    const html = await view(row, metric);
    assert.match(html, /预计费用约 ¥3\.90/);
    assert.match(html, /Token 预计金额/);
    assert.match(html, /不随类型筛选改变/);
  }
  for (const period of ['weekly', 'monthly']) assert.match(await view(row, 'totalTokens', period), /预计费用约 ¥3\.90/);
});
test('missing usage shows known lower bound, unknown costs stay pending and genuine zero stays zero', async () => {
  assert.match(await view({ ...row, missingUsage: 1 }), /已知预计费用 ≥ ¥3\.90/);
  const zero = { ...row, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  assert.match(await view(zero), /预计费用约 ¥0\.00/);
  assert.match(await view({ ...zero, missingUsage: 1 }), /预计费用：待确认/);
  assert.match(await view({ ...zero, totalTokens: 2000 }), /预计费用：待确认/);
});
test('fee rounding remains exact near the cent boundary', async () => {
  const value = { ...row, inputTokens: 2499, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2499 };
  assert.match(await view(value), /预计费用约 ¥0\.00/);
  assert.match(await view({ ...value, inputTokens: 2500, totalTokens: 2500 }), /预计费用约 ¥0\.01/);
});
