import { createServer } from 'node:http'
import { WatchManager } from './src/watch.js'
import { indexRepository } from './src/tools/index-repo.js'
import { queryMemoryTool } from './src/tools/query-memory.js'
import { rememberTool } from './src/tools/remember.js'
import { statsTool } from './src/tools/stats.js'
import { appendFileSync } from 'fs'

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

function logCall(id, tool, args, result) {
  appendFileSync('tool-log.jsonl', JSON.stringify({ ts: Date.now(), id, tool, args, result: String(result).slice(0, 500) }) + '\n')
}

const server = createServer(async (req, res) => {
  console.log(`[REQ] ${req.method} ${req.url}`)
  if (req.method === 'POST' && req.url === '/tool') {
    let body = ''
    try {
      for await (const chunk of req) {
        console.log('[REQ] chunk received', chunk.length)
        body += chunk
      }
      console.log('[REQ] body complete:', body)
    } catch (e) {
      console.error('[REQ] body read error:', e)
      res.writeHead(500); res.end('body read error'); return
    }

    let parsed
    try { parsed = JSON.parse(body) } catch { res.writeHead(400); res.end('bad json'); return }
    const { tool, args, id } = parsed
    console.log('[REQ] parsed:', { tool, id, args })

    if (!tool || !id) { res.writeHead(400); res.end('missing tool or id'); return }

    let result
    try {
      if (tool === 'query_memory') {
        console.log('[TOOL] calling query_memory...')
        result = await queryTool.execute(args, { ctx })
        console.log('[TOOL] query_memory done')
      } else if (tool === 'remember') {
        console.log('[TOOL] calling remember...')
        result = await rememberT.execute(args, { ctx })
        console.log('[TOOL] remember done')
      } else if (tool === 'stats') {
        console.log('[TOOL] calling stats...')
        result = await statsT.execute(args, { ctx })
        console.log('[TOOL] stats done')
      } else {
        result = { error: `unknown tool: ${tool}` }
      }
    } catch (e) {
      console.error('[TOOL] error:', e)
      result = { error: String(e) }
    }

    logCall(id, tool, args, result)
    console.log('[RES] sending response')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id, result }))
    console.log('[RES] response sent')
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

process.on('SIGINT', () => { console.log('\n[SERVER] Shutdown'); watchManager.stop(); process.exit(0) })