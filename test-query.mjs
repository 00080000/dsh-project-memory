import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { indexRepoTool } from './src/tools/index-repo.js'
import { queryMemoryTool } from './src/tools/query-memory.js'

const fakeLLM = {
  async *stream() {
    const body = JSON.stringify({
      title: 'Payment Module',
      summary: 'Handles order payments via PaymentService. Constraint: fees must stay under 1%.',
      keywords: ['payment', 'fees', 'gateway', 'PaymentService'],
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const config = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 50,
  maxOutputChars: 8000,
  maxPdfPages: 1000,
  llmQueryExpansion: true,
  expansionCount: 6,
  watch: true,
  watchInterval: 15,
}

const root = '/tmp/pm-test-query-' + Date.now()
const docsDir = path.join(root, 'docs')
const srcDir = path.join(root, 'src')
mkdirSync(docsDir, { recursive: true })
mkdirSync(srcDir, { recursive: true })

const mdPath = path.join(root, 'docs', 'spec.md')
writeFileSync(mdPath, '# Overview\n\nThis project handles payments end to end.\n\n# Fees\n\nFees must stay under 1%.\n\n# Archived\n\nOld section that changed.')
const pyPath = path.join(root, 'src', 'payments.py')
writeFileSync(pyPath, 'class PaymentService:\n    def charge(self, amount):\n    pass\n\ndef refund(tx):\n    pass\n')

const fakeLLM = {
  async *stream() {
    const body = JSON.stringify({
      title: 'Payment Module',
      summary: 'Handles order payments via PaymentService. Constraint: fees must stay under 1%.',
      keywords: ['payment', 'fees', 'gateway', 'PaymentService'],
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const config = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 50,
  maxOutputChars: 8000,
  maxPdfPages: 1000,
  llmQueryExpansion: true,
  expansionCount: 6,
  watch: true,
  watchInterval: 15,
}

const root = '/tmp/pm-test-query-' + Date.now()
const docsDir = path.join(root, 'docs')
const srcDir = path.join(root, 'src')
mkdirSync(docsDir, { recursive: true })
mkdirSync(srcDir, { recursive: true })

const mdPath = path.join(root, 'docs', 'spec.md')
writeFileSync(mdPath, '# Overview\n\nThis project handles payments end to end.\n\n# Fees\n\nFees must stay under 1%.\n\n# Archived\n\nOld section that changed.')
const pyPath = path.join(root, 'src', 'payments.py')
writeFileSync(pyPath, 'class PaymentService:\n    def charge(self, amount):\n    pass\n\ndef refund(tx):\n    pass\n')

const fakeLLM = {
  async *stream() {
    const body = JSON.stringify({
      title: 'Payment Module',
      summary: 'Handles order payments via PaymentService. Constraint: fees must stay under 1%.',
      keywords: ['payment', 'fees', 'gateway', 'PaymentService'],
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const ctx = { llm: fakeLLM }
const config = {
  memoryDir: '.dsh-project-memory',
  chunkChars: 3000,
  maxChunksPerFile: 40,
  maxFileSizeMb: 50,
  maxOutputChars: 8000,
  maxPdfPages: 1000,
  llmQueryExpansion: true,
  expansionCount: 6,
  watch: true,
  watchInterval: 15,
}

const { indexRepoTool } = await import('./src/tools/index-repo.js')
const { queryMemoryTool } = await import('./src/tools/query-memory.js')

const repoTool = indexRepoTool({ llm: fakeLLM }, config)
const out = await repoTool.execute({ root })
console.log('Index result:', out)

const noExpandTool = queryMemoryTool({ llm: { async *stream() { throw new Error('llm must not be called') } } }, { ...config, llmQueryExpansion: false })
const out2 = await noExpandTool.execute({ root, query: 'payment' })
console.log('Query result:', out2)
console.log('Includes PaymentService:', out2.includes('PaymentService'))
console.log('Includes Payment Module:', out2.includes('Payment Module'))