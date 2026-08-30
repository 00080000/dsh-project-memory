process.on('unhandledRejection', (r) => console.error('UNHANDLED REJECTION:', r))
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION:', e))

import { createServer } from 'node:http'
import { WatchManager } from './src/watch.js'
import { indexRepository } from './src/tools/index-repo.js'
import { queryMemoryTool } from './src/tools/query-memory.js'
import { rememberTool } from './src/tools/remember.js'
import { statsTool } from './src/tools/stats.js'

const fakeLLM = { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } } }
const ctx = { llm: fakeLLM, tools: { register: () => {} } }
const config = { memoryDir: '.dsh-project-memory', chunkChars: 3000, maxChunksPerFile: 40, maxFileSizeMb: 50, maxOutputChars: 8000, maxPdfPages: 1000, llmQueryExpansion: false, expansionCount: 6, lazyIndexing: false, autoIndexOnFirstUse: false, watch: true, watchInterval: 15 }

const watchManager = new WatchManager(ctx, config)
watchManager.addRoot(process.cwd())
await indexRepository(ctx, config, process.cwd())
watchManager.start(config.watchInterval * 1000)

const queryTool = queryMemoryTool(ctx, config)
const rememberT = rememberTool(config)
const statsT = statsTool(config)

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve({}) } })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  console.log('[REQ]', req.method, req.url)
  if (req.method === 'POST' && req.url === '/tool') {
    const { tool, args, id } = await parseBody(req)
    console.log('[REQ]', tool, id)
    try {
      let result
      if (tool === 'query_memory') result = await queryTool.execute(args, { ctx })
      else if (tool === 'remember') result = await rememberT.execute(args, { ctx })
      else if (tool === 'stats') result = await statsT.execute(args, { ctx })
      else result = { error: 'unknown tool' }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id, result }))
      console.log('[RES] ok')
    } catch (e) {
      console.error('[ERR]', e)
      res.writeHead(500); res.end('err')
    }
  } else if (req.method === 'GET' && req.url === '/health') {
    res.end('ok')
  } else { res.writeHead(404); res.end() }
})

server.listen(8765, () => console.log('Server ready on 8765'))
server.on('error', e => console.error('[SERVER ERR]', e))

setInterval(() => {}, 1000)
console.log('Server started, PID:', process.pid)