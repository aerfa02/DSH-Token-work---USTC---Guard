/**
 * 预算守卫：滚动窗口 + 原子预留 + 对账（SPEC 第 9、12、13、16、17 节）。
 *
 * 原子性
 *   预留的「检查」与「写入」在同一个同步临界区内完成。
 *   本模块所有变更方法均为同步函数，且不含 await，
 *   因此 Node 单线程下不可能被其他请求插入 —— 从根上消除
 *   check-then-set 竞态（验收 C：20 个并发只能有 1 个成功）。
 *
 * 保守性
 *   committed（已确认）+ active（已预留）+ uncertain（未确认）三者
 *   同时计入占用，未确认的预留**不会**被提前释放（SPEC 第 17 节）。
 *
 * 时间
 *   内部一律 UTC 毫秒时间戳；窗口按实际 elapsed duration 计算（SPEC 第 11 节）。
 *
 * @module lib/budget
 */

/**
 * 单个预算约束的滚动窗口账本。
 */
export class BudgetWindow {
  /** @type {string} 标签（3h / 12h / 24h）。 */
  label;

  /** @type {number} 窗口长度（毫秒）。 */
  windowMs;

  /** @type {bigint} 窗口内金额上限（微元）。 */
  limit;

  /** @type {Array<{at: number, amount: bigint}>} 已确认消费（按时间升序）。 */
  #confirmed = [];

  /**
   * @param {object} init - 初始化。
   * @param {string} init.label - 标签。
   * @param {number} init.windowMs - 窗口长度（毫秒）。
   * @param {bigint} init.limit - 上限（微元）。
   */
  constructor(init) {
    this.label = init.label;
    this.windowMs = init.windowMs;
    this.limit = init.limit;
  }

  /**
   * 清理滑出窗口的已确认消费。
   * @param {number} now - 当前时间（UTC ms）。
   * @returns {bigint} 被移除的金额合计（供调用方判断是否释放了额度）。
   */
  prune(now) {
    const cutoff = now - this.windowMs;
    let index = 0;
    let removed = 0n;
    while (index < this.#confirmed.length && this.#confirmed[index].at <= cutoff) {
      removed += this.#confirmed[index].amount;
      index += 1;
    }
    if (index > 0) this.#confirmed.splice(0, index);
    return removed;
  }

  /**
   * 窗口内已确认消费合计。
   * @param {number} now - 当前时间。
   * @returns {bigint} 合计（微元）。
   */
  confirmedTotal(now) {
    this.prune(now);
    let total = 0n;
    for (const entry of this.#confirmed) total += entry.amount;
    return total;
  }

  /**
   * 记入一笔已确认消费。
   * @param {number} at - 发生时间。
   * @param {bigint} amount - 金额（微元）。
   */
  addConfirmed(at, amount) {
    if (amount === 0n) return;
    const entry = { at, amount };
    const last = this.#confirmed.at(-1);
    if (!last || last.at <= at) { this.#confirmed.push(entry); return; }
    // Parallel calls complete in arbitrary order; pruning requires dispatch order.
    let low = 0, high = this.#confirmed.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#confirmed[middle].at <= at) low = middle + 1;
      else high = middle;
    }
    this.#confirmed.splice(low, 0, entry);
  }

  /** 从保留的请求账本替换已确认费用，用于单价版本升级。 */
  replaceConfirmed(entries) {
    this.#confirmed = entries
      .filter(entry => Number.isSafeInteger(entry?.at) && entry.at >= 0 && typeof entry.amount === 'bigint' && entry.amount > 0n)
      .map(entry => ({ at: entry.at, amount: entry.amount }))
      .sort((a, b) => a.at - b.at);
  }

  /**
   * 导出状态。
   * @returns {object} 可序列化快照。
   */
  snapshot() {
    return {
      label: this.label,
      windowMs: this.windowMs,
      limit: this.limit.toString(),
      confirmed: this.#confirmed.map((entry) => ({ at: entry.at, amount: entry.amount.toString() })),
    };
  }

  /**
   * 由快照恢复。
   * @param {object} data - snapshot 输出。
   */
  restore(data) {
    const confirmed = Array.isArray(data?.confirmed) ? data.confirmed : [];
    this.#confirmed = confirmed
      .filter((entry) => typeof entry?.at === 'number' && Number.isFinite(entry.at))
      .map((entry) => ({ at: entry.at, amount: BigInt(entry.amount ?? '0') }))
      .sort((a, b) => a.at - b.at);
  }
}

/**
 * 预算守卫：管理多个滚动窗口与所有活跃预留。
 *
 * 预留以 attemptId 为键，保证同一 attempt 不会重复预留，
 * 且对账（reconcile）天然幂等（SPEC 第 16 节）。
 */
export class BudgetGuard {
  /** @type {Map<string, BudgetWindow>} label → 窗口。 */
  #windows = new Map();

  /** @type {Map<string, {amount: bigint, uncertain: boolean, at: number}>} attemptId → 预留。 */
  #reservations = new Map();

  /** @type {boolean} 是否处于严格模式。 */
  #strict;

  /** @type {() => number} 时钟。 */
  #now;

  /**
   * @param {object} options - 构造选项。
   * @param {Array<{label: string, windowMs: number, limit: bigint}>} options.windows - 预算窗口。
   * @param {boolean} [options.strict] - 严格模式（成本未知时阻断）。
   * @param {() => number} [options.now] - 时钟。
   */
  constructor(options) {
    for (const item of options.windows) {
      this.#windows.set(item.label, new BudgetWindow(item));
    }
    this.#strict = options.strict !== false;
    this.#now = options.now ?? (() => Date.now());
  }

  /** 是否严格模式。 */
  get strict() {
    return this.#strict;
  }

  /** 全部窗口标签。 */
  labels() {
    return [...this.#windows.keys()];
  }

  /**
   * 取一个窗口。
   * @param {string} label - 标签。
   * @returns {BudgetWindow} 窗口实例。
   * @throws {TypeError} 标签不存在时抛出。
   */
  window(label) {
    const found = this.#windows.get(label);
    if (found === undefined) throw new TypeError(`未知预算窗口：${label}`);
    return found;
  }

  /**
   * 当前所有活跃预留（含未确认）的金额合计。
   * @returns {bigint} 合计（微元）。
   */
  reservedTotal(windowMs) {
    const now = this.#now();
    const longest = Math.max(...[...this.#windows.values()].map(window => window.windowMs));
    let total = 0n;
    for (const [id, entry] of this.#reservations) {
      if (entry.uncertain && entry.at <= now - longest) {
        this.#reservations.delete(id);
        continue;
      }
      if (!entry.uncertain || windowMs === undefined || entry.at > now - windowMs) total += entry.amount;
    }
    return total;
  }

  /** 未确认预留数量（SPEC 第 17 节 UI 需显示）。 */
  uncertainCount() {
    this.reservedTotal();
    let count = 0;
    for (const entry of this.#reservations.values()) if (entry.uncertain) count += 1;
    return count;
  }

  /** 未确认预留金额合计。 */
  uncertainTotal() {
    this.reservedTotal();
    let total = 0n;
    for (const entry of this.#reservations.values()) if (entry.uncertain) total += entry.amount;
    return total;
  }

  /**
   * 判断某金额能否通过全部窗口（不产生副作用）。
   * @param {bigint} amount - 待预留金额。
   * @returns {{allowed: boolean, blockedBy?: string, available?: bigint}} 判定结果。
   */
  canReserve(amount) {
    const now = this.#now();
    for (const window of this.#windows.values()) {
      const reserved = this.reservedTotal(window.windowMs);
      const used = window.confirmedTotal(now) + reserved;
      const next = used + amount;
      if (next > window.limit) {
        return { allowed: false, blockedBy: window.label, available: window.limit > used ? window.limit - used : 0n };
      }
    }
    return { allowed: true };
  }

  /**
   * 原子地预留预算。
   *
   * 检查与写入在同一同步临界区完成；失败不产生任何残留状态。
   * @param {object} request - 预留请求。
   * @param {string} request.attemptId - attempt ID。
   * @param {bigint} request.amount - 预留金额（微元）。
   * @returns {{ok: true} | {ok: false, reason: string, blockedBy?: string, available?: bigint}} 结果。
   */
  reserve(request) {
    if (this.#reservations.has(request.attemptId)) {
      // 幂等：同一 attempt 不重复预留
      return { ok: true };
    }
    const verdict = this.canReserve(request.amount);
    if (!verdict.allowed && this.#strict) {
      return { ok: false, reason: 'budget', blockedBy: verdict.blockedBy, available: verdict.available };
    }
    this.#reservations.set(request.attemptId, {
      amount: request.amount,
      uncertain: false,
      at: this.#now(),
    });
    return { ok: true };
  }

  /**
   * 把预留标记为「未确认」（SPEC 第 17 节）。
   *
   * 用于：请求已 dispatch 但最终 usage/cost 未知。
   * 标记后该预留继续计入预算，直到权威对账、确认未收费、窗口过期或人工处理。
   * @param {string} attemptId - attempt ID。
   * @returns {boolean} 标记成功为 true（预留不存在为 false）。
   */
  markUncertain(attemptId) {
    const entry = this.#reservations.get(attemptId);
    if (entry === undefined) return false;
    entry.uncertain = true;
    return true;
  }

  /**
   * 对账：把预留转为实际成本，释放差额或补记差额（SPEC 第 16 节）。
   *
   * 幂等：同一 attempt 重复对账不会重复记账。
   * @param {object} request - 对账请求。
   * @param {string} request.attemptId - attempt ID。
   * @param {bigint} request.actual - 实际成本（微元）。
   * @param {number} [request.at] - 发生时间，默认当前。
   * @returns {{ok: boolean, released: bigint, extra: bigint, reason?: string}} 对账结果。
   */
  reconcile(request) {
    const entry = this.#reservations.get(request.attemptId);
    if (entry === undefined) {
      return { ok: false, released: 0n, extra: 0n, reason: 'unknown-attempt' };
    }
    const at = request.at ?? entry.at;
    const actual = request.actual;
    const reserved = entry.amount;

    // 无论多退少补，都把实际成本记入每个窗口
    if (actual > 0n) {
      for (const window of this.#windows.values()) window.addConfirmed(at, actual);
    }
    this.#reservations.delete(request.attemptId);

    if (actual < reserved) return { ok: true, released: reserved - actual, extra: 0n };
    if (actual > reserved) return { ok: true, released: 0n, extra: actual - reserved };
    return { ok: true, released: 0n, extra: 0n };
  }

  /**
   * 释放预留但不记入消费（用于「明确未收费」的场景，SPEC 第 17 节）。
   * @param {string} attemptId - attempt ID。
   * @returns {bigint} 释放的金额；预留不存在时为 0。
   */
  release(attemptId) {
    const entry = this.#reservations.get(attemptId);
    if (entry === undefined) return 0n;
    this.#reservations.delete(attemptId);
    return entry.amount;
  }

  /**
   * 直接记入一笔已确认消费（无预留的场景，如历史数据导入）。
   * @param {object} request - 记账请求。
   * @param {bigint} request.amount - 金额。
   * @param {number} [request.at] - 时间。
   */
  addConfirmed(request) {
    const at = request.at ?? this.#now();
    for (const window of this.#windows.values()) window.addConfirmed(at, request.amount);
  }

  /**
   * 用完整保留的请求记录重建各滚动窗口的已确认消费。
   * 请求账本保留 48 小时，长于最大的 24 小时预算窗口。
   */
  replaceConfirmed(entries) {
    for (const window of this.#windows.values()) window.replaceConfirmed(entries);
  }

  /**
   * 计算某窗口当前用量与占比。
   * @param {string} label - 窗口标签。
   * @returns {{label: string, used: bigint, limit: bigint, ratio: number}} 用量信息。
   */
  usage(label) {
    const window = this.window(label);
    const now = this.#now();
    window.prune(now);
    const used = window.confirmedTotal(now) + this.reservedTotal(window.windowMs);
    const limit = window.limit;
    const ratio = limit === 0n ? 0 : Number((used * 10000n) / limit) / 10000;
    return { label, used, limit, ratio };
  }

  /**
   * 总体状态：由当前最危险的约束决定（SPEC 第 34 节）。
   * @returns {{level: string, ratio: number, label: string}} 状态。
   */
  status() {
    const order = ['normal', 'notice', 'near', 'high', 'exhausted'];
    const levels = [
      { level: 'exhausted', min: 1 },
      { level: 'high', min: 0.95 },
      { level: 'near', min: 0.85 },
      { level: 'notice', min: 0.7 },
      { level: 'normal', min: 0 },
    ];
    let worst = { level: 'normal', ratio: 0, label: '' };
    for (const label of this.#windows.keys()) {
      const item = this.usage(label);
      const level = levels.find((candidate) => item.ratio >= candidate.min)?.level ?? 'normal';
      if (order.indexOf(level) > order.indexOf(worst.level)) {
        worst = { level, ratio: item.ratio, label };
      }
    }
    return worst;
  }

  /**
   * 导出状态（SPEC 第 30 节：重启不得归零）。
   * @returns {object} 快照。
   */
  snapshot() {
    return {
      windows: [...this.#windows.values()].map((window) => window.snapshot()),
      reservations: [...this.#reservations.entries()].map(([attemptId, entry]) => ({
        attemptId,
        amount: entry.amount.toString(),
        uncertain: entry.uncertain,
        at: entry.at,
      })),
    };
  }

  /**
   * 由快照恢复。
   * @param {object} data - snapshot 输出。
   * @param {number} now - 当前时间（用于清理过期数据）。
   */
  restore(data, now = this.#now()) {
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    for (const label of this.#windows.keys()) {
      if (!windows.some(window => window.label === label)) throw new Error(`缺失预算窗口：${label}`);
    }
    for (const item of windows) {
      const window = this.#windows.get(item.label);
      if (window !== undefined) window.restore(item);
    }
    this.#reservations.clear();
    const reservations = Array.isArray(data?.reservations) ? data.reservations : [];
    for (const entry of reservations) {
      if (typeof entry?.attemptId !== 'string') continue;
      this.#reservations.set(entry.attemptId, {
        amount: BigInt(entry.amount ?? '0'),
        uncertain: entry.uncertain === true,
        at: Number(entry.at ?? now),
      });
    }
    for (const window of this.#windows.values()) window.prune(now);
  }

  /**
   * 调度下一个可能的放行时间（SPEC 第 31 节：返回可用 retryAt 而非长时间挂起）。
   * @param {bigint} amount - 期望预留金额。
   * @returns {number|undefined} 最早可能放行的时间戳；无法预测时 undefined。
   */
  nextAvailableAt(amount) {
    const now = this.#now();
    this.reservedTotal();
    let earliest;
    for (const window of this.#windows.values()) {
      const reserved = this.reservedTotal(window.windowMs);
      const used = window.confirmedTotal(now) + reserved;
      if (used + amount <= window.limit) continue;
      if (amount > window.limit) return undefined;
      const expirations = window.snapshot().confirmed.map(entry => ({ at: entry.at + window.windowMs, amount: BigInt(entry.amount) }));
      for (const entry of this.#reservations.values()) {
        if (entry.uncertain && entry.at + window.windowMs > now) expirations.push({ at: entry.at + window.windowMs, amount: entry.amount });
      }
      expirations.sort((a, b) => a.at - b.at);
      let running = used;
      let candidate;
      for (const entry of expirations) {
        running -= entry.amount;
        if (running + amount <= window.limit) {
          candidate = entry.at;
          break;
        }
      }
      if (candidate === undefined) return undefined;
      earliest = Math.max(earliest ?? 0, candidate);
    }
    return earliest;
  }
}
