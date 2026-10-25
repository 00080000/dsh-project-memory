// skill 化回归：node test/skill.test.mjs
// 验收面：SKILL.md 是唯一事实源（frontmatter 被剥掉）、注册走可选服务、体检脚本零依赖可跑。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SKILL_DIR, buildProjectMemorySkill, parseSkillFile, setupSkill } from '../src/skill.js'

let passed = 0
const ok = (name) => {
  passed++
  console.log('  ok', name)
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const script = path.join(SKILL_DIR, 'scripts', 'pm-digest.mjs')
const dir = () => mkdtempSync(path.join(tmpdir(), 'skill-'))

// --- 1. frontmatter 剥离：注册的正文不能把 YAML 再当正文喂给模型 ---
{
  const parsed = parseSkillFile('---\nname: demo\ndescription: "x y"\n---\n\n# Body\n')
  assert.equal(parsed.meta.name, 'demo')
  assert.equal(parsed.meta.description, 'x y', '引号要剥掉')
  assert.equal(parsed.body.trim(), '# Body')
  assert.equal(parseSkillFile('no frontmatter').body, 'no frontmatter')
  ok('frontmatter 与正文分离（引号、无 frontmatter 边界）')
}

// --- 2. 包内 skill 的形状：kebab 名、目录资源、正文可用 ---
{
  const skill = buildProjectMemorySkill()
  assert.match(skill.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `skill 名必须是 kebab-case：${skill.name}`)
  assert.ok(skill.description.length >= 20 && skill.description.length <= 500, 'description 必须非空且不超过宿主目录上限')
  assert.equal(skill.source, 'bundled')
  assert.ok(!skill.content.startsWith('---'), '正文不得带 frontmatter')
  assert.ok(skill.content.includes('query_memory') && skill.content.includes('save_lesson'), '正文要教查询与写回')
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.ok(existsSync(path.join(skill.resourceBase.path, 'SKILL.md')), 'resourceBase 指向包内目录')
  assert.ok(existsSync(script), 'scripts/pm-digest.mjs 必须随包发布')
  assert.ok(existsSync(skill.path), 'path 指向真实的 SKILL.md')
  ok('skill 形状：kebab 名 / 描述长度 / 正文 / 目录资源')
}

// --- 3. 注册：有 skills 服务就注册，没有就静默跳过（不能因为缺服务带崩插件） ---
{
  let captured = null
  setupSkill({
    inject: (names, fn) => {
      assert.deepEqual(names, ['skills'], '只对 skills 服务做可选注入')
      fn({ skills: { register: (skill) => { captured = skill } } })
    },
  })
  assert.ok(captured && captured.name === 'project-memory', '必须注册 project-memory')

  // 服务永远不出现（回调不执行）、ctx 连 inject 都没有：两种都必须安静
  assert.doesNotThrow(() => setupSkill({ inject: () => {} }))
  assert.doesNotThrow(() => setupSkill({}))
  // 注册抛错（宿主 schema 变更 / 重复注册）只告警
  const errors = []
  setupSkill(
    { inject: (_n, fn) => fn({ skills: { register: () => { throw new Error('already registered') } } }) },
    { log: { error: (line) => errors.push(line) } },
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0], /already registered/)
  ok('注册走可选服务；缺服务 / 抛错都不影响插件其余部分')
}

// --- 4. 体检脚本：真 store 能读出计数；空目录不报错 ---
{
  const root = dir()
  const store = path.join(root, '.dsh-project-memory')
  mkdirSync(path.join(store, 'shards'), { recursive: true })
  writeFileSync(path.join(store, 'shards', 'a.json'), '{}')
  writeFileSync(path.join(store, 'insights.json'), JSON.stringify({
    items: [
      { id: 'i1', kind: 'lesson', scope: 'project', title: 'a', trigger: { when: { intents: ['x'] } }, files: ['a.js'], updatedAt: new Date().toISOString() },
      { id: 'i2', kind: 'decision', scope: 'project', title: 'b', archived: true, updatedAt: new Date().toISOString() },
    ],
  }))
  writeFileSync(path.join(store, 'tasks.json'), JSON.stringify([
    { id: 't1', title: '在做的事', steps: ['s1', 's2'], files: ['a.js'], insights: [] },
    { id: 't2', title: '归档的', archived: true },
  ]))
  writeFileSync(path.join(store, 'binding.json'), JSON.stringify({ s1: 't1' }))

  const run = spawnSync(process.execPath, [script, root, '--json'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const out = JSON.parse(run.stdout)
  assert.equal(out.store, true)
  assert.equal(out.shards.files, 1)
  assert.equal(out.insights.total, 2)
  assert.equal(out.insights.archived, 1)
  assert.equal(out.insights.withTrigger, 1)
  assert.equal(out.tasks.total, 2)
  assert.equal(out.tasks.active, 1)
  assert.equal(out.tasks.steps, 2)
  assert.equal(out.bindings, 1)

  const text = spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
  assert.equal(text.status, 0)
  assert.match(text.stdout, /2 insights · 2 tasks/)

  const empty = dir()
  const none = spawnSync(process.execPath, [script, empty], { encoding: 'utf8' })
  assert.equal(none.status, 0, '空目录也要正常退出')
  assert.match(none.stdout, /no memory store/)
  ok('体检脚本：真 store 计数、人类可读输出、空目录不报错')
}

// --- 5. 发布面：skills 必须在 files 白名单里，否则 npm 包里没有它 ---
{
  assert.ok(pkg.files.includes('skills'), 'package.json files 必须包含 skills')
  ok('发布面：skills 目录在 files 白名单里')
}

console.log(`\nskill tests: ${passed} passed`)
