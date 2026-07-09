/**
 * Responses 协议工具循环 E2E:本地 mock Responses 端点,先回一个 function_call
 * (write_file),验证引擎真实执行工具、回灌 function_call_output、二轮拿到最终文本。
 * 全离线,不需真 key。
 *
 * 运行: npx electron scripts/responses-tools-e2e.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const http = require('node:http')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-resp-tools-'))
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-resp-work-'))
const reportPath = path.resolve(__dirname, '..', 'test-results', 'responses-api-recheck-report.json')
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const results = []
const requestBodies = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 140)}` : ''}`)
}
async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

// SSE 帮手:写一串 Responses 事件
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

let callSeq = 0
const server = http.createServer((req, res) => {
  if (!req.url.endsWith('/v1/responses')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}')
    requestBodies.push(parsed)
    const hasToolOutput = JSON.stringify(parsed.input || '').includes('function_call_output')
    callSeq += 1
    if (!hasToolOutput) {
      // 第一轮:回一个 write_file 函数调用
      sse(res, [
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'call_test_1',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'hello.txt', content: 'from responses tool loop' })
          }
        },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_test_1', name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'from responses tool loop' }) } },
        { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 5 } } }
      ])
    } else {
      // 第二轮:拿到工具结果后回最终文本
      sse(res, [
        { type: 'response.output_text.delta', delta: '文件已创建完成' },
        { type: 'response.completed', response: { id: 'resp_2', usage: { input_tokens: 20, output_tokens: 8 } } }
      ])
    }
  })
})

async function run() {
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  // Provider:显式 responses 协议(本地 mock 端点)
  const provider = await invoke('providers:create', {
    name: 'mock-responses', baseUrl: `http://127.0.0.1:${port}`, models: ['mock-resp'],
    openaiProtocol: 'responses', token: 'mock-key'
  })
  const meta = await invoke('sessions:create', {
    cwd: workDir, engine: 'openai', providerId: provider.id, model: 'mock-resp',
    isolated: false, permissionMode: 'bypassPermissions'
  })
  check('创建 responses 引擎会话', meta.engine === 'openai')

  await invoke('sessions:send', meta.id, { text: '创建 hello.txt' })
  const start = Date.now()
  let turn = null
  while (Date.now() - start < 30000) {
    const entries = await invoke('sessions:transcript', meta.id)
    turn = entries.find((e) => e.event.kind === 'turn-result')?.event ?? null
    if (turn) break
    await new Promise((r) => setTimeout(r, 400))
  }
  const file = path.join(workDir, 'hello.txt')
  check('Responses 工具循环真实写文件', fs.existsSync(file), fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'missing')
  check('工具结果回灌后拿到最终文本', turn && !turn.isError, turn?.resultText?.slice(0, 40))
  check('发生了两轮请求(调用→结果→文本)', callSeq >= 2, `callSeq=${callSeq}`)
  check(
    '工具结果轮携带 previous_response_id',
    requestBodies[1]?.previous_response_id === 'resp_1',
    JSON.stringify(requestBodies[1] ?? {}).slice(0, 160)
  )
  check(
    '工具结果轮只回灌 function_call_output',
    JSON.stringify(requestBodies[1]?.input ?? '').includes('function_call_output'),
    JSON.stringify(requestBodies[1]?.input ?? '').slice(0, 160)
  )

  const entries = await invoke('sessions:transcript', meta.id)
  const toolUse = entries.some((e) => e.event.kind === 'assistant-message' && (e.event.blocks ?? []).some((b) => b.type === 'tool_use' && b.name === 'write_file'))
  check('tool_use 事件持久化', toolUse)

  return finish(results.every((r) => r.ok) ? 0 : 1)
}
function finish(code) {
  const pass = results.filter((r) => r.ok).length
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ok: code === 0,
        generatedAt: new Date().toISOString(),
        pass,
        total: results.length,
        requestCount: requestBodies.length,
        secondPreviousResponseId: requestBodies[1]?.previous_response_id,
        results
      },
      null,
      2
    )
  )
  console.log(`\nresponses-tools e2e: ${pass}/${results.length} 通过`)
  console.log(`responses-api recheck report: ${reportPath}`)
  server.close()
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
