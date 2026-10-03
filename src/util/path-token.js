/**
 * 路径 token 抽取（纯函数、零依赖，readiness 与 ops 共用）。
 *
 * 为什么会有这个模块：同一套规则原先在 `readiness.js`（抽人类消息/工具参数里的路径）与
 * `ops.js`（抽 shell 命令的写目标）里各抄了一份，而 `ops.js` 那份的注释写着
 * 「与 readiness.extractPaths 同规则」—— 其实不是：它只抄了「带扩展名的路径」，
 * 漏掉了「点开头的裸文件名」（`.gitignore` / `.npmrc` / `.env`）。
 *
 * 后果不是文案问题：`ops.targets` 正是 `when.writes` 的匹配面，于是
 * `rm -f .gitignore` 在 ops 侧抽不出写目标（实测 targets=[]），一条明确写了
 * `writes: ['.gitignore']` 的教训被静默漏召 —— 注释还在替这份漂移担保。
 * 收敛到这里，只保留一个事实，两个调用方拿到的是同一份结果。
 *
 * 规则（两类 token，先「带扩展名」后「点开头」，各自按出现顺序去重）：
 *   1. 带扩展名的路径：`src/util/fs.js`、`README.md`、`.env.bak`（点算普通字符）；
 *   2. 点开头的裸文件名：只认 token 起始处（行首 / 空白 / 引号 / 左括号之后）的 `.xxx`
 *      —— `src/.env` 这类中缀点文件名没有扩展名可依，与普通点号无法区分，不在规则内；
 *      调用方若已知道完整路径，应直接并入，而不是指望从文本里猜。
 *
 * 只导出函数、不导出正则：全局正则一旦被 `.test()`/`.exec()` 用过就带 `lastIndex` 状态，
 * 共享出去等于把「顺序敏感」的坑一起共享。`matchAll` 内部克隆正则，这里无状态。
 * @module dsh-project-memory/util/path-token
 */

const PATH_TOKEN = /(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g
const DOTFILE_TOKEN = /(?:^|[\s"'`(])(\.[A-Za-z0-9_-]{2,})/g

/**
 * 文本 → 路径 token（去重、顺序确定、无副作用）。
 * @param {unknown} text - 工具调用参数、人类消息或 shell 命令。
 * @returns {string[]} 去重后的路径 token；空/缺失输入返回 `[]`。
 */
export function extractPathTokens(text) {
  const s = String(text || '')
  if (!s) return []
  const out = new Set()
  for (const m of s.matchAll(PATH_TOKEN)) out.add(m[0])
  for (const m of s.matchAll(DOTFILE_TOKEN)) out.add(m[1])
  return [...out]
}
