import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
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
  // 先 stat 再读：大小上限的意义就是"别把整个文件读进内存"。旧写法先 readFile 再比较，
  // 127 MB 的文件会先把 127 MB 拉进 RSS 再抛错（watch/lazy 每轮重试，反复发生）。
  if (Number.isFinite(maxBytes)) {
    let size = 0
    try {
      size = statSync(filePath).size
    } catch {
      size = 0 // 交给下面的 readFile 报真实错误（不存在 / 无权限）
    }
    if (size > maxBytes) {
      throw new Error(`File too large to index as text (${(size / 1024 / 1024).toFixed(1)} MB)`)
    }
  }
  const buf = await readFile(filePath)
  if (buf.length > maxBytes) {
    // stat 与 read 之间文件被改大：兜底再判一次
    throw new Error(`File too large to index as text (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
  }
  return buf.toString('utf8')
}

// 逐目录名排除。除构建产物外，专门收了 macOS/Homebrew 的巨型噪音目录：
// `Library`/`Applications` 在家目录下是十万级文件，`Cellar`/`Caskroom`/`Frameworks`
// 在 /opt/homebrew 下同理——它们正是把进程内存打满的那批（issue #5）。
const DEFAULT_IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', 'venv', '.venv',
  '__pycache__', '.idea', '.vscode', '.dsh-project-memory', '.cache',
  'coverage', '.turbo', 'target', 'vendor', 'third_party', 'thirdparty', 'obj',
  'Library', 'Applications', 'Cellar', 'Caskroom', 'Frameworks', 'DerivedData',
  'Pods', 'bower_components', 'jspm_packages', 'logs',
])

/** 单次扫描的默认上限。0 / 负数 / 非数字 = 不限制。 */
export const DEFAULT_SCAN_FILES = 20000
export const DEFAULT_SCAN_DEPTH = 12

/**
 * 从 config 解析扫描上限。非法值（NaN/0/负数）回落到出厂值——一个配置笔误不该
 * 把保护整个关掉。显式传 `maxScanFiles: 0` 才会真的关掉（见 README）。
 */
export function scanLimits(config) {
  const files = Number(config?.maxScanFiles)
  const depth = Number(config?.maxScanDepth)
  return {
    maxFiles: Number.isFinite(files) && files > 0 ? files : DEFAULT_SCAN_FILES,
    maxDepth: Number.isFinite(depth) && depth > 0 ? depth : DEFAULT_SCAN_DEPTH,
  }
}

/**
 * 遍历目录，返回 `{ files, truncated }`。
 *
 * 与旧版的两点区别都是 OOM 的直接修复：
 *   - **有上限**：`maxFiles` / `maxDepth` 封顶，超限只做截断标记，不再一路吃内存；
 *   - `truncated` 让调用方区分「这棵树扫完了」和「只扫了一部分」——后者绝不能拿
 *     本轮未见到的文件去删旧条目（见 index-repo/watch 的 unseen 用法）。
 */
export function walkDir(root, opts = {}) {
  const ignoreNames = opts.ignoreNames || DEFAULT_IGNORE
  const maxFiles = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : Infinity
  const maxDepth = Number.isFinite(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : Infinity
  const out = []
  const stack = [[root, 0]]
  let truncated = false
  let hitFileCap = false
  while (stack.length) {
    const [dir, depth] = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ignoreNames.has(entry.name)) continue
        if (depth + 1 > maxDepth) {
          truncated = true
          continue
        }
        stack.push([full, depth + 1])
      } else {
        if (out.length >= maxFiles) {
          truncated = true
          hitFileCap = true
          break
        }
        out.push(full)
      }
    }
    if (hitFileCap) break
  }
  out.sort()
  return { files: out, truncated }
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

/**
 * 危险根目录：整体扫描/监听它们会直接吃满内存（issue #5 实测把 DSH 撑死的就是
 * 家目录与 `/opt/homebrew`）。判定是**精确匹配**：只拒绝这些目录**本身**，不拒绝
 * 它们的子目录（`~/Library` 拒绝，`~/Library/Mobile Documents/…/MyProj` 照常可用）。
 *
 * 三类都在名单里：
 *   - 文件系统根（含 Windows 盘符根）；
 *   - 家目录及其所有祖先（`/Users`、`/home`、`/`），以及家目录下的系统型子目录；
 *   - 系统/包管理器前缀（`/usr`、`/opt`、`/opt/homebrew`、`C:\Windows` …）。
 */
function safeHomedir() {
  try {
    return os.homedir()
  } catch {
    return null
  }
}

/**
 * 危险根集合（判定用，`isUnsafeRoot` 的底座）。
 *
 * 参数化是为了**能在任意平台上验证每个平台的分支**：测试用 `path.win32` 模拟 Windows，
 * 不必真的跑在 Windows 上（第一版正是因为只在 POSIX 分支里塞了 `/usr`、`/opt`，却拿它们
 * 去断言 Windows，CI 才红）。生产路径只调用无参形式。
 *
 * 系统前缀按平台分组是刻意的：`C:\opt`、`C:\usr` 在 Windows 上是**正常用户目录**，
 * 跨平台套用既会误伤，也会自相矛盾（`/usr/local` 被拒而 `/usr` 放行）。
 */
export function collectUnsafeRoots({
  platform = process.platform,
  home = safeHomedir(),
  tmp = os.tmpdir(),
  env = process.env,
  pathApi = path,
} = {}) {
  const set = new Set()
  const push = (p) => {
    if (!p || typeof p !== 'string') return
    let abs
    try {
      abs = pathApi.resolve(p)
    } catch {
      return
    }
    set.add(storeKey(abs, platform))
  }

  push(tmp)
  let homeAbs = null
  try {
    homeAbs = home ? pathApi.resolve(home) : null
  } catch {
    homeAbs = null
  }
  if (homeAbs) {
    // 家目录 + 它的所有祖先：往上任何一级当根都会把整台机器扫进来。
    let dir = homeAbs
    for (;;) {
      push(dir)
      const parent = pathApi.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    for (const sub of platform === 'win32' ? ['AppData', 'Application Data'] : ['Library', 'Applications', '.Trash']) {
      push(pathApi.join(homeAbs, sub))
    }
  }

  if (platform === 'win32') {
    for (const name of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
      push(env[name])
    }
  } else {
    // POSIX 系统前缀 + 包管理器/工具链前缀。ARM Mac 的 Homebrew 是 git clone 到
    // `/opt/homebrew` 的——那里**有 `.git`**，所以单靠"只认项目标记"仍会把整个 Homebrew
    // 判成项目根（issue #5 的第二个位置）。
    for (const p of [
      '/usr', '/usr/local', '/usr/local/Homebrew', '/usr/local/Cellar',
      '/opt', '/opt/homebrew', '/opt/local',
      '/etc', '/var', '/bin', '/sbin', '/dev', '/proc', '/sys', '/run',
      '/System', '/Library', '/Applications', '/private', '/cores',
      '/home/linuxbrew', '/home/linuxbrew/.linuxbrew', '/nix',
    ]) {
      push(p)
    }
  }
  return set
}

const UNSAFE_DIRS = collectUnsafeRoots()

/** 判定依据文案：用于拒绝时告诉用户「为什么是它」。 */
function unsafeReason(abs) {
  const key = storeKey(abs)
  const parsed = path.parse(abs)
  if (abs === parsed.root) return 'the filesystem root'
  let home = null
  try {
    home = storeKey(path.resolve(os.homedir()))
  } catch {
    home = null
  }
  if (home && key === home) return 'your home directory'
  if (key === storeKey(path.resolve(os.tmpdir()))) return 'the shared temp directory'
  return 'a system directory that is never a project root'
}

/** 这个目录能否当项目记忆根？纯判定，无副作用。 */
export function isUnsafeRoot(root) {
  if (typeof root !== 'string' || !root) return true
  let abs
  try {
    abs = path.resolve(root)
  } catch {
    return true
  }
  const parsed = path.parse(abs)
  if (!parsed.dir || abs === parsed.root) return true
  return UNSAFE_DIRS.has(storeKey(abs))
}

export class UnsafeRootError extends Error {
  constructor(root, requested) {
    const target = requested && String(requested).trim() ? String(requested) : String(root)
    super(
      `Refusing to use ${target} as a project memory root: it is ${unsafeReason(path.resolve(root))}. ` +
        'Indexing or watching it would walk the whole directory tree (hundreds of thousands of files) and exhaust memory. ' +
        'Pass a project directory instead, or set allowUnsafeRoots: true if you really mean it.',
    )
    this.name = 'UnsafeRootError'
    this.root = root
  }
}

/**
 * 校验「这个根可以当项目记忆根」。所有把目录当根写盘的入口都必须先过这一关：
 * 写盘前拒绝，比事后清理 `.dsh-project-memory` 便宜得多。
 */
export function assertSafeRoot(root, { requested = root, allowUnsafe = false } = {}) {
  if (allowUnsafe) return root
  if (!isUnsafeRoot(root)) return root
  throw new UnsafeRootError(root, requested)
}

export function resolveIndexRoot(exec, explicitRoot) {
  if (explicitRoot && explicitRoot.trim()) return path.resolve(explicitRoot)
  const sessionCwd = exec?.agent?.session?.header?.cwd
  if (sessionCwd) return path.resolve(sessionCwd)
  return path.resolve(process.cwd())
}

// ---------------------------------------------------------------------------
// 项目根推导 —— 全插件唯一的策略实现。
//
// 顺序（前两者是"声明"，后两者是"推定"）：
//   1. 显式传入的 root（工具参数）；
//   2. 显式登记过的根（watch_repo / watchManager）；
//   3. 最近的、含 VCS 或构建/清单标记的祖先；
//   4. 会话工作目录本身 —— 只要它是安全目录。
// 都没有 → null（该文件不落任何记忆）。
//
// 第 4 条是刻意的：`cwd` 是**人明确选择的工作位置**（在那里启动了 dsh），和"模型顺手读到的
// 某个文件所在目录"完全不是一回事。旧实现把后者也当根（兜底 `path.dirname(file)`），
// 又让 `.dsh-project-memory` 自己当标记，才把家目录锁成了项目（issue #5）。
// ---------------------------------------------------------------------------

/** VCS 边界：最强的项目根信号（`.git` 在 worktree 里是文件，existsSync 同样命中）。 */
export const VCS_MARKERS = ['.git', '.hg', '.svn']

/**
 * 构建/清单标记。**刻意不含 `.dsh-project-memory`**：那个目录是插件自己创建的，
 * 一旦算作项目标记就会自我固化——审计日志在会话 cwd 建出它之后，读该目录下任意文件
 * 都会把根解析回该目录，于是家目录被永久锁成"项目"。
 */
export const PROJECT_MARKERS = [
  'package.json', 'tsconfig.json', 'deno.json', 'deno.jsonc',
  'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'setup.py',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'CMakeLists.txt', 'Makefile', 'composer.json', 'Gemfile', 'mix.exs', 'Package.swift',
]

/** 探针文件名：findProjectRoot 期望文件路径，用目录内的探针路径问"这个目录的根是谁"。 */
export const PROJECT_PROBE = '__dsh-project-memory__.probe'

/** 该目录**自身**是否带项目标记（不向上找）。用于判断根是"声明的"还是"推定的"。 */
export function hasProjectMarker(dir) {
  if (typeof dir !== 'string' || !dir) return false
  let abs
  try {
    abs = path.resolve(dir)
  } catch {
    return false
  }
  for (const marker of VCS_MARKERS) if (existsSync(path.join(abs, marker))) return true
  for (const marker of PROJECT_MARKERS) if (existsSync(path.join(abs, marker))) return true
  return false
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 显式登记的根里，包含该文件的**最深**那一个（最长前缀匹配）。 */
function longestRootContaining(roots, absPath) {
  let best = null
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue
    let resolved
    try {
      resolved = path.resolve(root)
    } catch {
      continue
    }
    if (!isInside(resolved, absPath)) continue
    if (!best || resolved.length > best.length) best = resolved
  }
  return best
}

function resolveDir(dir) {
  try {
    return path.resolve(dir)
  } catch {
    return null
  }
}

function nearestMarker(absPath, markers) {
  let dir = path.dirname(absPath)
  for (;;) {
    // 撞到家目录/系统目录边界就停：既不把边界当根，也不再向上（上面只会更宽）。
    if (isUnsafeRoot(dir)) return null
    for (const marker of markers) {
      if (existsSync(path.join(dir, marker))) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 项目根推导（**只认标记与显式声明，绝不从文件路径兜底**）。
 *
 * @param {string} filePath 目标文件（也接受目录内探针文件路径）
 * @param {{ extraRoots?: Iterable<string>, sessionRoot?: string|null }} [opts]
 *   `extraRoots`：显式登记过的根（watch_repo / watchManager）。
 *   `sessionRoot`：会话工作目录，作为**最后**一级推定——仅当文件确实在它里面、
 *   且它是安全目录时采用。
 * @returns {string|null}
 */
export function findProjectRoot(filePath, opts = {}) {
  if (typeof filePath !== 'string' || !filePath) return null
  let abs
  try {
    abs = path.resolve(filePath)
  } catch {
    return null
  }
  const explicit = longestRootContaining(opts.extraRoots || [], abs)
  if (explicit) return isUnsafeRoot(explicit) ? null : explicit

  const byMarker = nearestMarker(abs, VCS_MARKERS) || nearestMarker(abs, PROJECT_MARKERS)
  if (byMarker) return byMarker

  const session = resolveDir(opts.sessionRoot)
  if (session && !isUnsafeRoot(session) && isInside(session, abs)) return session
  return null
}

/**
 * **会话记忆根**：本插件所有"这个会话的记忆放哪"的唯一答案。
 * 声明优先（标记）→ 会话工作目录（安全时）→ null（家目录/系统目录，且没有标记）。
 */
export function resolveProjectMemoryRoot(cwd) {
  const base = resolveDir(cwd) || resolveDir(process.cwd())
  if (!base) return null
  return findProjectRoot(path.join(base, PROJECT_PROBE), { sessionRoot: base })
}

/**
 * 工具侧的根解析：显式 root 优先（并校验安全），否则取会话记忆根。
 * 会话 cwd 是家目录且没有标记时抛 `UnsafeRootError`——旧代码会在那里建
 * `.dsh-project-memory` 并把它当成项目标记，进而把整个家目录锁成"项目"（issue #5）。
 */
export function resolveSafeIndexRoot(exec, explicitRoot, config) {
  const allowUnsafe = config?.allowUnsafeRoots === true
  const explicit = explicitRoot && String(explicitRoot).trim() ? String(explicitRoot) : null
  if (explicit) {
    return assertSafeRoot(path.resolve(explicit), { requested: explicit, allowUnsafe })
  }
  const cwd = resolveIndexRoot(exec)
  const root = resolveProjectMemoryRoot(cwd)
  if (root) return root
  if (allowUnsafe) return cwd
  throw new UnsafeRootError(cwd, cwd)
}

/** 尽力而为的会话记忆根：拿不到就返回 null（用于审计镜像这类旁路，不抛错）。 */
export function sessionMemoryRootOrNull(exec, config) {
  try {
    return resolveSafeIndexRoot(exec, null, config)
  } catch {
    return null
  }
}