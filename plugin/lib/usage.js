/**
 * Token / Cost 记账与对账（SPEC 第 14、24、25 节）。
 *
 * 数据诚实（SPEC 第 7、29、34 节）
 *   本模块严格区分四种费用等级，绝不混用：
 *     authoritative — 平台实际返回（当前 DSH 内无来源，保留以便将来接入）
 *     calculated    — 真实 TokenUsage × 已确认价格
 *     estimated     — DSH usage × 平台公开模型单价；缓存写入按普通输入估算
 *     unknown       — 无法计算
 *
 * DSH pi-ai 统计口径：
 *   usage.input 已扣除 cacheRead 和 cacheWrite；usage.totalTokens 则包含
 *   input + output + cacheRead + cacheWrite。不能再从 input 中扣缓存，
 *   也不能只用 input + output 重造 DSH 的总 Token 数。
 *
 * reasoning token 陷阱（SPEC 第 24 节 / 验收 G）
 *   `TokenUsage` 的 schema 未声明 `reasoningTokens` 是否已包含在 `outputTokens` 内。
 *   盲目相加会重复计费。本模块的规则：
 *     默认认为 provider 的 outputTokens **已包含** reasoning（保守，不重复加），
 *     仅当 provider 显式声明 reasoning 独立时才单独计入。
 *   宁可少算也不重复计 —— 少算会让费用偏保守，重复加会让预算虚高而误拦。
 *
 * @module lib/usage
 */

import { moneyFromString, moneyScale } from './money.js';

/** 费用等级。 */
export const COST_SOURCE = Object.freeze({
  AUTHORITATIVE: 'authoritative',
  CALCULATED: 'calculated',
  ESTIMATED: 'estimated',
  UNKNOWN: 'unknown',
});

/** 每百万 token 的换算分母。 */
const PER_MILLION = 1_000_000n;

/**
 * 规范化 TokenUsage 对象，剔除非法值。
 *
 * @param {unknown} usage - 原始 usage（可能来自 StreamChunk）。
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number, totalTokens: number}} 规范化结果。
 */
export function normalizeUsage(usage) {
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);
  const source = typeof usage === 'object' && usage !== null ? usage : {};
  const inputTokens = pick(source.inputTokens);
  const outputTokens = pick(source.outputTokens);
  const cacheReadTokens = pick(source.cacheReadTokens);
  const cacheWriteTokens = pick(source.cacheWriteTokens);
  const derivedTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = Number.isSafeInteger(source.totalTokens) && source.totalTokens >= 0
    ? source.totalTokens
    : (Number.isSafeInteger(derivedTotal) ? derivedTotal : 0);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: pick(source.reasoningTokens),
    totalTokens,
  };
}

/**
 * 计算「计费意义上的输入 token」。
 *
 * DSH pi-ai 口径：inputTokens 不含 cacheRead/cacheWrite，三者分别计价。
 * @param {object} usage - normalizeUsage 的结果。
 * @returns {number} 计费输入 token 数。
 */
export function billableInputTokens(usage) {
  return usage.inputTokens + usage.cacheWriteTokens;
}

/**
 * 计算「计费意义上的输出 token」。
 *
 * 关键决策：默认 `reasoningTokens` **已包含**在 `outputTokens` 内，不重复相加。
 * 仅当显式传入独立标记时才追加（当前无 provider 声明该能力）。
 * @param {object} usage - normalizeUsage 的结果。
 * @param {object} [options] - 选项。
 * @param {boolean} [options.reasoningSeparate] - reasoning 是否独立计价，默认 false。
 * @returns {number} 计费输出 token 数。
 */
export function billableOutputTokens(usage, options = {}) {
  if (options.reasoningSeparate === true) {
    return usage.outputTokens + usage.reasoningTokens;
  }
  return usage.outputTokens;
}

/**
 * 按单价表计算费用。
 *
 * 预留方向用 ceil、结算方向用 floor，由调用方通过 rounding 指定。
 * @param {object} request - 计算请求。
 * @param {object} request.usage - normalizeUsage 的结果。
 * @param {object} request.priceTable - 单价表（字符串形式）。
 * @param {'floor'|'ceil'} [request.rounding] - 舍入方向，默认 floor。
 * @param {boolean} [request.reasoningSeparate] - reasoning 是否独立计价。
 * @returns {{cost: bigint, costSource: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number}} 计算结果。
 */
export function computeCost(request) {
  const usage = request.usage;
  const inputTokens = usage.inputTokens;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheWriteTokens = usage.cacheWriteTokens;
  const outTokens = billableOutputTokens(usage, { reasoningSeparate: request.reasoningSeparate === true });
  const rounding = request.rounding ?? 'floor';

  if (!request.priceTable || request.priceTable.inputPerMillion === undefined
    || request.priceTable.outputPerMillion === undefined
    || (cacheReadTokens > 0 && request.priceTable.cacheReadPerMillion === undefined)) {
    return {
      cost: 0n,
      costSource: COST_SOURCE.UNKNOWN,
      inputTokens,
      outputTokens: outTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: usage.totalTokens,
    };
  }

  const inputPrice = moneyFromString(request.priceTable.inputPerMillion);
  const outputPrice = moneyFromString(request.priceTable.outputPerMillion);

  const cacheReadPrice = moneyFromString(request.priceTable.cacheReadPerMillion ?? request.priceTable.inputPerMillion);
  const cacheWritePrice = moneyFromString(request.priceTable.cacheWritePerMillion ?? request.priceTable.inputPerMillion);
  const inputCost = inputTokensToMoney(inputPrice, inputTokens, rounding);
  const cacheReadCost = inputTokensToMoney(cacheReadPrice, cacheReadTokens, rounding);
  const cacheWriteCost = inputTokensToMoney(cacheWritePrice, cacheWriteTokens, rounding);
  const outputCost = inputTokensToMoney(outputPrice, outTokens, rounding);
  const cost = inputCost + cacheReadCost + cacheWriteCost + outputCost;

  return {
    cost,
    costSource: COST_SOURCE.ESTIMATED,
    inputTokens: inputTokens + cacheWriteTokens,
    outputTokens: outTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usage.totalTokens,
  };
}

/**
 * 单价（微元/百万 token）× token 数 → 金额（微元）。
 * @param {bigint} pricePerMillion - 单价（微元/百万 token）。
 * @param {number} tokens - token 数。
 * @param {'floor'|'ceil'} rounding - 舍入方向。
 * @returns {bigint} 金额（微元）。
 */
function inputTokensToMoney(pricePerMillion, tokens, rounding) {
  if (tokens <= 0) return 0n;
  return moneyScale(pricePerMillion, BigInt(tokens), PER_MILLION, rounding);
}

/**
 * 估算一次请求的预留金额（SPEC 第 13 节）。
 *
 * 用 input token 数 + 模型最大输出长度估算上限，方向取 ceil（宁可高估）。
 * 若无法确定成本（缺价格或缺输入规模），严格模式下返回 unknown 交由调用方阻断。
 *
 * @param {object} request - 估算请求。
 * @param {number} [request.inputTokens] - 已知输入 token 数。
 * @param {number} [request.maxOutputTokens] - 该模型最大输出 token 数。
 * @param {object} request.priceTable - 单价表。
 * @returns {{ok: true, amount: bigint, basis: string} | {ok: false, reason: string}} 估算结果。
 */
export function estimateReservation(request) {
  const inputTokens = typeof request.inputTokens === 'number' && request.inputTokens >= 0
    ? Math.trunc(request.inputTokens)
    : undefined;
  const maxOutputTokens = typeof request.maxOutputTokens === 'number' && request.maxOutputTokens > 0
    ? Math.trunc(request.maxOutputTokens)
    : undefined;

  if (inputTokens === undefined && maxOutputTokens === undefined) {
    return { ok: false, reason: 'no-usage-basis' };
  }
  if (request.priceTable?.inputPerMillion === undefined || request.priceTable?.outputPerMillion === undefined) {
    return { ok: false, reason: 'no-price' };
  }

  const inputPrice = moneyFromString(request.priceTable.inputPerMillion);
  const outputPrice = moneyFromString(request.priceTable.outputPerMillion);
  const inputCost = inputTokensToMoney(inputPrice, inputTokens ?? 0, 'ceil');
  const outputCost = inputTokensToMoney(outputPrice, maxOutputTokens ?? 0, 'ceil');
  return {
    ok: true,
    amount: inputCost + outputCost,
    basis: inputTokens === undefined ? 'output-only' : (maxOutputTokens === undefined ? 'input-only' : 'input+max-output'),
  };
}

/**
 * 判断 usage 是否足以产出可信费用。
 * @param {object} usage - normalizeUsage 的结果。
 * @returns {boolean} 有可计费 token 为 true。
 */
export function hasBillableUsage(usage) {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0;
}

/**
 * 生成数据来源说明（SPEC 第 29 节：不得把本地统计冒充平台总量）。
 * @param {object} options - 选项。
 * @param {boolean} options.hasAuthoritative - 是否接入了平台权威数据。
 * @returns {{usageSource: string, costSourceLabel: string}} 来源标签。
 */
export function describeSource(options) {
  if (options.hasAuthoritative === true) {
    return { usageSource: 'platform-authoritative', costSourceLabel: 'authoritative' };
  }
  return { usageSource: 'local-observed', costSourceLabel: 'estimated' };
}

/**
 * 供 UI 显示的费用文本（SPEC 第 14 节：estimated 显示「约」，unknown 显示 `--`）。
 * @param {object} request - 请求。
 * @param {bigint} request.cost - 金额（微元）。
 * @param {string} request.costSource - 费用等级。
 * @param {(amount: bigint, digits?: number) => string} request.format - 格式化函数。
 * @returns {string} 展示文本。
 */
export function formatCostForDisplay(request) {
  if (request.costSource === COST_SOURCE.UNKNOWN) return '--';
  const text = `¥${request.format(request.cost, 2)}`;
  if (request.costSource === COST_SOURCE.ESTIMATED) return `约 ${text}`;
  return text;
}
