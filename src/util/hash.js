import { createHash } from 'node:crypto'

/**
 * 短哈希（8 位十六进制）：项目标识、任务 id 里够用，也不把完整摘要塞进 id。
 * 单独成模块是为了让纯映射/纯函数（如 setup/team-task.js）不必为了一个哈希去 import
 * 会拉进 store 的 taskbridge —— 以后在命令层复用映射时不会顺带把持久层拖进来。
 * @param {unknown} text
 * @returns {string}
 */
export function hash8(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 8)
}
