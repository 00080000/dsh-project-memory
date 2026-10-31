import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { listProjectFiles, memoryDirName, memoryRootFor, relativePath, rootRejection, scanLimits, storeKey } from './util/fs.js'
import { OVERSIZE, UNCHANGED, commitFileUpdates, fileKind, planFileIndex, toFileUpdate } from './index-pipeline.js'
import { ProjectMemoryStore } from './store.js'
import { onFileChanged, isTypeScriptFile } from './enhancer.js'
import { cfgValue } from './util/config.js'

/**
 * 把 `watch` / `watchInterval` 的**当前值**落到轮询器上。
 *
 * 这两个键是 volatile 字段：设置页保存后宿主会发 `loader/volatile-update`，插件不重启，
 * 由这里按新值重排定时器。stop() 对没启动过的实例是空操作；start() 会按新间隔重算
 * base/backoff/active 三个节拍。抽成函数是为了让"关掉后没有定时器、打开后按新间隔起"
 * 这条契约可以被单测直接钉住（否则它只存在于 apply 的闭包里）。
 * @param {WatchManager} watchManager 轮询器
 * @param {object} config 插件 Config（volatile 字段是 ref）
 * @returns {boolean} 当前是否在轮询
 */
export function applyWatchSettings(watchManager, config) {
  watchManager.stop()
  if (cfgValue(config, 'watch') === false) return false
  watchManager.start(Number(cfgValue(config, 'watchInterval')) * 1000)
  return true
}

/**
 * 有界并发 map。同步 `statSync` 循环在 Windows（尤其 WSL 挂 `/mnt/c`）会把事件循环卡住：
 * 400 文件实测 ~0.9s、12k 文件按同一比例是几十秒，期间面板与工具调用全部停摆。
 * 改用 `fs/promises.stat` + 16 并发：总量不变，主线程等 I/O 时可以让出去。
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

export class WatchManager {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.roots = new Map()
    this.timer = null
    this._polling = false
    this._truncationWarned = new Set()
    /** 已就「读不到的目录」告警过的根，只提示一次。 */
    this._unreadableWarned = new Set()
    /** 已就「跳过了嵌套项目根」告警过的根，只提示一次。 */
    this._nestedStoreWarned = new Set()
    /** 正在跑回合的会话 id 集合：**多会话**下任一在跑就算活跃（见 setSessionActive）。 */
    this._activeSessions = new Set()
    this._active = false
    this._activeInterval = undefined
  }

  /** 包含该路径的已注册根（最长前缀）：懒索引据此把文件归到显式 watch 过的无标记项目里。 */
  rootContaining(absPath) {
    let best = null
    for (const root of this.roots.keys()) {
      const rel = path.relative(root, absPath)
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue
      if (!best || root.length > best.length) best = root
    }
    return best
  }

  /** 危险根是否被显式放行（兼容旧调用点；判定统一走 rootRejection，deny/exclude 仍优先）。 */
  unsafeAllowed() {
    return this.config?.allowUnsafeRoots === true
  }

  restorePersisted() {
    const cwd = process.cwd()
    // cwd 是家目录/系统目录时直接跳过：必须「先判断再 load」，否则遗留的超大 store 光读盘就能 OOM。
    if (rootRejection(cwd, this.config)) return
    // 用 load() 的返回值：storeCache 命中时返回的是缓存实例，忽略它会拿到空 store。
    const store = new ProjectMemoryStore(memoryRootFor(cwd, this.config.memoryDir)).load()
    if (existsSync(store.dir)) {
      let dropped = 0
      for (const root of [...store.watchlist]) {
        if (typeof root !== 'string' || !root) continue
        // 自愈剔除两类条目：已不存在的根（每轮白跑，还会把目录重新 mkdir 出来），
        // 以及按当前配置不能整体监听的根。下一次启动自动摘掉，不需要用户手删 watch.json。
        if (!existsSync(root) || rootRejection(root, this.config)) {
          store.removeWatch(root)
          dropped++
          continue
        }
        // 文件路径（历史遗留 / 手改 watch.json）也摘掉：addRoot 现在只接受目录。
        if (!this.addRoot(root) && !this.roots.has(root)) {
          store.removeWatch(root)
          dropped++
        }
      }
      if (dropped) store.save()
    }
  }

  addRoot(root) {
    // 根目录不存在就拒绝：否则每轮 poll 的 commit → save → mkdirSync 会把它重新「创建」出来。
    if (!existsSync(root)) return false
    // 文件不是可轮询的根：readdir/listProjectFiles 会每轮失败，持久化后还会在启动时反复自愈。
    try {
      if (!statSync(root).isDirectory()) return false
    } catch {
      return false
    }
    // 文件系统根 / 家目录 / 系统前缀 / roots.deny / roots.exclude 不整体监听（子目录允许），
    // 除非配置显式放行（仅内置名单可放行）。
    if (rootRejection(root, this.config)) return false
    if (!this.roots.has(root)) {
      // **不在这里 load()**：`restorePersisted()` 会对整条 watchlist 逐个 addRoot，急切读盘等于
      // 「watch 过多少个根，启动就同步读多少个 store 的全部 shard」。store 到 pollRoot 需要时才取。
      this.roots.set(root, {
        snapshot: {},
        // rel → 上次已上报的错误。坏文件每轮都会重试，逐轮打印会刷屏。
        failures: new Map(),
      })
      return true
    }
    return false
  }

  /**
   * 每个根**按需**取 store（命中 `storeCache` 即 O(1)）。本类不长期持有实例：否则逐出对 watch
   * 根不省内存，真被逐出后 `load()` 还会再建一份，同一 root 出现两份互不可见的状态。内存上界
   * 因此回到 `STORE_CACHE_MAX_BYTES`，不由「watch 了多少个根」决定。
   */
  storeFor(root) {
    return new ProjectMemoryStore(memoryRootFor(root, this.config.memoryDir)).load()
  }

  removeRoot(root) {
    return this.roots.delete(root)
  }

  start(intervalMs = 30000) {
    // 非法值（NaN/undefined）会让定时器退化成 1ms 轮询打满事件循环，故回退默认 30s。
    const raw = Number(intervalMs)
    this._baseInterval = Number.isFinite(raw) ? Math.max(raw, 1000) : 30000
    // 空闲退避：连续没有变化的轮次把间隔翻倍，最长 2 分钟一轮；任何变化立刻回到 base。
    // 轮询是 O(树) 的 walkDir + 逐文件 stat（本仓库一轮实测 58–87ms），常驻 15s 一轮都在磨 I/O。
    this._maxInterval = Math.max(this._baseInterval, Math.min(this._baseInterval * 8, 120000))
    // 活跃兜底：**有人正在跑回合**时把节拍压到最低（默认 5 分钟、且不小于 base 的 10 倍）。
    // 不是"永不扫描"——外部编辑器改文件、或回合一直不结束（崩溃/长任务）时索引仍会自愈。
    this._activeInterval = Math.max(this._baseInterval * 10, 300000)
    this._interval = this._baseInterval
    // 复位必须在 guard 之前：设置页保存走 stop() → start()，而 stop() 会把 _stopped 置 true。
    // 如果轮询正在进行（_polling=true），这里的提前返回会留下 _stopped=true，那一轮 _tick() 收尾时
    // 看到"已停止"就不再排下一轮——watch 永久停摆，且 applyWatchSettings() 还返回 true。
    // 在飞的一轮结束时 _tick() 会按新的 _baseInterval/_activeInterval 续上。
    this._stopped = false
    // 轮询进行中 `timer` 会短暂为 null；此时再 start 会排第二个定时器。等这一轮结束由 `_tick()` 自己续。
    if (this.timer || this._polling) return
    this._schedule()
  }

  /**
   * 会话活跃信号：有会话在跑就把轮询压到最低，**回合结束立刻合并扫一次**。
   * 轮询是唯一"用户没在等、却仍在花机器"的地方，扫描时机恰好最不该抢 CPU；活跃期间的
   * 真实改动由下一轮兜底（≤ activeInterval 覆盖），回合结束一次性并入。
   * @param key - 会话标识（`session.id`）；多会话下任一活跃即活跃。
   * @param active - 该会话是否正在跑回合。
   */
  setSessionActive(key, active) {
    const id = String(key)
    if (active) this._activeSessions.add(id)
    else this._activeSessions.delete(id)
    const next = this._activeSessions.size > 0
    if (next === this._active) return
    this._active = next
    // 没 start()（watch: false）或已 stop()：只记状态，不碰定时器。
    if (this._stopped || this._activeInterval === undefined) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (next) {
      this._interval = this._activeInterval
      this._schedule(this._activeInterval)
    } else if (!this._polling) {
      // 回合结束：立刻补扫，然后回到常规节拍。
      // 如果已经有一轮 poll 在跑，不要在这里再起一轮：`poll()` 的 reentry guard 会把它当成
      // "本轮无变化"（返回 false），`_tick()` 于是按无变化把间隔翻倍；在飞那轮真正结束时
      // 又因为定时器已存在而降不回 base——回合结束的补扫被推迟到退避间隔之后。
      void this._tick()
    }
  }

  _schedule(interval = this._interval) {
    if (this._stopped || this.timer) return
    this.timer = setTimeout(() => this._tick(), interval)
    if (this.timer.unref) this.timer.unref()
  }

  async _tick() {
    this.timer = null
    // stop() 之后若还有定时器已经触发，不能再扫一轮。
    if (this._stopped) return
    let changed = false
    try {
      changed = await this.poll()
    } catch {
      // poll() 内部已逐根兜底；这里保证无论发生什么都一定排下一轮，不会静默停掉 watch。
    }
    if (this._stopped) return // 轮询期间被 stop() 了，不要再排下一轮
    this._interval = this._active
      ? this._activeInterval
      : changed ? this._baseInterval : Math.min(this._interval * 2, this._maxInterval)
    // poll 期间可能已排过下一轮；有就不再覆盖，否则旧句柄泄漏、轮询频率翻倍。
    if (!this.timer) this._schedule()
  }

  stop() {
    this._stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async poll() {
    // 慢轮询期间再次进入直接跳过（递归 setTimeout 下正常不会叠加，保留作防御）。
    if (this._polling) return false
    this._polling = true
    let changed = false
    try {
      for (const [root, state] of this.roots) {
        try {
          if (await this.pollRoot(root, state)) changed = true
        } catch (err) {
          console.error(`[dsh-project-memory] watch poll failed for ${root}: ${err.message}`)
        }
      }
    } finally {
      this._polling = false
    }
    return changed
  }

  async pollRoot(root, state) {
    const seen = new Set()
    const updates = []
    // rel → 本轮采集的 mtime:size。提交成功后才落进快照；CAS 失败的条目下轮重试。
    const signatures = new Map()
    // 本轮用的 store：命中缓存即 O(1)，被逐出则重新读盘。整个 pollRoot 期间共用这一个实例。
    const store = this.storeFor(root)

    const { files, truncated, capped, skipped: nestedRoots, unreadable } = listProjectFiles(root, {
      ...scanLimits(this.config),
      nestedStoreName: memoryDirName(this.config),
      config: this.config,
    })
    if (nestedRoots.length && !this._nestedStoreWarned.has(root)) {
      // 只提示一次：说明它们的旧副本会被本轮清掉。
      this._nestedStoreWarned.add(root)
      const rels = nestedRoots.map((p) => storeKey(relativePath(root, p)))
      console.error(
        `[dsh-project-memory] watch of ${root} skips nested project root(s) with their own store: ${rels.join(', ')}; ` +
          'their content is refreshed by their own root, and any duplicate copy previously indexed here is being removed.',
      )
    }
    if (unreadable.length && !this._unreadableWarned.has(root)) {
      // 读不到 ≠ 已删除：本轮跳过快照清理（见下方 unseen），既有条目原样保留。只提示一次。
      this._unreadableWarned.add(root)
      const rels = unreadable.map((p) => storeKey(relativePath(root, p)))
      console.error(
        `[dsh-project-memory] watch of ${root} could not read ${unreadable.length} director${unreadable.length === 1 ? 'y' : 'ies'} ` +
          `(${rels.join(', ')}); they are skipped and nothing under them is treated as deleted.`,
      )
    }
    if (capped && !this._truncationWarned.has(root)) {
      // 只提示一次：这是一条**永久**的降级说明，不是每轮都要刷屏的故障。
      this._truncationWarned.add(root)
      const { maxFiles, maxDepth } = scanLimits(this.config)
      console.error(
        `[dsh-project-memory] watch scan of ${root} hit the limit (maxFiles=${maxFiles}, maxDepth=${maxDepth}); ` +
          'only part of the tree is refreshed. Raise maxScanFiles/maxScanDepth if this project is legitimately that large.',
      )
    }

    // 先把元数据并发取回来；解析仍按顺序，解析量只与"变了的文件"有关。
    const statsByIndex = await mapLimit(files, 16, async (filePath) => {
      try {
        return await stat(filePath)
      } catch {
        return null
      }
    })
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const filePath = files[fileIndex]
      const rel = storeKey(relativePath(root, filePath))
      seen.add(rel)
      const kind = fileKind(path.extname(filePath).toLowerCase())
      if (!kind) continue

      const stats = statsByIndex[fileIndex]
      if (!stats) continue
      const sig = `${stats.mtimeMs}:${stats.size}`
      if (state.snapshot[rel] === sig) continue

      const record = store.fileRecord(rel)
      let plan
      try {
        plan = await planFileIndex({
          rel,
          filePath,
          kind,
          config: this.config,
          record,
          existingEntries: store.entries[rel],
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        })
      } catch (err) {
        // 坏文件每轮都会重试：同一个文件的同一个错误只上报一次，否则逐轮刷屏。
        if (state.failures.get(rel) !== err.message) {
          state.failures.set(rel, err.message)
          console.error(`[dsh-project-memory] re-index failed for ${rel}: ${err.message}`)
        }
        continue
      }
      state.failures.delete(rel)
      // 内容未变 / 体积超限也要落快照：否则 mtime:size 快路径永远命中不了，每次 poll 都要重读全仓。
      if (plan.key === UNCHANGED || plan.key === OVERSIZE) {
        // 内容没变、只有 mtime 变了：把新 mtime 写回条目，让下一轮（及其它入口）的快路径能命中。
        if (plan.key === UNCHANGED && typeof plan.mtimeMs === 'number') store.refreshMtime(rel, plan.mtimeMs)
        state.snapshot[rel] = sig
        continue
      }

      signatures.set(rel, sig)
      updates.push(toFileUpdate(rel, plan, record))
    }

    // 单事务写盘；CAS 失败的条目本轮不落快照，下一轮重试。
    // 截断时**不传 unseen**：没扫到的文件不等于被删了，否则被上限截掉的树每轮都会删掉自己
    // 一半记忆（先删再重新索引，纯粹的抖动）。`truncated` 同样覆盖"有目录读不到"（EACCES）。
    const { stale, removed } = commitFileUpdates(store, {
      updates,
      unseen: truncated ? null : seen,
      root,
    })
    // 扫全了才剪快照：删掉的文件不能留着，否则它以同样的 mtime:size 回来会被当成未变。
    if (!truncated) {
      for (const rel of Object.keys(state.snapshot)) if (!seen.has(rel)) delete state.snapshot[rel]
      for (const rel of state.failures.keys()) if (!seen.has(rel)) state.failures.delete(rel)
    }
    const failed = new Set(stale)
    let applied = 0
    for (const update of updates) {
      if (failed.has(update.rel)) continue
      applied++
      state.snapshot[update.rel] = signatures.get(update.rel)
      if (update.type !== 'code') continue
      const filePath = path.join(root, update.rel)
      if (isTypeScriptFile(filePath)) {
        onFileChanged(store, update.rel, filePath, this.config, root)
      }
    }
    // 有变化 → 下一轮回到 base 间隔；纯空转 → 退避。
    return applied > 0 || removed > 0
  }
}