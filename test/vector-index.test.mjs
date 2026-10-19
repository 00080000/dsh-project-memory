// 向量索引的持久化 / 逐条失效 / 降级回归。**不需要 leanvec**：embed 用确定性假函数注入，
// 所以这套能进 CI，盯的是"缓存对不对、坏了会不会炸、没有向量时退不退化"。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createVectorCosine, createVectorRerank, forgetVectorRows, leanvecFingerprint, openVectorIndex, vectorText,
} from '../src/vector-index.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }
const DIM = 256
const dir = mkdtempSync(join(tmpdir(), 'vecidx-'))
const MODEL = 'test-model:1'

// 确定性假编码：同样的文本 → 同样的向量（这样才能断言"读回来的和算出来的一致"）
const embed = (text) => {
  if (!text || text.includes('__NULL__')) return null
  const v = new Float32Array(DIM)
  let s = 0
  for (let i = 0; i < DIM; i++) { v[i] = Math.sin(i * 1.7 + text.length * 0.31 + (text.charCodeAt(0) || 7)); s += v[i] * v[i] }
  const n = Math.sqrt(s) || 1
  for (let i = 0; i < DIM; i++) v[i] /= n
  return v
}
const ITEMS = [
  { id: 'ins_a', title: 'pnpm 拦截安装脚本' },
  { id: 'ins_b', title: '误删文件怎么找回' },
  { id: 'ins_c', insightId: 'ins_c', id: 'insight:ins_c', title: '配额是保险丝' },
  { id: 'exp_d', problem: '缓存逐出是假的' },
]
const open = (items = ITEMS, extra = {}) => openVectorIndex({ dir, items, embed, model: MODEL, ...extra })

// ---- ① 门槛：缺 embed / 缺 model / 维度不符 → null（调用方据此退回纯词法）----
assert.equal(openVectorIndex({ dir, items: ITEMS, embed: undefined, model: MODEL }), null)
assert.equal(openVectorIndex({ dir, items: ITEMS, embed, model: null }), null)
assert.equal(openVectorIndex({ dir, items: ITEMS, embed, model: MODEL, dim: 128 }), null)
ok('缺 embed / 缺 model / 维度不符 → 返回 null（降级）')

// ---- ② 首次打开：全算并落盘 ----
const first = open()
assert.equal(first.stats.computedFirstOpen, ITEMS.length, `首次应计算 ${ITEMS.length} 条`)
assert.equal(first.stats.loadedFromDisk, false)
assert.ok(existsSync(join(dir, 'vectors.json')), '应写出 vectors.json')
const q = '误删文件怎么找回'
const s1 = first.score(q, ITEMS)
assert.equal(s1.size, ITEMS.length + 1, 'insightId 与 id 两个键都要登记（ins_c 多一个键）')
assert.ok([...s1.values()].every((v) => v >= -1.001 && v <= 1.001), '余弦必须在 [-1,1]')
ok(`首次打开：计算 ${first.stats.computedFirstOpen} 条并落盘`)

// ---- ③ 二次打开：全部复用，且**分数逐字节一致**（这是持久化正确性的核心断言）----
const second = open()
assert.equal(second.stats.loadedFromDisk, true, '第二次应从磁盘载入')
assert.equal(second.stats.computedFirstOpen, 0, '第二次不该重算任何一条')
assert.equal(second.stats.reusedFirstOpen, ITEMS.length, '第二次应全部复用')
const s2 = second.score(q, ITEMS)
for (const k of s1.keys()) assert.equal(s2.get(k), s1.get(k), `键 ${k} 的分数必须与首次完全一致`)
ok('二次打开：全部复用，且分数与首次逐位一致（base64 往返无损）')

// ---- ④ 只改一条文本 → 只重算那一条 ----
const changed = ITEMS.map((it) => (it.id === 'ins_b' ? { ...it, title: '误删文件怎么找回（改过了）' } : it))
const third = open(changed)
assert.equal(third.stats.computedFirstOpen, 1, `只改一条时应只重算 1 条，实得 ${third.stats.computedFirstOpen}`)
assert.equal(third.stats.reusedFirstOpen, ITEMS.length - 1, '其余应复用')
ok('逐条失效：只改一条文本 → 只重算那一条')

// ---- ⑤ 模型指纹变了 → 全量重建 ----
const fourth = open(changed, { model: 'test-model:2' })
assert.equal(fourth.stats.loadedFromDisk, false, '指纹变了应作废旧文件')
assert.equal(fourth.stats.computedFirstOpen, ITEMS.length, '指纹变了应全量重算')
ok('模型指纹变化 → 全量重建')

// ---- ⑥ 文件损坏 → 当没有，不抛 ----
writeFileSync(join(dir, 'vectors.json'), '{ 这不是 json')
const fifth = open()
assert.equal(fifth.stats.loadedFromDisk, false)
assert.equal(fifth.stats.computedFirstOpen, ITEMS.length)
ok('文件损坏 → 当作没有并重建（不抛）')

// ---- ⑦ 查询无法编码 / embed 抛异常 → 空 Map，且不抛（调用方据此降级）----
const sixth = open()
assert.equal(sixth.score('__NULL__', ITEMS).size, 0, '查询编码为 null → 空 Map')
const boom = openVectorIndex({ dir, items: ITEMS, embed: () => { throw new Error('vector down') }, model: MODEL })
assert.equal(boom.score(q, ITEMS).size, 0, 'embed 抛异常 → 空 Map')
assert.equal(boom.stats.computedFirstOpen, 0)
ok('查询无法编码 / embed 抛异常 → 空 Map，不抛（可降级）')

// ---- ⑧ dir = null → 纯内存，不写盘 ----
const memOnly = openVectorIndex({ dir: null, items: ITEMS, embed, model: MODEL })
assert.equal(memOnly.stats.file, null)
assert.equal(memOnly.flush(), false, '无 dir 时 flush 应为 false')
assert.equal(memOnly.score(q, ITEMS).size, ITEMS.length + 1, '纯内存模式仍要能工作')
ok('dir=null：纯内存可用、不写盘')

// ---- ⑨ vectorText 只用标题 / problem ----
assert.equal(vectorText({ title: 'T', summary: '很长的摘要' }), 'T')
assert.equal(vectorText({ problem: 'P', solution: 'S' }), 'P')
assert.equal(vectorText({}), '')
ok('vectorText：只取 title / problem（实测短文本变体最好）')

// ---- ⑩ leanvecFingerprint：目录不存在 → null（不是可用模型）----
assert.equal(leanvecFingerprint(join(dir, 'nope')), null)
assert.equal(leanvecFingerprint(null), null)
ok('leanvecFingerprint：不可用目录 → null')

// ---- ⑪ 写路径不建目录：读路径上的 flush 不得把 store 目录造出来 ----
{
  const ghost = join(mkdtempSync(join(tmpdir(), 'vec-ghost-')), 'not-there', '.dsh-project-memory')
  const idx = openVectorIndex({ dir: ghost, items: ITEMS, embed, model: MODEL })
  assert.equal(idx.flush(), false, '目录不存在时 flush 必须失败')
  idx.score(q, ITEMS)
  assert.equal(existsSync(ghost), false, '读路径不得创建 store 目录（writeJsonAtomic 会 mkdir）')
  ok('flush 不建目录：读路径不会在错误 root 下造出 store')
}

// ---- ⑫ 假 leanvec：验证「重排开关」与「写入去重开关」是分开的 ----
// 用一份最小的假模型目录（dist 里两个文件 + src/embed.mjs），不需要真实 80MB 表。
function fakeLeanvec() {
  const d = mkdtempSync(join(tmpdir(), 'fake-lv-'))
  mkdirSync(join(d, 'dist'), { recursive: true })
  mkdirSync(join(d, 'src'), { recursive: true })
  writeFileSync(join(d, 'dist', 'leanvec.tokenizer.json'), JSON.stringify({ dim: DIM }))
  writeFileSync(join(d, 'dist', 'leanvec.f32'), Buffer.alloc(DIM * 4))
  writeFileSync(join(d, 'src', 'embed.mjs'), `
    export function loadLeanvec() {
      return { dim: ${DIM}, size: 1, embed(t) {
        if (!t) return null
        const v = new Float32Array(${DIM})
        let s = 0
        for (let i = 0; i < ${DIM}; i++) { v[i] = Math.sin(i + t.length); s += v[i] * v[i] }
        const n = Math.sqrt(s) || 1
        for (let i = 0; i < ${DIM}; i++) v[i] /= n
        return v
      } }
    }
  `)
  return d
}
{
  const lvDir = fakeLeanvec()
  const storeDir = mkdtempSync(join(tmpdir(), 'vec-config-'))
  const items = [{ id: 'c1', title: 'pnpm 拦截安装脚本' }, { id: 'c2', title: '缓存逐出是假的' }]
  assert.equal(await createVectorRerank({ storeDir, items, vectorDir: lvDir, alpha: 0 }), null, 'alpha=0 关掉重排')
  const cosine = await createVectorCosine({ storeDir, items, vectorDir: lvDir })
  assert.equal(typeof cosine, 'function', 'alpha 只管重排，不该连带关掉写入去重')
  assert.ok(cosine('pnpm 拦截安装脚本', items).get('c1') > 0.99, '写入侧余弦要能命中自己')
  assert.equal(await createVectorCosine({ storeDir, items, vectorDir: lvDir, dedup: false }), null, 'vectorDedup:false 才关写入去重')
  assert.equal(await createVectorCosine({ storeDir, items, vectorDir: 'off' }), null)

  const rr = await createVectorRerank({ storeDir, items, vectorDir: lvDir, alpha: 0.5 })
  assert.equal(rr.itemMin, undefined, '不配 itemMin → 整段逻辑不启用')
  assert.equal(rr.speakMin, undefined)
  const rr2 = await createVectorRerank({ storeDir, items, vectorDir: lvDir, itemMin: 0.4, speakMin: 0.5 })
  assert.equal(rr2.itemMin, 0.4)
  assert.equal(rr2.speakMin, 0.5)
  ok('配置解耦：alpha=0 只关重排；vectorDedup 独立；itemMin/speakMin 仅在显式配置时生效')

  // ---- ⑬ forget 之后向量行真的没了（磁盘 + 进程内缓存）----
  assert.ok(existsSync(join(storeDir, 'vectors.json')))
  const removed = forgetVectorRows({ dir: storeDir, ids: ['c1'] })
  assert.equal(removed, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(storeDir, 'vectors.json'), 'utf8')).ids, ['c2'])
  const after = rr.score('pnpm 拦截安装脚本', items)
  assert.equal(after.has('c1'), false, '缓存索引里也不得再有被删的行')
  assert.equal(after.has('c2'), true)
  assert.equal(forgetVectorRows({ dir: storeDir, ids: ['nope'] }), 0, '没命中就是 0')
  ok('forget 向量行：磁盘与进程内缓存同时移除（不加载模型）')
}

rmSync(dir, { recursive: true, force: true })
console.log(`\nvector-index tests: ${passed} passed`)
