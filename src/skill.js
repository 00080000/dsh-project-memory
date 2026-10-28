// 把"怎么用 project-memory"作为宿主 skill 暴露，而不是文档里的一段说明。
//
// 为什么不写 `.dsh/skills/`：那会把文件写进用户项目或全局 home，且与插件版本脱钩
// （升级插件后 skill 还是旧的）。运行时注册随包升级，`resourceBase` 指向包内目录，
// 模型能按相对路径取 `scripts/pm-digest.mjs`。
//
// 宿主没有 `skills` 服务时静默跳过 —— 与 `/tasks` 同一套软依赖写法（顶层 inject 会让整个
// 半边在缺服务时**不挂载**，那是最坏的失败形态，见 src/client/services.ts 的同类注释）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'project-memory'
/** 包内目录：`skills/project-memory/`（npm files 白名单里有 `skills`）。 */
export const SKILL_DIR = fileURLToPath(new URL('../skills/project-memory/', import.meta.url))

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

/**
 * 拆 frontmatter 与正文。SKILL.md 是**唯一事实源**（name / description / 正文 / 资源目录），
 * 注册时只解析它，避免"文件里一份、代码里一份"的漂移。
 * @param {string} text
 * @returns {{ meta: Record<string,string>, body: string }}
 */
export function parseSkillFile(text) {
  // 记事本/部分编辑器保存 UTF-8 时会带 BOM：`^---` 会因此匹配不上，frontmatter 整段被忽略，
  // skill 的 name/description 静默回落默认值。BOM 不是内容，先剥掉。
  const source = String(text || '').replace(/^\uFEFF/, '')
  const match = FRONTMATTER.exec(source)
  const meta = {}
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(':')
      if (at <= 0) continue
      const key = line.slice(0, at).trim()
      let value = line.slice(at + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (key) meta[key] = value
    }
  }
  return { meta, body: match ? source.slice(match[0].length) : source }
}

/**
 * 构造 `ctx.skills.register()` 接受的运行时 skill。
 * @param {{ readFile?: (file: string, enc: string) => string, dir?: string }} [opts]
 * @returns {{ name: string, description: string, whenToUse?: string, source: string, path: string, content: string, resourceBase: { kind: 'directory', path: string } }}
 */
export function buildProjectMemorySkill({ readFile = readFileSync, dir = SKILL_DIR } = {}) {
  const file = path.join(dir, 'SKILL.md')
  const { meta, body } = parseSkillFile(readFile(file, 'utf8'))
  const skill = {
    name: meta.name || SKILL_NAME,
    description: meta.description || 'Recall and maintain this project\'s long-term memory: indexed docs and code symbols, lessons, decisions, procedures, and cross-session tasks.',
    source: 'bundled',
    path: file,
    content: body.trim(),
    resourceBase: { kind: 'directory', path: dir },
  }
  if (meta.whenToUse) skill.whenToUse = meta.whenToUse
  return skill
}

/**
 * 把 skill 注册进宿主。`ctx.inject(['skills'], …)` 是可选依赖：没有该服务时回调不执行，
 * 插件其余部分照常工作；注册失败只告警，不影响工具与注入。
 * @param {object} ctx
 * @param {{ build?: () => object, log?: { error: Function } }} [opts]
 */
export function setupSkill(ctx, { build = buildProjectMemorySkill, log = console } = {}) {
  const register = (skillsCtx) => {
    try {
      skillsCtx.skills.register(build())
    } catch (err) {
      log.error(`[dsh-project-memory] skill registration skipped: ${err?.message || err}`)
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['skills'], register)
    else if (typeof ctx.get === 'function' && ctx.get('skills')) register(ctx)
  } catch (err) {
    log.error(`[dsh-project-memory] skill registration skipped: ${err?.message || err}`)
  }
}
