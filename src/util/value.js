// 值判定与 ISO 时间：磁盘 JSON 的形状校验、排序键比较在各层共用同一套语义。
// 时间戳只认非空字符串，缺失/非法/数字一律 0（`Date.parse('0')` 会得到 2000-01-01）。

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isoMs(value) {
  if (typeof value !== 'string' || !value) return 0
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : 0
}

export function newerIso(a, b) {
  return isoMs(a) - isoMs(b)
}
