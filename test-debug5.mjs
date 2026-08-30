import { maskTokens, JS_MASKER, matchJsLike, JS_DECL_START } from './src/symbols.js'

const code = `export function
  multilineFn(
    a: string,
    b: number
  ): Promise<void> {}`

const lines = code.split("\n")
console.log("Raw lines:")
lines.forEach((l, i) => console.log(i, ":", JSON.stringify(l)))

const masked = maskTokens(lines, JS_MASKER)
console.log("\nMasked lines:")
masked.forEach((l, i) => console.log(i, ":", JSON.stringify(l)))

// Check what matchJsLike sees at each step
console.log("\n--- Join simulation ---")
let i = 0
const maskedText = masked[i].trim()
console.log("i=0, maskedText:", JSON.stringify(maskedText))

let joined = maskedText
for (let j = i + 1; j < masked.length; j++) {
  const tail = masked[j].trim()
  if (!tail) continue
  joined += " " + tail
  console.log("j=" + j + ", tail:", JSON.stringify(tail), "joined:", JSON.stringify(joined))
  const m = matchJsLike(joined)
  console.log("  match:", m)
  if (m) break
  if (/[{};]/.test(tail)) break
}

console.log("\nFinal joined:", JSON.stringify(joined))