import {
  accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { sessionWorkingDir } from './session-dir.js'

/**
 * 原子写 JSON：先写同目录的 `<file>.<pid>.tmp`，再 rename 覆盖目标。
 *
 * 两点语义，别再各写一份副本：
 * - 先建父目录（global insight 文件首次写入时父目录可能不存在）。
 * - 失败时删掉自己的 `.tmp`，不重试 rename：同样的参数重试没有意义，而 `.tmp` 留下只有
 *   `cleanStaleTmp()` 会清，它扫不到 `~/.config/dsh-project-memory/`。
 *
 * 崩溃（kill -9 / 断电）走不到 catch，那种残留由 `cleanStaleTmp()` 兜底。
 * @param {string} file - 目标文件绝对路径。
 * @param {unknown} data - 要序列化的 JSON 值。
 * @throws 序列化失败或写盘/rename 失败时原样抛出（调用方决定回退策略）。
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Windows 上 rename/unlink 会被杀毒软件、搜索索引、备份代理瞬时占用（EPERM/EBUSY），
 * 同一参数重试一次通常就过。只在**瞬时错误码**上重试；真实失败（EISDIR/ENOSPC/EACCES 持续）
 * 立即抛出，保持原有"失败要清 .tmp 并抛出去"的契约。
 */
function retryTransient(op, attempts = 3) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      return op()
    } catch (err) {
      last = err
      if (!TRANSIENT_FS_CODES.has(err?.code)) throw err
      if (i + 1 < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (i + 1))
    }
  }
  throw last
}

export function writeJsonAtomic(file, data, { ensureDir = true } = {}) {
  const dir = path.dirname(file)
  if (ensureDir) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const payload = JSON.stringify(data)
  const write = () => {
    retryTransient(() => writeFileSync(tmp, payload))
    retryTransient(() => renameSync(tmp, file))
  }
  try {
    write()
  } catch (err) {
    let failure = err
    // 目录可能在两次写之间被外部删掉（测试、用户清理、挂载点抖动）；`ensureDir: false` 的
    // 快路径因此不能假设目录一定在——补建后重做一次，仍然失败才按原契约抛。
    if (err?.code === 'ENOENT') {
      try {
        mkdirSync(dir, { recursive: true })
        write()
        return
      } catch (retryErr) {
        failure = retryErr
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // tmp 已不在（rename 其实成功了）或不可删；两种都无需处理
    }
    throw failure
  }
}

/** 本机标识：锁的存活判定只在同机可信（跨机只能退回 mtime）。 */
const LOCK_HOST = os.hostname()
const LOCK_FILE = '.write.lock'
let lockSeq = 0

/**
 * 读锁文件（不存在/读失败返回 null）。
 * 旧版本写的是裸 pid；新版本写 JSON（pid + host + token）。两种都要能读。
 * @param {string} file
 * @returns {null | { text: string, meta: { pid?: number, host?: string, token?: string }, ageMs: number }}
 */
function readLockState(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const ageMs = Date.now() - statSync(file).mtimeMs
    let meta = null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') meta = parsed
    } catch {
      // 旧格式：裸 pid
    }
    if (!meta) meta = { pid: Number.parseInt(text.trim(), 10) }
    return { text, meta, ageMs }
  } catch {
    return null
  }
}

/**
 * 进程启动时刻（Linux：`/proc/<pid>` 的 ctime）。其它平台读不到就返回 null。
 * 只用于识别 **pid 复用**：一个新进程复用了崩溃进程的 pid 时，它的启动时刻一定晚于
 * 旧锁的 `at` —— 那是"锁确实死了"的硬证据，不必因为 pid 活着而永久卡住。
 * @param {number} pid
 * @returns {number|null}
 */
function processStartMs(pid) {
  try {
    return statSync(`/proc/${pid}`).ctimeMs
  } catch {
    return null
  }
}

/** 进程是否还活着。EPERM = 存在但属于别人，按活着算。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 锁是否可以回收（stale）。
 *
 * 三条规则，按可信度排序：
 * 1. 同机 + 锁里有 pid + 进程活着 → **绝不回收**，哪怕 mtime 很老。旧实现只看 mtime，
 *    一次 > 10s 的大 store 写入就会被第二个进程抢走，而原持有者 release 时还会删掉对方的锁
 *    （实测三者同时持锁）。
 * 2. 同机 + pid 明确已死 → 立即回收。不必等 staleMs —— 这正是"崩溃残留锁 + 重试预算 8.3s
 *    < staleMs 10s"导致 save 静默跳过的原因。
 * 3. 跨机（或没有 host 字段的旧锁）→ 只能按 mtime：超过 staleMs 回收；超过 hardStaleMs 的
 *    一律回收，兜住 pid 复用（同机也适用）。
 * @param {{meta: object, ageMs: number}} state
 * @param {number} staleMs
 * @param {number} hardStaleMs
 * @returns {boolean}
 */
function lockIsStale(state, staleMs, hardStaleMs) {
  if (!state) return true
  const { meta, ageMs } = state
  const sameHost = !meta.host || meta.host === LOCK_HOST
  if (!sameHost || !Number.isInteger(meta.pid)) {
    // 跨机 / 旧格式没有 pid：只能按 mtime，hardStaleMs 是最后兜底。
    return ageMs > staleMs || ageMs > hardStaleMs
  }
  if (!pidAlive(meta.pid)) return true
  // 活着：正常情况绝不回收。唯一的例外是 pid 被复用（新进程的启动时刻晚于旧锁）。
  // 没有 `at` 的旧锁无法做这个判断 → 信任存活，宁可等也不能双写。
  const started = processStartMs(meta.pid)
  const at = Date.parse(meta.at || '')
  if (started !== null && Number.isFinite(at) && started > at + 5000) return true
  return false
}

/**
 * 目录级写锁（跨进程）。写入前短暂持有，读改写之间不会交错。
 *
 * 锁文件是 `.write.lock`，内容 `{pid, host, token, at}`；**释放要校验 token**，绝不 unlink
 * 别人的锁。拿不到锁返回 null（调用方必须把这一次写当成失败，而不是"等会儿会写"）。
 * `ensureDir: false` 只跳过**每次 save 的预防性 mkdir**（9p/NTFS 上 ~4ms）；目录被外部
 * 删掉时仍会在 `ENOENT` 上补建一次再重试。少了这次补建，缓存过的“目录已在”会把一次外部
 * 删除变成永久写失败（见 store.js 的 `_storeDirReady`）。
 *
 * @param {string} dir 目标目录（不存在则创建）
 * @param {{timeoutMs?: number, staleMs?: number, hardStaleMs?: number, ensureDir?: boolean}} [opts]
 * @returns {null | (() => void)} 释放函数；拿不到锁返回 null
 */
export function acquireDirLock(dir, { timeoutMs = 2000, staleMs = 10000, hardStaleMs = 0, ensureDir = true } = {}) {
  if (ensureDir) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return null
    }
  }
  const file = path.join(dir, LOCK_FILE)
  const hardLimit = hardStaleMs > 0 ? hardStaleMs : staleMs * 10
  const token = `${process.pid}-${Date.now().toString(36)}-${++lockSeq}-${randomUUID().slice(0, 8)}`
  const payload = JSON.stringify({ pid: process.pid, host: LOCK_HOST, token, at: new Date().toISOString() })
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  let recoveredDir = false
  for (;;) {
    try {
      const fd = openSync(file, 'wx')
      try {
        writeFileSync(fd, payload)
      } finally {
        closeSync(fd)
      }
      return () => releaseDirLock(file, token)
    } catch (err) {
      if (err?.code === 'ENOENT' && !recoveredDir) {
        // 目录在 load 之后被外部删掉（用户清理 / 挂载点抖动 / 测试）。
        // 只恢复一次，避免目录不可写时在这里死循环。
        recoveredDir = true
        try {
          mkdirSync(dir, { recursive: true })
        } catch {
          return null
        }
        continue
      }
      if (err?.code !== 'EEXIST') return null
      const state = readLockState(file)
      if (!state) continue // 刚好被释放：下一轮直接抢
      if (lockIsStale(state, staleMs, hardLimit)) {
        // 只删"刚刚读到的那个内容"：两次读之间锁可能已被别人抢到并重写。
        try {
          if (readFileSync(file, 'utf8') === state.text) unlinkSync(file)
        } catch {
          // 已被别处回收
        }
        continue
      }
      if (Date.now() >= deadline) return null
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
}

/**
 * 释放锁：内容还是自己的 token 才删。旧格式（裸 pid）只在自己 pid 匹配时删。
 * 抢锁逻辑已经保证"别人抢走后原持有者不会删它"——这里是第二道闸。
 * @param {string} file
 * @param {string} token
 */
function releaseDirLock(file, token) {
  try {
    const text = readFileSync(file, 'utf8')
    let meta = null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') meta = parsed
    } catch {
      // 旧格式
    }
    if (meta && typeof meta.token === 'string') {
      if (meta.token !== token) return
    } else if (text.trim() !== String(process.pid)) {
      return
    }
    unlinkSync(file)
  } catch {
    // 已被回收或目录不可写：不影响调用方
  }
}

/**
 * 读锁状态（诊断/测试用）：谁持有、多久了、是否会被当成 stale。
 * @param {string} dir
 * @param {{staleMs?: number, hardStaleMs?: number}} [opts]
 * @returns {null | { pid: number|undefined, host: string|undefined, token: string|undefined, ageMs: number, stale: boolean }}
 */
export function inspectDirLock(dir, { staleMs = 10000, hardStaleMs = 0 } = {}) {
  const state = readLockState(path.join(dir, LOCK_FILE))
  if (!state) return null
  return {
    pid: state.meta.pid,
    host: state.meta.host,
    token: state.meta.token,
    ageMs: state.ageMs,
    stale: lockIsStale(state, staleMs, hardStaleMs > 0 ? hardStaleMs : staleMs * 10),
  }
}

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
 * 从 config 解析扫描上限。0 / 负数 / 非数值一律回落到出厂值：上限只能放宽，不能取消。见 README 配置表。
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
 * 遍历目录，返回 `{ files, truncated, capped, skipped, unreadable }`。
 *
 * 与旧版的两点区别都是 OOM 的直接修复：
 *   - **有上限**：`maxFiles` / `maxDepth` 封顶，超限只做截断标记，不再一路吃内存；
 *   - `truncated` 让调用方区分「这棵树扫完了」和「只扫了一部分」——后者绝不能拿
 *     本轮未见到的文件去删旧条目（见 index-repo/watch 的 unseen 用法）。
 *
 * `truncated` 现在有**两个来源**，必须分开报告：
 *   - `capped`：撞到 `maxFiles` / `maxDepth`；
 *   - `unreadable`：某个目录 `readdirSync` 失败（EACCES/EPERM…）。
 * 旧实现把读失败当"这个目录不存在"直接 `continue` —— 于是那棵子树里的文件既不在 `seen` 里、
 * 又不置 `truncated`，调用方就会把它们当"已删除"清掉（派生索引静默丢失，且每次索引都白清一遍）。
 * 读不到 ≠ 不存在：置 `truncated` 是最保守的处置。
 */
/**
 * 一个目录是否**自带 store**（即它自己已经是一个被索引过的项目根）。
 *
 * 判据用 `format.json`：任何走过一次 `save()` 的 store 都必然有它，而误建/刚建的空
 * `.dsh-project-memory` 目录没有——那种不能作为跳过的依据，否则父 store 一跳过，内容两头都没了。
 */
export function hasOwnStore(dir, memoryDirName) {
  return existsSync(path.join(dir, memoryDirName, 'format.json'))
}

/**
 * 列出 `root` 下**自带 store** 的子目录 —— 也就是"这部分内容有自己的独立索引"。
 *
 * 存在的理由：`walkDir()` 会跳过这些子树（父根不再重复保存它们的内容），于是"在父根下问子项目
 * 的事"必须换个 `root=` 再问一次。这个函数就是用来在**查询未命中时给模型指路**的，不是文件系统
 * 巡检：BFS、限深 3 层、最多列 8 个、最多看 300 个目录，且不往已知的子根里下探。
 */
export function nestedStoreRoots(root, memoryDirName, { maxDepth = 3, maxEntries = 8, maxVisited = 300 } = {}) {
  const found = []
  const queue = [[root, 0]]
  let visited = 0
  while (queue.length && found.length < maxEntries && visited < maxVisited) {
    const [dir, depth] = queue.shift()
    visited++
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= maxEntries) break
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (DEFAULT_IGNORE.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (hasOwnStore(full, memoryDirName)) {
        found.push(full)
        continue // 已知的子根不再往里下探
      }
      if (depth + 1 <= maxDepth) queue.push([full, depth + 1])
    }
  }
  return found.sort()
}

export function walkDir(root, opts = {}) {
  const ignoreNames = opts.ignoreNames || DEFAULT_IGNORE
  const maxFiles = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : Infinity
  const maxDepth = Number.isFinite(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : Infinity
  // 传 memoryDir 名即开启「嵌套根不重复索引」：子目录自带 store 时不再往下走。
  // 理由是跟解析规则保持一致——`findProjectRoot()` 对子树里的文件返回的正是那个子根，
  // 扫描也该同意这一点；否则父根会把子项目的全部内容再存一份（实测一个父目录
  // 的 store 里 9075/9081 个文件是子根 store 的重复副本）。
  const nestedStoreName = opts.nestedStoreName || null
  // `roots.exclude` 是子树级前缀匹配：命中的目录整棵剪掉，命中的文件直接不收。
  const policy = isCompiledRootPolicy(opts.policy)
    ? opts.policy
    : isCompiledRootPolicy(opts.config)
      ? opts.config
      : opts.config ? compileRootPolicy(opts.config) : null
  const out = []
  const skipped = []
  const unreadable = []
  const stack = [[root, 0]]
  let capped = false
  let truncated = false
  let hitFileCap = false
  while (stack.length) {
    const [dir, depth] = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 读不到 ≠ 不存在。旧实现直接 continue，于是这片子树被当成"已删除"（调用方拿
      // seen 去清 unseen），而且失败是静默的。置 truncated 让调用方跳过清理。
      unreadable.push(dir)
      truncated = true
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ignoreNames.has(entry.name)) continue
        if (policy && excludedEntryForAbs(full, policy)) continue
        if (nestedStoreName && hasOwnStore(full, nestedStoreName)) {
          skipped.push(full)
          continue
        }
        if (depth + 1 > maxDepth) {
          truncated = true
          capped = true
          continue
        }
        stack.push([full, depth + 1])
      } else {
        if (policy && excludedEntryForAbs(full, policy)) continue
        if (out.length >= maxFiles) {
          truncated = true
          capped = true
          hitFileCap = true
          break
        }
        out.push(full)
      }
    }
    if (hitFileCap) break
  }
  out.sort()
  skipped.sort()
  unreadable.sort()
  return { files: out, truncated, capped, skipped, unreadable }
}

/**
 * git 工作区文件（已跟踪 + 未跟踪且未被忽略）；git 不可用/不是仓库时返回 null。
 * `--exclude-standard` 让嵌套 `.gitignore` 也生效，构建产物与内部文档不会再进语料。
 * @param {string} root 项目根
 * @returns {string[]|null} 仓库相对路径（`/` 分隔）
 */
function gitListedFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

/**
 * 项目文件清单：git 仓库走 `git ls-files`（尊重 `.gitignore` 与嵌套规则），
 * 非 git 目录回退 {@link walkDir}。返回形状与 walkDir 一致，调用方无需分支。
 * @param {string} root 项目根
 * @param {object} [opts] 同 walkDir，另加 `gitAware: false` 强制走 walkDir
 * @returns {{files: string[], truncated: boolean, capped: boolean, skipped: string[], unreadable: string[]}}
 */
export function listProjectFiles(root, opts = {}) {
  const policy = isCompiledRootPolicy(opts.policy)
    ? opts.policy
    : isCompiledRootPolicy(opts.config)
      ? opts.config
      : opts.config ? compileRootPolicy(opts.config) : null
  const listed = opts.gitAware === false ? null : gitListedFiles(root)
  if (listed === null) return walkDir(root, opts)
  const maxFiles = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : Infinity
  const maxDepth = Number.isFinite(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : Infinity
  const nestedName = opts.nestedStoreName || null
  const nested = nestedName
    ? nestedStoreRoots(root, nestedName).map((p) => relativePath(root, p))
    : []
  const files = []
  const skipped = new Set()
  let capped = false
  for (const raw of listed) {
    const rel = String(raw).split(path.sep).join('/')
    if (!rel) continue
    const segs = rel.split('/')
    if (segs.some((s) => DEFAULT_IGNORE.has(s))) continue
    const abs = path.join(root, rel)
    // 与 walkDir 同一判据：exclude 是子树级前缀，git 清单里的文件同样要过这一关。
    // 这一步必须在 maxDepth 之前：被排除文件不该把扫描标成 truncated（否则本轮
    // 不会清理"未见到的旧条目"，排除规则反而让旧索引留在盘上）。
    if (policy && excludedEntryForAbs(abs, policy)) continue
    if (segs.length > maxDepth) {
      capped = true
      continue
    }
    const under = nested.find((n) => rel === n || rel.startsWith(`${n}/`))
    if (under) {
      skipped.add(path.join(root, under))
      continue
    }
    if (files.length >= maxFiles) {
      capped = true
      break
    }
    try {
      if (!statSync(abs).isFile()) continue
    } catch {
      continue
    }
    files.push(abs)
  }
  files.sort()
  return { files, truncated: capped, capped, skipped: [...skipped].sort(), unreadable: [] }
}

/** 单个文件是否被 git 忽略（仅 git 仓库；非 git 目录返回 false）。 */
export function isGitIgnored(root, filePath) {
  if (!root || !filePath || !existsSync(path.join(root, '.git'))) return false
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', relativePath(root, filePath)], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
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

/**
 * `insight.files` 的写入期归一 —— 工具 schema 承诺的是「项目相对路径」，但此前**没有任何校验**：
 * 项目外的绝对路径会原样落盘，事后只能靠审计发现"查不到"（实测 144 处引用里 3 处项目外、
 * 6 处真悬空）。这里把承诺兑现成入口约束，而不是每次统计：
 *   - 非空字符串；反斜杠 → `/`；去掉 `./` 前缀；重复值合并；
 *   - **项目内**绝对路径 → 项目相对路径（`path.resolve` 判定，跨 OS 形态同样适用）；
 *   - 其余（项目外绝对、`..` 逃出根、没有根时无法判定的绝对路径）**丢弃**并回报 ——
 *     调用方负责把丢弃数量说出来，而不是静默少几行。
 * @param {unknown} files - 原始 files（工具参数 / 编辑表单）。
 * @param {string} root - 目标项目根（`save_lesson` 的 root 参数即权威）。
 * @returns {{files: string[], dropped: string[]}} 归一后的相对路径，以及被丢弃的原值。
 */
export function normalizeCitationFiles(files, root) {
  const kept = []
  const dropped = []
  const base = typeof root === 'string' && root.trim() ? path.resolve(root) : null
  for (const raw of Array.isArray(files) ? files : []) {
    if (typeof raw !== 'string') continue
    const value = raw.trim().replace(/\\/g, '/')
    if (!value) continue
    const looksAbsolute = value.startsWith('/') || /^[A-Za-z]:\//.test(value)
    if (base === null && looksAbsolute) {
      dropped.push(raw)
      continue
    }
    const abs = base === null ? null : path.resolve(base, looksAbsolute ? value : value.replace(/^\.\//, ''))
    let rel = value.replace(/^\.\//, '')
    if (abs !== null) {
      const inside = path.relative(base, abs)
      if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
        dropped.push(raw)
        continue
      }
      rel = inside.split(path.sep).join('/')
    }
    if (!rel || rel.startsWith('..')) {
      dropped.push(raw)
      continue
    }
    if (!kept.includes(rel)) kept.push(rel)
  }
  return { files: kept, dropped }
}

export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

export function storeKey(rel, platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' ? rel.toLowerCase() : rel
}

export function memoryRootFor(indexRoot, memoryDir) {
  return path.join(indexRoot, memoryDir)
}

/** store 目录名（配置项 `memoryDir`；调用方可能来自工具参数，缺省时兜底成默认值）。 */
export const DEFAULT_MEMORY_DIR = '.dsh-project-memory'

export function memoryDirName(config) {
  const raw = config?.memoryDir
  return typeof raw === 'string' && raw.trim() ? raw : DEFAULT_MEMORY_DIR
}

/**
 * 危险根目录：整体扫描/监听它们会直接吃满内存（issue #5 实测把 DSH 撑死的就是
 * 家目录与 `/opt/homebrew`）。判定是**精确匹配**：只拒绝这些目录**本身**，不拒绝
 * 它们的子目录（`~/Library` 拒绝，`~/Library/Mobile Documents/…/MyProj` 照常可用；
 * `/tmp` 拒绝，`/tmp/myproj` 照常可用）。
 *
 * 四类都在名单里：
 *   - 文件系统根（含 Windows 盘符根）；
 *   - 家目录及其所有祖先（`/Users`、`/home`、`/`），以及家目录下的系统型子目录；
 *   - 每用户私有临时目录与共享/系统临时目录（`/tmp`、`/var/tmp`、`%TEMP%`、
 *     `%SystemRoot%\Temp` …）——macOS 的 `os.tmpdir()` 是 `/var/folders/…/T`，共享的
 *     `/tmp` 是**另一个**路径，两者都要拒；
 *   - 系统/包管理器前缀（`/usr`、`/opt`、`/opt/homebrew`、`C:\Windows` …），按平台分组。
 */
function safeHomedir() {
  try {
    return os.homedir()
  } catch {
    return null
  }
}

/**
 * POSIX 的**共享/系统**临时目录。刻意与 `os.tmpdir()` 分开列：macOS 上 `os.tmpdir()` 是
 * `/var/folders/…/T` 这个每用户私有目录，共享的 `/tmp`（→ `/private/tmp`）根本不在名单里，
 * 于是 `cd /tmp && dsh` 仍会把整个 /tmp 当项目根——和家目录是同一类问题（issue #5 补充发现）。
 */
const POSIX_SHARED_TEMP = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', '/var/folders', '/dev/shm']

/**
 * 危险根集合（判定用，`isUnsafeRoot` 的底座）。
 *
 * 参数化是为了**能在任意平台上验证每个平台的分支**：测试用 `path.win32` 模拟 Windows，
 * 不必真的跑在 Windows 上（第一版正是因为只在 POSIX 分支里塞了 `/usr`、`/opt`，却拿它们
 * 去断言 Windows，CI 才红）。生产路径只调用无参形式。
 *
 * 系统前缀按平台分组是刻意的：`C:\opt`、`C:\usr` 在 Windows 上是**正常用户目录**，
 * 跨平台套用既会误伤，也会自相矛盾（`/usr/local` 被拒而 `/usr` 放行）。
 *
 * @returns {{ unsafe: Set<string>, sharedTemp: Set<string> }} `sharedTemp` 单独返回，只为了让
 *   拒绝文案能说清"是共享临时目录"而不是笼统的"系统目录"——两套集合由同一次调用产出，不会漂移。
 */
export function collectUnsafeRootSets({
  platform = process.platform,
  home = safeHomedir(),
  tmp = os.tmpdir(),
  env = process.env,
  pathApi = path,
} = {}) {
  const set = new Set()
  const sharedTemp = new Set()
  const push = (target) => (p) => {
    if (!p || typeof p !== 'string') return
    let abs
    try {
      abs = pathApi.resolve(p)
    } catch {
      return
    }
    target.add(storeKey(abs, platform))
  }
  const add = push(set)
  const addTemp = push(sharedTemp)

  // 每用户私有临时目录 + 共享/系统临时目录，都算"共享临时目录"（拒绝文案上同类）。
  addTemp(tmp)
  if (platform === 'win32') {
    addTemp(env.TEMP)
    addTemp(env.TMP)
    if (env.SystemRoot) addTemp(pathApi.join(env.SystemRoot, 'Temp'))
    if (env.windir) addTemp(pathApi.join(env.windir, 'Temp'))
  } else {
    for (const p of POSIX_SHARED_TEMP) addTemp(p)
  }
  for (const key of sharedTemp) set.add(key)

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
      add(dir)
      const parent = pathApi.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    for (const sub of platform === 'win32' ? ['AppData', 'Application Data'] : ['Library', 'Applications', '.Trash']) {
      add(pathApi.join(homeAbs, sub))
    }
  }

  if (platform === 'win32') {
    for (const name of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
      add(env[name])
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
      add(p)
    }
  }
  return { unsafe: set, sharedTemp }
}

/** 兼容入口：只要判定集合。 */
export function collectUnsafeRoots(opts) {
  return collectUnsafeRootSets(opts).unsafe
}

const UNSAFE = collectUnsafeRootSets()
const UNSAFE_DIRS = UNSAFE.unsafe
const SHARED_TEMP_DIRS = UNSAFE.sharedTemp

// ---------------------------------------------------------------------------
// 用户可配置的根名单（`roots.allow` / `roots.deny` / `roots.exclude`）。
//
// 三个字段的匹配口径刻意不同，别合并成一个：
//   - allow / deny：**精确匹配**，只针对目录本身。`deny: /srv/shared` 不拒绝
//     `/srv/shared/myproj`——它自己是一个合法项目根。
//   - exclude：**路径边界前缀匹配**，整棵子树都算。子树里的文件一律不进索引，
//     也不能在这棵子树里推出新的项目根。
//
// 优先级：exclude > deny > allow > 内置名单。`allowUnsafeRoots: true` 保留为兼容，
// 只放开**内置名单**；deny / exclude 仍然优先。文件系统根永远不能当根（allow 也不行）。
// ---------------------------------------------------------------------------

const ROOT_POLICY_FIELDS = ['allow', 'deny', 'exclude']

/** 每条告警只打一次：配置在进程内是静态的，重复刷屏没有信息量。 */
const warnedRootPolicyEntries = new Set()

function warnRootPolicyOnce(key, message, warn) {
  if (warnedRootPolicyEntries.has(key)) return
  warnedRootPolicyEntries.add(key)
  const log = typeof warn === 'function' ? warn : console.error
  log(`[dsh-project-memory] ${message}`)
}

function expandHomeEntry(value, home, pathApi) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return home ? pathApi.resolve(home, value.slice(2)) : null
  }
  return value
}

function normalizeRootPolicyEntries(list, field, { platform, pathApi, home, warn }) {
  const out = []
  if (list === undefined || list === null) return out
  if (!Array.isArray(list)) {
    warnRootPolicyOnce(
      `shape:${field}`,
      `config.roots.${field} must be an array of absolute paths; ignoring it.`,
      warn,
    )
    return out
  }
  for (const raw of list) {
    if (typeof raw !== 'string') {
      warnRootPolicyOnce(
        `type:${field}:${typeof raw}`,
        `config.roots.${field} contains a non-string entry; ignoring it (only absolute path strings are accepted).`,
        warn,
      )
      continue
    }
    const value = raw.trim()
    if (!value) continue
    const expanded = expandHomeEntry(value, home, pathApi)
    if (expanded === null) {
      warnRootPolicyOnce(
        `home:${field}:${value}`,
        `config.roots.${field} entry ${JSON.stringify(value)} cannot be expanded: the home directory is unavailable.`,
        warn,
      )
      continue
    }
    if (!pathApi.isAbsolute(expanded)) {
      warnRootPolicyOnce(
        `relative:${field}:${value}`,
        `config.roots.${field} entry ignored (not an absolute path): ${JSON.stringify(value)}. ` +
          'Relative paths would be resolved against the host cwd and are unpredictable; use an absolute path or ~/...',
        warn,
      )
      continue
    }
    let abs
    try {
      abs = pathApi.resolve(expanded)
    } catch {
      warnRootPolicyOnce(
        `resolve:${field}:${value}`,
        `config.roots.${field} entry ignored (cannot be resolved): ${JSON.stringify(value)}.`,
        warn,
      )
      continue
    }
    out.push({ abs, key: storeKey(abs, platform), raw: value })
  }
  return out
}

function isCompiledRootPolicy(value) {
  return Boolean(value && typeof value === 'object' && value.__rootPolicy === true)
}

/**
 * 把插件 config 编译成一份可复用的根判定策略。
 *
 * 参数化（platform / pathApi / home / env）是为了在任意平台上验证 Windows 语义，
 * 与 `collectUnsafeRootSets()` 的测试惯例一致；生产路径只用无参形式。
 *
 * @param {object} [config] 插件 config（只读 `config.roots` 与 `config.allowUnsafeRoots`）
 * @param {{platform?: string, pathApi?: object, home?: string|null, env?: object, warn?: Function,
 *   allowUnsafe?: boolean, unsafeDirs?: Set<string>, sharedTemp?: Set<string>}} [opts]
 * @returns {object} 策略对象（内部结构，调用方应通过 rootRejection/isUnsafeRoot/isExcludedPath 使用）
 */
export function compileRootPolicy(config, opts = {}) {
  const platform = opts.platform || process.platform
  const pathApi = opts.pathApi || path
  const home = Object.prototype.hasOwnProperty.call(opts, 'home') ? opts.home : safeHomedir()
  const warn = opts.warn
  const rawRoots = config && typeof config === 'object' ? config.roots : undefined
  const roots = rawRoots && typeof rawRoots === 'object' && !Array.isArray(rawRoots) ? rawRoots : {}
  if (rawRoots !== undefined && (typeof rawRoots !== 'object' || rawRoots === null || Array.isArray(rawRoots))) {
    warnRootPolicyOnce(
      'shape:roots',
      'config.roots must be an object with `allow` / `deny` / `exclude` arrays; ignoring it.',
      warn,
    )
  }

  const entries = {}
  for (const field of ROOT_POLICY_FIELDS) {
    entries[field] = normalizeRootPolicyEntries(roots[field], field, { platform, pathApi, home, warn })
  }

  let builtin = opts.unsafeDirs || null
  let sharedTemp = opts.sharedTemp || null
  if (!builtin || !sharedTemp) {
    // 只有"完全没传模拟参数"时才复用模块级集合。只要显式给了 platform / pathApi /
    // home / tmp / env 中的任一个，就按这些参数重算——否则在 Linux 上模拟 Windows
    // 或换一个 home 时，内置名单会悄悄沿用当前机器的那一份。
    const simulated = ['platform', 'pathApi', 'home', 'tmp', 'env'].some((key) =>
      Object.prototype.hasOwnProperty.call(opts, key),
    )
    if (!simulated && platform === process.platform) {
      builtin = builtin || UNSAFE_DIRS
      sharedTemp = sharedTemp || SHARED_TEMP_DIRS
    } else {
      const sets = collectUnsafeRootSets({
        platform,
        home,
        tmp: Object.prototype.hasOwnProperty.call(opts, 'tmp') ? opts.tmp : os.tmpdir(),
        env: opts.env || process.env,
        pathApi,
      })
      builtin = builtin || sets.unsafe
      sharedTemp = sharedTemp || sets.sharedTemp
    }
  }

  const allowEntries = new Map(entries.allow.map((e) => [e.key, e.raw]))
  const denyEntries = new Map(entries.deny.map((e) => [e.key, e.raw]))
  return {
    __rootPolicy: true,
    platform,
    pathApi,
    home,
    allowUnsafeRoots: config?.allowUnsafeRoots === true || opts.allowUnsafe === true,
    allow: new Set(allowEntries.keys()),
    deny: new Set(denyEntries.keys()),
    exclude: entries.exclude,
    allowEntries,
    denyEntries,
    builtin,
    sharedTemp,
  }
}

function policyFor(configOrPolicy, opts) {
  if (isCompiledRootPolicy(configOrPolicy)) return configOrPolicy
  return compileRootPolicy(configOrPolicy, opts)
}

/** `parent` 是否等于 `child` 或它的祖先（按路径分隔符，含子树）。 */
function isInsideKey(parentKey, childKey, sep) {
  if (parentKey === childKey) return true
  const prefix = parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`
  return childKey.startsWith(prefix)
}

function excludedEntryForAbs(abs, policy) {
  if (!policy.exclude.length) return null
  let absResolved
  try {
    absResolved = policy.pathApi.resolve(abs)
  } catch {
    return null
  }
  const key = storeKey(absResolved, policy.platform)
  for (const entry of policy.exclude) {
    if (isInsideKey(entry.key, key, policy.pathApi.sep)) return entry
  }
  return null
}

/**
 * 某个文件/目录是否落在 `roots.exclude` 的子树里。
 * @returns {{abs: string, key: string, raw: string}|null} 命中的条目（用于报告），否则 null
 */
export function excludedEntryForPath(filePath, configOrPolicy, opts) {
  if (typeof filePath !== 'string' || !filePath) return null
  const policy = policyFor(configOrPolicy, opts)
  let abs
  try {
    abs = policy.pathApi.resolve(filePath)
  } catch {
    return null
  }
  return excludedEntryForAbs(abs, policy)
}

/** 文案用的「为什么是它」。 */
function unsafeReason(abs, policy = {}) {
  const platform = policy.platform || process.platform
  const pathApi = policy.pathApi || path
  const key = storeKey(abs, platform)
  const parsed = pathApi.parse(abs)
  if (key === storeKey(parsed.root, platform)) return 'the filesystem root'
  if (policy.home) {
    try {
      if (key === storeKey(pathApi.resolve(policy.home), platform)) return 'your home directory'
    } catch {
      // 家目录不可解析：继续按临时/系统目录归类
    }
  } else {
    try {
      if (key === storeKey(path.resolve(os.homedir()), platform)) return 'your home directory'
    } catch {
      // 同上
    }
  }
  const shared = policy.sharedTemp || SHARED_TEMP_DIRS
  if (shared.has(key)) return 'the shared temp directory'
  return 'a system directory that is never a project root'
}

/**
 * 根判定的**唯一实现**：返回 null（可用）或一条命中记录。
 *
 * 命中记录带 `kind` / `field` / `entry` / `reason`，调用方据此生成"是哪条命中的、
 * 该改哪个字段"的拒绝文案。优先级在这里一眼可见：exclude → deny → 内置（allow
 * 与 allowUnsafeRoots 只作用于内置名单）→ 文件系统根永远拒绝。
 *
 * @param {string} root 候选根
 * @param {object} [configOrPolicy] 插件 config，或 `compileRootPolicy()` 的返回值
 */
export function rootRejection(root, configOrPolicy, opts) {
  const policy = policyFor(configOrPolicy, opts)
  if (typeof root !== 'string' || !root) {
    return { kind: 'invalid', field: null, entry: null, reason: 'not a usable directory path' }
  }
  let abs
  try {
    abs = policy.pathApi.resolve(root)
  } catch {
    return { kind: 'invalid', field: null, entry: null, reason: 'not a usable directory path' }
  }
  const platform = policy.platform
  const key = storeKey(abs, platform)
  const parsed = policy.pathApi.parse(abs)
  if (!parsed.dir || key === storeKey(parsed.root, platform)) {
    return { kind: 'filesystem-root', abs, field: null, entry: null, reason: 'the filesystem root' }
  }
  const excluded = excludedEntryForAbs(abs, policy)
  if (excluded) {
    return {
      kind: 'exclude',
      abs,
      field: 'roots.exclude',
      entry: excluded.raw,
      reason: `inside the subtree excluded by ${JSON.stringify(excluded.raw)}`,
    }
  }
  if (policy.deny.has(key)) {
    return {
      kind: 'deny',
      abs,
      field: 'roots.deny',
      entry: policy.denyEntries.get(key) || null,
      reason: 'listed in roots.deny',
    }
  }
  if (policy.builtin.has(key) && !policy.allowUnsafeRoots && !policy.allow.has(key)) {
    return { kind: 'builtin', abs, field: 'roots.allow', entry: null, reason: unsafeReason(abs, policy) }
  }
  return null
}

/** 这个目录能否当项目记忆根？纯判定，无副作用。 */
export function isUnsafeRoot(root, configOrPolicy, opts) {
  return rootRejection(root, configOrPolicy, opts) !== null
}

const CONFIG_LOCATION = 'under `- id: project-memory` → `config:`'

/** 把命中记录变成一句可执行的拒绝文案。 */
function rootRejectionMessage(target, rejection) {
  const head = `Refusing to use ${target} as a project memory root: `
  switch (rejection.kind) {
    case 'filesystem-root':
      return (
        head +
        'it is the filesystem root. That can never be a project memory root; pass a project directory instead.'
      )
    case 'exclude':
      return (
        head +
        `it is inside the subtree excluded by \`roots.exclude\` entry ${JSON.stringify(rejection.entry)}. ` +
        `Remove that entry from \`config.roots.exclude\` ${CONFIG_LOCATION} if this directory should be a root.`
      )
    case 'deny':
      return (
        head +
        `it is listed in \`roots.deny\`${rejection.entry ? ` as ${JSON.stringify(rejection.entry)}` : ''}. ` +
        `Remove that entry from \`config.roots.deny\` ${CONFIG_LOCATION} to allow it.`
      )
    case 'builtin':
      return (
        head +
        `it is ${rejection.reason}, a built-in protected root. Indexing or watching it would walk the whole ` +
        'directory tree (hundreds of thousands of files) and exhaust memory. Pass a project directory instead, ' +
        `or add this exact directory to \`config.roots.allow\` ${CONFIG_LOCATION} if you really mean it ` +
        '(or set `allowUnsafeRoots: true` to allow every built-in protected directory).'
      )
    default:
      return head + `${rejection.reason}. Pass an absolute project directory instead.`
  }
}

export class UnsafeRootError extends Error {
  constructor(root, requested, options = {}) {
    const target = requested && String(requested).trim() ? String(requested) : String(root)
    const rejection = options.rejection || rootRejection(root, options.config)
    super(rootRejectionMessage(target, rejection))
    this.name = 'UnsafeRootError'
    this.root = root
    this.code = rejection.kind
    this.kind = rejection.kind
    this.reason = rejection.reason
    this.field = rejection.field
    this.entry = rejection.entry
  }
}

/**
 * 校验「这个根可以当项目记忆根」。所有把目录当根写盘的入口都必须先过这一关：
 * 写盘前拒绝，比事后清理 `.dsh-project-memory` 便宜得多。
 *
 * `allowUnsafe` 是旧的内部兼容参数，语义等同 `allowUnsafeRoots: true`——只放开内置
 * 名单，绝不会越过 `roots.deny` / `roots.exclude`。
 */
export function assertSafeRoot(root, { requested = root, allowUnsafe = false, config } = {}) {
  const policy = isCompiledRootPolicy(config)
    ? (allowUnsafe && !config.allowUnsafeRoots ? { ...config, allowUnsafeRoots: true } : config)
    : compileRootPolicy(config, { allowUnsafe })
  const rejection = rootRejection(root, policy)
  if (!rejection) return root
  throw new UnsafeRootError(root, requested, { rejection })
}

export function resolveIndexRoot(exec, explicitRoot) {
  if (explicitRoot && explicitRoot.trim()) return path.resolve(explicitRoot)
  // 会话当前工作目录：0.2.1+ 读 workingDirectory 投影（cd 后会变），老宿主回退 header.cwd。
  const sessionCwd = sessionWorkingDir(exec?.agent?.session, { agent: exec?.agent })
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

/**
 * 自底向上找最近的根标记。**一次遍历同时看 VCS 与 PROJECT**，语义仍是"VCS 优先于 PROJECT"：
 * 先命中的 VCS 直接返回（它一定是最深的）；没有 VCS 就返回最深的 PROJECT。
 *
 * 为什么合并：旧实现对两组标记各走一遍祖先链，每层还要对每个 marker 做一次 existsSync。
 * 11 个 marker × 7 层 × 2 组在 WSL/NTFS 上实测 ~119ms/次——而每次懒索引都要走一遍。
 * 现在每层只 readdir 一次（同时拿到所有名字），遍历也只走一趟。
 */
function nearestRootByMarkers(absPath, vcsMarkers, projectMarkers, isUnsafe) {
  let project = null
  let dir = path.dirname(absPath)
  for (;;) {
    // 撞到家目录/系统目录边界就停：既不把边界当根，也不再向上（上面只会更宽）。
    // 已经记录的 PROJECT 命中仍然有效——它就在边界下方；丢掉它会退化成"会话根"兜底。
    if (isUnsafe(dir)) return project
    let names = null
    try {
      names = new Set(readdirSync(dir))
    } catch {
      names = null
    }
    if (names) {
      if (vcsMarkers.some((marker) => names.has(marker))) return dir
      if (!project && projectMarkers.some((marker) => names.has(marker))) project = dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return project
    dir = parent
  }
}

/**
 * 项目根推导（**只认标记与显式声明，绝不从文件路径兜底**）。
 *
 * `roots.exclude` 在这条链路里是最强的否定：文件落在被排除的子树里 → 直接 null，
 * 不再向上找标记，也不会退回会话工作目录（那棵树本来就不该进任何索引）。
 *
 * @param {string} filePath 目标文件（也接受目录内探针文件路径）
 * @param {{ extraRoots?: Iterable<string>, sessionRoot?: string|null, isUnsafe?: (dir: string) => boolean,
 *   config?: object, policy?: object }} [opts]
 *   `extraRoots`：显式登记过的根（watch_repo / watchManager）。
 *   `sessionRoot`：会话工作目录，作为**最后**一级推定——仅当文件确实在它里面、
 *   且它是安全目录时采用。
 *   `config`：插件 config；`roots.deny` / `roots.exclude` / `roots.allow` 由此生效。
 *   `isUnsafe`：危险根判定，默认 `isUnsafeRoot`。可注入是为了让"被拒前缀里有一个合法
 *   `.git`"这条反直觉输入能在任意平台上用一个临时目录复现（`/opt/homebrew` 正是被
 *   `.git` 主动选中的，不是兜底误判——issue #5 的现场复核结论）。
 * @returns {string|null}
 */
export function findProjectRoot(filePath, opts = {}) {
  if (typeof filePath !== 'string' || !filePath) return null
  const policy = isCompiledRootPolicy(opts.policy)
    ? opts.policy
    : isCompiledRootPolicy(opts.config)
      ? opts.config
      : compileRootPolicy(opts.config, { allowUnsafe: opts.allowUnsafe === true })
  const isUnsafe = typeof opts.isUnsafe === 'function'
    ? opts.isUnsafe
    : (dir) => rootRejection(dir, policy) !== null
  let abs
  try {
    abs = path.resolve(filePath)
  } catch {
    return null
  }
  if (excludedEntryForAbs(abs, policy)) return null
  const explicit = longestRootContaining(opts.extraRoots || [], abs)
  if (explicit) return isUnsafe(explicit) ? null : explicit

  // 标记优先于会话根兜底；VCS 优先于 PROJECT（"a marker above the cwd still wins" 是既有契约）。
  const byMarker = nearestRootByMarkers(abs, VCS_MARKERS, PROJECT_MARKERS, isUnsafe)
  if (byMarker) return byMarker

  const session = resolveDir(opts.sessionRoot)
  if (session && !isUnsafe(session) && isInside(session, abs)) return session
  return null
}

/**
 * **会话记忆根**：本插件所有"这个会话的记忆放哪"的唯一答案。
 * 声明优先（标记）→ 会话工作目录（安全时）→ null（家目录/系统目录，且没有标记）。
 * `config` 里的 `roots.*` 与 `allowUnsafeRoots` 与工具侧共用同一套判定。
 */
export function resolveProjectMemoryRoot(cwd, config) {
  const base = resolveDir(cwd) || resolveDir(process.cwd())
  if (!base) return null
  return findProjectRoot(path.join(base, PROJECT_PROBE), { sessionRoot: base, config })
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
    return assertSafeRoot(path.resolve(explicit), { requested: explicit, allowUnsafe, config })
  }
  const cwd = resolveIndexRoot(exec)
  const root = resolveProjectMemoryRoot(cwd, config)
  if (root) return root
  // allowUnsafeRoots 只放开内置名单；cwd 被 deny / exclude / 文件系统根命中时仍然拒绝。
  if (allowUnsafe && !rootRejection(cwd, config)) return cwd
  throw new UnsafeRootError(cwd, cwd, { config })
}

/** 尽力而为的会话记忆根：拿不到就返回 null（用于审计镜像这类旁路，不抛错）。 */
export function sessionMemoryRootOrNull(exec, config) {
  try {
    return resolveSafeIndexRoot(exec, null, config)
  } catch {
    return null
  }
}