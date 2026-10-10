import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness, htmlOf, exampleSnapshot } from '../../tools/ui-harness.mjs';
import { UsageHistory } from '../lib/history.js';

function nodes(harness, node = harness.render()) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(item => nodes(harness, item));
  if (typeof node.type === 'function') return nodes(harness, harness.resolve(node));
  return [node, ...node.children.flatMap(item => nodes(harness, item))];
}
const find = (h, label) => nodes(h).find(node => node.props['aria-label'] === label);
function snapshot() {
  const now = Date.parse('2026-10-04T05:00:00Z');
  const history = new UsageHistory('Asia/Shanghai', Date.parse('2026-08-01T00:00:00Z'));
  history.archive({ dispatchTimestamp: Date.parse('2026-08-02T00:00:00Z'), usageRecorded: true, inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 10, totalTokens: 360, reasoningTokens: 8 });
  history.archive({ dispatchTimestamp: Date.parse('2026-10-03T00:00:00Z'), usageRecorded: true, inputTokens: 110, outputTokens: 70, cacheReadTokens: 400, cacheWriteTokens: 20, totalTokens: 600, reasoningTokens: 10 });
  return { ...structuredClone(exampleSnapshot), lastSync: now, history: history.snapshot([], now) };
}
test('normal panel replaces 6h with budgeted 12h; analytics opens beside expansion control', async () => {
  const harness = await uiHarness({ snap: snapshot() });
  const html = htmlOf(harness);
  assert.match(html, /近 12 小时/); assert.doesNotMatch(html, /近 6 小时/);
  assert.match(html, /近 12 小时费用占预算提醒线比例/);
  find(harness, 'Token 消耗详情').props.onClick();
  assert.equal(harness.state[6], true);
  assert.match(htmlOf(harness, harness.render()), /时段 Token 消耗统计图/);
  assert.match(htmlOf(harness, harness.render()), /6h/);
  find(harness, '关闭 Token 详情').props.onClick();
  assert.equal(harness.state[6], false);
});
test('minimized panel has independent analytics and restore controls', async () => {
  const harness = await uiHarness({ snap: snapshot(), minimized: true });
  find(harness, 'Token 消耗详情').props.onClick();
  assert.equal(harness.state[6], true); assert.equal(harness.state[5], true);
  assert.ok(find(harness, '恢复监控面板'));
  const dialog = nodes(harness).find(node => node.props.role === 'dialog');
  dialog.props.onKeyDown({ key: 'Escape' }); assert.equal(harness.state[6], false);
});
test('time range renders independent chronological bins and axes without resetting history selection', async () => {
  const snap = snapshot();
  const now = snap.lastSync;
  snap.history = new UsageHistory('Asia/Shanghai', now - 86400000).snapshot([
    { dispatchTimestamp: now - 3600000, usageRecorded: true, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    { dispatchTimestamp: now - 1800000, usageRecorded: true, inputTokens: 400, outputTokens: 20, totalTokens: 420 },
  ], now);
  const harness = await uiHarness({ snap, details: true, period: 'monthly' });
  find(harness, '时段范围').children[0].props.onClick();
  assert.equal(harness.state[11], '3h'); assert.equal(harness.state[7], 'monthly');
  const chart = find(harness, '时段 Token 消耗统计图');
  assert.equal(chart.children.length, 24);
  const values = chart.children.map(b => b.children[0].children[0]);
  assert.ok(values.includes('120')); assert.ok(values.includes('420'));
  assert.ok(values.includes('0'));
  const html = htmlOf(harness, harness.render());
  assert.match(html, /Token 纵轴刻度/); assert.match(html, /时间 →/);
  assert.match(html, /独立的 7.5 分钟/);
});
test('every time range fills one grid with all intervals, including unrecorded coverage', async () => {
  const snap = snapshot();
  const now = snap.lastSync;
  snap.history = new UsageHistory('Asia/Shanghai', now - 60000).snapshot([], now);
  const harness = await uiHarness({ snap, details: true });
  for (const [index, count] of [[0, 24], [1, 24], [2, 24], [3, 24]]) {
    find(harness, '时段范围').children[index].props.onClick();
    const chart = find(harness, '时段 Token 消耗统计图');
    assert.equal(chart.children.length, count);
    assert.equal(chart.props.style['--chart-columns'], String(count));
    assert.match(chart.children[0].props['aria-label'], /未记录/);
    chart.children[0].props.onClick();
    assert.match(htmlOf(harness, harness.render()), /不能视为零消耗/);
  }
});
test('12-hour progress remains visible with known or incomplete usage', async () => {
  for (const incomplete of [false, true]) {
    const snap = snapshot();
    Object.assign(snap.observed['12h'], { cost: '7', unpriced: incomplete ? 1 : 0 });
    const harness = await uiHarness({ snap });
    const bar = find(harness, '近 12 小时费用占预算提醒线比例');
    assert.ok(bar);
    assert.equal(bar.props['aria-valuenow'], 10);
    assert.equal(bar.children[0].props.style.width, '10%');
    if (incomplete) assert.match(bar.props['aria-valuetext'], /至少/);
  }
});
test('daily/week/month tabs, earlier pages and token filters are functional', async () => {
  const harness = await uiHarness({ snap: snapshot(), details: true });
  const earlier = () => nodes(harness).find(node => node.type === 'button' && node.children[0] === '更早');
  assert.equal(earlier().props.disabled, false); earlier().props.onClick();
  assert.equal(harness.state[8], 1);
  const tabs = find(harness, '历史粒度');
  tabs.children[1].props.onClick();
  assert.equal(harness.state[7], 'weekly'); assert.equal(harness.state[8], 0);
  tabs.children[2].props.onClick(); assert.equal(harness.state[7], 'monthly');
  assert.match(htmlOf(harness, harness.render()), /每月 Token 历史条形图/);
  const filter = find(harness, 'Token 类型筛选'); filter.children[3].props.onClick();
  assert.equal(harness.state[9], 'cacheReadTokens');
  const august = nodes(harness).find(node => node.type === 'button' && node.props['aria-label']?.startsWith('2026-08，缓存命中 200，'));
  assert.ok(august); august.props.onClick(); assert.equal(harness.state[10], '2026-08');
  assert.match(htmlOf(harness, harness.render()), /推理（单列，不叠加计费）/);
  find(harness, 'Token 类型筛选').children[5].props.onClick();
  assert.equal(harness.state[9], 'reasoningTokens');
  assert.ok(nodes(harness).some(node => node.props['aria-label']?.startsWith('2026-08，推理 8，')));
});
test('zero days are visible, unrecorded history stays excluded and missing history explains coverage', async () => {
  const harness = await uiHarness({ snap: snapshot(), details: true, period: 'monthly' });
  assert.ok(nodes(harness).some(node => node.props['aria-label']?.startsWith('2026-09，总 Token 0，')));
  assert.ok(!nodes(harness).some(node => node.props['aria-label']?.startsWith('2026-07，')));
  const html = htmlOf(harness); assert.match(html, /更早数据未记录/); assert.match(html, /部分时段/);
  const empty = htmlOf(await uiHarness({ details: true }));
  assert.match(empty, /暂无历史记录/); assert.doesNotMatch(empty.replace(/src="data:[^"]*"/g, ''), /NaN|Infinity/);
});
test('mascot is embedded, has reduced-motion fallback, and unsafe error strings are escaped', async () => {
  const harness = await uiHarness({ details: true, snap: snapshot() });
  const html = htmlOf(harness);
  assert.match(html, /data:image\/png;base64/);
  assert.match(html, /data:image\/gif;base64/);
  assert.doesNotMatch(html, /pose--side|pose--back/);
  assert.match(harness.css, /prefers-reduced-motion:reduce/);
  assert.equal(nodes(harness).filter(node => node.type === 'img' && node.props.src?.startsWith('http')).length, 0);
  harness.state[2] = '<script>alert(1)</script>';
  harness.state[6] = false;
  assert.match(htmlOf(harness, harness.render()), /&lt;script>/);
});
test('minimized HUD keeps the animated mascot and historical bars retain 24-slot widths', async () => {
  const minimized = await uiHarness({ snap: snapshot(), minimized: true });
  assert.ok(find(minimized, '大肥鱼待机与互动动画'));
  assert.match(htmlOf(minimized), /data:image\/gif;base64/);
  const history = await uiHarness({ snap: snapshot(), details: true, period: 'monthly' });
  const chart = find(history, '每月 Token 历史条形图');
  assert.equal(chart.props.style['--chart-columns'], '24');
  assert.equal(chart.children.length, 24);
  assert.equal(chart.children.filter(node => node.type === 'button').length, 3);
  assert.equal(chart.children.filter(node => node.props.className === 'ustc-guard__chart-placeholder').length, 21);
});
