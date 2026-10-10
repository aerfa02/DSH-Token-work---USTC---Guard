/**
 * 请求状态机（SPEC 第 18 节）。
 *
 * 每个状态显式回答四个问题，避免散落的条件判断：
 *   - 是否占用 RPM
 *   - 是否占用 Concurrency
 *   - 是否占用 Budget Reservation
 *   - 是否允许 Retry
 *
 * @module lib/state
 */

/** 请求状态定义表。 */
export const REQUEST_STATE = Object.freeze({
  queued: Object.freeze({ rpm: false, concurrency: false, reservation: false, retryable: false }),
  reserved: Object.freeze({ rpm: true, concurrency: false, reservation: true, retryable: false }),
  dispatching: Object.freeze({ rpm: true, concurrency: true, reservation: true, retryable: false }),
  streaming: Object.freeze({ rpm: true, concurrency: true, reservation: true, retryable: false }),
  completed: Object.freeze({ rpm: false, concurrency: false, reservation: false, retryable: false }),
  failed_before_dispatch: Object.freeze({ rpm: true, concurrency: false, reservation: false, retryable: true }),
  failed_after_dispatch: Object.freeze({ rpm: false, concurrency: false, reservation: true, retryable: false }),
  retry_wait: Object.freeze({ rpm: false, concurrency: false, reservation: true, retryable: true }),
  rate_blocked: Object.freeze({ rpm: false, concurrency: false, reservation: false, retryable: true }),
  budget_blocked: Object.freeze({ rpm: false, concurrency: false, reservation: false, retryable: true }),
  aborted: Object.freeze({ rpm: false, concurrency: false, reservation: false, retryable: false }),
  partial: Object.freeze({ rpm: false, concurrency: false, reservation: true, retryable: false }),
  unknown: Object.freeze({ rpm: false, concurrency: false, reservation: true, retryable: false }),
  unknown_after_restart: Object.freeze({ rpm: false, concurrency: false, reservation: true, retryable: false }),
});

/** 全部合法状态名。 */
export const REQUEST_STATE_NAMES = Object.freeze(Object.keys(REQUEST_STATE));

/** 终止状态：不再变化，且不占用任何资源。 */
const TERMINAL = new Set(['completed', 'failed_before_dispatch', 'failed_after_dispatch', 'aborted', 'unknown_after_restart']);

/** 允许的状态迁移（from → 可到的 to 集合）。 */
const TRANSITIONS = Object.freeze({
  queued: ['reserved', 'dispatching', 'rate_blocked', 'budget_blocked', 'aborted', 'failed_before_dispatch'],
  reserved: ['dispatching', 'aborted', 'failed_before_dispatch', 'budget_blocked'],
  dispatching: ['streaming', 'completed', 'failed_after_dispatch', 'aborted', 'partial', 'unknown'],
  streaming: ['completed', 'failed_after_dispatch', 'aborted', 'partial', 'unknown'],
  retry_wait: ['queued', 'reserved', 'dispatching', 'aborted', 'failed_before_dispatch'],
  rate_blocked: ['queued', 'aborted'],
  budget_blocked: ['queued', 'aborted'],
  partial: ['completed', 'unknown', 'aborted'],
  unknown: ['completed', 'unknown_after_restart', 'aborted'],
  // 终止状态无出边
  completed: [],
  failed_before_dispatch: [],
  failed_after_dispatch: [],
  aborted: [],
  unknown_after_restart: [],
});

/**
 * 判断状态名是否合法。
 * @param {unknown} name - 状态名。
 * @returns {boolean} 合法为 true。
 */
export function isRequestState(name) {
  return typeof name === 'string' && Object.hasOwn(REQUEST_STATE, name);
}

/**
 * 判断是否为终止状态。
 * @param {unknown} name - 状态名。
 * @returns {boolean} 终止为 true。
 */
export function isTerminalState(name) {
  return typeof name === 'string' && TERMINAL.has(name);
}

/**
 * 判断迁移是否被允许。
 * @param {string} from - 当前状态。
 * @param {string} to - 目标状态。
 * @returns {boolean} 允许为 true。
 * @throws {TypeError} 状态名非法时抛出。
 */
export function canTransition(from, to) {
  if (!isRequestState(from)) throw new TypeError(`非法状态：${String(from)}`);
  if (!isRequestState(to)) throw new TypeError(`非法状态：${String(to)}`);
  return TRANSITIONS[from].includes(to);
}

/**
 * 该状态是否占用指定资源。
 * @param {string} state - 状态名。
 * @param {'rpm'|'concurrency'|'reservation'|'retryable'} resource - 资源种类。
 * @returns {boolean} 占用为 true。
 */
export function stateHolds(state, resource) {
  if (!isRequestState(state)) throw new TypeError(`非法状态：${String(state)}`);
  return REQUEST_STATE[state][resource] === true;
}

/**
 * 请求记录：承载一个 attempt 的全部可持久化字段（SPEC 第 30 节）。
 */
export class RequestRecord {
  /**
   * @param {object} init - 初始字段。
   * @param {string} init.attemptId - 稳定唯一 attempt ID（禁止用 prompt hash）。
   * @param {string} init.provider - provider 路由名。
   * @param {string} init.model - 模型 id。
   * @param {string} init.scope - quota scope。
   * @param {number} init.dispatchTimestamp - dispatch 时间（UTC ms）。
   */
  constructor(init) {
    this.attemptId = init.attemptId;
    this.provider = init.provider;
    this.model = init.model;
    this.scope = init.scope;
    this.dispatchTimestamp = init.dispatchTimestamp;
    this.state = 'queued';
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.totalTokens = undefined;
    this.reasoningTokens = 0;
    this.usageRecorded = false;
    this.cost = 0n;
    this.costSource = 'unknown';
    this.reservation = 0n;
    this.uncertainReservation = false;
    this.retryCount = 0;
    this.requestId = undefined;
    this.reconciliation = 'none';
    this.updatedAt = Date.now();
  }

  /**
   * 迁移到新状态。
   * @param {string} next - 目标状态。
   * @returns {boolean} 实际发生迁移为 true；已是该状态为 false。
   * @throws {TypeError} 迁移非法时抛出（调用方须修复逻辑，不静默忽略）。
   */
  transition(next) {
    if (this.state === next) return false;
    if (!canTransition(this.state, next)) {
      throw new TypeError(`非法状态迁移：${this.state} → ${next}（attempt ${this.attemptId}）`);
    }
    this.state = next;
    this.updatedAt = Date.now();
    return true;
  }

  /**
   * 投影为可持久化 / 可发送的纯数据。
   * @returns {object} JSON 可序列化对象。
   */
  toJSON() {
    return {
      attemptId: this.attemptId,
      provider: this.provider,
      model: this.model,
      scope: this.scope,
      dispatchTimestamp: this.dispatchTimestamp,
      state: this.state,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      totalTokens: Number.isSafeInteger(this.totalTokens)
        ? this.totalTokens
        : this.inputTokens + this.outputTokens + this.cacheReadTokens + this.cacheWriteTokens,
      reasoningTokens: this.reasoningTokens,
      usageRecorded: this.usageRecorded,
      cost: this.cost.toString(),
      costSource: this.costSource,
      reservation: this.reservation.toString(),
      uncertainReservation: this.uncertainReservation,
      retryCount: this.retryCount,
      requestId: this.requestId ?? null,
      reconciliation: this.reconciliation,
      finishKind: this.finishKind,
      errorCode: this.errorCode,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * 由持久化数据恢复。
   * @param {object} data - toJSON 的输出。
   * @returns {RequestRecord} 记录实例。
   */
  static fromJSON(data) {
    const record = new RequestRecord({
      attemptId: String(data.attemptId),
      provider: String(data.provider ?? ''),
      model: String(data.model ?? ''),
      scope: String(data.scope ?? 'ustc'),
      dispatchTimestamp: Number(data.dispatchTimestamp ?? 0),
    });
    record.state = isRequestState(data.state) ? data.state : 'unknown';
    record.finishKind = typeof data.finishKind === 'string' ? data.finishKind : undefined;
    record.errorCode = typeof data.errorCode === 'string' ? data.errorCode : undefined;
    record.inputTokens = Number(data.inputTokens ?? 0);
    record.outputTokens = Number(data.outputTokens ?? 0);
    record.cacheReadTokens = Number(data.cacheReadTokens ?? 0);
    record.cacheWriteTokens = Number(data.cacheWriteTokens ?? 0);
    const derivedTotal = record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
    record.totalTokens = Number.isSafeInteger(data.totalTokens) && data.totalTokens >= 0
      ? data.totalTokens
      : (Number.isSafeInteger(derivedTotal) ? derivedTotal : 0);
    record.reasoningTokens = Number(data.reasoningTokens ?? 0);
    record.usageRecorded = data.usageRecorded === true;
    record.cost = BigInt(data.cost ?? '0');
    record.costSource = typeof data.costSource === 'string' ? data.costSource : 'unknown';
    record.reservation = BigInt(data.reservation ?? '0');
    record.uncertainReservation = data.uncertainReservation === true;
    record.retryCount = Number(data.retryCount ?? 0);
    record.requestId = data.requestId ?? undefined;
    record.reconciliation = typeof data.reconciliation === 'string' ? data.reconciliation : 'none';
    record.updatedAt = Number(data.updatedAt ?? Date.now());
    return record;
  }
}
