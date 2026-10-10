/**
 * Provider 识别（SPEC 第 4 节：Provider 判断必须集中管理）。
 *
 * 实际地址存在时，仅按精确主机名判断；名称不能覆盖已知地址。
 * 未提供地址的纯逻辑调用保留旧版 provider 名称匹配；
 * 正式 Host 将无法解析的地址明确传为 null，禁止依名称猜测。
 *
 * 重要：GenerateOptions 本身不含 baseURL（已勘察确认），
 * 因此 baseURL 线索必须由调用方（Host 侧读取 provider 配置）注入。
 * 本模块只做纯判定，不读配置、不做 I/O，便于单测。
 *
 * @module lib/identity
 */

/** 标准 USTC Host（SPEC 第 4 节）。 */
export const USTC_HOST = 'api.llm.ustc.edu.cn';

/** 常见 USTC provider 路由名（小写比较）。 */
const USTC_PROVIDER_NAMES = new Set(['ustc', 'ustc-llm', 'ustc-ai', 'ustcai', 'zhongkeda']);

/**
 * 从 URL 中提取小写主机名。
 * @param {unknown} url - 可能是完整 URL 的字符串。
 * @returns {string|undefined} 主机名；无法解析时 undefined。
 */
export function hostOf(url) {
  if (typeof url !== 'string' || url === '') return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // 允许传入裸主机名
    const candidate = url.trim().toLowerCase();
    return /^[a-z0-9.-]+$/.test(candidate) ? candidate : undefined;
  }
}

/**
 * 判断一个 provider 路由是否属于受保护的 USTC。
 *
 * @param {object} request - 判定输入。
 * @param {string} request.provider - `GenerateOptions.provider`（路由名）。
 * @param {string} [request.baseURL] - 该 provider 配置的 baseURL（调用方注入）。
 * @param {readonly string[]} [request.protectedProviders] - 显式保护的 provider 名。
 * @param {readonly string[]} [request.protectedHosts] - 显式保护的主机名。
 * @returns {{protected: boolean, reason: string}} 判定结果与理由（理由用于 UI/报告）。
 */
export function identifyProvider(request) {
  const provider = typeof request?.provider === 'string' ? request.provider.toLowerCase() : '';
  const protectedProviders = (request?.protectedProviders ?? []).map((item) => item.toLowerCase());
  const protectedHosts = (request?.protectedHosts ?? [USTC_HOST]).map((item) => item.toLowerCase());

  // An actual route address is authoritative, even when its alias says USTC.
  if (request?.baseURL !== undefined) {
    return { protected: isProtectedHost(request.baseURL, protectedHosts), reason: 'base-url-host' };
  }

  if (provider === '') {
    return { protected: false, reason: 'unknown-provider' };
  }

  // 1. 显式配置优先
  if (protectedProviders.includes(provider)) {
    return { protected: true, reason: 'explicit-provider' };
  }

  // 2. 路由名本身是 USTC 变体
  if (USTC_PROVIDER_NAMES.has(provider)) {
    return { protected: true, reason: 'provider-name' };
  }

  return { protected: false, reason: 'not-ustc' };
}

/**
 * 判断一个主机名是否属于受保护集合。
 * @param {unknown} url - URL 或裸主机名。
 * @param {readonly string[]} [protectedHosts] - 受保护主机集合。
 * @returns {boolean} 命中为 true。
 */
export function isProtectedHost(url, protectedHosts = [USTC_HOST]) {
  const host = hostOf(url);
  if (host === undefined) return false;
  return protectedHosts.some((candidate) => {
    const normalized = candidate.toLowerCase();
    return host === normalized;
  });
}

/** Resolve endpoint metadata even while model discovery is unavailable. */
export function snapshotBaseURL(snapshot, provider, model) {
  let profile;
  try { profile = snapshot?.profiles?.get(provider); } catch {}
  let route;
  if (model != null) {
    try { route = snapshot?.models?.getModel(provider, model); } catch {}
  }
  return route?.baseUrl ?? route?.baseURL ?? profile?.baseURL ?? profile?.piProvider?.baseUrl ?? null;
}

/** Locate a capability through delegation wrappers without bypassing their execution. */
export function adapterWithMethod(adapter, method) {
  const visited = new Set();
  for (let depth = 0; adapter && typeof adapter === 'object' && depth < 32; depth++) {
    if (visited.has(adapter)) return null;
    visited.add(adapter);
    if (typeof adapter[method] === 'function') return adapter;
    adapter = adapter.inner;
  }
  return null;
}
