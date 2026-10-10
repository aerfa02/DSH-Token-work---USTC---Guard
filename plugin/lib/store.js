/**
 * 持久化：原子写入 + 恢复 + HMR 交接（SPEC 第 30、36 节）。
 *
 * 要求
 *   - Refresh / HMR / Restart / Crash 后数据不得全部归零。
 *   - 写入必须原子：读者只能看到旧的完整内容或新的完整内容。
 *   - 损坏的状态必须被识别为「不可信」，从而触发 fail closed（SPEC 第 32 节），
 *     而不是静默地从空白状态继续跑（那等于绕过所有保护）。
 *
 * 实现
 *   写入走「同目录临时文件 + rename」：rename 在同一文件系统上是原子的。
 *   读取时校验 schemaVersion 与结构，任何不匹配都抛错交由调用方 fail closed。
 *
 * @module lib/store
 */

import { validateHistory } from './history.js';
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isRequestState } from './state.js';

/** 当前状态文件 schema 版本；不匹配即视为不可信。 */
export const STATE_SCHEMA_VERSION = 2;

/**
 * 状态存储。
 */
export class GuardStore {
  /** @type {string} 状态文件的绝对路径。 */
  #path;

  #legacyRaw;
  #legacySavedAt;

  /** @type {boolean} 是否已成功加载过（用于判断 store 是否可信）。 */
  #loaded = false;

  /** @type {boolean} 是否处于损坏状态（损坏后禁止 dispatch）。 */
  #corrupted = false;

  /** @type {string|undefined} 损坏原因。 */
  #corruptionReason;

  /**
   * @param {object} options - 构造选项。
   * @param {string} options.directory - 存放状态的目录（绝对路径）。
   * @param {string} options.filename - 状态文件名。
   */
  constructor(options) {
    this.#path = join(options.directory, options.filename);
  }

  /** 状态文件的绝对路径。 */
  get path() {
    return this.#path;
  }

  /** store 是否可信（已加载成功且未损坏）。 */
  get trusted() {
    return !this.#corrupted;
  }

  /** 损坏原因（若损坏）。 */
  get corruptionReason() {
    return this.#corruptionReason;
  }

  /**
   * 读取并校验状态。
   *
   * 文件不存在返回 undefined（首次运行，属正常情况）；
   * 文件存在但损坏则抛出错误，调用方必须 fail closed。
   * @returns {Promise<object|undefined>} 校验通过的状态；首次运行返回 undefined。
   * @throws {Error} 状态损坏或版本不匹配时抛出。
   */
  async load() {
    try { return await this.#loadValidated(); }
    catch (error) {
      if (this.trusted) this.#markCorrupted(`状态校验失败：${error?.message ?? String(error)}`);
      throw error;
    }
  }

  async #loadValidated() {
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#loaded = true;
        return undefined;
      }
      this.#markCorrupted(`无法读取状态文件：${error?.message ?? String(error)}`);
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.#markCorrupted(`状态文件不是合法 JSON：${error?.message ?? String(error)}`);
      throw new Error(`ustc-guard: 状态文件损坏（JSON 解析失败）：${this.#path}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#markCorrupted('状态文件根节点不是对象');
      throw new Error(`ustc-guard: 状态文件损坏（根节点非对象）：${this.#path}`);
    }
    if (![1, STATE_SCHEMA_VERSION].includes(parsed.schemaVersion)) {
      this.#markCorrupted(`schemaVersion 不匹配：期望 ${STATE_SCHEMA_VERSION}，实际 ${String(parsed.schemaVersion)}`);
      throw new Error(`ustc-guard: 状态文件版本不匹配：${this.#path}`);
    }
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) {
      this.#markCorrupted('缺少合法的 savedAt');
      throw new Error(`ustc-guard: 状态文件损坏（savedAt 非法）：${this.#path}`);
    }
    if (!parsed.limiter || !parsed.budget || !Array.isArray(parsed.requests)) {
      throw new Error('ustc-guard: 状态缺少 limiter/budget/requests');
    }
    if (!Array.isArray(parsed.limiter.dispatchTimestamps) || !Array.isArray(parsed.budget.windows) || !Array.isArray(parsed.budget.reservations)) {
      throw new Error('ustc-guard: 限流或预算账本缺失');
    }
    for (const item of parsed.requests) {
      if (!isRequestState(item?.state)) throw new Error('ustc-guard: 请求状态损坏');
      if (typeof item?.attemptId !== 'string' || !Number.isFinite(item.dispatchTimestamp) || !/^\d+$/.test(item.cost) || !/^\d+$/.test(item.reservation)) {
        throw new Error('ustc-guard: 请求账本损坏');
      }
    }
    const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= parsed.savedAt + 1000;
    const unique = (items, key) => new Set(items.map(item => item[key])).size === items.length;
    if (!timestamp(parsed.savedAt) || !unique(parsed.requests, 'attemptId')
      || !unique(parsed.budget.reservations, 'attemptId') || !unique(parsed.budget.windows, 'label')) {
      throw new Error('ustc-guard: 重复账本标识或非法时间');
    }
    for (const item of parsed.requests) {
      if (!timestamp(item.dispatchTimestamp) || !['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].every(key => Number.isSafeInteger(item[key]) && item[key] >= 0)) {
        throw new Error('ustc-guard: 请求用量或时间损坏');
      }
      if (!Number.isSafeInteger(item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheWriteTokens)
        || (item.usageRecorded !== undefined && typeof item.usageRecorded !== 'boolean')
        || (item.uncertainReservation !== undefined && typeof item.uncertainReservation !== 'boolean')
        || (item.updatedAt !== undefined && !timestamp(item.updatedAt))) throw new Error('请求计数或结算标记损坏');
      if (item.totalTokens !== undefined && (!Number.isSafeInteger(item.totalTokens) || item.totalTokens < 0)) {
        throw new Error('ustc-guard: totalTokens 非法');
      }
    }
    for (const value of parsed.limiter.dispatchTimestamps ?? []) {
      if (!timestamp(value)) throw new Error('ustc-guard: RPM 状态损坏');
    }
    for (const item of parsed.budget.reservations ?? []) {
      if (typeof item.attemptId !== 'string' || !timestamp(item.at) || !/^\d+$/.test(item.amount)) throw new Error('ustc-guard: 预留状态损坏');
    }
    for (const window of parsed.budget.windows ?? []) {
      if (!Array.isArray(window.confirmed)) throw new Error('ustc-guard: 确认账本缺失');
      for (const item of window.confirmed ?? []) {
        if (!timestamp(item.at) || !/^\d+$/.test(item.amount)) throw new Error('ustc-guard: 预算账本损坏');
      }
    }

    if (parsed.schemaVersion === 2 && !parsed.history) throw new Error('2.0 历史账本缺失');
    validateHistory(parsed.history, parsed.savedAt);
    if (parsed.schemaVersion === 1) { this.#legacyRaw = raw; this.#legacySavedAt = parsed.savedAt; }
    this.#loaded = true;
    return parsed;
  }

  /**
   * 原子写入状态。
   *
   * 先写同目录临时文件，再 rename 覆盖目标：读者永远看不到半截内容。
   * @param {object} state - 待写入的状态体。
   * @returns {Promise<void>} 写入完成。
   */
  async save(state) {
    const payload = {
      ...state,
      history: state.history ?? { version: 1, timezone: 'Asia/Shanghai', startedAt: Date.now(), days: [] },
      schemaVersion: STATE_SCHEMA_VERSION,
      savedAt: Date.now(),
    };
    const text = JSON.stringify(payload);
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true });
    if (this.#legacyRaw !== undefined) {
      const backup = this.#path + '.pre-2.0-' + this.#legacySavedAt + '.json';
      try {
        const file = await open(backup, 'wx');
        try { await file.writeFile(this.#legacyRaw, 'utf8'); await file.sync(); } finally { await file.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST' || await readFile(backup, 'utf8') !== this.#legacyRaw) throw error;
      }
      this.#legacyRaw = undefined;
    }
    const temp = `${this.#path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const file = await open(temp, 'wx');
      try {
        await file.writeFile(text, 'utf8');
        await file.sync();
      } finally { await file.close(); }
      await rename(temp, this.#path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * 标记为损坏。
   * @param {string} reason - 原因。
   */
  #markCorrupted(reason) {
    this.#corrupted = true;
    this.#corruptionReason = reason;
  }

  /**
   * 显式标记损坏（供 Host 在关键子系统初始化失败时调用，SPEC 第 32 节）。
   * @param {string} reason - 原因。
   */
  markCorrupted(reason) {
    this.#markCorrupted(reason);
  }

  /**
   * 是否曾经成功加载（用于首次运行判定）。
   * @returns {boolean} 已加载为 true。
   */
  get loaded() {
    return this.#loaded;
  }
}

/**
 * 组装完整状态快照（SPEC 第 30 节字段）。
 * @param {object} parts - 各部分快照。
 * @param {object} parts.limiter - Limiter.snapshot()。
 * @param {object} parts.budget - BudgetGuard.snapshot()。
 * @param {Array<object>} parts.requests - RequestRecord.toJSON() 数组。
 * @param {object} [parts.meta] - 附加元信息。
 * @returns {object} 完整状态体。
 */
export function buildState(parts) {
  return {
    limiter: { dispatchTimestamps: [], activeSlots: [], ...parts.limiter },
    budget: { windows: [], reservations: [], ...parts.budget },
    requests: parts.requests,
    meta: parts.meta ?? {},
    history: parts.history ?? { version: 1, timezone: 'Asia/Shanghai', startedAt: Date.now(), days: [] },
  };
}

/**
 * 判断一组请求记录中哪些在重启前仍处于「进行中」状态。
 *
 * 这些记录重启后必须转为 unknown_after_restart，且**不得**自动重放
 * （SPEC 第 22 节：不能假装 Provider concurrency 已立即归零）。
 * @param {Array<object>} requests - 持久化的请求记录。
 * @returns {Array<object>} 需要标记为 unknown_after_restart 的记录。
 */
export function findInterruptedRequests(requests) {
  if (!Array.isArray(requests)) return [];
  const inFlight = new Set(['queued', 'reserved', 'dispatching', 'streaming', 'retry_wait', 'unknown_after_restart']);
  return requests.filter((item) => inFlight.has(item?.state));
}
