import { extractTypeSignature } from './src/symbols.js'

// Test the joined text directly
const joined = `function multiLine(     a: string,     b: number   ): Promise<void> { }`
console.log("Input:", JSON.stringify(joined))
console.log("Output:", JSON.stringify(extractTypeSignature(joined)))