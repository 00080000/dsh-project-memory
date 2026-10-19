// 经验/洞察层的**可选**向量索引（leanvec）：持久化 + 逐条失效 + 优雅降级。
//
// 为什么持久化：实测 103 条 × 256 维 = **105 KB**，全量编码要 ~0.4s；读盘 + base64 解码 ~20ms。
// 为什么只覆盖这两层：它们的池子小（实测真实 store ≤103 条）；doc/symbol 是 10⁴ 量级
// （某真实 TS 仓库 15.6k 条目），每查询全量编码要 60s，所以那一层继续纯词法。
//
// 失效分两级：
//   ① **模型指纹**（词表内容哈希 + 表字节数）变了 → 整个文件作废，全量重建；
//   ② **条目文本哈希**变了 → 只重算那一行（其余复用）。
// 降级：leanvec 不可用、文件损坏、embed 抛异常 —— 一律返回 null / 空 Map，
// 调用方不传 rerank，行为逐字段退回纯词法。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeJsonAtomic } from './util/fs.js'

const FILE = 'vectors.json'
const VERSION = 1
const DIM = 256

/**
 * 条目用于编码的文本：**只取标题**（经验条目取 problem）。
 *
 * 为什么不用完整的评分文本：实测（36 条刻意无词重叠的查询 / 103 条池）标题变体的并集
 * hit@10 是 94%，而把 300 字摘要一起喂进去只有 89%——长文本在均值池化下会被稀释向语料均值。
 *
 * ⚠ 兜底链必须与 `normalizeInsight` 的标题推导**逐项相同**（含 `choice` 与否决 `topic`），
 * 且同样截到 200：写入路径拿的是**归一化之前**的 raw（`save_lesson` 允许只给
 * pattern / choice），只认 title 会让这类写入的查询文本变成空串 → 整条向量带去重静默失效
 * （`vectorNear` 见空文本直接返回 null）。索引侧编码的是落盘后的 title，两边同源才可比。
 */
export function vectorText(it) {
  const t = it?.title || it?.pattern || it?.problem || it?.choice || it?.topic || it?.body
  return String(t ?? '').trim().slice(0, 200)
}

const hashOf = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
const keyOf = (it) => (it?.insightId ?? it?.id ?? null)

/**
 * leanvec 的模型指纹：词表内容 sha256 + 向量表字节数。
 *
 * 词表决定 token id、向量表按同一 id 排布，任一变化都必须让旧向量作废。
 * 表全文哈希要 ~0.2s，与省下的 0.4s 相抵，所以用"内容哈希 + 字节数"近似——
 * 只有"表内容变了但字节数恰好相同且词表没变"这种极罕见情形会漏判，日后再加密实指纹。
 * @returns {string|null} null = 这个目录不是一份可用的 leanvec
 */
export function leanvecFingerprint(modelDir) {
  if (!modelDir) return null
  const tj = join(modelDir, 'dist', 'leanvec.tokenizer.json')
  const tb = join(modelDir, 'dist', 'leanvec.f32')
  if (!existsSync(tj) || !existsSync(tb)) return null
  const h = createHash('sha256').update(readFileSync(tj)).digest('hex').slice(0, 16)
  return `l1:${h}:${statSync(tb).size}`
}

/** 从磁盘读回旧索引；任何异常都当成"没有"，绝不抛。 */
function readSaved(file) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (doc?.version !== VERSION || typeof doc.blob !== 'string' || !Array.isArray(doc.ids) || !Array.isArray(doc.hashes)) return null
    const buf = Buffer.from(doc.blob, 'base64')
    // 复制一次拿到 byteOffset=0 且对齐的新缓冲——Buffer.from(base64) 的下层 ArrayBuffer
    // 可能不是 4 字节对齐，直接 new Float32Array(buf.buffer, buf.byteOffset) 会抛。
    const u8 = new Uint8Array(buf)
    const all = new Float32Array(u8.buffer, 0, Math.floor(u8.byteLength / 4))
    const map = new Map()
    for (let i = 0; i < doc.ids.length; i++) {
      const off = i * DIM
      if (off + DIM > all.length) break
      map.set(doc.ids[i], { v: all.subarray(off, off + DIM), h: String(doc.hashes[i] ?? '') })
    }
    return { model: doc.model, dim: doc.dim, map, all }
  } catch {
    return null
  }
}

/**
 * 打开（或新建）向量索引。
 * @param {object} o
 * @param {string|null} o.dir - 持久化目录（通常是项目 store 目录）；null → 只在内存里
 * @param {object[]} o.items - 要建索引的条目（经验 + 洞察两层合一份，id 互不冲突）
 * @param {(text: string) => Float32Array|null} o.embed - leanvec 的编码函数
 * @param {string} o.model - 模型指纹（见 {@link leanvecFingerprint}）
 * @returns {{score: Function, flush: Function, stats: object}|null} null = 不可用 → 调用方退回纯词法
 */
export function openVectorIndex({ dir = null, items = [], embed, model, dim = DIM } = {}) {
  if (typeof embed !== 'function' || !model || dim !== DIM) return null
  const file = dir ? join(dir, FILE) : null
  const saved = file ? readSaved(file) : null
  const usable = saved && saved.model === model && saved.dim === dim ? saved : null
  const entryMap = new Map() // key -> { v: Float32Array, h: string }
  let reused = 0
  let computed = 0
  let dirty = false

  const ensure = (it) => {
    const key = keyOf(it)
    if (!key) return null
    const text = vectorText(it)
    if (!text) return null
    const h = hashOf(text)
    const prev = usable?.map.get(key)
    if (prev && prev.h === h) {
      if (!entryMap.has(key)) { entryMap.set(key, prev); reused++ }
      return prev.v
    }
    if (entryMap.has(key) && entryMap.get(key).h === h) return entryMap.get(key).v
    let v = null
    try { v = embed(text) } catch { v = null }
    if (!v) return null
    entryMap.set(key, { v, h })
    computed++
    dirty = true
    return v
  }

  /** 持久化（仅在有变化时写；失败不影响本次运行）。 */
  const flush = () => {
    if (!dirty || !file) return false
    try {
      const keys = [...entryMap.keys()]
      const all = new Float32Array(keys.length * dim)
      const hashes = []
      keys.forEach((k, i) => { all.set(entryMap.get(k).v, i * dim); hashes.push(entryMap.get(k).h) })
      writeJsonAtomic(file, {
        version: VERSION, model, dim, ids: keys, hashes,
        blob: Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString('base64'),
      })
      dirty = false
      return true
    } catch {
      return false // 磁盘不可写等：本次仍可用，只是下次还要重算
    }
  }

  /**
   * 与 auto-inject / recall 两个接缝约定的同一签名：返回 Map<id, cos>。
   * 查询无法编码、或某条目无文本/无向量 → 该条不进 Map（调用方据此降级，不当 0 分罚它）。
   * 同时用 `insightId` 与 `id` 两个键登记，兼容两层各自的 id 约定。
   */  const score = (q, cands) => {
    const out = new Map()
    let qv = null
    try { qv = embed(typeof q === 'string' ? q : String(q ?? '')) } catch { qv = null }
    if (!qv) return out
    for (const it of cands || []) {
      const v = ensure(it)
      if (!v) continue
      let s = 0
      for (let i = 0; i < dim; i++) s += qv[i] * v[i]
      const key = keyOf(it)
      out.set(key, s)
      if (it?.id && it.id !== key) out.set(it.id, s)
    }
    flush()
    return out
  }

  // 首次打开时把给定条目全部对齐（复用旧行 / 补算缺失行），并**立即落盘**——
  // 那 0.4s 的构建成本必须在本次会话就存下来，而不是等第一次查询才写。
  // （必须放在 flush 定义之后：flush 是 const 箭头函数，提前调用会 TDZ。）
  for (const it of items) ensure(it)
  flush()

  return {
    score,
    flush,
    stats: {
      file, model, dim,
      persisted: entryMap.size,
      reusedFirstOpen: reused,
      computedFirstOpen: computed,
      loadedFromDisk: Boolean(usable),
    },
  }
}

/**
 * 从两个 store 收集**要建索引的条目**：洞察层（项目 + 全局）。
 * 与提示通道/召回看到的池子同源；归档条目不进（它们不会被召回）。
 * v0.4 的经验笔记也在里面——统一存储后它们是 `kind:'experience'` 的 insight，
 * 加载时已从 experience.json 导入，不再有第二个池子。
 */
export function vectorItemsFrom(store, globalStore) {
  const out = []
  try { if (typeof store?.insightItems === 'function') out.push(...store.insightItems()) } catch { /* store 形状不保证 */ }
  try { if (typeof globalStore?.items === 'function') out.push(...globalStore.items()) } catch { /* 同上 */ }
  return out.filter((it) => it && !it.archived)
}

/** leanvec 运行时只在进程内加载一次（77 MB 表 + 词表索引 Map，加载 ~90ms、常驻 ~120MB）。 */
let runtimeCache = null
/** 向量索引按 (storeDir, 模型指纹) 缓存；条目增删改由 `score()` 里的逐条对齐懒处理。 */
const indexCache = new Map()
/**
 * "解析目录 + 模型指纹"的进程内记忆。
 *
 * 为什么必须缓存：`leanvecFingerprint()` 要 sha256 一份 1.94MB 的词表（~10ms），而
 * `createVectorRerank` 在**每一步注入**上都会被调用——不缓存就是每步白付 10ms。
 * 键取"显式配置 + 环境变量"的组合：两者都没变就不必重算。
 */
const resolveCache = new Map()

/**
 * 解析 leanvec 目录。顺序：显式配置 > 环境变量 `DSH_LEANVEC_DIR` > **作为可选依赖**。
 * 三者都拿不到 → null（调用方退回纯词法，这是正常路径不是错误）。
 */
async function resolveLeanvecDir(explicit) {
  const cand = []
  if (typeof explicit === 'string' && explicit) cand.push(explicit)
  if (typeof process.env.DSH_LEANVEC_DIR === 'string' && process.env.DSH_LEANVEC_DIR) cand.push(process.env.DSH_LEANVEC_DIR)
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    try { cand.push(dirname(req.resolve('leanvec/package.json'))) } catch { cand.push(dirname(dirname(req.resolve('leanvec')))) }
  } catch {
    // 未安装 leanvec：**正常**，不是故障——可选依赖的意义就在这里
  }
  for (const d of cand) if (leanvecFingerprint(d)) return d
  return null
}

/**
 * 构造给 `recallItems` / `buildInjection` 用的 rerank。leanvec 不可用 → **null**。
 *
 * 装了就有向量、没装就纯词法，两条路的差别只在排序：闸门（覆盖率/共同词数）与返回条数都不变。
 * @param {object} o
 * @param {string|null} [o.storeDir] - 持久化位置（通常是项目 store 目录）；null → 只在内存里
 * @param {object[]} [o.items] - 建索引的条目（见 {@link vectorItemsFrom}）
 * @param {string|null} [o.vectorDir] - leanvec 目录（显式配置优先）
 * @param {number} [o.alpha] - 融合权重；实测 0.5 在小 k 上最优（见 recall.js 的注释）
 * @returns {Promise<{score: Function, alpha: number, stats: object}|null>}
 */
export async function createVectorRerank({ storeDir = null, items = [], vectorDir = null, alpha = 0.5 } = {}) {
  // 强制关闭：`vectorDir: 'off'`（或 alpha=0）一律返回 null，连模型都不加载。
  // 为什么需要：装了可选依赖之后，没有这个开关就无法退回纯词法——测试固定基线、
  // 线上排查"是不是向量层导致的"都会用得上。
  if (typeof vectorDir === 'string' && vectorDir.trim().toLowerCase() === 'off') return null
  if (alpha === 0) return null
  const rk = `${typeof vectorDir === 'string' ? vectorDir : ''}\u0000${process.env.DSH_LEANVEC_DIR ?? ''}`
  let resolved = resolveCache.get(rk)
  if (resolved === undefined) {
    const dir = await resolveLeanvecDir(vectorDir)
    resolved = { dir, fingerprint: dir ? leanvecFingerprint(dir) : null }
    resolveCache.set(rk, resolved) // 未安装也记下来：避免每步重复 resolve 的 IO
  }
  const { dir, fingerprint } = resolved
  if (!dir || !fingerprint) return null
  try {
    if (!runtimeCache || runtimeCache.dir !== dir) {
      const mod = await import(pathToFileURL(join(dir, 'src', 'embed.mjs')).href)
      const lv = mod.loadLeanvec({
        table: join(dir, 'dist', 'leanvec.f32'),
        tokenizer: join(dir, 'dist', 'leanvec.tokenizer.json'),
      })
      runtimeCache = { dir, lv, fingerprint }
    }
    const { lv } = runtimeCache
    const ck = `${storeDir ?? ''}\u0000${fingerprint}`
    // 索引按 (storeDir, 指纹) 缓存；之后新增/改写的条目由 `score()` 里的逐条对齐懒处理
    // （内容变了就重算那一行并落盘），所以这里不需要按 items 签名判断是否重建。
    let index = indexCache.get(ck)
    if (!index) {
      index = openVectorIndex({ dir: storeDir, items, embed: (t) => lv.embed(t), model: fingerprint })
      if (!index) return null
      indexCache.set(ck, index)
    }
    const a = typeof alpha === 'number' && alpha >= 0 && alpha <= 1 ? alpha : 0.5
    return { score: index.score, alpha: a, stats: index.stats }
  } catch {
    return null // 任何异常都降级到纯词法，绝不因为可选的向量层让召回失败
  }
}
