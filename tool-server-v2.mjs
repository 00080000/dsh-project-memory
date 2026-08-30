import { createServer } from 'node:http'
import { WatchManager } from './src/watch.js'
import { indexRepository } from './src/tools/index-repo.js'
import { queryMemoryTool } from './src/tools/query-memory.js'
import { rememberTool } from './src/tools/remember.js'
import { statsTool } from './src/tools/stats.js'

const fakeLLM = { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } } }
const ctx = { llm: fakeLLM, tools: { register: () => {} } }
const config = { memoryDir: '.dsh-project-memory', chunkChars: 3000, maxChunksPerFile: 40, maxFileSizeMb: 50, maxOutputChars: 8000, maxPdfPages: 1000, llmQueryExpansion: false, expansionCount: 6, lazyIndexing: false, autoIndexOnFirstUse: false, watch: true, watchInterval: 15 }

console.log('[1] Creating WatchManager...')
const watchManager = new WatchManager(ctx, config)
watchManager.addRoot(process.cwd())

console.log('[2] Starting index...')
await indexRepository(ctx, config, process.cwd())
console.log('[3] Index done')

watchManager.start(config.watchInterval * 1000)
console.log('[4] Watch started')

const queryTool = queryMemoryTool(ctx, config)
const rememberT = rememberTool(config)
const statsT = statsTool(config)

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(body)) } catch (e) { resolve({}) }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  console.log(`[REQ] ${req.method} ${req.url}`)
  if (req.method === 'POST' && req.url === '/tool') {
    const { tool, args, id } = await parseBody(req)
    console.log('[REQ] parsed:', { tool, id, args })
    if (!tool || !id) { res.writeHead(400); res.end('missing tool or id'); return }

    try {
      let result
      if (tool === 'query_memory') {
        console.log('[TOOL] query_memory...')
        result = await queryTool.execute(args, { ctx })
        console.log('[TOOL] query_memory done')
      } else if (tool === 'remember') {
        console.log('[TOOL] remember...')
        result = await rememberT.execute(args, { ctx })
        console.log('[TOOL] remember done')
      } else if (tool === 'stats') {
        console.log('[TOOL] stats...')
        result = await statsT.execute(args, { ctx })
        console.log('[TOOL] stats done')
      } else {
        result = { error: `unknown tool: ${tool}` }
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id, result }))
      console.log('[RES] response sent')
    } catch (e) {
      console.error('[TOOL] error:', e)
      res.writeHead(500); res.end(JSON.stringify({ id, result: { error: String(e) } }))
    }
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(404); res.end('not found')
})

server.listen(8765, () => console.log('[SERVER] Listening on :8765'))
server.on('error', e => console.error('[SERVER] error:', e))

// Keep process alive
process.stdin.resume()
console.log('[SERVER] Ready, process will stay alive')