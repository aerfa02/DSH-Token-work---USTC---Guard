/**
 * 定点金额运算（SPEC 第 15 节：预算内部禁止普通浮点累计）。
 *
 * 设计
 *   内部统一以 BigInt 表示「最小计价单位」的整数倍。
 *   默认 SCALE = 10^6，即 1 单位 = 0.000001 元（微元），
 *   足以精确表达 0.158208 元/M 这类六位小数单价，且累加无浮点误差。
 *
 *   所有预算比较、预留、结算都在 BigInt 域内完成；
 *   仅在面向 UI 格式化时才降级为字符串/数字，且不做二次累加。
 *
 * 为什么不用 Number
 *   Number 是 IEEE-754 双精度：0.1 + 0.2 !== 0.3。
 *   大量小额累加会漂移，可能让 29.999999999 被误判为未超 30（验收 T）。
 *   BigInt 无此问题。
 *
 * @module lib/money
 */

/** 每元包含的微元数：1 元 = 1_000_000 微元。 */
export const SCALE = 1_000_000n;

/** 最小计价单位（微元）的十进制位数。 */
export const SCALE_DIGITS = 6;

/**
 * 判断值是否为 bigint。
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 是 bigint 时为 true。
 */
export function isMoney(value) {
  return typeof value === 'bigint';
}

/**
 * 由字符串构造定点金额，避免任何浮点中转。
 * @param {string} text - 形如 "30"、"0.158208"、"-1.5" 的十进制字符串。
 * @returns {bigint} 微元整数。
 * @throws {TypeError} 格式非法时抛出。
 */
export function moneyFromString(text) {
  if (typeof text !== 'string') throw new TypeError('moneyFromString 需要字符串');
  const trimmed = text.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null || (match[2] === '' && (match[3] === undefined || match[3] === ''))) {
    throw new TypeError(`非法金额字符串：${text}`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] === '' ? 0n : BigInt(match[2]);
  const fracText = (match[3] ?? '').padEnd(SCALE_DIGITS, '0').slice(0, SCALE_DIGITS);
  const frac = fracText === '' ? 0n : BigInt(fracText);
  return sign * (whole * SCALE + frac);
}

/**
 * 把有限数字转换为定点金额。
 *
 * 仅供内部常量与测试使用：调用方若已持有十进制字符串，应优先用 moneyFromString，
 * 以免在字符串→Number 这一步就引入二进制舍入。
 * @param {number} value - 有限数字。
 * @returns {bigint} 微元整数。
 * @throws {TypeError} 非有限数时抛出。
 */
export function moneyFromNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('moneyFromNumber 需要有限数字');
  }
  // toFixed 会四舍五入到 SCALE_DIGITS 位，再用字符串构造，避开浮点累加
  return moneyFromString(value.toFixed(SCALE_DIGITS));
}

/**
 * 以整数比计算金额，全程 BigInt，避免中间浮点。
 *
 * 典型用途：单价（微元/百万 token）× token 数 ÷ 1_000_000。
 *
 * 舍入方向很重要：
 *   - 计算「预算预留」时用 ceil，宁可高估也不能低估（低估会让预算被突破）；
 *   - 计算「实际结算」时用 floor，与平台计费口径一致且不虚增已用额度。
 * 因此本函数默认 floor（保守不虚增），调用方需要上取整时显式传 'ceil'。
 *
 * @param {bigint} amount - 被乘数（微元）。
 * @param {bigint|number} numerator - 乘数分子。
 * @param {bigint|number} denominator - 乘数分母，不可为 0。
 * @param {'floor'|'ceil'} [rounding] - 舍入方向，默认 'floor'。
 * @returns {bigint} 结果（微元）。
 * @throws {TypeError} 分母为 0 或 rounding 非法时抛出。
 */
export function moneyScale(amount, numerator, denominator, rounding = 'floor') {
  if (rounding !== 'floor' && rounding !== 'ceil') {
    throw new TypeError(`moneyScale 的 rounding 只能是 'floor' 或 'ceil'，收到 ${String(rounding)}`);
  }
  const n = typeof numerator === 'bigint' ? numerator : BigInt(Math.trunc(numerator));
  const d = typeof denominator === 'bigint' ? denominator : BigInt(Math.trunc(denominator));
  if (d === 0n) throw new TypeError('moneyScale 的分母不可为 0');
  const product = amount * n;
  if (rounding === 'ceil') {
    // BigInt 除法向零截断；对正数补足余数即得上取整
    const quotient = product / d;
    const remainder = product % d;
    if (remainder !== 0n && (product > 0n) === (d > 0n)) return quotient + 1n;
    return quotient;
  }
  return product / d;
}

/**
 * 把微元金额格式化为元字符串，固定 SCALE_DIGITS 位小数。
 * @param {bigint} amount - 微元整数。
 * @returns {string} 形如 "12.400000" 的字符串（含符号）。
 */
export function formatMoneyExact(amount) {
  if (typeof amount !== 'bigint') throw new TypeError('formatMoneyExact 需要 bigint');
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(SCALE_DIGITS, '0')}`;
}

/**
 * 面向 UI 的金额格式化：保留指定小数位，四舍五入。
 *
 * 仅用于展示，绝不把结果回代进预算计算。
 * @param {bigint} amount - 微元整数。
 * @param {number} digits - 保留小数位，0~SCALE_DIGITS。
 * @returns {string} 形如 "12.40" 的字符串。
 * @throws {TypeError} digits 越界时抛出。
 */
export function formatMoney(amount, digits = 2) {
  if (typeof amount !== 'bigint') throw new TypeError('formatMoney 需要 bigint');
  if (!Number.isInteger(digits) || digits < 0 || digits > SCALE_DIGITS) {
    throw new TypeError(`formatMoney 的 digits 必须在 0~${SCALE_DIGITS} 之间`);
  }
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const dropped = SCALE_DIGITS - digits;
  const divisor = 10n ** BigInt(dropped);
  // 四舍五入：加半个除数再整除
  const rounded = (abs + divisor / 2n) / divisor;
  const unit = 10n ** BigInt(digits);
  const whole = rounded / unit;
  const frac = rounded % unit;
  const fracText = digits === 0 ? '' : `.${frac.toString().padStart(digits, '0')}`;
  return `${negative ? '-' : ''}${whole}${fracText}`;
}
