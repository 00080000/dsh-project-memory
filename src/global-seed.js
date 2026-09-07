// global.json 幂等初始化与种子（v0.5）
// - ensureGlobalInit：确保文档结构与文件存在（幂等，仅补缺失 id）
// - 不做任何内置"个人经验"种子（WSL 发包等属用户数据，由用户/测试提供 seeds）
import { GlobalStore, defaultGlobalFile } from './insight-store.js'

/**
 * 确保 global 存储文件/结构就绪。
 * @param {object} [config] plugin config（insight.globalFile 可覆盖默认路径）
 * @param {Array<object>} [seeds] 种子条目（需含稳定 id）；只补缺失 id，绝不覆盖
 * @returns {{ store: GlobalStore, file: string, created: boolean, seeded: number }}
 */
export function ensureGlobalInit(config = {}, seeds = []) {
  const c = (config.insight || {})
  const file = typeof c.globalFile === 'string' && c.globalFile ? c.globalFile : defaultGlobalFile()
  const store = new GlobalStore(file).load()
  let created = false
  if (!store.doc.createdAt) {
    store.doc.createdAt = new Date().toISOString()
    created = true
  }
  let seeded = 0
  for (const seed of seeds || []) {
    if (!seed || !seed.id) continue
    if (store.items().some((it) => it.id === seed.id)) continue
    const now = new Date().toISOString()
    store.items().push({
      kind: 'procedure',
      ...seed,
      scope: seed.scope || 'global',
      source: seed.source || 'seed',
      createdAt: seed.createdAt || now,
      updatedAt: seed.updatedAt || now,
    })
    seeded++
  }
  if (created || seeded) store.markDirty()
  store.commit(() => undefined)
  return { store, file, created, seeded }
}

export { defaultGlobalFile }
