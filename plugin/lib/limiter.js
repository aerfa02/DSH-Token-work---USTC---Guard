/**
 * 限流器：rolling RPM + 并发计数（SPEC 第 6、7 节）。
 *
 * RPM 采用滑动时间戳队列，而非整分钟清零计数器：
 *   任意连续 60 秒内的 dispatch 数 ≤ effectiveRPM。
 *   整分钟清零会在分钟边界产生 burst，验收 A 明确禁止。
 *
 * 并发只统计「已经真正 dispatch 且尚未完全结束」的请求：
 *   排队不算 active；retry wait 不占并发（SPEC 第 19 节）。
 *
 * 本模块是纯内存状态机且**自身串行**：所有变更方法都是同步的。
 * Node 单线程 + 同步临界区保证 acquire 的「检查+占用」不会被其他
 * 请求插入，从根上避免 check-then-set 竞态。
 *
 * @module lib/limiter
 */

/** RPM 观测窗口长度（毫秒）。 */
export const RPM_WINDOW_MS = 60_000;

/**
 * 滑动窗口限流器。
 */
export class Limiter {
  /** @type {number[]} 窗口内的 dispatch 时间戳（升序）。 */
  #dispatchTimestamps = [];

  /** @type {Map<string, number>} 活跃 token → acquire 时间戳。 */
  #activeSlots = new Map();

  /** @type {number} 已发放的并发令牌序号，用于生成唯一 token。 */
  #slotSeq = 0;

  /** @type {() => number} 时钟（可注入以便测试）。 */
  #now;

  /**
   * @param {object} [options] - 构造选项。
   * @param {() => number} [options.now] - 时钟函数，默认 Date.now。
   */
  constructor(options = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * 当前滚动窗口内的 dispatch 数（会先清理过期时间戳）。
   * @returns {number} 窗口内计数。
   */
  rpmUsed() {
    this.#prune(this.#now());
    return this.#dispatchTimestamps.length;
  }

  /**
   * 当前活跃并发数。
   * @returns {number} 活跃数。
   */
  concurrencyUsed() {
    return this.#activeSlots.size;
  }

  /**
   * 判断此刻是否可立即 dispatch（不产生任何副作用）。
   * @param {object} limits - 限制。
   * @param {number} limits.maxRPM - RPM 上限。
   * @param {number} limits.maxConcurrency - 并发上限。
   * @returns {{allowed: boolean, reason?: string, retryAtMs?: number}} 判定结果。
   */
  canAcquire(limits) {
    const now = this.#now();
    this.#prune(now);
    if (this.#dispatchTimestamps.length >= limits.maxRPM) {
      // 最早的一次 dispatch 滑出窗口即可再放行
      const oldest = this.#dispatchTimestamps[0];
      return { allowed: false, reason: 'rpm', retryAtMs: oldest + RPM_WINDOW_MS - now };
    }
    if (this.#activeSlots.size >= limits.maxConcurrency) {
      return { allowed: false, reason: 'concurrency' };
    }
    return { allowed: true };
  }

  /**
   * 原子地占用一个并发令牌**并**记入一次 RPM dispatch。
   *
   * 二者必须同时成功：任一失败则整体不生效，绝不留下半占状态。
   * @param {object} limits - 限制。
   * @param {number} limits.maxRPM - RPM 上限。
   * @param {number} limits.maxConcurrency - 并发上限。
   * @returns {{ok: true, slot: string} | {ok: false, reason: string, retryAtMs?: number}} 结果。
   */
  acquire(limits) {
    const verdict = this.canAcquire(limits);
    if (!verdict.allowed) {
      return verdict.reason === 'rpm'
        ? { ok: false, reason: 'rpm', retryAtMs: verdict.retryAtMs }
        : { ok: false, reason: 'concurrency' };
    }
    const now = this.#now();
    this.#dispatchTimestamps.push(now);
    this.#slotSeq += 1;
    const slot = `slot-${this.#slotSeq}`;
    this.#activeSlots.set(slot, now);
    return { ok: true, slot };
  }

  /**
   * 释放并发令牌。幂等：重复释放同一 token 不会造成计数偏差。
   * @param {string} slot - acquire 返回的令牌。
   * @returns {boolean} 实际释放为 true；令牌不存在（已释放）为 false。
   */
  release(slot) {
    return this.#activeSlots.delete(slot);
  }

  /**
   * 当前所有活跃令牌（用于 HMR / 诊断）。
   * @returns {string[]} 令牌列表。
   */
  activeSlots() {
    return [...this.#activeSlots.keys()];
  }

  /**
   * 清理滑出窗口的时间戳。
   * @param {number} now - 当前时间。
   */
  #prune(now) {
    const cutoff = now - RPM_WINDOW_MS;
    let index = 0;
    while (index < this.#dispatchTimestamps.length && this.#dispatchTimestamps[index] <= cutoff) {
      index += 1;
    }
    if (index > 0) this.#dispatchTimestamps.splice(0, index);
  }

  /**
   * 导出可持久化的计数状态（SPEC 第 30 节：重启不得归零）。
   * @returns {{dispatchTimestamps: number[], activeSlots: [string, number][]}} 状态快照。
   */
  snapshot() {
    this.#prune(this.#now());
    return {
      dispatchTimestamps: [...this.#dispatchTimestamps],
      activeSlots: [...this.#activeSlots.entries()],
    };
  }

  /**
   * 由持久化状态恢复。
   *
   * 关键：只恢复仍在 RPM 窗口内的时间戳；并发令牌不恢复为「活跃」，
   * 因为重启后无法确认上游请求是否仍在运行（SPEC 第 22 节），
   * 调用方须据此进入 Recovery Hold 而非假装并发归零。
   * @param {object} state - snapshot 的结果。
   */
  restore(state) {
    const now = this.#now();
    const cutoff = now - RPM_WINDOW_MS;
    const timestamps = Array.isArray(state?.dispatchTimestamps) ? state.dispatchTimestamps : [];
    this.#dispatchTimestamps = timestamps
      .filter((value) => typeof value === 'number' && Number.isFinite(value) && value > cutoff)
      .sort((a, b) => a - b);
    this.#activeSlots = new Map();
    const seq = Array.isArray(state?.activeSlots) ? state.activeSlots.length : 0;
    this.#slotSeq = seq;
  }

  /**
   * 检测到系统时间回拨时进入保守状态（SPEC 第 37 节）。
   *
   * 若当前时间早于窗口内最早的时间戳，说明时钟被回拨：
   * 此时不能把窗口清零（那等于白白放行），而应保留时间戳，
   * 由 #prune 的 cutoff 逻辑自然延迟其过期。
   * @returns {boolean} 检测到回拨为 true。
   */
  detectClockRollback() {
    const now = this.#now();
    const latest = this.#dispatchTimestamps[this.#dispatchTimestamps.length - 1];
    return latest !== undefined && now < latest;
  }
}
