import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness, htmlOf, exampleSnapshot } from '../../tools/ui-harness.mjs';

test('minimize hides the body, keeps readings and restores expanded details', async () => {
  const harness = await uiHarness({ open: true });
  harness.tree.children[1].children[1].props.onClick();
  let tree = harness.render();
  assert.match(htmlOf(harness, tree), /恢复监控面板/);
  assert.match(htmlOf(harness, tree), /约¥18.86/);
  assert.doesNotMatch(htmlOf(harness, tree), /近 3 小时|等待发送/);
  assert.equal(harness.storage.get('ustc-guard.minimized'), 'true');
  tree.children[1].children.find(node => node?.props?.['aria-label'] === '恢复监控面板').props.onClick();
  tree = harness.render();
  assert.match(htmlOf(harness, tree), /近 3 小时|等待发送/);
  assert.equal(harness.state[0], true);
  assert.equal(harness.storage.get('ustc-guard.minimized'), 'false');
});

test('minimized mode respects selection, unknown costs and failed connection', async () => {
  assert.equal((await uiHarness({ minimized: true, selection: { provider: 'other', model: 'fish' } })).tree, null);
  const snap = structuredClone(exampleSnapshot);
  snap.observed.today.costSource = 'unknown';
  const harness = await uiHarness({ minimized: true, snap });
  assert.match(htmlOf(harness), /费用未知/);
  harness.state[2] = 'offline';
  assert.match(htmlOf(harness, harness.render()), /连接断开/);
  harness.render().children[1].children.find(node => node?.props?.['aria-label'] === '恢复监控面板').props.onClick();
  assert.match(htmlOf(harness, harness.render()), /无法读取状态：offline/);
});

test('saved minimized preference is restored on mount and monitoring keeps refreshing', async () => {
  const harness = await uiHarness({ savedMinimized: true, runEffects: true, services: liveServices(fixedDirectory()) });
  assert.match(htmlOf(harness), /恢复监控面板/);
  assert.ok(harness.timers.has(2000));
  harness.state[1] = { ...exampleSnapshot, observed: { today: { cost: '25', costSource: 'estimated' } } };
  assert.match(htmlOf(harness, harness.render()), /约¥25.00/);
  await harness.timers.get(2000)();
  assert.match(htmlOf(harness, harness.render()), /约¥18.86/);
  harness.cleanup();
});

test('minimized costs distinguish today and 3h including partial and unknown values', async () => {
  const snap = structuredClone(exampleSnapshot);
  snap.observed.today.cost = '25';
  snap.observed['3h'].cost = '7.2';
  snap.observed['3h'].unpriced = 1;
  let html = htmlOf(await uiHarness({ minimized: true, snap }));
  assert.match(html, /今日<\/small><b>约¥25.00/);
  assert.match(html, /近3小时<\/small><b>已知约¥7.20/);
  snap.observed['3h'].costSource = 'unknown';
  html = htmlOf(await uiHarness({ minimized: true, snap }));
  assert.match(html, /近3小时<\/small><b>费用未知/);
  assert.match(html, /今日<\/small><b>约¥25.00/);
});

test('provider failure is visible independently of valid cost reconciliation', async () => {
  const snap = { ...exampleSnapshot, lastRequest: { finishKind: 'error', errorCode: 'TIMEOUT' } };
  assert.match(htmlOf(await uiHarness({ snap })), /最近请求失败：TIMEOUT/);
});

test('HUD only renders for the current protected route/model pair', async () => {
  assert.ok((await uiHarness()).tree);
  assert.equal((await uiHarness({ selection: { provider: 'other', model: 'fish' } })).tree, null);
  assert.equal((await uiHarness({ selection: { provider: 'alias', model: 'other' } })).tree, null);
});
test('expanded HUD removes clutter and gives tokens an explicit unit', async () => {
  const snap = structuredClone(exampleSnapshot);
  Object.assign(snap.observed.today, { inputTokens: 21_000, outputTokens: 1_000, cacheReadTokens: 124_820, cacheWriteTokens: 0 });
  const harness = await uiHarness({ open: true, snap });
  const html = htmlOf(harness);
  assert.match(html, /146.8K Token/);
  assert.match(html, /输入 145\.8K/);
  assert.match(html, /缓存命中 124\.8K/);
  assert.doesNotMatch(html.replace(/src="data:[^"]*"/g, ''), /TPM|24h|严格|数据来源|0 ·/);
  snap.observed.today.totalTokens = 0;
  assert.match(htmlOf(await uiHarness({ snap })), /暂无 Token 记录/);
});

test('displayed input includes cache reads and writes without adding output', async () => {
  for (const [fields, expected] of [
    [{ inputTokens: 100, outputTokens: 99, cacheReadTokens: 200, cacheWriteTokens: 50 }, '输入 350'],
    [{ inputTokens: 0, cacheReadTokens: 400 }, '输入 400'],
    [{ inputTokens: 40 }, '输入 40'],
  ]) {
    const snap = structuredClone(exampleSnapshot);
    snap.observed.today = { ...fields, cost: '1', totalTokens: 999 };
    const html = htmlOf(await uiHarness({ snap }));
    assert.ok(html.includes(expected));
    assert.match(html, /缓存命中是输入的子集/);
  }
});

test('partial prices display known-cost progress as a lower bound', async () => {
  const snap = structuredClone(exampleSnapshot);
  snap.observed['3h'].unpriced = 1;
  snap.observed['3h'].costSource = 'partial';
  const harness = await uiHarness({ snap });
  const row = harness.resolve(harness.tree.children[2].children[2].children[0]);
  assert.equal(row.children[1].props['aria-valuenow'], 62.87);
  assert.match(row.children[1].props['aria-valuetext'], /至少/);
  assert.match(htmlOf(harness), /已知费用进度 ≥/);
  assert.match(htmlOf(harness), /另有 1 笔未计价/);
});

test('today headline distinguishes partial, unknown and complete estimates including zero', async () => {
  for (const [cost, costSource, unpriced, expected] of [
    ['2.5', 'partial', 1, '<small>已知约</small>¥2.50'],
    ['0', 'partial', 2, '<small>已知约</small>¥0.00'],
    ['0', 'unknown', 1, '费用未知'],
    ['2.5', 'estimated', 0, '<small>约</small>¥2.50'],
  ]) {
    const snap = structuredClone(exampleSnapshot);
    Object.assign(snap.observed.today, { cost, costSource, unpriced });
    const html = htmlOf(await uiHarness({ snap }));
    const headline = html.match(/<div class="ustc-guard__money">(.*?)<\/div>/)?.[1];
    // Harness serializes React's key prop; real React omits it from the DOM.
    assert.equal(headline?.replace(/ key="[^"]*"/g, ''), expected);
  }
});

test('expense progress uses the displayed cost rather than pending reservation ratio', async () => {
  const snap = structuredClone(exampleSnapshot);
  snap.observed['3h'].cost = '0.01';
  snap.windows['3h'].ratio = 0.5;
  const harness = await uiHarness({ snap });
  const row = harness.resolve(harness.tree.children[2].children[2].children[0]);
  const bar = row.children[1];
  assert.equal(bar.children[0].props.style.width, '0.03%');
  assert.equal(bar.props['aria-valuenow'], 0.03);
});

test('expense progress handles excess, unknown cost and zero limits honestly', async () => {
  for (const [cost, source, limit, expected] of [
    ['60', 'estimated', '30', '100%'], ['0', 'estimated', '30', '0%'],
    ['10', 'unknown', '30', null], ['10', 'estimated', '0', null], ['bad', 'estimated', '30', null],
  ]) {
    const snap = structuredClone(exampleSnapshot);
    snap.observed['3h'].cost = cost; snap.observed['3h'].costSource = source;
    snap.windows['3h'].limit = limit;
    const harness = await uiHarness({ snap });
    const row = harness.resolve(harness.tree.children[2].children[2].children[0]);
    const bar = row.children[1];
    if (expected === null) { assert.equal(bar.props['aria-valuenow'], undefined); assert.equal(bar.children[0], null); }
    else assert.equal(bar.children[0].props.style.width, expected);
  }
});

test('waiting explains dispatch and unconfirmed usage stays hidden even with pending records', async () => {
  const snap = structuredClone(exampleSnapshot);
  snap.queue.length = 3; snap.uncertain = { count: 2, amount: '15' };
  const html = htmlOf(await uiHarness({ snap, open: true }));
  assert.match(html, /等待发送/); assert.match(html, /3 \/ 100/);
  assert.doesNotMatch(html, /用量未确认|预留约/);
  assert.match(html, /尚未发给模型/); assert.match(html, /预算超额只提醒/);
  snap.queue.length = 0; snap.uncertain.count = 0;
  const empty = htmlOf(await uiHarness({ snap, open: true }));
  assert.match(empty, /0 \/ 100/); assert.doesNotMatch(empty, /笔用量未确认/);
});
test('pointer drag clamps to the viewport and remembers position', async () => {
  const harness = await uiHarness();
  const grip = harness.tree.children[0];
  let captured;
  grip.props.onPointerDown({ button: 0, pointerId: 1, clientX: 610, clientY: 305, currentTarget: { setPointerCapture(id) { captured = id; } }, preventDefault() {} });
  assert.equal(captured, 1);
  grip.props.onPointerMove({ pointerId: 1, clientX: 2000, clientY: 2000 });
  assert.equal(harness.state[3].x, 614);
  assert.equal(harness.state[3].y, 360);
  assert.equal(JSON.parse(harness.storage.get('ustc-guard.position')).x, 614);
  grip.props.onPointerUp({ pointerId: 1 });
  grip.props.onPointerMove({ pointerId: 1, clientX: 0, clientY: 0 });
  assert.equal(harness.state[3].x, 614);
  grip.props.onDoubleClick();
  assert.equal(harness.state[3], null);
  assert.equal(harness.storage.size, 0);
});

test('unrelated pointer endings cannot interrupt an active drag; capture loss cancels it', async () => {
  const harness = await uiHarness();
  const grip = harness.tree.children[0];
  const down = id => grip.props.onPointerDown({ button: 0, pointerId: id, clientX: 610, clientY: 305, currentTarget: { setPointerCapture() {} }, preventDefault() {} });
  down(1);
  down(2);
  grip.props.onPointerUp({ pointerId: 2 });
  grip.props.onPointerMove({ pointerId: 1, clientX: 200, clientY: 200 });
  assert.equal(harness.state[3]?.x, 190, 'another pointer release must not stop pointer 1');
  grip.props.onPointerCancel({ pointerId: 2 });
  grip.props.onPointerMove({ pointerId: 1, clientX: 300, clientY: 300 });
  assert.equal(harness.state[3].x, 290);
  grip.props.onLostPointerCapture({ pointerId: 1 });
  grip.props.onPointerMove({ pointerId: 1, clientX: 400, clientY: 400 });
  assert.equal(harness.state[3].x, 290, 'capture loss ends the owning drag');
});

test('drag in a viewport smaller than the panel clamps at zero and cancel stops writes', async () => {
  const harness = await uiHarness({ width: 200, height: 120 });
  const grip = harness.tree.children[0];
  let captures = 0;
  const down = button => grip.props.onPointerDown({ button, pointerId: 1, clientX: 610, clientY: 305, currentTarget: { setPointerCapture() { captures++; } }, preventDefault() {} });
  down(2);
  assert.equal(captures, 0);
  down(0);
  grip.props.onPointerMove({ pointerId: 2, clientX: 20, clientY: 20 });
  assert.equal(harness.state[3], null);
  grip.props.onPointerMove({ pointerId: 1, clientX: -20, clientY: 2000 });
  assert.equal(harness.state[3].x, 0); assert.equal(harness.state[3].y, 0);
  grip.props.onPointerCancel({ pointerId: 1 });
  const saved = harness.storage.get('ustc-guard.position');
  grip.props.onPointerMove({ pointerId: 1, clientX: 100, clientY: 100 });
  assert.equal(harness.storage.get('ustc-guard.position'), saved);
});

test('model binding retries after failure and follows other -> USTC without session change', async () => {
  let attempts = 0, listener, chosen = { provider: 'other', model: 'm' };
  const directory = { store: { getSnapshot() { return { current: chosen }; }, subscribe(fn) { listener = fn; return () => { listener = undefined; }; } }, async load() {} };
  const harness = await uiHarness({ selection: null, runEffects: true, services: {
    sessions: { list: { getSnapshot() { return { byId: { s: { id: 's', retainedBy: { mainView: 1 } } } }; }, subscribe() { return () => {}; } } },
    modelDirectories: { directoryFor() { if (++attempts === 1) throw new Error('not ready'); return directory; } },
  } });
  assert.match(htmlOf(harness, harness.render()), /等待识别 USTC 服务地址/);
  harness.timers.get(1000)();
  assert.ok(listener);
  assert.equal(harness.render(), null);
  chosen = { provider: 'alias', model: 'fish' }; listener();
  assert.ok(harness.render());
  chosen = { provider: 'other', model: 'm' }; listener();
  assert.equal(harness.render(), null);
  chosen = { provider: 'alias', model: 'fish' }; harness.timers.get(1000)();
  assert.ok(harness.render(), 'periodic reconciliation recovers missed selection events');
  harness.cleanup(); assert.equal(harness.timers.size, 0);
});

test('USTC route fallback works while catalog is empty, model override remains authoritative', async () => {
  const snap = { ...exampleSnapshot, protectedModels: [], routes: [{ provider: 'alias', protected: true, models: [] }] };
  assert.ok((await uiHarness({ snap })).tree);
  snap.routes[0].models.push({ model: 'fish', protected: false });
  assert.equal((await uiHarness({ snap })).tree, null);
});

function liveServices(directory, session = () => 's') {
  return {
    sessions: { list: { getSnapshot() { const id = session(); return { byId: { [id]: { id, retainedBy: { mainView: 1 } } } }; }, subscribe() { return () => {}; } } },
    modelDirectories: { directoryFor: typeof directory === 'function' ? directory : () => directory },
  };
}
const fixedDirectory = () => ({ store: { getSnapshot() { return { current: { provider: 'alias', model: 'fish' } }; }, subscribe() { return () => {}; } }, async load() {} });

test('Remote failure shows a clear error and subsequent success restores readings', async () => {
  let failure = false;
  const harness = await uiHarness({ runEffects: true, services: liveServices(fixedDirectory()),
    async snapshot() { return failure ? { ok: false, error: { message: 'disconnected' } } : { ok: true, value: exampleSnapshot }; },
  });
  await Promise.resolve(); await Promise.resolve();
  failure = true; await harness.timers.get(2000)();
  assert.match(htmlOf(harness, harness.render()), /无法读取状态：disconnected/);
  failure = false; await harness.timers.get(2000)();
  const html = htmlOf(harness, harness.render());
  assert.match(html, /146.8K Token/); assert.doesNotMatch(html, /disconnected/);
  harness.cleanup();
});

test('late snapshot after unmount cannot write state or restart timers', async () => {
  let complete;
  const harness = await uiHarness({ runEffects: true, services: liveServices(fixedDirectory()), snapshot() { return new Promise(resolve => { complete = resolve; }); } });
  const before = [...harness.state];
  harness.cleanup();
  complete({ ok: true, value: { ...exampleSnapshot, rpm: { used: 999, limit: 20 } } });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(harness.state, before);
  assert.equal(harness.timers.size, 0);
});

test('pending old model load does not prevent a new session binding or overwrite it', async () => {
  let session = 'old', complete, oldReleased = 0;
  const old = { store: { getSnapshot() { return { current: null }; }, subscribe() { return () => { oldReleased++; }; } }, load() { return new Promise(resolve => { complete = resolve; }); } };
  const next = fixedDirectory();
  const harness = await uiHarness({ selection: null, runEffects: true, services: liveServices(id => id === 'old' ? old : next, () => session) });
  await Promise.resolve(); await Promise.resolve();
  session = 'new'; harness.timers.get(1000)();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(harness.render()); assert.equal(oldReleased, 1);
  complete(); await Promise.resolve(); await Promise.resolve();
  assert.equal(harness.state[4].provider, 'alias');
  harness.cleanup(); assert.equal(harness.timers.size, 0);
});

test('configured USTC shows on home screen without a selected session and respects explicit other endpoints', async () => {
  const snap = { ...exampleSnapshot, routes: [{ provider: 'tokenworks-custom', protected: true, models: [] }, { provider: 'other', protected: false, models: [] }] };
  const harness = await uiHarness({ snap, selection: null });
  assert.ok(harness.tree);
  assert.match(htmlOf(harness), /近 12 小时/);
  assert.ok((await uiHarness({ snap, selection: null, minimized: true })).tree);
  assert.equal((await uiHarness({ snap, selection: { provider: 'other', model: 'm' } })).tree, null);
  snap.routes[0].models.push({ model: 'external', protected: false });
  assert.equal((await uiHarness({ snap, selection: { provider: 'tokenworks-custom', model: 'external' } })).tree, null);
  snap.routes = [{ provider: 'ustc', protected: false, models: [] }];
  assert.equal((await uiHarness({ snap, selection: null })).tree, null);
});

test('loading and failed status retrieval stay visible without route metadata', async () => {
  const harness = await uiHarness({ snap: null, selection: null });
  assert.match(htmlOf(harness), /正在连接 USTC 用量监控/);
  harness.state[2] = 'namespace unavailable';
  assert.match(htmlOf(harness, harness.render()), /无法读取状态：namespace unavailable/);
  const snap = { ...exampleSnapshot, routes: [], protectedModels: [] };
  const waiting = await uiHarness({ snap, selection: { provider: 'pending', model: 'm' }, minimized: true });
  assert.match(htmlOf(waiting), /等待识别 USTC 服务地址/);
  assert.doesNotMatch(htmlOf(waiting), /约¥18.86/);
  waiting.state[1] = { ...snap, routes: [{ provider: 'pending', protected: true, models: [] }] };
  assert.match(htmlOf(waiting, waiting.render()), /约¥18.86/);
  waiting.state[1] = { ...snap, routes: [{ provider: 'pending', protected: false, models: [] }] };
  assert.equal(waiting.render(), null);
});

test('enterprise route metadata does not hide the panel after its initial loading flash', async () => {
  const harness = await uiHarness({ snap: null, selection: null });
  assert.ok(harness.tree);
  harness.state[1] = { ...exampleSnapshot, protectedModels: [], routes: [{ provider: 'enterprise', protected: false, addressKnown: false, models: [{ model: 'm', protected: true, addressKnown: true }] }] };
  assert.ok(harness.render(), 'provider without baseURL is valid when its actual models use USTC');
  harness.state[4] = { provider: 'enterprise', model: 'm' };
  assert.match(htmlOf(harness, harness.render()), /近 12 小时/);
  harness.state[1].routes[0].models = [];
  assert.match(htmlOf(harness, harness.render()), /等待识别 USTC 服务地址/);
  harness.state[1].routes[0].addressKnown = true;
  assert.equal(harness.render(), null, 'a genuinely known other endpoint still hides');
});
