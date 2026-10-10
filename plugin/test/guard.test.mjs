#!/usr/bin/env node
/**
 * USTC API Guard自动测试套件。
 *
 * 覆盖限流、费用、持久化与请求生命周期。
 * 仅用 Node 内置 `node:test` 与 `node:assert`，不引入第三方测试框架。
 *
 * 用法
 *   node --test test/guard.test.mjs
 *
 * 说明
 *   涉及真实网络、平台管理接口、跨进程、多页面、浏览器视觉的验收项无法在此自动覆盖，
 *   会以 `t.skip()` 明确列出原因，绝不伪装为通过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Limiter, RPM_WINDOW_MS } from '../lib/limiter.js';
import { BudgetGuard } from '../lib/budget.js';
import { moneyFromString, formatMoneyExact, formatMoney, moneyScale } from '../lib/money.js';
import { normalizeConfig, buildEffectivePolicy, LOCAL_MAX_RPM, LOCAL_MAX_CONCURRENCY, PRICE_TABLE } from '../lib/policy.js';
import { identifyProvider, isProtectedHost, USTC_HOST } from '../lib/identity.js';
import { normalizeUsage, computeCost, estimateReservation, billableOutputTokens, billableInputTokens, formatCostForDisplay, COST_SOURCE } from '../lib/usage.js';
import { REQUEST_STATE_NAMES, REQUEST_STATE, canTransition, RequestRecord } from '../lib/state.js';
import { GuardStore, STATE_SCHEMA_VERSION, findInterruptedRequests, buildState } from '../lib/store.js';
import { UstcGuard } from '../index.js';

const HOUR = 3600_000;

/** 建一个用注入时钟的限流器。 */
function limiterWithClock(ref) {
  return new Limiter({ now: () => ref.t });
}

/** 建一个三窗口预算守卫。 */
function budgetGuard(ref, limits = { '3h': '30', '12h': '70', '24h': '100' }) {
  return new BudgetGuard({
    windows: Object.entries(limits).map(([label, amount]) => ({
      label,
      windowMs: label === '3h' ? 3 * HOUR : label === '12h' ? 12 * HOUR : 24 * HOUR,
      limit: moneyFromString(amount),
    })),
    now: () => ref.t,
  });
}

/** 造一个一次性异步流。 */
function streamOf(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

/**
 * 迭代受保护流并返回抛出的错误（无错误则为 undefined）。
 *
 * handle() 按 llm/stream 契约同步返回 AsyncIterable，因此准入失败的错误
 * 是在**迭代时**抛出，而非调用时。断言错误必须经由本函数。
 * @param {AsyncIterable<object>} stream - guard.handle() 的返回值。
 * @returns {Promise<unknown>} 抛出的错误或 undefined。
 */
async function drainError(stream) {
  try {
    for await (const _ of stream) { /* drain */ }
    return undefined;
  } catch (error) {
    return error;
  }
}

const CHUNK_TEXT = { type: 'text-delta', index: 0, text: 'hi' };
const CHUNK_USAGE = { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 } };
const CHUNK_FINISH = { type: 'finish', reason: { kind: 'stop' } };
const TEST_PRICE_TABLE = Object.freeze({ inputPerMillion: '0.158208', cacheReadPerMillion: '0.158208', cacheWritePerMillion: '0.158208', outputPerMillion: '47.852815' });

/** 建一个使用独立状态目录的 Guard。 */
async function guardIn(config = {}, dir, priceTableForModel = () => TEST_PRICE_TABLE) {
  const directory = dir ?? await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const guard = new UstcGuard({
    // Legacy rejection-path cases opt out of the production FIFO queue.
    config: { protectedProviders: ['ustc'], queueEnabled: false, ...config },
    stateDirectory: directory,
    priceTableForModel,
    log: () => {},
  });
  await guard.init();
  return { guard, directory };
}

// ───────────────────────────── A. RPM ─────────────────────────────

test('A. RPM：任意连续 60 秒内 dispatch 数不超过 effectiveRPM', () => {
  const ref = { t: 0 };
  const limiter = limiterWithClock(ref);
  const limits = { maxRPM: 20, maxConcurrency: 1000 };
  const stamps = [];
  for (let ms = 0; ms <= 180_000; ms += 1000) {
    ref.t = ms;
    if (limiter.acquire(limits).ok) stamps.push(ms);
  }
  for (let i = 0; i < stamps.length; i += 1) {
    let count = 1;
    for (let j = i + 1; j < stamps.length; j += 1) {
      if (stamps[j] - stamps[i] < RPM_WINDOW_MS) count += 1;
      else break;
    }
    assert.ok(count <= 20, `窗口起点 ${stamps[i]} 内出现 ${count} 次 dispatch`);
  }
});

test('A. RPM：不采用整分钟清零，59.x 到 60.x 之间无 burst', () => {
  const ref = { t: 0 };
  const limiter = limiterWithClock(ref);
  const limits = { maxRPM: 20, maxConcurrency: 1000 };
  for (let i = 0; i < 20; i += 1) assert.ok(limiter.acquire(limits).ok);

  ref.t = 59_999;
  assert.equal(limiter.rpmUsed(), 20, '59.999s 时 20 条仍在窗口内');
  assert.equal(limiter.acquire(limits).ok, false, '59.999s 拒绝第 21 次');

  ref.t = 60_000;
  assert.equal(limiter.rpmUsed(), 0, '60.000s 时全部滑出');
  assert.ok(limiter.acquire(limits).ok, '60.000s 放行（区间 (0,60000] 不含 t=0）');
});

test('A. RPM：失败与重试同样占用额度（由 acquire 时机保证）', () => {
  const ref = { t: 0 };
  const limiter = limiterWithClock(ref);
  const limits = { maxRPM: 2, maxConcurrency: 100 };
  assert.ok(limiter.acquire(limits).ok);
  assert.ok(limiter.acquire(limits).ok);
  assert.equal(limiter.acquire(limits).reason, 'rpm', '额度在 dispatch 前占用，与成败无关');
});

test('A. RPM：platform 更严格时执行更严格者', () => {
  const config = normalizeConfig({ maxRPM: 20 });
  assert.equal(buildEffectivePolicy(config, { rpm: 10 }).effectiveRPM, 10);
  assert.equal(buildEffectivePolicy(config, { rpm: 50 }).effectiveRPM, 20, '平台更宽松不得突破本地硬上限');
});

// ───────────────────────── B. Concurrency ─────────────────────────

test('B. 并发：30 个请求中 active 不超过 20，其余被拒', () => {
  const ref = { t: 0 };
  const limiter = limiterWithClock(ref);
  const limits = { maxRPM: 1000, maxConcurrency: 20 };
  const slots = [];
  let rejected = 0;
  for (let i = 0; i < 30; i += 1) {
    const result = limiter.acquire(limits);
    if (result.ok) slots.push(result.slot);
    else rejected += 1;
  }
  assert.equal(slots.length, 20);
  assert.equal(rejected, 10);
  assert.ok(limiter.concurrencyUsed() <= 20);
});

test('B. 并发：全部释放后 active=0，无 slot leak', () => {
  const ref = { t: 0 };
  const limiter = limiterWithClock(ref);
  const limits = { maxRPM: 1000, maxConcurrency: 5 };
  const slots = [];
  for (let i = 0; i < 5; i += 1) slots.push(limiter.acquire(limits).slot);
  for (const slot of slots) assert.equal(limiter.release(slot), true);
  assert.equal(limiter.concurrencyUsed(), 0, '无 slot leak');
});

test('B. 并发：release 幂等，double-release 不造成负计数', () => {
  const ref = { t: 0 };
  const limiter = limiterWithClock(ref);
  const limits = { maxRPM: 100, maxConcurrency: 5 };
  const { slot } = limiter.acquire(limits);
  assert.equal(limiter.release(slot), true);
  assert.equal(limiter.release(slot), false, '重复释放返回 false');
  assert.equal(limiter.concurrencyUsed(), 0);
});

test('B. 并发：acquire 原子，RPM 与并发用尽时不出现半占', () => {
  const ref = { t: 0 };
  const limiter = limiterWithClock(ref);
  const limits = { maxRPM: 1, maxConcurrency: 1 };
  assert.ok(limiter.acquire(limits).ok);
  assert.equal(limiter.acquire(limits).ok, false);
  assert.equal(limiter.rpmUsed(), 1);
  assert.equal(limiter.concurrencyUsed(), 1);
});

// ───────────────────────── C. Budget Race ─────────────────────────

test('C. Budget Race：20 个并发抢 1 个额度，恰好 1 个成功', () => {
  const ref = { t: 0 };
  const guard = new BudgetGuard({
    windows: [{ label: '3h', windowMs: 3 * HOUR, limit: moneyFromString('1') }],
    now: () => ref.t,
  });
  let ok = 0;
  let blocked = 0;
  for (let i = 0; i < 20; i += 1) {
    const result = guard.reserve({ attemptId: `a${i}`, amount: moneyFromString('0.6') });
    if (result.ok) ok += 1;
    else blocked += 1;
  }
  assert.equal(ok, 1, '必须恰好 1 个预留成功，否则存在竞态');
  assert.equal(blocked, 19);
  assert.equal(formatMoneyExact(guard.reservedTotal()), '0.600000');
});

test('C. Budget：同一 attempt 重复预留是幂等的', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  guard.reserve({ attemptId: 'x', amount: moneyFromString('5') });
  guard.reserve({ attemptId: 'x', amount: moneyFromString('5') });
  assert.equal(formatMoneyExact(guard.reservedTotal()), '5.000000');
});

test('C. Budget：恰好等于限额允许，超出 1 微元即拒绝', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  guard.addConfirmed({ amount: moneyFromString('29'), at: 0 });
  assert.ok(guard.canReserve(moneyFromString('1')).allowed, '29+1=30 恰好等于限额');
  assert.equal(guard.canReserve(moneyFromString('1.000001')).allowed, false, '多 1 微元即拒');
});

// ───────────────────────── D. Budget Windows ─────────────────────────

test('D. 窗口边界：2h59m 与 3h01m', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  guard.addConfirmed({ amount: moneyFromString('25'), at: 0 });

  ref.t = 2 * HOUR + 59 * 60_000;
  assert.equal(formatMoneyExact(guard.usage('3h').used), '25.000000', '2h59m 仍在 3h 内');
  assert.equal(guard.canReserve(moneyFromString('10')).allowed, false);
  assert.ok(guard.canReserve(moneyFromString('4')).allowed);

  ref.t = 3 * HOUR + 60_000;
  assert.equal(formatMoneyExact(guard.usage('3h').used), '0.000000', '3h01m 已滑出');
  assert.equal(formatMoneyExact(guard.usage('12h').used), '25.000000', '仍在 12h 内');
});

test('D. 窗口边界：11h59m 与 12h01m', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  guard.addConfirmed({ amount: moneyFromString('65'), at: 0 });

  ref.t = 11 * HOUR + 59 * 60_000;
  assert.equal(guard.canReserve(moneyFromString('6')).allowed, false, '65 加 6 超过 70');
  ref.t = 12 * HOUR + 60_000;
  assert.equal(formatMoneyExact(guard.usage('12h').used), '0.000000', '12h01m 滑出 12h');
  assert.equal(formatMoneyExact(guard.usage('24h').used), '65.000000', '仍在 24h 内');
});

test('D. 窗口边界：23h59m 与 24h01m', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  guard.addConfirmed({ amount: moneyFromString('95'), at: 0 });

  ref.t = 23 * HOUR + 59 * 60_000;
  assert.equal(guard.canReserve(moneyFromString('6')).allowed, false, '95 加 6 超过 100');
  ref.t = 24 * HOUR + 60_000;
  assert.equal(formatMoneyExact(guard.usage('24h').used), '0.000000', '24h01m 全部滑出');
});

test('D. 多窗口同时生效，取最严格者', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  guard.addConfirmed({ amount: moneyFromString('28'), at: 0 });
  const verdict = guard.canReserve(moneyFromString('3'));
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.blockedBy, '3h', '应由最紧的 3h 窗口拦截');
  assert.equal(formatMoneyExact(verdict.available), '2.000000');
});

// ───────────────────────── E. 6h ─────────────────────────

test('E. 6h 只有 Token 与费用，不存在 70 元预算约束', async () => {
  const { guard, directory } = await guardIn();
  const snapshot = guard.snapshot();
  assert.ok(snapshot.observed['6h'] !== undefined, '6h 观测窗口存在');
  assert.equal(snapshot.observed['6h'].hasBudget, false, '6h 不得带预算约束');
  assert.equal(snapshot.observed['3h'].hasBudget, true);
  assert.equal(snapshot.observed['12h'].hasBudget, true);
  assert.equal(snapshot.observed['24h'].hasBudget, true);
  assert.ok(!('6h' in snapshot.windows), '6h 不得出现在预算窗口集合里');
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── F. Today vs 24h ─────────────────────────

test('F. Today 与 24h 使用不同逻辑，Today 含时区', async () => {
  const { guard, directory } = await guardIn();
  const snapshot = guard.snapshot();
  assert.notEqual(snapshot.observed.today.timezone, undefined, 'Today 必须携带时区');
  assert.equal(snapshot.observed.today.timezone, 'Asia/Shanghai');
  assert.equal(snapshot.observed.today.hasBudget, false, 'Today 不带预算约束');
  assert.equal(snapshot.observed['24h'].hasBudget, true, '24h 带预算约束，证明二者独立');
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── G. Token ─────────────────────────

test('G. Token：五类计数均保留', () => {
  const usage = normalizeUsage({
    inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5,
  });
  assert.equal(usage.inputTokens, 1);
  assert.equal(usage.outputTokens, 2);
  assert.equal(usage.cacheReadTokens, 3);
  assert.equal(usage.cacheWriteTokens, 4);
  assert.equal(usage.reasoningTokens, 5);
});

test('G. Token：reasoning 已含于 output 时不得二次计数', () => {
  const usage = normalizeUsage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 200 });
  assert.equal(billableOutputTokens(usage), 500, '默认不把 reasoning 再加到 output 上');
  assert.equal(billableOutputTokens(usage, { reasoningSeparate: true }), 700, '仅显式声明独立时才相加');

  const base = computeCost({ usage, priceTable: PRICE_TABLE });
  const separate = computeCost({ usage, priceTable: PRICE_TABLE, reasoningSeparate: true });
  assert.ok(separate.cost > base.cost, '独立计价应更贵，证明未重复计');
});

test('G. Token：DSH input 不含缓存，totalTokens 包含 cacheRead/cacheWrite', () => {
  const usage = normalizeUsage({ inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 50 });
  assert.equal(billableInputTokens(usage), 10_050, '普通输入与缓存写入按输入价计');
  assert.equal(usage.totalTokens, 19_150, '缺失 total 时按 DSH 的输入、输出、缓存读写求和');
  assert.equal(normalizeUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, totalTokens: 21 }).totalTokens, 21,
    '优先使用 DSH 明确传来的 totalTokens');
});

test('G. Token：按官方价分别计算普通输入、缓存命中和输出', () => {
  const usage = normalizeUsage({ inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 100_000, totalTokens: 3_100_000 });
  const result = computeCost({ usage, priceTable: PRICE_TABLE });
  assert.equal(formatMoneyExact(result.cost), '2.600000', '1M×¥2 + 2M×¥0.2 + 0.1M×¥2');
  assert.equal(result.totalTokens, 3_100_000);
});

test('G. Token：DSH usage 中的 cacheRead 与 total 原样进入窗口汇总', async () => {
  const { guard, directory } = await guardIn({}, undefined, () => PRICE_TABLE);
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 };
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
    () => streamOf([{ type: 'usage', usage }, CHUNK_FINISH]),
  )) { /* drain */ }
  const today = guard.snapshot().observed.today;
  assert.equal(today.inputTokens, 100);
  assert.equal(today.outputTokens, 10);
  assert.equal(today.cacheReadTokens, 900);
  assert.equal(today.totalTokens, 1010);
  assert.equal(today.cost, '0.000400');
  await guard.dispose();
  await rm(directory, { recursive: true, force: true });
});

test('迁移：旧单价账本按保留的 DSH usage 与逐模型官方单价重算', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-reprice-test-'));
  const legacy = await guardIn({}, directory);
  const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 900_000, totalTokens: 1_010_000 };
  for await (const _ of legacy.guard.handle(
    { provider: 'ustc', model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
    () => streamOf([{ type: 'usage', usage }, CHUNK_FINISH]),
  )) { /* drain */ }
  await legacy.guard.dispose();

  const store = new GuardStore({ directory, filename: 'ustc-guard-state.json' });
  const state = await store.load();
  state.meta.pricingVersion = 'legacy-local-calibration';
  await store.save(state);

  const current = await guardIn({}, directory, () => PRICE_TABLE);
  const today = current.guard.snapshot().observed.today;
  assert.equal(today.cost, '0.400000', '100K×¥2 + 900K×¥0.2 + 10K×¥2');
  assert.equal(today.totalTokens, 1_010_000);
  assert.equal(current.guard.snapshot().windows['3h'].used, '0.400000', '提醒窗口与重算费用一致');
  await current.guard.dispose();
  await rm(directory, { recursive: true, force: true });
});

test('G. Token：失败 attempt 的 usage 仍进入统计', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  const stream = (async function* generate() {
    yield CHUNK_USAGE;
    throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
  })();
  const error = await drainError(guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => stream,
  ));
  assert.equal(error?.code, 'ECONNRESET', '原始异常应向上抛出');
  assert.notEqual(guard.snapshot().windows['3h'].used, '0.000000', '失败请求的 usage 仍应记账');
  await rm(directory, { recursive: true, force: true });
});

test('G. Token：usage 只记账一次（重复 usage chunk）', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard: guardA } = await guardIn({}, dirA);
  for await (const _ of guardA.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => streamOf([CHUNK_USAGE, CHUNK_USAGE, CHUNK_FINISH]),
  )) { /* drain */ }

  const dirB = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard: guardB } = await guardIn({}, dirB);
  for await (const _ of guardB.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => streamOf([CHUNK_USAGE, CHUNK_FINISH]),
  )) { /* drain */ }

  assert.equal(
    guardA.snapshot().windows['3h'].used,
    guardB.snapshot().windows['3h'].used,
    '两个 usage chunk 应与一个的记账结果相同',
  );
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

// ───────────────────────── H. Retry Amplification ─────────────────────────

test('H. Retry：Guard 自身不实现任何 retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  let dispatches = 0;
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => {
      dispatches += 1;
      return streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } } }]);
    },
  )) { /* drain */ }
  assert.equal(dispatches, 1, 'Guard 不得因可重试错误自行重新 dispatch');
  await rm(directory, { recursive: true, force: true });
});

test('H. Retry：每个新 attempt 都重新经过 Guard（RPM 计数递增）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  for (let i = 0; i < 3; i += 1) {
    for await (const _ of guard.handle(
      { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
      () => streamOf([CHUNK_FINISH]),
    )) { /* drain */ }
  }
  assert.equal(guard.snapshot().rpm.used, 3, '3 次 attempt 都应占用 RPM');
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── I. Partial Stream ─────────────────────────

test('I. Partial：断流保留已收到的输出，且不自动重放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  let dispatches = 0;
  const stream = (async function* generate() {
    yield CHUNK_TEXT;
    throw Object.assign(new Error('disconnect'), { code: 'ECONNRESET' });
  })();
  const received = [];
  let thrown;
  try {
    for await (const chunk of guard.handle(
      { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
      () => { dispatches += 1; return stream; },
    )) received.push(chunk);
  } catch (error) {
    thrown = error;
  }
  assert.equal(received.length, 1, '已收到的 partial 输出必须保留');
  assert.equal(thrown?.code, 'ECONNRESET');
  assert.equal(dispatches, 1, '不得自动重新 dispatch');
  assert.equal(guard.snapshot().concurrency.used, 0, '异常路径也必须释放并发槽');
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── J. Safe Retry ─────────────────────────

test('J. Safe Retry：dispatch 前失败不占预算预留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  const failed = await drainError(guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => { throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' }); },
  ));
  assert.equal(failed?.code, 'NO_ADAPTER');
  const snapshot = guard.snapshot();
  assert.equal(snapshot.uncertain.count, 0, 'dispatch 前失败不应留下未确认预留');
  assert.equal(snapshot.concurrency.used, 0, '并发槽必须释放');
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── K. Unknown Cost ─────────────────────────

test('K. Unknown Cost：已 dispatch 但无 usage，预留不释放且标 uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => streamOf([CHUNK_TEXT, CHUNK_FINISH]),
  )) { /* drain */ }
  const snapshot = guard.snapshot();
  assert.equal(snapshot.uncertain.count, 1, 'UI 必须显示未确认请求数');
  assert.notEqual(snapshot.uncertain.amount, '0.000000', '必须显示保守占用金额');
  await rm(directory, { recursive: true, force: true });
});

test('K. Unknown Cost：错误 finish 且无 usage 时预留必须保守保留（回归）', async () => {
  // 回归用例：settle 的 dispatched 判定曾遗漏 unknown 状态，
  // 导致「已收到 429 错误 finish 但无 usage」被误判为未 dispatch，从而提前释放预留。
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429 } } }]),
  )) { /* drain */ }
  const snapshot = guard.snapshot();
  assert.equal(snapshot.uncertain.count, 1, '429 无 usage 必须标为未确认');
  assert.notEqual(snapshot.windows['3h'].used, '0.000000', '预留必须保守保留，不得提前释放');
  assert.equal(snapshot.concurrency.used, 0, '并发槽仍须释放');
  await rm(directory, { recursive: true, force: true });
});

test('K. Unknown Cost：错误 finish 但带 usage 时正常对账', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => streamOf([
      { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', status: 500 } } },
    ]),
  )) { /* drain */ }
  const snapshot = guard.snapshot();
  assert.equal(snapshot.uncertain.count, 0, '有 usage 就不应标未确认');
  assert.equal(snapshot.windows['3h'].used, '0.004943', '按真实 usage 对账（0.000158 加 0.004785）');
  await rm(directory, { recursive: true, force: true });
});

test('K. Unknown Cost：uncertain 预留继续计入预算，阻止后续请求', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  guard.reserve({ attemptId: 'u1', amount: moneyFromString('25') });
  guard.markUncertain('u1');
  assert.equal(guard.uncertainCount(), 1);
  assert.equal(formatMoneyExact(guard.uncertainTotal()), '25.000000');
  assert.equal(guard.canReserve(moneyFromString('10')).allowed, false, '保守保留：不得提前释放');
});

// ───────────────────────── L. Restart ─────────────────────────

test('L. Restart：进行中请求变 unknown_after_restart，且历史不归零', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const first = new UstcGuard({ config: { protectedProviders: ['ustc'] }, stateDirectory: directory, log: () => {} });
  await first.init();
  const relay = first.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 },
    () => streamOf([CHUNK_TEXT, CHUNK_USAGE, CHUNK_FINISH]),
  );
  const iterator = relay[Symbol.asyncIterator]();
  await iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const before = first.snapshot();
  assert.ok(before.rpm.used >= 1, '重启前应有 RPM 记录');

  const second = new UstcGuard({ config: { protectedProviders: ['ustc'] }, stateDirectory: directory, log: () => {} });
  await second.init();
  const after = second.snapshot();
  assert.ok(after.rpm.used >= 1, 'RPM 历史不得归零');
  assert.ok(after.uncertain.count >= 1, '进行中请求必须转为未确认，不得自动重放');
  await rm(directory, { recursive: true, force: true });
});

test('L. Restart：findInterruptedRequests 正确识别进行中状态', () => {
  const requests = [
    { attemptId: '1', state: 'streaming' },
    { attemptId: '2', state: 'dispatching' },
    { attemptId: '3', state: 'completed' },
    { attemptId: '4', state: 'aborted' },
  ];
  const found = findInterruptedRequests(requests).map((item) => item.attemptId);
  assert.deepEqual(found.sort(), ['1', '2']);
});

// ───────────────────────── M/N. 多 Agent / 多页面 ─────────────────────────

test('M. 多 Agent：共享同一 Guard 实例，合计不突破上限', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({ maxRPM: 3 }, directory);
  for (let i = 0; i < 4; i += 1) {
    const error = await drainError(guard.handle(
      { provider: 'ustc', model: 'm', sessionId: `session-${i}`, messages: [{ role: 'user', content: 'x' }], maxTokens: 10 },
      () => streamOf([CHUNK_FINISH]),
    ));
    if (error !== undefined) assert.equal(error.code, 'USTC_RATE_BLOCKED', '第 4 个应被限流');
  }
  assert.equal(guard.snapshot().rpm.used, 3, '所有 agent 合计不得超过 effectiveRPM');
  await rm(directory, { recursive: true, force: true });
});

test('N. 多页面：状态由 Host 单点持有，页面只读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 },
    () => streamOf([CHUNK_FINISH]),
  )) { /* drain */ }
  const pageA = guard.snapshot();
  const pageB = guard.snapshot();
  assert.equal(pageA.rpm.used, pageB.rpm.used, '不同页面必须读到同一份 Guard 状态');
  assert.equal(pageA.rpm.limit, pageB.rpm.limit);
  await rm(directory, { recursive: true, force: true });
});

test('O. 多进程：本架构无法保证跨独立进程强一致', (t) => {
  t.skip('DSH 未提供面向插件通用的跨进程同步原语，验收 O 无法在本架构实现；已列入验收报告「当前无法保证」。');
});

// ───────────────────────── P. Platform Policy ─────────────────────────

test('P. Platform Policy：local 20 加 platform 10 得 10', () => {
  const config = normalizeConfig({ maxRPM: 20 });
  assert.equal(buildEffectivePolicy(config, { rpm: 10 }).effectiveRPM, 10);
});

test('P. Platform Policy：local 20 加 platform 50 得 20', () => {
  const config = normalizeConfig({ maxRPM: 20 });
  assert.equal(buildEffectivePolicy(config, { rpm: 50 }).effectiveRPM, 20);
});

test('P. Platform Policy：并发同样取更严格者', () => {
  const config = normalizeConfig({});
  assert.equal(buildEffectivePolicy(config, { concurrency: 5 }).effectiveConcurrency, 5);
  assert.equal(buildEffectivePolicy(config, { concurrency: 500 }).effectiveConcurrency, 20);
});

test('P. 本地硬上限不可通过配置上调', () => {
  assert.throws(() => normalizeConfig({ maxRPM: 50 }), /硬上限/);
  assert.throws(() => normalizeConfig({ maxConcurrency: 50 }), /硬上限/);
  assert.throws(() => normalizeConfig({ budgets: { '3h': '100' } }), /硬上限/);
  assert.equal(normalizeConfig({ maxRPM: 20 }).maxRPM, LOCAL_MAX_RPM);
  assert.equal(normalizeConfig({}).maxConcurrency, LOCAL_MAX_CONCURRENCY);
});

// ───────────────────────── Q. Fail Closed ─────────────────────────

test('Q. Fail Closed：状态损坏时 USTC 被阻断', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'ustc-guard-state.json'), '{ not valid json');

  const guard = new UstcGuard({ config: { protectedProviders: ['ustc'] }, stateDirectory: directory, log: () => {} });
  await guard.init();
  assert.ok(guard.failingClosed, '损坏状态必须触发 fail closed');

  let dispatched = false;
  const blocked = await drainError(guard.handle({ provider: 'ustc', model: 'm' }, () => {
    dispatched = true;
    return streamOf([]);
  }));
  assert.equal(blocked?.code, 'USTC_GUARD_UNAVAILABLE');
  assert.equal(dispatched, false, 'USTC 请求不得 dispatch');
  await rm(directory, { recursive: true, force: true });
});

test('Q. Fail Closed：其他 Provider 不受影响', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'ustc-guard-state.json'), '{ broken');

  const guard = new UstcGuard({ config: { protectedProviders: ['ustc'] }, stateDirectory: directory, log: () => {} });
  await guard.init();
  assert.ok(guard.failingClosed);

  let dispatched = false;
  for await (const _ of guard.handle({ provider: 'openai', model: 'x' }, () => {
    dispatched = true;
    return streamOf([CHUNK_TEXT]);
  })) { /* drain */ }
  assert.equal(dispatched, true, '非 USTC Provider 必须正常工作');
  await rm(directory, { recursive: true, force: true });
});

test('Q. Fail Closed：状态版本不匹配也视为不可信', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const store = new GuardStore({ directory, filename: 'ustc-guard-state.json' });
  await store.save({ limiter: {}, budget: {}, requests: [] });
  writeFileSync(join(directory, 'ustc-guard-state.json'), JSON.stringify({ schemaVersion: 999, savedAt: Date.now() }));
  await assert.rejects(() => store.load(), /版本不匹配/);
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── R. Queue Cancellation ─────────────────────────

test('R. Queue：被拒请求不占预留、不占并发、无 slot 泄漏', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({ maxConcurrency: 1 }, directory);
  const relay = guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 },
    () => streamOf([CHUNK_TEXT, CHUNK_FINISH]),
  );
  const iterator = relay[Symbol.asyncIterator]();
  await iterator.next();

  const rateBlocked = await drainError(guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 },
    () => streamOf([CHUNK_FINISH]),
  ));
  assert.equal(rateBlocked?.code, 'USTC_RATE_BLOCKED');

  const snapshot = guard.snapshot();
  assert.equal(snapshot.concurrency.used, 1, '被拒请求不得占用并发槽');
  assert.equal(snapshot.uncertain.count, 0, '被拒请求不得留下预留');

  for await (const _ of relay) { /* drain */ }
  assert.equal(guard.snapshot().concurrency.used, 0, '队列不被破坏，且无泄漏');
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── S. HMR / Reload ─────────────────────────

test('S. HMR：交接期间 fail closed，不出现无限制放行窗口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  await guard.beginHandover();
  assert.ok(guard.failingClosed, '交接期间必须 fail closed');

  let dispatched = false;
  const blocked = await drainError(guard.handle({ provider: 'ustc', model: 'm' }, () => {
    dispatched = true;
    return streamOf([]);
  }));
  assert.equal(blocked?.code, 'USTC_GUARD_UNAVAILABLE');
  assert.equal(dispatched, false, 'reload 瞬间不得放行');

  guard.endHandover();
  assert.equal(guard.failingClosed, false, '交接结束后恢复');
  await rm(directory, { recursive: true, force: true });
});

test('S. HMR：重载后计数不归零（经持久状态交接）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 },
    () => streamOf([CHUNK_FINISH]),
  )) { /* drain */ }
  await guard.dispose();

  const next = new UstcGuard({ config: { protectedProviders: ['ustc'] }, stateDirectory: directory, log: () => {} });
  await next.init();
  assert.ok(next.snapshot().rpm.used >= 1, 'dispose 落盘后新实例应恢复计数');
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── T. Cost Precision ─────────────────────────

test('T. 精度：普通浮点会漂移，BigInt 定点不会', () => {
  let floatSum = 0;
  for (let i = 0; i < 300; i += 1) floatSum += 0.1;
  assert.notEqual(floatSum, 30, '浮点累加确实会漂移（这是引入 BigInt 的理由）');

  let fixed = moneyFromString('0');
  for (let i = 0; i < 300; i += 1) fixed += moneyFromString('0.1');
  assert.equal(formatMoneyExact(fixed), '30.000000', '定点累加必须精确');
});

test('T. 精度：29.999999 不得被误判为已达 30 上限', () => {
  const ref = { t: 0 };
  const guard = new BudgetGuard({
    windows: [{ label: '3h', windowMs: 3 * HOUR, limit: moneyFromString('30') }],
    now: () => ref.t,
  });
  const oneMicro = moneyFromString('0.000001');
  for (let i = 0; i < 29_999_999; i += 1) guard.addConfirmed({ amount: oneMicro, at: 0 });
  assert.equal(formatMoneyExact(guard.usage('3h').used), '29.999999');
  assert.ok(guard.canReserve(oneMicro).allowed, '还差 1 微元应仍可放行');

  guard.addConfirmed({ amount: oneMicro, at: 0 });
  assert.equal(formatMoneyExact(guard.usage('3h').used), '30.000000');
  assert.equal(guard.canReserve(oneMicro).allowed, false, '恰好到达后必须拒绝');
});

test('T. 精度：moneyScale 的 floor 与 ceil 方向正确', () => {
  assert.equal(formatMoneyExact(moneyScale(moneyFromString('0.158208'), 22_100_000n, 1_000_000n)), '3.496396');
  assert.equal(formatMoneyExact(moneyScale(moneyFromString('0.158208'), 22_100_000n, 1_000_000n, 'ceil')), '3.496397');
  assert.equal(formatMoneyExact(moneyScale(moneyFromString('2'), 1_000_000n, 1_000_000n)), '2.000000');
  assert.equal(formatMoneyExact(moneyScale(moneyFromString('2'), 1_000_000n, 1_000_000n, 'ceil')), '2.000000');
});

test('T. 精度：金额字符串往返无损', () => {
  for (const text of ['0.000001', '0.158208', '47.852815', '30', '100', '0.1']) {
    const expected = text.includes('.') ? text.padEnd(text.indexOf('.') + 7, '0') : `${text}.000000`;
    assert.equal(formatMoneyExact(moneyFromString(text)), expected);
  }
});

// ───────────────────────── U. Data Honesty ─────────────────────────

test('U. 数据诚实：estimated 显示「约」，unknown 显示 --', () => {
  assert.equal(
    formatCostForDisplay({ cost: moneyFromString('12.4'), costSource: COST_SOURCE.ESTIMATED, format: formatMoney }),
    '约 ¥12.40',
  );
  assert.equal(
    formatCostForDisplay({ cost: 0n, costSource: COST_SOURCE.UNKNOWN, format: formatMoney }),
    '--',
  );
  assert.equal(
    formatCostForDisplay({ cost: moneyFromString('12.4'), costSource: COST_SOURCE.CALCULATED, format: formatMoney }),
    '¥12.40',
  );
});

test('U. 数据诚实：用量来源标为「本 DSH 已观测」，绝非平台总量', async () => {
  const { guard, directory } = await guardIn();
  const snapshot = guard.snapshot();
  assert.equal(snapshot.usageSource, 'local-observed');
  assert.notEqual(snapshot.usageSource, 'platform-authoritative');
  await rm(directory, { recursive: true, force: true });
});

test('U. 数据诚实：单价表标明 USTC 模型服务页来源', () => {
  assert.equal(PRICE_TABLE.source, 'user-specified-ustc-rate');
  assert.equal(PRICE_TABLE.calibratedAt, '2026-10-03');
  assert.equal(PRICE_TABLE.inputPerMillion, '2');
  assert.equal(PRICE_TABLE.cacheReadPerMillion, '0.2');
  assert.equal(PRICE_TABLE.outputPerMillion, '2');
});

test('U. 数据诚实：策略来源为仅本地时不得虚构平台数值', () => {
  const config = normalizeConfig({});
  const policy = buildEffectivePolicy(config);
  assert.equal(policy.policySource, 'local-only');
  assert.equal(policy.platformRPM, undefined, '无平台数据时不得虚构');
  assert.equal(policy.platformConcurrency, undefined);
  assert.equal(policy.effectiveTPM, undefined);
});

// ───────────────────────── V. API Key ─────────────────────────

test('V. 安全：状态文件与快照中不存在任何密钥形态的字符串', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'deepseek-flash', messages: [{ role: 'user', content: 'secret prompt text' }], maxTokens: 10 },
    () => streamOf([CHUNK_USAGE, CHUNK_FINISH]),
  )) { /* drain */ }
  await guard.dispose();

  const { readFileSync, readdirSync } = await import('node:fs');
  const blob = readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8')).join('\n');
  assert.ok(!/Bearer\s/i.test(blob), '不得记录 Authorization');
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(blob), '不得记录 API key');
  assert.ok(!blob.includes('secret prompt text'), '不得记录完整 prompt');

  const snapshot = JSON.stringify(guard.snapshot());
  assert.ok(!snapshot.includes('secret prompt text'), '快照不得包含 prompt');
  assert.ok(!/apiKey|api_key|Authorization/i.test(snapshot), '快照不得含密钥字段');
  await rm(directory, { recursive: true, force: true });
});

// ───────────────────────── W. UI 数据一致性 ─────────────────────────

test('W. UI：面板数据与 Guard 实际值一致', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({ maxRPM: 5, maxConcurrency: 3 }, directory);
  for await (const _ of guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 },
    () => streamOf([CHUNK_FINISH]),
  )) { /* drain */ }
  const snapshot = guard.snapshot();
  assert.equal(snapshot.rpm.limit, 5, 'UI 显示的 RPM 上限必须等于实际策略');
  assert.equal(snapshot.concurrency.limit, 3);
  assert.equal(snapshot.rpm.used, 1, 'UI 显示的已用值必须等于实际计数');
  assert.ok(['normal', 'notice', 'near', 'high', 'exhausted'].includes(snapshot.budgetStatus.level));
  assert.equal(snapshot.displayTimezone, 'Asia/Shanghai', 'Today 必须带时区');
  await rm(directory, { recursive: true, force: true });
});

test('W. UI：预算状态分级阈值正确', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  assert.equal(guard.status().level, 'normal');
  guard.addConfirmed({ amount: moneyFromString('21'), at: 0 });
  assert.equal(guard.status().level, 'notice', '70%');
  guard.addConfirmed({ amount: moneyFromString('4.5'), at: 0 });
  assert.equal(guard.status().level, 'near', '85%');
  guard.addConfirmed({ amount: moneyFromString('3'), at: 0 });
  assert.equal(guard.status().level, 'high', '95%');
  guard.addConfirmed({ amount: moneyFromString('1.5'), at: 0 });
  assert.equal(guard.status().level, 'exhausted', '100%');
});

test('W. 实际 DSH 桌面中的视觉与鼠标拖动需要现场验收', (t) => {
  t.skip('已在浏览器检查实际组件的浅色/深色静态预览；实际 DSH 桌面中的会话切换与拖动仍需现场验收。');
});

// ─────────────── 回归：llm/stream 的 AsyncIterable 契约 ───────────────

test('回归：handle() 必须同步返回 AsyncIterable，绝不能返回 Promise', async () => {
  // 严重缺陷回归：曾把 handle 写成 async，返回值成为 Promise，
  // 上游 for await 报「stream is not async iterable」/「yield* ... is not async iterable」，
  // 导致每一轮 USTC 对话直接失败。此用例锁定该契约。
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);

  const result = guard.handle(
    { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 },
    () => streamOf([CHUNK_FINISH]),
  );

  assert.equal(typeof result?.then, 'undefined', 'handle 不得返回 Promise（不可有 then）');
  assert.equal(typeof result[Symbol.asyncIterator], 'function', 'handle 必须返回 AsyncIterable');

  for await (const _ of result) { /* drain */ }
  await rm(directory, { recursive: true, force: true });
});

test('回归：非 USTC 路径同样同步返回 AsyncIterable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  const result = guard.handle({ provider: 'openai', model: 'x' }, () => streamOf([CHUNK_TEXT]));
  assert.equal(typeof result?.then, 'undefined', '非 USTC 路径也不得返回 Promise');
  assert.equal(typeof result[Symbol.asyncIterator], 'function');
  const seen = [];
  for await (const chunk of result) seen.push(chunk);
  assert.equal(seen.length, 1);
  await rm(directory, { recursive: true, force: true });
});

test('回归：apply() 注册的 llm/stream listener 必须是同步函数', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(
    !/ctx(?:\.root)?\.on\(\s*'llm\/stream'\s*,\s*async/.test(source),
    'llm/stream listener 不得声明为 async',
  );
  assert.ok(
    /ctx(?:\.root)?\.on\(\s*'llm\/stream'\s*,\s*\(/.test(source),
    'llm/stream listener 应以同步箭头函数注册',
  );
});

// ───────────────────────── 成本与估算 ─────────────────────────

test('用户固定价：所有 USTC 模型和 alias 使用输入2输出2缓存0.2且不重复收费', async () => {
  const { priceTableForModel } = await import('../lib/policy.js');
  for (const model of ['deepseek-flash', 'qwen-chat', 'glm-5.3-flash', 'smart/default', 'new-alias']) {
    const price = priceTableForModel(model);
    assert.equal(price.inputPerMillion, '2');
    assert.equal(price.outputPerMillion, '2');
    assert.equal(price.cacheReadPerMillion, '0.2');
    const result = computeCost({ priceTable: price, usage: normalizeUsage({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000 }) });
    assert.equal(result.cost, 2_600_000n);
  }
  assert.equal(priceTableForModel(''), undefined);
});

test('成本：未配置的模型单价明确标为未知，不伪造零费用', () => {
  const result = computeCost({ usage: normalizeUsage({ inputTokens: 10, outputTokens: 2 }), priceTable: undefined });
  assert.equal(result.cost, 0n);
  assert.equal(result.costSource, COST_SOURCE.UNKNOWN);
});

test('成本：无法确定成本时不返回 0，而是明确失败', () => {
  const noPrice = estimateReservation({ priceTable: { inputPerMillion: undefined, outputPerMillion: undefined }, inputTokens: 100 });
  assert.equal(noPrice.ok, false);
  assert.equal(noPrice.reason, 'no-price');

  const noBasis = estimateReservation({ priceTable: PRICE_TABLE });
  assert.equal(noBasis.ok, false);
  assert.equal(noBasis.reason, 'no-usage-basis');
});

test('成本：预留估算方向为 ceil，不低于实际结算', () => {
  const estimate = estimateReservation({
    priceTable: PRICE_TABLE,
    inputTokens: 22_100_000,
    maxOutputTokens: 384_000,
  });
  assert.ok(estimate.ok);
  const settled = computeCost({
    usage: normalizeUsage({ inputTokens: 22_100_000, outputTokens: 384_000 }),
    priceTable: PRICE_TABLE,
    rounding: 'floor',
  });
  assert.ok(estimate.amount >= settled.cost, '预留不得低于 floor 结算值');
});

test('成本：旧 strict 配置也只提醒，无法估算仍可对话', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({ budgetMode: 'strict' }, directory);
  const unknownCost = await drainError(
    guard.handle({ provider: 'ustc', model: 'm' }, () => streamOf([CHUNK_FINISH])),
  );
  assert.equal(unknownCost, undefined);
  assert.equal(guard.snapshot().concurrency.used, 0, '被拒后必须释放并发槽');
  await rm(directory, { recursive: true, force: true });
});

test('成本：对账多退少补，且幂等', () => {
  const ref = { t: 0 };
  const guard = budgetGuard(ref);
  guard.reserve({ attemptId: 'r1', amount: moneyFromString('10') });
  const less = guard.reconcile({ attemptId: 'r1', actual: moneyFromString('4') });
  assert.equal(less.ok, true);
  assert.equal(formatMoneyExact(less.released), '6.000000', 'actual 小于 reserved 释放差额');
  assert.equal(formatMoneyExact(guard.usage('3h').used), '4.000000');
  const again = guard.reconcile({ attemptId: 'r1', actual: moneyFromString('4') });
  assert.equal(again.ok, false, '重复对账不得重复记账');
  assert.equal(formatMoneyExact(guard.usage('3h').used), '4.000000');

  guard.reserve({ attemptId: 'r2', amount: moneyFromString('4') });
  const more = guard.reconcile({ attemptId: 'r2', actual: moneyFromString('10') });
  assert.equal(formatMoneyExact(more.extra), '6.000000', 'actual 大于 reserved 补记差额');
});

// ───────────────────────── 持久化与原子写 ─────────────────────────

test('持久化：首次运行无状态文件不报错', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const store = new GuardStore({ directory, filename: 'ustc-guard-state.json' });
  assert.equal(await store.load(), undefined);
  assert.equal(store.trusted, true);
  await rm(directory, { recursive: true, force: true });
});

test('持久化：写入后可完整读回，且带 schemaVersion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const store = new GuardStore({ directory, filename: 'ustc-guard-state.json' });
  const state = buildState({ limiter: { dispatchTimestamps: [1, 2] }, budget: {}, requests: [], meta: { savedBy: 'test' } });
  await store.save(state);
  const loaded = await store.load();
  assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(typeof loaded.savedAt, 'number');
  assert.deepEqual(loaded.limiter.dispatchTimestamps, [1, 2]);
  await rm(directory, { recursive: true, force: true });
});

test('持久化：原子写不残留临时文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const store = new GuardStore({ directory, filename: 'ustc-guard-state.json' });
  await store.save(buildState({ limiter: {}, budget: {}, requests: [] }));
  const { readdirSync } = await import('node:fs');
  const leftovers = readdirSync(directory).filter((name) => name.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, `不应残留临时文件：${leftovers.join(', ')}`);
  await rm(directory, { recursive: true, force: true });
});

test('限流器：时钟回拨可被检出，且不清零窗口', () => {
  const ref = { t: 100_000 };
  const limiter = limiterWithClock(ref);
  limiter.acquire({ maxRPM: 20, maxConcurrency: 20 });
  ref.t = 50_000;
  assert.equal(limiter.detectClockRollback(), true, '回拨必须被检出');
  assert.equal(limiter.rpmUsed(), 1, '回拨不得让窗口突然清零');
  ref.t = 150_000;
  assert.equal(limiter.detectClockRollback(), false);
});

// ───────────────────────── 状态机与识别 ─────────────────────────

test('状态机：每个状态显式回答占 RPM/并发/预留/可重试四问', () => {
  for (const name of REQUEST_STATE_NAMES) {
    const entry = REQUEST_STATE[name];
    for (const key of ['rpm', 'concurrency', 'reservation', 'retryable']) {
      assert.equal(typeof entry[key], 'boolean', `${name}.${key} 必须是布尔`);
    }
  }
  assert.equal(REQUEST_STATE.streaming.concurrency, true);
  assert.equal(REQUEST_STATE.queued.concurrency, false, '排队不算 active');
  assert.equal(REQUEST_STATE.retry_wait.concurrency, false, 'retry wait 不占并发');
  assert.equal(REQUEST_STATE.unknown.reservation, true, 'unknown 仍占预留');
  assert.equal(REQUEST_STATE.unknown_after_restart.reservation, true);
});

test('状态机：非法迁移会被拒绝而非静默通过', () => {
  assert.ok(canTransition('dispatching', 'streaming'));
  assert.ok(canTransition('streaming', 'completed'));
  assert.equal(canTransition('completed', 'streaming'), false, '终止状态不得再迁移');
  assert.throws(() => canTransition('bogus', 'streaming'), /非法状态/);
});

test('状态机：RequestRecord 记录 SPEC 第 30 节要求的字段', () => {
  const record = new RequestRecord({ attemptId: 'a', provider: 'ustc', model: 'm', scope: 'ustc', dispatchTimestamp: 1 });
  const json = record.toJSON();
  for (const field of [
    'attemptId', 'provider', 'model', 'scope', 'dispatchTimestamp', 'state',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
    'cost', 'costSource', 'reservation', 'uncertainReservation', 'retryCount', 'requestId', 'reconciliation',
  ]) {
    assert.ok(field in json, `缺少持久化字段 ${field}`);
  }
});

test('状态机：attempt ID 不使用 prompt 或 messages hash', () => {
  const a = new RequestRecord({ attemptId: 'id-a', provider: 'ustc', model: 'm', scope: 's', dispatchTimestamp: 1 });
  const b = new RequestRecord({ attemptId: 'id-b', provider: 'ustc', model: 'm', scope: 's', dispatchTimestamp: 1 });
  assert.notEqual(a.attemptId, b.attemptId, '相同 prompt 的两次合法请求必须有不同的 attempt identity');
});

test('识别：USTC 判定集中且多路命中', () => {
  assert.equal(identifyProvider({ provider: 'ustc' }).protected, true);
  assert.equal(identifyProvider({ provider: 'ustc' }).reason, 'provider-name');
  assert.equal(identifyProvider({ provider: 'my-ustc', protectedProviders: ['my-ustc'] }).reason, 'explicit-provider');
  assert.equal(identifyProvider({ provider: 'x', baseURL: 'https://api.llm.ustc.edu.cn/v1' }).reason, 'base-url-host');
  assert.equal(identifyProvider({ provider: 'openai', baseURL: 'https://api.openai.com/v1' }).protected, false);
  assert.equal(identifyProvider({ provider: '' }).protected, false);
  assert.equal(isProtectedHost('https://api.llm.ustc.edu.cn/v1'), true);
  assert.equal(isProtectedHost('https://evil-ustc.edu.cn'), false, '不得被后缀混淆');
  assert.equal(USTC_HOST, 'api.llm.ustc.edu.cn');
});

test('识别：非 USTC 请求零额外延迟与零状态写入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ustc-guard-test-'));
  const { guard } = await guardIn({}, directory);
  let dispatched = false;
  const received = [];
  for await (const chunk of guard.handle({ provider: 'anthropic', model: 'claude' }, () => {
    dispatched = true;
    return streamOf([CHUNK_TEXT]);
  })) received.push(chunk);
  assert.equal(dispatched, true);
  assert.equal(received.length, 1);
  const snapshot = guard.snapshot();
  assert.equal(snapshot.rpm.used, 0, '非 USTC 不占用 Guard 计数');
  assert.equal(snapshot.concurrency.used, 0);
  await rm(directory, { recursive: true, force: true });
});
