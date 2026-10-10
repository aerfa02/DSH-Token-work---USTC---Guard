/**
 * USTC 有效策略（SPEC 第 3 节：唯一策略来源）。
 *
 * 原则
 *   UI / Limiter / Budget Guard 必须读取同一份 Policy，
 *   禁止多个地方各自维护限制数字。
 *
 *   本地上限是硬上限：配置可以调低，但绝不可调高（SPEC 第 2 节）。
 *   平台若返回更严格策略则执行更严格者：effective = min(local, platform)。
 *
 * 现实约束（已在勘察中确认并记录于计划 §7）
 *   DSH 内不存在读取 USTC 平台策略的接口，因此 platform* 一律为 undefined，
 *   effective 退化为 local。此处不虚构平台数值。
 *
 * @module lib/policy
 */

import { moneyFromString, formatMoneyExact } from './money.js';

/** 本地硬上限：RPM（SPEC 第 2 节，配置不可上调超过此值）。 */
export const LOCAL_MAX_RPM = 20;

/** 本地硬上限：并发（SPEC 第 2 节）。 */
export const LOCAL_MAX_CONCURRENCY = 20;

/** 本地预算约束（滚动窗口，秒 → 金额字符串）。 */
export const LOCAL_BUDGETS = Object.freeze([
  Object.freeze({ windowSeconds: 3 * 3600, amount: '30', label: '3h' }),
  Object.freeze({ windowSeconds: 12 * 3600, amount: '70', label: '12h' }),
  Object.freeze({ windowSeconds: 24 * 3600, amount: '100', label: '24h' }),
]);

/** 用户指定的 USTC 固定估价，单位：元 / 百万 token。 */
const rate = (inputPerMillion, cacheReadPerMillion, outputPerMillion) => Object.freeze({
  source: 'user-specified-ustc-rate',
  calibratedAt: '2026-10-03',
  note: '按用户指定的输入2、输出2、缓存命中0.2统一估价；用量来自DSH usage，非平台总账单API',
  inputPerMillion,
  cacheReadPerMillion,
  // 平台页未单列缓存写入价，故 cacheWrite 按普通输入价估算。
  cacheWritePerMillion: inputPerMillion,
  outputPerMillion,
});

const DEEPSEEK_RATE = rate('2', '0.2', '2');
const QWEN_RATE = DEEPSEEK_RATE;
const GLM_RATE = DEEPSEEK_RATE;
const ONE_YUAN_RATE = DEEPSEEK_RATE;

/** 保留旧模型映射导出；所有 USTC 模型现在按用户指定的固定价估算。 */
export const PRICE_TABLES_BY_MODEL = Object.freeze({
  'deepseek-flash': DEEPSEEK_RATE,
  'deepseek-flash-2': DEEPSEEK_RATE,
  'deepseek-v4-flash': DEEPSEEK_RATE,
  'deepseek-v4-flash-ascend1': DEEPSEEK_RATE,
  'glm-5.3-flash': GLM_RATE,
  mineru: ONE_YUAN_RATE,
  'qwen3.8-chat': QWEN_RATE,
  'qwen-chat': QWEN_RATE,
  'qwen3.8-reasoner': QWEN_RATE,
  'qwen-reasoner': QWEN_RATE,
  'qwen3.8-flash-next-2': QWEN_RATE,
  'qwen3.8-flash-next': QWEN_RATE,
  'qwen3-embedding': QWEN_RATE,
  'qwen3-reranker': QWEN_RATE,
  'unlimited-ocr': QWEN_RATE,
});

/**
 * USTC 请求采用用户指定的统一单价，模型 alias 也使用同一估价。
 * @param {string} model - DSH request model ID。
 * @returns {object|undefined} 费率表。
 */
export function priceTableForModel(model) {
  return typeof model === 'string' && model.trim() ? DEEPSEEK_RATE : undefined;
}

/** 默认公开单价供策略说明和纯费用工具使用；运行时必须按实际模型解析。 */
export const PRICE_TABLE = DEEPSEEK_RATE;
export const PRICING_VERSION = 'ustc-user-fixed-2-2-0.2-v2';

/** 计费模式。 */
export const BUDGET_MODE = Object.freeze({
  /** 严格：无法可靠计算成本时阻断（SPEC 第 13 节）。 */
  STRICT: 'strict',
  /** 监控：不阻断预算，仅观测；UI 必须声明预算保护无法保证。 */
  MONITOR: 'monitor',
});

/** 默认配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 是否启用保护。 */
  enabled: true,
  /** RPM 上限（不得超过 LOCAL_MAX_RPM）。 */
  maxRPM: LOCAL_MAX_RPM,
  /** 并发上限（不得超过 LOCAL_MAX_CONCURRENCY）。 */
  maxConcurrency: LOCAL_MAX_CONCURRENCY,
  /** 是否启用预算保护。 */
  budgetEnabled: true,
  /** 计费模式。 */
  budgetMode: BUDGET_MODE.MONITOR,
  /** 额外受保护的 provider 路由名。 */
  protectedProviders: Object.freeze([]),
  /** 额外受保护的上游主机名（用于按 baseURL 识别）。 */
  protectedHosts: Object.freeze(['api.llm.ustc.edu.cn']),
  /** 3h / 12h / 24h 预算覆盖（只能调低）。 */
  budgets: Object.freeze({ '3h': '30', '12h': '70', '24h': '100' }),
  /** 队列上限，防止无限内存增长（SPEC 第 31 节）。 */
  maxQueueLength: 100,
  /** 单次等待限流的最长时间；超时返回明确错误而非长时间挂起。 */
  maxQueueWaitMs: 120000,
  /** Today 显示时区（SPEC 第 11 节）。 */
  displayTimezone: 'Asia/Shanghai',
  /** 持久化文件名（相对 DSH home 的 guard 目录）。 */
  storeFilename: 'ustc-guard-state.json',
  /** 平台策略（当前无来源，显式留空以免虚构）。 */
  platform: Object.freeze({
    rpm: undefined,
    concurrency: undefined,
    tpm: undefined,
  }),
});

/**
 * 校验并规范化用户配置。
 * @param {object} [input] - 插件行传入的 config。
 * @returns {object} 规范化后的配置。
 * @throws {TypeError} 关键字段非法时抛出（触发 Host fail closed）。
 */
export function normalizeConfig(input = {}) {
  const raw = input ?? {};
  const enabled = raw.enabled !== false;
  const maxRPM = normalizeCap(raw.maxRPM, LOCAL_MAX_RPM, 'maxRPM');
  const maxConcurrency = normalizeCap(raw.maxConcurrency, LOCAL_MAX_CONCURRENCY, 'maxConcurrency');
  // User policy: budgets are advisory, including profiles carrying old strict config.
  const budgetMode = BUDGET_MODE.MONITOR;

  const budgets = {};
  for (const entry of LOCAL_BUDGETS) {
    const override = raw.budgets?.[entry.label];
    const value = override === undefined ? moneyFromString(entry.amount) : moneyFromString(String(override));
    if (value <= 0n) throw new TypeError(`预算 ${entry.label} 必须为正数`);
    const hardCap = moneyFromString(entry.amount);
    if (value > hardCap) {
      // 本地硬上限不可上调（SPEC 第 2 节）
      throw new TypeError(`预算 ${entry.label} 不可超过本地硬上限 ${entry.amount} 元`);
    }
    budgets[entry.label] = value;
  }

  const protectedProviders = normalizeStringList(raw.protectedProviders);
  const protectedHosts = normalizeStringList(raw.protectedHosts, DEFAULT_CONFIG.protectedHosts, true);
  const maxQueueLength = normalizePositiveInt(raw.maxQueueLength, DEFAULT_CONFIG.maxQueueLength, 'maxQueueLength');
  const maxQueueWaitMs = normalizePositiveInt(raw.maxQueueWaitMs, DEFAULT_CONFIG.maxQueueWaitMs, 'maxQueueWaitMs');
  const displayTimezone = typeof raw.displayTimezone === 'string' && raw.displayTimezone !== ''
    ? raw.displayTimezone
    : DEFAULT_CONFIG.displayTimezone;
  assertTimezone(displayTimezone);
  const storeFilename = raw.storeFilename ?? DEFAULT_CONFIG.storeFilename;
  if (typeof storeFilename !== 'string' || !/^[\w.-]+$/.test(storeFilename) || storeFilename === '.' || storeFilename === '..') {
    throw new TypeError('storeFilename 必须是目录内的普通文件名');
  }

  return {
    enabled,
    queueEnabled: raw.queueEnabled !== false,
    recoveryHoldMs: normalizePositiveInt(raw.recoveryHoldMs, 60000, 'recoveryHoldMs'),
    maxRPM,
    maxConcurrency,
    budgetEnabled: raw.budgetEnabled !== false,
    budgetMode,
    protectedProviders,
    protectedHosts,
    budgets,
    maxQueueLength,
    maxQueueWaitMs,
    displayTimezone,
    storeFilename,
  };
}

/**
 * 构造有效策略对象（SPEC 第 3 节的 UstcEffectivePolicy）。
 *
 * UI / Limiter / Budget 均消费本对象，确保只有一处限制数字。
 * @param {object} config - normalizeConfig 的结果。
 * @param {object} [platform] - 平台返回的策略；当前无来源，缺省即 unknown。
 * @returns {object} 有效策略。
 */
export function buildEffectivePolicy(config, platform = DEFAULT_CONFIG.platform) {
  const platformRPM = platform?.rpm;
  const platformConcurrency = platform?.concurrency;
  const platformTPM = platform?.tpm;

  // effective = min(local, platform)；平台未知则取 local
  const effectiveRPM = minDefined(config.maxRPM, platformRPM);
  const effectiveConcurrency = minDefined(config.maxConcurrency, platformConcurrency);
  const effectiveTPM = minDefined(undefined, platformTPM);

  const constraints = LOCAL_BUDGETS.map((entry) => ({
    label: entry.label,
    windowSeconds: entry.windowSeconds,
    limit: config.budgets[entry.label],
    source: config.budgets[entry.label] === moneyFromString(entry.amount) ? 'local' : 'local-override',
  }));

  const policySource = platformRPM === undefined && platformConcurrency === undefined && platformTPM === undefined
    ? 'local-only'
    : 'local+platform';

  return Object.freeze({
    providerIdentity: 'ustc',
    rateScope: 'ustc',
    concurrencyScope: 'ustc',
    budgetScope: 'ustc',
    localRPM: config.maxRPM,
    platformRPM,
    effectiveRPM,
    localConcurrency: config.maxConcurrency,
    platformConcurrency,
    effectiveConcurrency,
    localTPM: undefined,
    platformTPM,
    effectiveTPM,
    budgetConstraints: constraints,
    budgetMode: config.budgetMode,
    budgetEnabled: config.budgetEnabled,
    priceTable: PRICE_TABLE,
    policySource,
    policyTimestamp: Date.now(),
    displayTimezone: config.displayTimezone,
  });
}

/**
 * 把有效策略投影为可安全发送到 Client 的纯数据。
 * @param {object} policy - buildEffectivePolicy 的结果。
 * @returns {object} JSON 可序列化对象（金额已转字符串）。
 */
export function describePolicy(policy) {
  return {
    providerIdentity: policy.providerIdentity,
    rateScope: policy.rateScope,
    concurrencyScope: policy.concurrencyScope,
    budgetScope: policy.budgetScope,
    localRPM: policy.localRPM,
    platformRPM: policy.platformRPM ?? null,
    effectiveRPM: policy.effectiveRPM,
    localConcurrency: policy.localConcurrency,
    platformConcurrency: policy.platformConcurrency ?? null,
    effectiveConcurrency: policy.effectiveConcurrency,
    platformTPM: policy.platformTPM ?? null,
    effectiveTPM: policy.effectiveTPM ?? null,
    budgetMode: policy.budgetMode,
    budgetEnabled: policy.budgetEnabled,
    budgetConstraints: policy.budgetConstraints.map((item) => ({
      label: item.label,
      windowSeconds: item.windowSeconds,
      limit: formatMoneyExact(item.limit),
      source: item.source,
    })),
    priceTableSource: policy.priceTable.source,
    priceTableNote: policy.priceTable.note,
    policySource: policy.policySource,
    policyTimestamp: policy.policyTimestamp,
    displayTimezone: policy.displayTimezone,
  };
}

/**
 * 取两个值中的较小者，忽略 undefined / null。
 * @param {number|undefined} a - 值一。
 * @param {number|undefined} b - 值二。
 * @returns {number|undefined} 较小者；两者皆无则 undefined。
 */
function minDefined(a, b) {
  if (a === undefined || a === null) return b ?? undefined;
  if (b === undefined || b === null) return a;
  return Math.min(a, b);
}

/**
 * 规范化上限值：必须为正整数且不得超过硬上限。
 * @param {unknown} value - 原始值。
 * @param {number} hardCap - 硬上限。
 * @param {string} field - 字段名，用于报错。
 * @returns {number} 规范化后的值。
 */
function normalizeCap(value, hardCap, field) {
  if (value === undefined || value === null) return hardCap;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} 必须是正整数`);
  }
  if (value > hardCap) {
    throw new TypeError(`${field} 不可超过本地硬上限 ${hardCap}（SPEC 第 2 节：本地绝对上限不可上调）`);
  }
  return value;
}

/**
 * 规范化正整数配置。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 缺省值。
 * @param {string} field - 字段名。
 * @returns {number} 规范化后的值。
 */
function normalizePositiveInt(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} 必须是正整数`);
  }
  return value;
}

/**
 * 规范化字符串数组。
 * @param {unknown} value - 原始值。
 * @param {readonly string[]} [fallback] - 缺省值。
 * @param {boolean} [allowEmpty] - 是否允许空数组覆盖缺省。
 * @returns {string[]} 规范化后的数组。
 */
function normalizeStringList(value, fallback = [], allowEmpty = false) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) throw new TypeError('受保护的 provider / host 列表必须是数组');
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new TypeError('受保护的 provider / host 列表元素必须是非空字符串');
    }
    result.push(item.trim());
  }
  if (result.length === 0 && !allowEmpty) return [...fallback];
  return result;
}

/**
 * 校验时区标识可用（SPEC 第 11 节：UI 必须显示 Today 使用的时区）。
 * @param {string} timezone - IANA 时区名。
 * @throws {TypeError} 时区不可用时抛出。
 */
function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new TypeError(`displayTimezone 不是有效的 IANA 时区：${timezone}`);
  }
}
