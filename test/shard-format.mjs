// 分片布局读取助手：同时支持 v3 桶（items 数组）与 v2 一文件一 shard。
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function shardItems(memDir) {
  const out = []
  const dir = path.join(memDir, 'shards')
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    let doc
    try {
      doc = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const items = Array.isArray(doc.items) ? doc.items : [doc]
    for (const item of items) {
      if (item && typeof item.relPath === 'string' && item.record && typeof item.record === 'object') out.push(item)
    }
  }
  return out
}

export function shardItem(memDir, rel) {
  return shardItems(memDir).find((item) => item.relPath === rel)
}
