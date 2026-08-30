import { readFileSync } from 'node:fs'

const JS_LIKE = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'])
const PYTHON = new Set(['.py'])
const GO = new Set(['.go'])
const RUST = new Set(['.rs'])
const C_FAMILY = new Set(['.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.java'])
const SHELL = new Set(['.sh', '.zsh'])

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'foreach', 'using', 'lock', 'var', 'function'])

const JS_MASKER = { lineComment: '//', blockStart: '/*', blockEnd: '*/', quotes: ['`', '"', "'"], multilineQuotes: ['`'] }
const PY_MASKER = { lineComment: '#', blockStart: null, blockEnd: null, quotes: ['"""', "'''", '"', "'"], multilineQuotes: ['"""', "'''"] }
const GO_MASKER = { lineComment: '//', blockStart: '/*', blockEnd: '*/', quotes: ['`', '"'], multilineQuotes: ['`'] }
const RUST_MASKER = { lineComment: '//', blockStart: '/*', blockEnd: '*/', blockNested: true, quotes: ['"'], multilineQuotes: [] }
const C_FAMILY_MASKER = { lineComment: '//', blockStart: '/*', blockEnd: '*/', quotes: ['"', "'"], multilineQuotes: [] }
const SHELL_MASKER = { lineComment: '#', lineCommentBoundary: true, blockStart: null, blockEnd: null, quotes: ["'", '"'], multilineQuotes: [] }

function maskTokens(lines, { lineComment, lineCommentBoundary = false, blockStart, blockEnd, blockNested = false, quotes, multilineQuotes = [] }) {
  const out = new Array(lines.length)
  let mode = 'code'
  let blockDepth = 0
  const blank = (n) => ' '.repeat(n)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let res = ''
    let j = 0
    while (j < line.length) {
      if (mode === 'code') {
        if (lineComment && line.startsWith(lineComment, j)) {
          if (!lineCommentBoundary || j === 0 || /\s/.test(line[j - 1])) {
            res += blank(line.length - j)
            break
          }
        }
        if (blockStart && line.startsWith(blockStart, j)) {
          mode = blockEnd
          blockDepth = 1
          j += blockStart.length
          res += blank(blockStart.length)
          continue
        }
        const quote = quotes.find((q) => line.startsWith(q, j))
        if (quote) {
          mode = quote
          j += quote.length
          res += blank(quote.length)
          continue
        }
        res += line[j]
        j++
      } else if (quotes.includes(mode)) {
        if (line[j] === '\\') {
          j += 2
          res += '  '
          continue
        }
        if (line.startsWith(mode, j)) {
          j += mode.length
          res += blank(mode.length)
          mode = 'code'
          continue
        }
        res += ' '
        j++
      } else {
        if (blockNested && blockStart && line.startsWith(blockStart, j)) {
          blockDepth++
          res += blank(blockStart.length)
          j += blockStart.length
          continue
        }
        if (line.startsWith(mode, j)) {
          j += mode.length
          res += blank(mode.length)
          if (blockNested && blockDepth > 1) blockDepth--
          else mode = 'code'
          continue
        }
        res += ' '
        j++
      }
    }
    if (mode && quotes.includes(mode) && !multilineQuotes.includes(mode)) mode = 'code'
    out[i] = res
  }
  return out
}

function balanceDelta(text) {
  let delta = 0
  for (const ch of text) {
    if (ch === '(') delta++
    else if (ch === ')') delta--
  }
  return delta
}

function matchJsLike(line) {
  let m = line.match(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))/)
  if (m) return { name: m[1] || m[2], kind: m[1] ? 'function' : 'class' }
  m = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
  if (m) return { name: m[1], kind: 'function' }
  m = line.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/)
  if (m) return { name: m[1], kind: 'class' }
  m = line.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/)
  if (m) return { name: m[1], kind: 'function' }
  m = line.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/)
  if (m) return { name: m[1], kind: 'function' }
  m = line.match(/^(?:export\s+)?(?:async\s+)?function\s*\(/) // anonymous
  if (m) return { name: '(anonymous)', kind: 'function' }
  return null
}

const JS_DECL_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b|const\b)/

const JS_NON_METHOD = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'default',
  'try', 'catch', 'finally', 'return', 'throw', 'break', 'continue',
  'new', 'delete', 'typeof', 'instanceof', 'void', 'await', 'yield', 'with',
])

function scanJsLike(masked, relPath, rawLines) {
  const symbols = []
  let prevOpensBlock = false
  for (let i = 0; i < masked.length; i++) {
    const text = masked[i].trim()
    if (!text) continue
    let matched = null
    if (prevOpensBlock) {
      const method = text.match(/^([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(([^()]*)\)\s*(?::\s*[^={]{1,80})?\{/)
      if (method && !JS_NON_METHOD.has(method[1])) matched = { name: method[1], kind: 'method' }
    }
    if (!matched) matched = matchJsLike(text)
    if (!matched && JS_DECL_START.test(text)) {
      let joined = text
      let extra = 0
      for (let j = i + 1; j < masked.length && extra < 3; j++) {
        const tail = masked[j].trim()
        if (!tail) continue
        joined += ' ' + tail
        extra++
        matched = matchJsLike(joined)
        if (matched) {
          i = j
          break
        }
        if (/[{};]/.test(tail)) break
      }
    }
    if (matched) symbols.push(buildSymbol(matched, relPath, rawLines[i], i + 1))
    prevOpensBlock = masked[i].trim().endsWith('{')
  }
  return symbols
}

function scanPython(masked, relPath, rawLines) {
  const symbols = []
  let depth = 0
  for (let i = 0; i < masked.length; i++) {
    const text = masked[i].trim()
    const delta = balanceDelta(text)
    if (depth > 0) {
      depth += delta
      continue
    }
    let matched = null
    const fn = text.match(/^(?:async\s+)?def\s+(\w+)\s*\(/)
    const cls = fn ? null : text.match(/^class\s+(\w+)\s*[(:]/)
    if (fn) matched = { name: fn[1], kind: 'function' }
    else if (cls) matched = { name: cls[1], kind: 'class' }
    if (matched) symbols.push(buildSymbol(matched, relPath, rawLines[i], i + 1))
    depth += delta
  }
  return symbols
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
  let m = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*\(/)
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

function extractParamsAndReturn(line) {
  const trimmed = line.trim()
  
  // Try to extract params and return type from function declaration
  // Matches: function name(params): returnType { or => returnType {
  const funcMatch = line.match(/function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))\s*(?::\s*([^{]+))?\s*\{/)
  if (funcMatch) {
    const params = funcMatch[2] || '()'
    const returnType = funcMatch[3] ? `: ${funcMatch[3].trim()}` : ''
    return `${funcMatch[1]}${params}${returnType}`
  }
  
  // Arrow function: const name = (params): returnType => {
  const arrowMatch = line.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*:\s*([^=]+)\s*=>/)
  if (arrowMatch) {
    return `${arrowMatch[1]}(${arrowMatch[2]}): ${arrowMatch[3].trim()}`
  }
  
  // Arrow function without explicit return type: const name = (params) => {
  const arrowSimple = line.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/)
  if (arrowMatch) {
    return `${arrowMatch[1]}(${arrowMatch[2]})`
  }
  
  // Class method: methodName(params): returnType {
  const methodMatch = line.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(([^()]*)\)\s*(?::\s*([^{]+))?\s*\{/)
  if (methodMatch) {
    const returnType = methodMatch[3] ? `: ${methodMatch[3].trim()}` : ''
    return `${methodMatch[1]}(${methodMatch[2] || ''})${returnType}`
  }
  
  // Constructor
  const constructorMatch = line.match(/constructor\s*\(([^)]*)\)/)
  if (constructorMatch) {
    return `constructor(${constructorMatch[1]})`
  }
  
  // Fallback: try to extract from the raw line
  const declMatch = line.match(/(function|const|let|var)\s+([A-Za-z_$][\w$]*)/)
  if (declMatch) {
    return declMatch[0]
  }
  
  // Fallback: return the raw line trimmed
  return ''
}

function buildSymbol(matched, relPath, rawLine, lineNo) {
  // Extract signature from raw line - keep full declaration
  const fullDecl = String(rawLine).trim()
  
  // Build one-line identity: name(params): returnType — file.ts:lineNo
  const identity = `${matched.name}${extractParamsAndReturn(rawLine)} — ${relPath}:${lineNo}`

  return {
    id: `${String(relPath).replace(/[\\/:\s]/g, '_')}#${lineNo}`,
    sourcePath: relPath,
    sourceLine: lineNo,
    type: 'symbol',
    title: `${matched.name} (${matched.kind})`,
    keywords: [matched.name, matched.kind],
    text: `${matched.name}${extractParamsAndReturn(rawLine)} — ${relPath}:${lineNo}`,  // full signature as identity card
  }
}

export function scanSymbols(a, b, c) {
  // Backward compatible: old signature (filePath, content) or new (relPath, filePath, content)
  const [relPath, filePath, content] = c === undefined ? [a, a, b] : [a, b, c]
  const ext = relPath.slice(relPath.lastIndexOf('.'))
  const lines = content.split(/\r?\n/)
  if (JS_LIKE.has(ext)) return scanJsLike(maskTokens(lines, JS_MASKER), relPath, lines)
  if (PYTHON.has(ext)) return scanPython(maskTokens(lines, PY_MASKER), relPath, lines)

  let masker = null
  if (GO.has(ext)) masker = GO_MASKER
  else if (RUST.has(ext)) masker = RUST_MASKER
  else if (C_FAMILY.has(ext)) masker = C_FAMILY_MASKER
  else if (SHELL.has(ext)) masker = SHELL_MASKER
  const masked = masker ? maskTokens(lines, masker) : lines

  const symbols = []
  for (let i = 0; i < masked.length; i++) {
    const raw = lines[i]
    const line = masked[i].trim()
    if (!line) continue
    let matched = null
    if (GO.has(ext)) matched = matchGo(line)
    else if (RUST.has(ext)) matched = matchRust(line)
    else if (C_FAMILY.has(ext)) matched = matchCFamily(line)
    else if (SHELL.has(ext)) matched = matchShell(line)
    else if (/^(?:def|func|fn|function)\s+(\w+)/.test(line)) {
      matched = { name: line.match(/^(?:def|func|fn|function)\s+(\w+)/)[1], kind: 'function' }
    }
    if (matched) symbols.push(buildSymbol(matched, relPath, raw, i + 1))
  }
  return symbols
}