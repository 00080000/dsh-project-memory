import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

export function assertReadableFile(filePath, maxFileSizeMb) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('file_path must be a non-empty string')
  }
  let stats
  try {
    accessSync(filePath, constants.R_OK)
    stats = statSync(filePath)
  } catch {
    throw new Error(`File not readable: ${filePath}`)
  }
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`)
  }
  if (maxFileSizeMb && stats.size > maxFileSizeMb * 1024 * 1024) {
    throw new Error(`File too large (${(stats.size / 1024 / 1024).toFixed(1)} MB), limit is ${maxFileSizeMb} MB`)
  }
  return filePath
}

export function sha256OfBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256OfFile(filePath) {
  const buf = await readFile(filePath)
  return { hash: sha256OfBuffer(buf), size: buf.length }
}

export async function readTextFile(filePath, maxBytes = 2 * 1024 * 1024) {
  const buf = await readFile(filePath)
  if (buf.length > maxBytes) {
    throw new Error(`File too large to index as text (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
  }
  return buf.toString('utf8')
}

const DEFAULT_IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', 'venv', '.venv',
  '__pycache__', '.idea', '.vscode', '.dsh-project-memory', '.cache',
  'coverage', '.turbo', 'target', 'vendor', 'third_party', 'thirdparty', 'obj',
])

export function walkDir(root, ignoreNames = DEFAULT_IGNORE) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      if (entry.isDirectory()) {
        if (ignoreNames.has(entry.name)) continue
        stack.push(path.join(dir, entry.name))
      } else {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  return out.sort()
}

export function isSupportedDoc(ext) {
  return ['.pdf', '.md', '.markdown', '.txt'].includes(ext)
}

const DUMP_REFLECTION = /(?:==\s*TYPE\s|\bVersion=\d+\.\d+\.\d+\.\d+|loaded:\s*\S+,\s*Version=)/

export function looksLikeDump(text, maxBytes = 4096) {
  if (!text) return false
  const head = String(text).slice(0, maxBytes)
  if (!/^(\uFEFF)?\s*={3,}/.test(head)) return false
  return DUMP_REFLECTION.test(head)
}

export function isSupportedCode(ext) {
  return [
    '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py', '.java', '.go',
    '.rs', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.php', '.rb',
    '.swift', '.kt', '.kts', '.sh', '.zsh',
  ].includes(ext)
}

export function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

export function storeKey(rel, platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' ? rel.toLowerCase() : rel
}

export function memoryRootFor(indexRoot, memoryDir) {
  return path.join(indexRoot, memoryDir)
}

export function resolveIndexRoot(exec, explicitRoot) {
  if (explicitRoot && explicitRoot.trim()) return path.resolve(explicitRoot)
  const sessionCwd = exec?.agent?.session?.header?.cwd
  if (sessionCwd) return path.resolve(sessionCwd)
  return path.resolve(process.cwd())
}