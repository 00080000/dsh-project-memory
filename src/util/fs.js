import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs'
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

/** Windows-style absolute path (`D:\dir`, `C:/dir`) — not absolute on POSIX. */
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

/**
 * 校验索引根目录：必须存在且是目录。
 *
 * 之前 `index_repo` / `autoIndexOnFirstUse` 只做 `path.resolve()`：在 Linux/macOS 上传入
 * Windows 风格路径（如 `D:\project\foo`）会被解析成相对路径 `<cwd>/D:\project\foo`，
 * 随后 store 的 `mkdirSync` 把这个字面量目录（连同其 `.dsh-project-memory`）真的建出来。
 * 这里在写盘前拒绝不存在的根；`requested` 只用于在报错里点明“这看起来是 Windows 路径”。
 */
export function assertIndexRoot(root, requested = root) {
  let stats
  try {
    stats = statSync(root)
  } catch {
    const hint = process.platform !== 'win32' && WINDOWS_ABSOLUTE_PATH.test(String(requested))
      ? ` The argument looks like a Windows path, which is not absolute on ${process.platform}.`
      : ''
    throw new Error(`Index root does not exist: ${root}.${hint}`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`Index root is not a directory: ${root}`)
  }
  return root
}

export function sha256OfBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256OfFile(filePath) {
  const buf = await readFile(filePath)
  return { hash: sha256OfBuffer(buf), size: buf.length }
}

/**
 * 单次同步读：同一 buffer 同时供内容哈希与正文解码使用。
 *
 * 替代 “await sha256OfFile() + readFileSync()” 的二次读盘。对大量小文件的批量
 * 索引，逐文件 `async readFile` 的线程池往返是主要开销（实测 2000 文件 260ms →
 * 单次同步读 ~6ms）；调用方拿到 buffer 后按需 toString('utf8')，未变更文件无需解码。
 */
export function readFileForIndex(filePath) {
  const buffer = readFileSync(filePath)
  return { hash: sha256OfBuffer(buffer), size: buffer.length, buffer }
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