// PR 2 项目技术栈画像（tags）：解析 package.json / go.mod / Cargo.toml → 内存缓存
// 用途：global procedure 的 trigger.scope 过滤（与画像 tags 取交集为空则跳过）
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const cache = new Map() // root -> { tags: string[], mtimeMs: number }

function tryRead(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function depsOf(manifest, fields) {
  const tags = new Set()
  for (const f of fields) {
    const deps = manifest && manifest[f]
    if (!deps || typeof deps !== 'object') continue
    for (const name of Object.keys(deps)) {
      if (typeof name !== 'string' || !name) continue
      tags.add(name.toLowerCase())
      if (!name.startsWith('@')) continue
      // scoped 包名 `@scope/pkg`：要加的是 **scope**（`vue`），不是包名段（`compiler-sfc`）。
      // 旧写法 `name.split('/')[1]` 让 `@vue/*` 项目永远拿不到 `vue` tag，
      // trigger.scope:['vue'] / legacy scope 过滤会把最相关的那条 procedure 静默判死；
      // 而 `@malformed`（没有 `/`）会在这里抛错，异常被 collectTags 整个吞掉 → 全项目 tags 清零。
      const parts = name.slice(1).split('/')
      if (parts[0]) tags.add(parts[0].toLowerCase())
      if (parts[1]) tags.add(parts[1].toLowerCase())
    }
  }
  return tags
}

/**
 * 解析项目技术栈 tags。带 mtime 缓存；任何解析失败返回空集（不抛）。
 * @param {string} root
 * @returns {string[]}
 */
export function projectTags(root) {
  if (!root) return []
  try {
    const cached = cache.get(root)
    const pkgPath = path.join(root, 'package.json')
    const marker = pkgPath
    const mtime = statSync(marker).mtimeMs
    if (cached && cached.mtimeMs === mtime) return cached.tags
    const tags = collectTags(root)
    cache.set(root, { tags, mtimeMs: mtime })
    return tags
  } catch {
    const tags = collectTags(root)
    cache.set(root, { tags, mtimeMs: 0 })
    return tags
  }
}

function collectTags(root) {
  const tags = new Set()
  try {
    const pkg = JSON.parse(tryRead(path.join(root, 'package.json')) || '{}')
    for (const t of depsOf(pkg, ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])) tags.add(t)
    for (const k of Array.isArray(pkg.keywords) ? pkg.keywords : []) if (typeof k === 'string') tags.add(k.toLowerCase())
    if (pkg.name) tags.add(String(pkg.name).toLowerCase())
  } catch {
    // package.json 缺失或损坏 → 继续尝试其它清单
  }
  const go = tryRead(path.join(root, 'go.mod'))
  if (go) {
    const m = go.match(/^module\s+(\S+)/m)
    if (m) tags.add(m[1].toLowerCase())
  }
  const cargo = tryRead(path.join(root, 'Cargo.toml'))
  if (cargo) {
    const m = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m)
    if (m) tags.add(m[1].toLowerCase())
  }
  return [...tags]
}

export function clearProjectTagsCache() {
  cache.clear()
}
