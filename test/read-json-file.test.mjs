// 读 JSON 文件的损坏隔离契约：node test/read-json-file.test.mjs
//
// 为什么单测这个 util：这份「ENOENT 不算错 / 读失败只回调 / 解析失败才挪走坏文件」的判据
// 原先在 store.js 与 insight-store.js 里各一份，且备份失败时一处打日志、一处静默。
// 两种 store 共用同一份实现后，判据必须钉死，否则"某个 store 悄悄吃掉坏文件"没人会发现。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readJsonFile } from '../src/util/fs.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const dir = mkdtempSync(path.join(tmpdir(), 'readjsonfile-'))

// 1) 正常文件：返回解析结果，字符数照实回报（residentBoundBytes 的计量口径）
{
  const file = path.join(dir, 'ok.json')
  writeFileSync(file, '{"a":1}')
  let chars = 0
  assert.deepEqual(readJsonFile(file, null, { onChars: (n) => { chars += n } }), { a: 1 })
  assert.equal(chars, 7, 'onChars 回报的是读盘文本长度，不是解析后的对象大小')
  ok('正常文件：解析结果 + 读盘字符数')
}

// 2) 缺失文件 = "真的没有"：返回 fallback，不触发 onReadError（否则每个新库都会进只读模式）
{
  let readErrors = 0
  assert.deepEqual(readJsonFile(path.join(dir, 'missing.json'), [], { onReadError: () => { readErrors++ } }), [])
  assert.equal(readErrors, 0, 'ENOENT 不是读失败')
  ok('缺失文件：fallback，且不算读错误')
}

// 3) 解析失败：坏文件挪到 <file>.<ts>.corrupt（原文保留、原位清空），返回 fallback
{
  const file = path.join(dir, 'bad.json')
  writeFileSync(file, '{oops')
  let chars = 0
  assert.equal(readJsonFile(file, 'fallback', { onChars: (n) => { chars += n } }), 'fallback')
  assert.equal(chars, 5, '坏文件也算读到了字符（计量的是读盘量）')
  assert.equal(existsSync(file), false, '坏文件必须挪走：留在原位会被下一次写覆盖，现场就丢了')
  const backups = readdirSync(dir).filter((name) => name.startsWith('bad.json.') && name.endsWith('.corrupt'))
  assert.equal(backups.length, 1, '恰好备份一份')
  assert.equal(readFileSync(path.join(dir, backups[0]), 'utf8'), '{oops', '备份必须是原文')
  ok('解析失败：坏文件挪成 .corrupt 并返回 fallback')
}

// 4) 读失败（这里是目录，EISDIR）：只回调 onReadError，不备份、不解析
{
  const file = path.join(dir, 'as-dir.json')
  mkdirSync(file)
  const errors = []
  assert.equal(readJsonFile(file, null, { onReadError: (err) => errors.push(err) }), null)
  assert.equal(errors.length, 1, '非 ENOENT 的读失败必须交给调用方（只读降级）')
  assert.equal(errors[0].code, 'EISDIR')
  assert.equal(existsSync(file), true, '读失败不动现场：目录还在')
  ok('读失败：回调错误，不动现场')
}

// 5) 合法 JSON 的 null 不是"失败"：返回 null 而不是 fallback（store 上层的 isRecord 守卫负责判形状）
{
  const file = path.join(dir, 'null.json')
  writeFileSync(file, 'null')
  assert.equal(readJsonFile(file, 'fallback'), null)
  ok('合法 null：原样返回，不落 fallback')
}

// 6) 空文件按损坏处理：与两处旧实现一致（挪走 + fallback），不原地留着让下一次写覆盖
{
  const file = path.join(dir, 'empty.json')
  writeFileSync(file, '')
  assert.equal(readJsonFile(file, { items: [] }).items.length, 0)
  assert.equal(existsSync(file), false)
  assert.equal(readdirSync(dir).filter((name) => name.startsWith('empty.json.') && name.endsWith('.corrupt')).length, 1)
  ok('空文件：按损坏挪走')
}

console.log(`\nread-json-file: ${passed} 项通过`)
