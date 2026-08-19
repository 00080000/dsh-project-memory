import { readFileSync } from 'node:fs'

const JS_LIKE = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'])
const PYTHON = new Set(['.py'])
const GO = new Set(['.go'])
const RUST = new Set(['.rs'])
const C_FAMILY = new Set(['.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.java'])
const SHELL = new Set(['.sh', '.zsh'])

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'foreach', 'using', 'lock', 'var', 'function'])

function matchJsLike(line) {
  let m = line.match(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))/)
  if (m) return { name: m[1] || m[2], kind: m[1] ? 'function' : 'class' }
  m = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
  if (m) return { name: m[1], kind: 'function' }
  m = line.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/)
  if (m) return { name: m[1], kind: 'class' }
  m = line.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/)
  if (m) return { name: m[1], kind: 'function' }
  m = line.match(/^(?:export\s+)?(?:async\s+)?function\s*\(/) // anonymous
  if (m) return { name: '(anonymous)', kind: 'function' }
  return null
}

function matchPython(line) {
  let m = line.match(/^class\s+(\w+)\s*(?:\(|:)/)
  if (m) return { name: m[1], kind: 'class' }
  m = line.match(/^def\s+(\w+)\s*\(/)
  if (m) return { name: m[1], kind: 'function' }
  m = line.match(/^async\s+def\s+(\w+)\s*\(/)
  if (m) return { name: m[1], kind: 'function' }
  return null
}

function matchGo(line) {
  let m = line.match(/^func\s+\([^)]*\)\s+(\w+)\s*\(/)
  if (m) return { name: m[1], kind: 'method' }
  m = line.match(/^func\s+(\w+)\s*\(/)
  if (m) return { name: m[1], kind: 'function' }
  m = line.match(/^type\s+(\w+)\s+(?:struct|interface)\b/)
  if (m) return { name: m[1], kind: 'type' }
  return null
}

function matchRust(line) {
  let m = line.match(/^fn\s+(\w+)\s*\(/)
  if (m) return { name: m[1], kind: 'function' }
  m = line.match(/^(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/)
  if (m) return { name: m[1], kind: line.includes('impl') ? 'impl' : 'type' }
  return null
}

function matchCFamily(line) {
  const type = line.match(/^(?:public|private|protected|internal|static|abstract|sealed|partial|\s)*\b(?:class|interface|struct|enum|record)\s+(\w+)/)
  if (type) return { name: type[1], kind: 'class' }
  const fn = line.match(
    /^(?:public|private|protected|internal|static|abstract|virtual|override|sealed|async|unsafe|extern|readonly|ref|partial|\s)*(\b[A-Za-z_]\w*(?:<[^<>]*>)?(?:\s*\[\s*\])?|\([^(){};]*\))\s+([A-Za-z_]\w*)\s*\([^(){};]*\)\s*(?:where\s+[^{;]*?)?\s*(?:;|\{)?\s*$/,
  )
  if (fn && !CONTROL.has(fn[1])) return { name: fn[2], kind: 'function' }
  return null
}

function matchShell(line) {
  const m = line.match(/^([A-Za-z_]\w*)\s*\(\s*\)/)
  return m ? { name: m[1], kind: 'function' } : null
}

export function scanSymbols(filePath, content) {
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  const symbols = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\/\/.*$/, '').replace(/#.*$/, '').trim()
    if (!line) continue
    let matched = null
    if (JS_LIKE.has(ext)) matched = matchJsLike(line)
    else if (PYTHON.has(ext)) matched = matchPython(line)
    else if (GO.has(ext)) matched = matchGo(line)
    else if (RUST.has(ext)) matched = matchRust(line)
    else if (C_FAMILY.has(ext)) matched = matchCFamily(line)
    else if (SHELL.has(ext)) matched = matchShell(line)
    else if (/^(?:def|func|fn|function)\s+(\w+)/.test(line)) {
      matched = { name: line.match(/^(?:def|func|fn|function)\s+(\w+)/)[1], kind: 'function' }
    }
    if (matched) {
      symbols.push({
        id: `${String(filePath).replace(/[\\/:\s]/g, '_')}#${i + 1}`,
        sourcePath: filePath,
        sourceLine: i + 1,
        type: 'symbol',
        title: `${matched.name} (${matched.kind})`,
        summary: `${matched.kind} "${matched.name}" declared at ${filePath}:${i + 1}`,
        keywords: [matched.name, matched.kind],
        text: raw.trim().slice(0, 200),
      })
    }
  }
  return symbols
}