/**
 * client 半边唯一的「按宿主语言取翻译函数」入口。
 *
 * 为什么单独一个模块：同一段「软读 locale 服务 → 中文用 zh、其余（含服务缺失）用 en →
 * createTranslate」原先在 TaskPanel.tsx（getT）与 slash.ts（translator）各写一份。
 * 语言判据是产品语义而不是某次渲染的局部细节：两份副本各自演化时，面板会中文、
 * `/` 菜单却英文，而且看起来都"正常"。收敛到这里，只保留一个事实。
 *
 * 语义（刻意定死）：
 *  - 只认 `active === 'zh'`；其它值（en / 未知 / 缺失 locale 服务）一律英文——
 *    与旧实现一致，也不把"未知语言"猜成中文；
 *  - `service()` 是软探测，宿主没有 locale 服务时这里不抛错，面板照常渲染英文。
 * @module dsh-project-memory/client/i18n
 */
import { createTranslate, en, zh } from './locales.ts'
import { service } from './services.ts'

/** 翻译函数签名（key 可能是运行期拼出来的，故不按词典 key 做字面量约束）。 */
export type Translator = (key: string, params?: Record<string, string | number>) => string

/**
 * 当前宿主语言对应的翻译函数。
 * @param ctx - client 上下文（缺失/贫服务宿主也能调用）。
 * @returns 翻译函数；语言服务不可读时退回英文。
 */
export function translatorFor(ctx: any): Translator {
  const active = service(ctx, 'locale')?.getSnapshot?.()?.active
  return createTranslate(active === 'zh' ? zh : en) as unknown as Translator
}
