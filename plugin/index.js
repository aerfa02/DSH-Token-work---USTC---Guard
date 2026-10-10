/**
 * USTC API Guard — Host。
 *
 * 职责
 *   在 `llm/stream` waterfall 上拦截**所有**走向 USTC provider 的模型调用，
 *   在真正的网络 dispatch 之前完成：
 *     Provider 识别 → 有效策略 → RPM 获取 → 并发获取 → 预算预留
 *   并在流结束后做 usage/cost 对账与释放。
 *
 * 为什么是 `llm/stream`
 *   官方描述为 "Waterfall around every streaming model call (retry, replay, routing)"，
 *   它包裹整个流式调用（含重试），是 Provider I/O 前唯一的统一控制点。
 *   主 Agent、子 Agent、标题生成、压缩等所有调用方都经由此处。
 *
 * 为什么本插件**不实现 retry**
 *   DSH 已有唯一 Retry Owner：`@deepseek-ai/dsh-llm-retry`，它挂在
 *   `agent/request-error` 上。每次真正重试都会重新调用 `llm.stream()`，
 *   因此必然再次经过本 Guard —— 「每次 Retry 重新过 Guard」天然成立。
 *   若本插件再加一层 retry，就会形成 SPEC 第 19 节明令禁止的
 *   `DSH retry × Guard retry` 放大。
 *
 * @module dsh-ustc-api-guard
 */

import { UsageHistory } from './lib/history.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { buildEffectivePolicy, normalizeConfig, describePolicy, priceTableForModel, PRICING_VERSION } from './lib/policy.js';
import { identifyProvider, snapshotBaseURL, adapterWithMethod } from './lib/identity.js';
import { attachUstcTimeout } from './lib/stream-timeout.js';
import { Limiter } from './lib/limiter.js';
import { BudgetGuard } from './lib/budget.js';
import { GuardStore, buildState, findInterruptedRequests } from './lib/store.js';
import { RequestRecord } from './lib/state.js';
import { computeCost, estimateReservation, normalizeUsage, COST_SOURCE } from './lib/usage.js';
import { formatMoney, formatMoneyExact, moneyFromString } from './lib/money.js';
import { isUsageChunk, isFinishChunk } from './lib/stream.js';
import { mountSnapshotRemote } from './lib/remote.js';
import { AdmissionQueue } from './lib/queue.js';

/** Cordis 插件名。 */
export const name = 'ustc-api-guard';

/** 依赖的 Host 服务。llm 用于读取 provider 重试策略；webServer/typert 由 Remote 承载。 */
export const inject = ['llm', 'typert'];

/** Resolve only endpoint metadata; never expose credentials to the Client. */
export function routeBaseURL(ctx, provider, model) {
  try {
    const adapter = ctx.llm?.adapters?.get(provider)?.adapter;
    const snapshot = adapterWithMethod(adapter, 'current')?.current();
    return snapshotBaseURL(snapshot, provider, model);
  } catch { return null; }
}

export function protectedModels(ctx) {
  const result = [];
  for (const [provider, registration] of ctx.llm?.adapters ?? []) {
    try {
      const snapshot = adapterWithMethod(registration.adapter, 'current')?.current();
      for (const model of snapshot?.models?.getModels(provider) ?? []) {
        if (identifyProvider({ provider, baseURL: routeBaseURL(ctx, provider, model.id) }).protected) {
          result.push({ provider, model: model.id });
        }
      }
    } catch { /* A broken unrelated adapter must not break the HUD. */ }
  }
  return result;
}

export function routeCatalog(ctx) {
  const result = [];
  for (const [provider, registration] of ctx.llm?.adapters ?? []) {
    try {
      const snapshot = adapterWithMethod(registration.adapter, 'current')?.current();
      const baseURL = snapshotBaseURL(snapshot, provider);
      const models = [];
      try {
        for (const model of snapshot?.models?.getModels(provider) ?? []) {
          const endpoint = model.baseUrl ?? model.baseURL ?? baseURL;
          models.push({ model: model.id, protected: identifyProvider({ provider, baseURL: endpoint }).protected, addressKnown: endpoint != null });
        }
      } catch {}
      result.push({ provider, protected: identifyProvider({ provider, baseURL }).protected, addressKnown: baseURL != null, models });
    } catch {}
  }
  return result;
}

function validUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
    || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
    || !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) return false;
  if (!Number.isSafeInteger(usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))) return false;
  return ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'].every(key =>
    usage[key] === undefined || (Number.isSafeInteger(usage[key]) && usage[key] >= 0));
}

/**
 * Guard 运行时：持有全部限流与预算状态，并对一次请求完成完整的生命周期管理。
 */
export class UstcGuard {
  /** @type {ReturnType<typeof normalizeConfig>} 规范化配置。 */
  #config;

  /** @type {ReturnType<typeof buildEffectivePolicy>} 有效策略。 */
  #policy;

  /** @type {Limiter} 限流器。 */
  #limiter;

  /** @type {BudgetGuard} 预算守卫。 */
  #budget;

  /** @type {GuardStore} 状态存储。 */
  #store;

  /** @type {Map<string, RequestRecord>} 活跃与历史请求记录。 */
  #requests = new Map();

  #history;

  /** @type {Map<string, number>} attemptId → 并发令牌。 */
  #slots = new Map();

  /** @type {{reason: string}|undefined} 致命故障；存在时 USTC 一律 fail closed。 */
  #fatal;

  /** @type {boolean} 是否处于 HMR 交接窗口（短暂 fail closed）。 */
  #handover = false;

  /** @type {() => Promise<void>} 持久化节流句柄。 */
  #flushTimer;

  /** @type {boolean} 是否有待写入的变更。 */
  #dirty = false;
  #queue;
  #priceTableForModel;
  #recoveryUntil = 0;
  #flushChain = Promise.resolve();
  #recoveryCount = 0;

  /**
   * @param {object} options - 构造选项。
   * @param {object} options.config - 用户配置。
   * @param {string} options.stateDirectory - 状态目录（绝对路径）。
   * @param {(message: string, detail?: unknown) => void} [options.log] - 日志函数。
   */
  constructor(options) {
    this.#resolveRoute = options.resolveRoute;
    this.#protectedModels = options.protectedModels;
    this.#routeCatalog = options.routeCatalog;
    this.#config = normalizeConfig(options.config);
    this.#policy = buildEffectivePolicy(this.#config);
    this.#priceTableForModel = options.priceTableForModel ?? (() => this.#policy.priceTable);
    this.#limiter = new Limiter();
    this.#queue = new AdmissionQueue({
      acquire: () => this.#limiter.acquire({ maxRPM: this.#policy.effectiveRPM, maxConcurrency: this.#policy.effectiveConcurrency }),
      maxLength: this.#config.maxQueueLength, waitMs: this.#config.maxQueueWaitMs,
    });
    this.#budget = new BudgetGuard({
      windows: this.#policy.budgetConstraints.map((item) => ({
        label: item.label,
        windowMs: item.windowSeconds * 1000,
        limit: item.limit,
      })),
      strict: this.#config.budgetMode === 'strict',
    });
    this.#history = new UsageHistory(this.#config.displayTimezone);
    this.#store = new GuardStore({
      directory: options.stateDirectory,
      filename: this.#config.storeFilename,
    });
    this.#log = options.log ?? (() => {});
  }

  /** @type {(message: string, detail?: unknown) => void} */
  #log;
  #resolveRoute;
  #protectedModels;
  #routeCatalog;

  /** 当前有效策略。 */
  get policy() {
    return this.#policy;
  }
  get enabled() { return this.#config.enabled; }

  /** 是否处于 fail closed。 */
  get failingClosed() {
    return this.#fatal !== undefined || this.#handover || Date.now() < this.#recoveryUntil;
  }
  markUnavailable(reason) {
    this.#fatal = { reason };
    this.#queue.close();
  }

  /**
   * 初始化：加载持久状态并把重启前进行中的请求标记为 unknown_after_restart。
   *
   * 加载失败即进入 fail closed（SPEC 第 32 节）：绝不以空白状态继续放行。
   * @returns {Promise<void>} 初始化完成。
   */
  async init() {
    try {
      const state = await this.#store.load();
      if (state !== undefined) {
        if (state.savedAt > Date.now() + 1000) throw new Error('状态时间晚于当前时间，检测到时钟回拨');
        this.#limiter.restore(state.limiter);
        this.#budget.restore(state.budget);
        this.#restoreRequests(state.requests);
        this.#history.restore(state.history, state.requests);
        if (!state.history) this.#dirty = true;
        if (state.meta?.pricingVersion !== PRICING_VERSION) {
          this.#repriceLoadedRequests();
          this.#dirty = true;
        }
      }
    } catch (error) {
      this.#fatal = { reason: `状态加载失败：${error?.message ?? String(error)}` };
      this.#store.markCorrupted(String(error?.message ?? error));
      this.#log('ustc-guard: 状态不可信，USTC 请求将 fail closed', error);
      return;
    }
    // 重启前进行中的请求：不得自动重放（SPEC 第 22 节）
    const interrupted = findInterruptedRequests([...this.#requests.values()].map((item) => item.toJSON()));
    for (const item of interrupted) {
      const record = this.#requests.get(item.attemptId);
      if (record === undefined) continue;
      record.state = 'unknown_after_restart';
      record.uncertainReservation = true;
      this.#budget.markUncertain(record.attemptId);
    }
    if (interrupted.length > 0) {
      this.#recoveryUntil = Date.now() + this.#config.recoveryHoldMs;
      this.#recoveryCount = interrupted.length;
      this.#log(`ustc-guard: ${interrupted.length} 个进行中请求在重启后标记为 unknown_after_restart（不自动重放）`);
      this.#dirty = true;
    }
    await this.#flush();
  }

  /**
   * 处理一次模型调用。作为 `llm/stream` listener 的实现。
   *
   * ⚠️ 关键约束：`llm/stream` 是 waterfall，**监听器必须返回 AsyncIterable，
   * 不能返回 Promise**。因此本方法**刻意不是 async 函数**：
   *   - 非 USTC / 已停用：同步 `return next()`
   *   - 受保护：同步返回一个异步生成器（生成器调用即返回 AsyncIterable）
   *
   * 曾因写成 `async handle(...)` 导致返回值是 Promise，上游 `for await` 报
   * 「stream is not async iterable」/「yield* (intermediate value) is not async iterable」，
   * 使每一轮 USTC 对话直接失败。此约束必须保持。
   *
   * @param {object} options - GenerateOptions。
   * @param {() => AsyncIterable<object>} next - 下游（真正的 adapter 流）。
   * @returns {AsyncIterable<object>} 流。
   */
  handle(options, next) {
    if (!this.protects(options)) return next();
    if (!this.#config.enabled) return next();
    return this.#runGuarded(options, next);
  }

  protects(options) {
    return identifyProvider({
      provider: options?.provider,
      baseURL: options?.baseURL ?? options?.endpoint ?? this.#providerBaseURL(options?.provider, options?.model),
      protectedProviders: this.#config.protectedProviders,
      protectedHosts: this.#config.protectedHosts,
    }).protected;
  }

  /**
   * 受保护请求的异步生成器：准入 → dispatch → 透传 → 收尾。
   *
   * 由 `handle` 同步调用，保证调用方拿到的是 AsyncIterable 而非 Promise。
   * @param {object} options - GenerateOptions。
   * @param {() => AsyncIterable<object>} next - 下游流工厂。
   * @returns {AsyncIterable<object>} 包装后的流。
   */
  async* #runGuarded(options, next) {
    if (this.#limiter.detectClockRollback()) this.#fatal = { reason: '系统时钟回拨，限流状态不可信' };
    // Fail closed（SPEC 第 32 节）
    if (this.failingClosed) {
      throw this.#guardError('USTC_GUARD_UNAVAILABLE', this.#fatal?.reason
        ?? (Date.now() < this.#recoveryUntil ? '重启恢复等待中，上游请求可能仍在运行' : 'USTC Guard 正在重载交接中，暂时拒绝请求'));
    }

    const attemptId = randomUUID();
    const now = Date.now();
    const record = new RequestRecord({
      attemptId,
      provider: options.provider,
      model: options.model ?? '',
      scope: this.#policy.budgetScope,
      dispatchTimestamp: now,
    });

    // ---- 1. RPM + 并发（原子获取）----
    const acquired = this.#config.queueEnabled
      ? await this.#queue.acquireSlot(options?.signal)
      : this.#limiter.acquire({
      maxRPM: this.#policy.effectiveRPM,
      maxConcurrency: this.#policy.effectiveConcurrency,
    });
    if (!acquired.ok) {
      // 限流被拒：不占用并发槽、不产生预留（acquire 未成功即无副作用）
      record.state = 'rate_blocked';
      record.retryCount = 0;
      this.#remember(record);
      const error = this.#guardError(
        'USTC_RATE_BLOCKED',
        acquired.reason === 'rpm'
          ? `USTC RPM 已达上限 ${this.#policy.effectiveRPM}/60s`
          : `USTC 并发已达上限 ${this.#policy.effectiveConcurrency}`,
      );
      error.retryAt = acquired.retryAtMs === undefined ? undefined : now + acquired.retryAtMs;
      error.reason = acquired.reason;
      throw error;
    }
    record.state = 'reserved';
    this.#slots.set(attemptId, acquired.slot);

    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      this.#limiter.release(acquired.slot);
      this.#slots.delete(attemptId);
      this.#queue.wake();
    };

    // ---- 2. 预算预留（原子）----
    let reserved = false;
    if (options?.signal?.aborted || this.failingClosed) {
      releaseSlot();
      throw options?.signal?.reason ?? this.#guardError('USTC_GUARD_UNAVAILABLE', 'Guard 不可用');
    }
    if (this.#config.budgetEnabled) {
      const estimate = estimateReservation({
        inputTokens: this.#estimateInputTokens(options),
        maxOutputTokens: this.#maxOutputTokens(options),
        priceTable: this.#priceTableForModel(record.model),
      });
      if (estimate.ok && estimate.basis !== 'input+max-output' && this.#budget.strict) {
        releaseSlot();
        throw this.#guardError('USTC_COST_UNKNOWN', '缺少输入规模或最大输出长度，无法预留完整费用');
      }
      if (!estimate.ok) {
        // 严格模式：无法可靠计算成本时不得当作 0（SPEC 第 13 节）
        if (this.#budget.strict) {
          releaseSlot();
          record.state = 'failed_before_dispatch';
          this.#remember(record);
          throw this.#guardError('USTC_COST_UNKNOWN', `无法估算 USTC 请求成本（${estimate.reason}），严格模式下拒绝发出`);
        }
        this.#log(`ustc-guard: 无法估算成本（${estimate.reason}），monitor 模式下放行但不预留`);
      } else {
        const reservation = this.#budget.reserve({ attemptId, amount: estimate.amount });
        if (!reservation.ok) {
          releaseSlot();
          record.state = 'budget_blocked';
          this.#remember(record);
          const error = this.#guardError(
            'USTC_BUDGET_BLOCKED',
            `USTC 预算不足（${reservation.blockedBy} 窗口），本次请求被拒绝`,
          );
          error.blockedBy = reservation.blockedBy;
          error.available = reservation.available === undefined ? undefined : formatMoneyExact(reservation.available);
          error.retryAt = this.#budget.nextAvailableAt(estimate.amount);
          throw error;
        }
        record.reservation = estimate.amount;
        reserved = true;
      }
    }

    // ---- 3. dispatch（HTTP 从此往下游真正开始）----
    record.state = 'dispatching';
    record.dispatchTimestamp = Date.now();
    this.#remember(record);
    // Commit admission before provider I/O; a crash must not erase reservations.
    await this.#flush();
    if (this.failingClosed || options?.signal?.aborted) {
      releaseSlot();
      if (reserved) this.#budget.release(attemptId);
      record.state = 'failed_before_dispatch';
      this.#remember(record);
      throw options?.signal?.reason ?? this.#guardError('USTC_GUARD_UNAVAILABLE', this.#fatal?.reason ?? 'Guard 不可用');
    }

    let stream;
    try {
      stream = await next();
    } catch (error) {
      // Returning no stream does not prove the remote request was never sent.
      record.finishKind = options?.signal?.aborted ? 'aborted' : 'error';
      record.errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'UNKNOWN';
      releaseSlot();
      const safe = ['NO_ADAPTER', 'INVALID_MODEL', 'UNKNOWN_MODEL', 'INVALID_CONFIG', 'UNSUPPORTED_OPTION', 'INVALID_MODEL_MAX_TOKENS'].includes(error?.code);
      if (reserved) safe ? this.#budget.release(attemptId) : this.#budget.markUncertain(attemptId);
      record.state = safe ? 'failed_before_dispatch' : 'unknown';
      record.uncertainReservation = !safe;
      record.reconciliation = safe ? 'released' : 'uncertain';
      this.#remember(record);
      await this.#flush();
      throw error;
    }

    const context = {
      guard: this,
      attemptId,
      record,
      releaseSlot,
      reserved,
    };

    // 透传 + 收尾（收尾保证恰好一次；异常时不重放，保留 partial）
    let settled = false;
    let usage;
    let finishKind;
    let errorCode;

    /** 收尾恰好一次。 */
    const settleOnce = async () => {
      if (settled) return;
      settled = true;
      try {
        await this.settle(context, { usage, finishKind, errorCode });
      } catch (error) {
        record.uncertainReservation = true;
        if (reserved) this.#budget.markUncertain(attemptId);
        this.#fatal = { reason: '请求收尾失败，状态不可信' };
        this.#log('ustc-guard: 收尾失败', error);
      } finally {
        releaseSlot();
      }
    };

    try {
      for await (const chunk of stream) {
        // 同一 attempt 只采纳第一个 usage（SPEC 第 24 节）
        if (isUsageChunk(chunk)) {
          if (usage === undefined && validUsage(chunk.usage)) usage = chunk.usage;
        } else if (isFinishChunk(chunk)) {
          finishKind = chunk.reason?.kind;
          if (finishKind === 'error' || finishKind === 'aborted') {
            errorCode = chunk.reason?.failure?.code;
          }
        }
        yield chunk;
      }
    } catch (error) {
      // 已 dispatch 后出错：不重放，保留已透传的 partial（SPEC 第 21 节）
      finishKind = options?.signal?.aborted ? 'aborted' : 'error';
      errorCode = error?.code ?? 'UNKNOWN';
      await settleOnce();
      throw error;
    } finally {
      await settleOnce();
    }
  }

  /**
   * 流结束后的收尾：记账、对账、释放（幂等）。
   *
   * @param {object} context - 流上下文。
   * @param {object} outcome - 结果。
   * @param {boolean} outcome.gotUsage - 是否收到 usage。
   * @param {boolean} outcome.gotFinish - 是否收到 finish。
   * @param {string|undefined} outcome.errorCode - 错误码。
   * @param {string|undefined} outcome.finishKind - finish 类型。
   * @returns {Promise<void>} 收尾完成。
   */
  async settle(context, outcome) {
    const { attemptId, record, releaseSlot, reserved } = context;
    // Billing reconciliation and stream outcome are independent: failed streams
    // may still report valid, billable usage. Never persist provider error text.
    record.finishKind = outcome.finishKind ?? (outcome.errorCode ? 'error' : 'closed');
    record.errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(outcome.errorCode ?? '') ? outcome.errorCode : undefined;
    if (record.finishKind === 'error') this.#log(`ustc-guard: 模型请求失败 (${record.errorCode ?? 'UNKNOWN'})`);

    // usage 只记一次（SPEC 第 24 节）
    if (!record.usageRecorded && validUsage(outcome.usage)) {
      const usage = normalizeUsage(outcome.usage);
      record.inputTokens = usage.inputTokens;
      record.outputTokens = usage.outputTokens;
      record.cacheReadTokens = usage.cacheReadTokens;
      record.cacheWriteTokens = usage.cacheWriteTokens;
      record.totalTokens = usage.totalTokens;
      record.reasoningTokens = usage.reasoningTokens;
      record.usageRecorded = true;
      const computed = computeCost({ usage, priceTable: this.#priceTableForModel(record.model) });
      record.cost = computed.cost;
      record.costSource = computed.costSource;
    }

    // 凡「已经越过 dispatch 点」的状态都算已发出：
    // dispatching/streaming 是进行中；partial/unknown 是流的终态；
    // completed 表示正常收尾。遗漏 unknown 会导致「已发出但无 usage」被误判为
    // 未发出，从而提前释放预算预留 —— 违反 SPEC 第 17 节。
    const dispatched = record.state === 'dispatching' || record.state === 'streaming'
      || record.state === 'partial' || record.state === 'unknown' || record.state === 'completed';

    if (record.usageRecorded && record.costSource !== COST_SOURCE.UNKNOWN) {
      // 有真实/可计算 usage：对账（多退少补，幂等）
      if (reserved) {
        const result = this.#budget.reconcile({ attemptId, actual: record.cost });
        record.reconciliation = result.ok ? 'reconciled' : 'missing';
      } else if (this.#config.budgetEnabled) {
        this.#budget.addConfirmed({ amount: record.cost, at: record.dispatchTimestamp });
      }
      if (record.state !== 'completed') {
        // partial/unknown 也可带 usage，统一落到 completed 以便不再占用资源
        record.state = 'completed';
      }
    } else if (record.usageRecorded) {
      // Usage is valid but this exact model has no published rate. Keep token
      // counts, disclose the unpriced call, and never fabricate zero cost.
      if (reserved) {
        record.uncertainReservation = true;
        this.#budget.markUncertain(attemptId);
      }
      record.reconciliation = 'unknown-cost';
      if (record.state !== 'completed') record.state = 'completed';
    } else if (dispatched) {
      // 已 dispatch 但没有 usage：不得立即释放预算（SPEC 第 17 节）
      record.uncertainReservation = true;
      if (reserved) this.#budget.markUncertain(attemptId);
      record.reconciliation = 'uncertain';
      if (record.state === 'dispatching' || record.state === 'streaming') {
        record.state = outcome.finishKind === 'aborted' ? 'partial' : 'unknown';
      }
    } else if (reserved) {
      // 未 dispatch 且无 usage：明确未收费，释放
      this.#budget.release(attemptId);
      record.reconciliation = 'released';
    }

    releaseSlot();
    this.#remember(record);
    await this.#flush();
  }

  /**
   * HMR 交接：停止接受新请求，等待在途请求结束。
   * @returns {Promise<void>} 交接完成。
   */
  async beginHandover() {
    this.#handover = true;
    this.#queue.close();
    await this.#flush();
  }

  /**
   * 结束交接（新实例接管后调用）。
   */
  endHandover() {
    this.#handover = false;
    this.#queue.reopen();
  }

  /**
   * 释放：清空定时器并落盘。
   * @returns {Promise<void>} 完成。
   */
  async dispose() {
    this.#queue.close();
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    await this.#flush();
  }

  /**
   * 供 UI 的状态快照（纯数据，金额转字符串）。
   * @returns {object} 状态。
   */
  snapshot() {
    const now = Date.now();
    const windows = {};
    for (const label of this.#budget.labels()) {
      const item = this.#budget.usage(label);
      windows[label] = {
        used: formatMoneyExact(item.used),
        limit: formatMoneyExact(item.limit),
        ratio: item.ratio,
      };
    }
    // 6h / Today 仅为观测指标，绝不出现在预算约束里（SPEC 第 10 节）
    const observed = this.#observedWindows(now);
    const status = this.#budget.status();
    return {
      runtimeVersion: '1.0.0',
      lastRequest: [...this.#requests.values()].filter(record => record.finishKind)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 1).map(record => ({
          model: record.model, finishKind: record.finishKind, errorCode: record.errorCode,
          at: record.updatedAt, durationMs: Math.max(0, record.updatedAt - record.dispatchTimestamp),
        }))[0] ?? null,
      protectedModels: this.#protectedModels?.() ?? [],
      routes: this.#routeCatalog?.() ?? [],
      policy: describePolicy(this.#policy),
      rpm: { used: this.#limiter.rpmUsed(), limit: this.#policy.effectiveRPM },
      concurrency: { used: this.#limiter.concurrencyUsed() + (now < this.#recoveryUntil ? this.#recoveryCount : 0), limit: this.#policy.effectiveConcurrency },
      tpm: null,
      queue: { length: this.#queue.length, limit: this.#config.maxQueueLength },
      recoveryUntil: this.#recoveryUntil,
      windows,
      observed,
      history: this.#history.snapshot([...this.#requests.values()], now),
      uncertain: { count: this.#budget.uncertainCount(), amount: formatMoneyExact(this.#budget.uncertainTotal()) },
      budgetStatus: status,
      failingClosed: this.failingClosed,
      fatalReason: this.#fatal?.reason ?? null,
      usageSource: 'local-observed',
      lastSync: now,
      displayTimezone: this.#config.displayTimezone,
    };
  }

  /**
   * 计算观测窗口（3h/6h/12h/Today/24h）的 token 与费用。
   *
   * 注意：这些窗口只用于展示，**不参与预算判定**。
   * Today 按 displayTimezone 当天 00:00 起算，与 rolling 24h 完全独立（SPEC 第 10、11 节）。
   * @param {number} now - 当前时间。
   * @returns {Record<string, object>} 各窗口指标。
   */
  #observedWindows(now) {
    const rollups = [
      { label: '3h', ms: 3 * 3600_000 },
      { label: '6h', ms: 6 * 3600_000 },
      { label: '12h', ms: 12 * 3600_000 },
      { label: '24h', ms: 24 * 3600_000 },
    ];
    const result = {};
    const records = [...this.#requests.values()];
    for (const item of rollups) {
      result[item.label] = this.#sumSince(records, now - item.ms, item.label === '3h' || item.label === '12h' || item.label === '24h');
    }
    const todayStart = this.#todayStart(now);
    result.today = { ...this.#sumSince(records, todayStart, false), timezone: this.#config.displayTimezone };
    return result;
  }

  /**
   * 汇总某时间点之后的 token 与费用。
   * @param {RequestRecord[]} records - 请求记录。
   * @param {number} since - 起始时间。
   * @param {boolean} hasBudget - 该窗口是否存在预算约束（决定 UI 是否显示 / ¥X）。
   * @returns {object} 汇总。
   */
  #sumSince(records, since, hasBudget) {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let total = 0;
    let reasoning = 0;
    let cost = 0n;
    let uncertain = 0;
    let unpriced = 0;
    let recorded = 0;
    let missingUsage = 0;
    for (const record of records) {
      if (record.dispatchTimestamp < since || record.dispatchTimestamp > Date.now()) continue;
      input += record.inputTokens;
      output += record.outputTokens;
      reasoning += record.reasoningTokens;
      cacheRead += record.cacheReadTokens;
      cacheWrite += record.cacheWriteTokens;
      total += Number.isSafeInteger(record.totalTokens)
        ? record.totalTokens
        : record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
      if (record.usageRecorded) recorded += 1;
      else if (record.uncertainReservation) missingUsage += 1;
      if (record.usageRecorded && record.costSource === COST_SOURCE.UNKNOWN) unpriced += 1;
      // Display settled cost only; pending reservations are not observed spending.
      if (!(record.usageRecorded && record.costSource === COST_SOURCE.UNKNOWN)) {
        cost += record.cost;
      }
      if (record.uncertainReservation) uncertain += 1;
    }
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: total,
      reasoningTokens: reasoning,
      cost: formatMoneyExact(cost),
      costSource: missingUsage > 0 && recorded === 0 ? COST_SOURCE.UNKNOWN : unpriced > 0 || missingUsage > 0 ? 'partial' : COST_SOURCE.ESTIMATED,
      missingUsage,
      hasBudget,
      uncertain,
      unpriced,
    };
  }

  /** Reprice retained local usage with the current per-model rate catalog. */
  #repriceLoadedRequests() {
    const confirmed = [];
    for (const record of this.#requests.values()) {
      if (!record.usageRecorded) continue;
      const computed = computeCost({
        usage: normalizeUsage(record),
        priceTable: this.#priceTableForModel(record.model),
      });
      record.cost = computed.cost;
      record.costSource = computed.costSource;
      record.reconciliation = computed.costSource === COST_SOURCE.UNKNOWN ? 'unknown-cost' : 'repriced';
      if (computed.costSource !== COST_SOURCE.UNKNOWN && computed.cost > 0n) {
        confirmed.push({ at: record.dispatchTimestamp, amount: computed.cost });
      }
    }
    // The request log is retained 48h, longer than the maximum 24h budget window.
    // This corrects old estimated rows without clearing live reservations.
    this.#budget.replaceConfirmed(confirmed);
  }

  /**
   * 计算 displayTimezone 当天 00:00 的 UTC 毫秒时间戳。
   *
   * Today 与 rolling 24h 是**两套独立逻辑**（SPEC 第 10 节）：
   * 前者按 displayTimezone 的自然日切分，后者按实际流逝的 24 小时。
   * @param {number} now - 当前时间。
   * @returns {number} 当天起点（UTC ms）。
   */
  #todayStart(now) {
    const timezone = this.#config.displayTimezone;
    const text = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(now)); // YYYY-MM-DD
    const [year, month, day] = text.split('-').map(Number);
    return this.#zonedMidnightUtc(year, month, day, timezone);
  }

  /**
   * 求某时区当地 00:00 对应的 UTC 毫秒。
   *
   * 做法：把「当地日期 00:00」当成 UTC 造一个探测时刻，
   * 用 formatToParts 读出该时刻在目标时区的墙上时间，
   * 二者之差即该时区在那一刻的 UTC 偏移，再反推真正的 UTC 时刻。
   * 已用 Asia/Shanghai、UTC、America/New_York 三点验证正确。
   * @param {number} year - 年。
   * @param {number} month - 月（1-12）。
   * @param {number} day - 日。
   * @param {string} timezone - IANA 时区。
   * @returns {number} UTC 毫秒。
   */
  #zonedMidnightUtc(year, month, day, timezone) {
    const probe = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(probe);
    const map = {};
    for (const part of parts) map[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(map.year), Number(map.month) - 1, Number(map.day),
      Number(map.hour) % 24, Number(map.minute), Number(map.second),
    );
    const offset = asUtc - probe.getTime();
    return Date.UTC(year, month - 1, day) - offset;
  }

  /**
   * 估算输入 token（用于预留）。优先用消息文本粗估；不可得则 undefined。
   * @param {object} options - GenerateOptions。
   * @returns {number|undefined} 估算值。
   */
  #estimateInputTokens(options) {
    const messages = Array.isArray(options?.messages) ? options.messages : [];
    if (messages.length === 0) {
      return typeof options?.system === 'string' && options.system !== ''
        ? Buffer.byteLength(options.system, 'utf8') + 16
        : undefined;
    }
    let characters = typeof options?.system === 'string' ? options.system.length : 0;
    for (const message of messages) {
      if (typeof message?.content === 'string') {
        characters += message.content.length;
        continue;
      }
      if (Array.isArray(message?.content)) {
        for (const block of message.content) {
          if (block?.type === 'text' && typeof block.text === 'string') characters += block.text.length;
          else if (block?.type === 'reasoning' && typeof block.text === 'string') characters += block.text.length;
          else if (block?.type === 'tool-call' && typeof block.arguments === 'string') characters += block.arguments.length;
          else characters += 64; // 非文本块的保守固定开销
        }
      }
    }
    // 约 4 字符 ≈ 1 token 的通用经验值；方向偏保守
    // UTF-8 bytes bound text tokenization more conservatively than chars/4.
    // Include tools and message framing; unsupported media is rejected below.
    if (messages.some(message => Array.isArray(message?.content) && message.content.some(block => !['text', 'reasoning', 'tool-call', 'tool-result'].includes(block?.type)))) return undefined;
    try {
      const serialized = JSON.stringify({ system: options?.system, messages, tools: options?.tools });
      return Buffer.byteLength(serialized, 'utf8') + messages.length * 16;
    } catch { return undefined; }
  }

  /**
   * 取该 provider 的最大输出 token 数（用于预留上限）。
   * @param {object} options - GenerateOptions。
   * @returns {number|undefined} 最大输出 token。
   */
  #maxOutputTokens(options) {
    if (Number.isSafeInteger(options?.maxTokens) && options.maxTokens > 0) return options.maxTokens;
    return undefined;
  }

  /**
   * 读取适配器当前解析后的模型地址；正式运行无法解析时返回 null。
   * @param {string|undefined} provider - 路由名。
   * @returns {string|null|undefined} baseURL。
   */
  #providerBaseURL(provider, model) {
    return this.#resolveRoute?.(provider, model);
  }

  /**
   * 记录请求，并限制历史长度避免无限增长。
   * @param {RequestRecord} record - 记录。
   */
  #remember(record) {
    record.updatedAt = Date.now();
    this.#requests.set(record.attemptId, record);
    this.#dirty = true;
    const cutoff = Date.now() - 48 * 3600_000;
    for (const item of this.#requests.values()) {
      if (item.dispatchTimestamp < cutoff && !this.#slots.has(item.attemptId)
        && !['queued', 'reserved', 'dispatching', 'streaming', 'retry_wait'].includes(item.state)) {
        this.#history.archive(item);
        this.#requests.delete(item.attemptId);
      }
    }
    this.#scheduleFlush();
  }

  /**
   * 节流落盘，避免每个 chunk 都写文件。
   */
  #scheduleFlush() {
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#flush();
    }, 250);
    if (typeof this.#flushTimer.unref === 'function') this.#flushTimer.unref();
  }

  /**
   * 落盘（失败不致命，但记录）。
   * @returns {Promise<void>} 完成。
   */
  #flush() {
    const operation = this.#flushChain.then(async () => {
    if (!this.#dirty || this.#fatal) return;
    this.#dirty = false;
    const state = buildState({
      limiter: this.#limiter.snapshot(),
      budget: this.#budget.snapshot(),
      requests: [...this.#requests.values()].map((item) => item.toJSON()),
      meta: { savedBy: name, pricingVersion: PRICING_VERSION },
      history: this.#history.toJSON(),
    });
    try {
      await this.#store.save(state);
    } catch (error) {
      this.#dirty = true;
      this.#fatal = { reason: `状态写入失败：${error?.code ?? 'IO_ERROR'}` };
      this.#queue.close();
      this.#log('ustc-guard: 状态写入失败', error);
    }
    });
    this.#flushChain = operation;
    return operation;
  }

  /**
   * 恢复请求记录。
   * @param {unknown} list - 持久化列表。
   */
  #restoreRequests(list) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      try {
        const record = RequestRecord.fromJSON(item);
        this.#requests.set(record.attemptId, record);
      } catch {
        throw new Error('请求账本损坏，无法安全恢复');
      }
    }
  }

  /**
   * 构造带错误码的 Guard 错误。
   * @param {string} code - 错误码。
   * @param {string} message - 消息。
   * @returns {Error} 错误对象。
   */
  #guardError(code, message) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    error.name = 'UstcGuardError';
    return error;
  }
}

/** Cordis 插件入口。 */
export async function apply(ctx, config = {}) {
  const stateDirectory = resolve(process.env.DSH_HOME ?? process.cwd(), 'ustc-guard');
  const key = Symbol.for('@local/dsh-ustc-api-guard/runtime');
  const runtimes = globalThis[key] ??= new WeakMap();
  let runtime = runtimes.get(ctx.root);
  let normalized;
  let configError;
  try { normalized = normalizeConfig(config); }
  catch (error) { configError = error.message; normalized = normalizeConfig(); }
  const signature = JSON.stringify({ normalized, configError }, (_, value) => typeof value === 'bigint' ? value.toString() : value);
  if (runtime && runtime.signature !== signature) {
    // Keep the old guard closed until a full restart loads changed policy.
    await runtime.guard.beginHandover();
    throw new Error('USTC Guard 配置已改变，请完整重启 DSH 以安全应用新策略');
  }
  if (!runtime) {
  const routeContext = { llm: ctx.llm };
  const guard = new UstcGuard({
    config: configError ? {} : config,
    resolveRoute: (provider, model) => routeBaseURL(routeContext, provider, model),
    protectedModels: () => protectedModels(routeContext),
    routeCatalog: () => routeCatalog(routeContext),
    priceTableForModel,
    stateDirectory,
    log: (message, detail) => {
      if (detail === undefined) ctx.logger?.info?.(message);
      else ctx.logger?.warn?.(message, detail);
    },
  });
  if (configError) guard.markUnavailable(`策略配置无效：${configError}`);
  const ready = guard.init();
  runtime = { guard, ready, signature, owner: undefined };
  runtimes.set(ctx.root, runtime);
  }
  const { guard, ready } = runtime;
  const owner = {};
  runtime.owner = owner;
  await ready;
  guard.endHandover();
  const timeoutAdapters = new Map();
  ctx.effect(() => () => { for (const detach of timeoutAdapters.values()) detach(); timeoutAdapters.clear(); }, 'USTC stream timeout lifecycle');
  // Scope owns both listeners: disabling or uninstalling withdraws all enforcement.
  ctx.on('llm/stream', (options, next) => {
    if (!guard.enabled || !guard.protects(options)) return next();
    const adapter = ctx.llm?.adapters?.get(options.provider)?.adapter;
    if (adapter && !timeoutAdapters.has(adapter)) {
      const detach = attachUstcTimeout(adapter, () => guard.enabled);
      if (detach) timeoutAdapters.set(adapter, detach);
      else ctx.logger?.warn?.('USTC 10分钟空闲超时未应用：当前适配器不支持 streamWithSnapshot');
    }
    return (async function* () {
      await ready;
      yield* guard.handle(options, next);
    })();
  }, { prepend: true });
  ctx.on('agent/request-error', (payload, next) => {
    if (!guard.enabled || !guard.protects({ provider: payload.provider })) return next();
    // Only demonstrably pre-I/O failures may reach DSH's single Retry Owner.
    if (['NO_ADAPTER', 'INVALID_MODEL', 'INVALID_MODEL_MAX_TOKENS'].includes(payload.failure?.code)) return next();
    return undefined;
  }, { prepend: true });
  ctx.effect(() => async () => {
    if (runtime.owner !== owner) return;
    await guard.beginHandover();
    await guard.dispose();
  }, 'ustc-api-guard lifecycle');
  mountSnapshotRemote(ctx, guard, ready);
  ctx.logger?.info?.('USTC Guard 1.0.0 Host activated');
}

/**
 * Host 侧 RPC：供本包 Client 半通过 `host.call` 读取 Guard 状态。
 *
 * 契约：只返回纯 JSON 数据（金额已转字符串），不泄露任何密钥、prompt 或输出。
 * @param {UstcGuard} guard - Guard 实例。
 * @returns {(method: string, args: unknown) => Promise<unknown>} RPC 处理函数。
 */
export function createHostRpc(guard) {
  return async (method, args) => {
    void args;
    if (method === 'snapshot') return guard.snapshot();
    throw new Error(`ustc-guard: 未知的 Host 方法 "${method}"`);
  };
}

export { UstcGuard as Guard };
