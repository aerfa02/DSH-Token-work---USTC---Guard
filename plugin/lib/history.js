/** Daily aggregates survive request compaction; timezone and dispatch-date attribution are fixed. */
export const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const counters = [...TOKEN_FIELDS, 'requests', 'missingUsage'];
const formatters = new Map();
export function dayKey(at, timezone = 'Asia/Shanghai') {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const parts = Object.fromEntries(formatters.get(timezone).formatToParts(at).map(p => [p.type, p.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}
function empty(date) { return Object.fromEntries([['date', date], ...counters.map(key => [key, 0])]); }
function add(target, source) {
  for (const key of counters) {
    const sum = target[key] + (source[key] ?? 0);
    if (!Number.isSafeInteger(sum) || sum < 0) throw new Error('历史 Token 计数超出安全整数范围');
    target[key] = sum;
  }
}
export function validateHistory(data, savedAt) {
  if (data === undefined) return; // v1 migration
  if (!data || data.version !== 1 || !Number.isSafeInteger(data.startedAt) || data.startedAt < 0 || data.startedAt > savedAt + 1000 || !Array.isArray(data.days)) throw new Error('历史数据头损坏');
  if (data.days.length > 100000) throw new Error('历史日期数量异常');
  try { dayKey(savedAt, data.timezone); } catch { throw new Error('历史时区损坏'); }
  if (typeof data.timezone !== 'string' || !data.timezone) throw new Error('历史时区缺失');
  const seen = new Set(), latest = dayKey(savedAt + 1000, data.timezone);
  for (const item of data.days) {
    const date = item?.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date || date > latest || seen.has(date)) throw new Error('历史日期损坏或重复');
    seen.add(date);
    if (!counters.every(key => Number.isSafeInteger(item[key]) && item[key] >= 0) || item.missingUsage > item.requests) throw new Error('历史计数损坏');
  }
}
function contribution(record) {
  if (!record.usageRecorded && !['unknown', 'partial', 'unknown_after_restart'].includes(record.state)) return null;
  const result = empty('');
  result.requests = 1;
  result.missingUsage = record.usageRecorded ? 0 : 1;
  if (record.usageRecorded) {
    for (const key of TOKEN_FIELDS) result[key] = record[key] ?? 0;
    if (!Number.isSafeInteger(record.totalTokens)) result.totalTokens = record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
  }
  return result;
}
function periodKey(date, kind) {
  if (kind === 'monthly') return date.slice(0, 7);
  if (kind === 'daily') return date;
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
}
export class UsageHistory {
  #days = new Map();
  constructor(timezone = 'Asia/Shanghai', startedAt = Date.now()) { this.timezone = timezone; this.startedAt = startedAt; }
  restore(data, records = []) {
    if (data) {
      validateHistory(data, Date.now());
      if (data.timezone !== this.timezone) throw new Error('历史时区与配置不同，需显式迁移');
      this.startedAt = data.startedAt;
      this.#days = new Map(data.days.map(item => [item.date, { ...item }]));
    } else {
      // Earlier deleted records cannot be reconstructed. Preserve the oldest surviving coverage.
      for (const record of records) this.startedAt = Math.min(this.startedAt, record.dispatchTimestamp);
    }
  }
  archive(record) {
    const values = contribution(record); if (!values) return;
    const date = dayKey(record.dispatchTimestamp, this.timezone);
    const next = { ...(this.#days.get(date) ?? empty(date)) };
    add(next, values); this.#days.set(date, next);
  }
  toJSON() { return { version: 1, timezone: this.timezone, startedAt: this.startedAt, days: [...this.#days.values()].sort((a, b) => a.date.localeCompare(b.date)) }; }
  snapshot(records, now = Date.now()) {
    // Non-overlapping 7.5-minute bins from surviving request details (retained 48h).
    const step = 7.5 * 60 * 1000;
    const end = Math.floor(now / step) * step + step;
    const start = end - 24 * 60 * 60 * 1000;
    const timeline = Array.from({ length: 192 }, (_, i) => ({ ...empty(String(start + i * step)), at: start + i * step, end: start + (i + 1) * step, partial: start + i * step < this.startedAt || start + (i + 1) * step > now }));
    for (const record of records) {
      if (record.dispatchTimestamp < start || record.dispatchTimestamp > now) continue;
      const values = contribution(record);
      if (values) add(timeline[Math.floor((record.dispatchTimestamp - start) / step)], values);
    }
    const daily = new Map([...this.#days].map(([date, value]) => [date, { ...value }]));
    for (const record of records) {
      if (record.dispatchTimestamp > now) continue;
      const values = contribution(record); if (!values) continue;
      const date = dayKey(record.dispatchTimestamp, this.timezone);
      const next = daily.get(date) ?? empty(date); add(next, values); daily.set(date, next);
    }
    const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
    const group = kind => {
      const rows = new Map();
      for (const day of days) { const date = periodKey(day.date, kind), next = rows.get(date) ?? empty(date); add(next, day); rows.set(date, next); }
      return [...rows.values()].sort((a,b) => a.date.localeCompare(b.date));
    };
    return { version: 1, timezone: this.timezone, startedAt: this.startedAt, attribution: 'dispatch-date', timeline: timeline.filter(row => row.end > this.startedAt), daily: days, weekly: group('weekly'), monthly: group('monthly') };
  }
}
