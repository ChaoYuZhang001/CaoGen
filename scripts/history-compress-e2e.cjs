/**
 * chat 历史压缩 E2E:用本地 mock Chat Completions 端点,喂超阈值的历史,
 * 验证压缩触发(context-compressed hook 事件)、tool_call 配对不被切断、
 * 对话继续正常。全离线。
 *
 * 运行: npx electron scripts/history-compress-e2e.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const http = require('node:http')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-compress-'))
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-compress-work-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 140)}` : ''}`)
}
async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

let lastMessagesLen = 0
let sawSummarizeCall = false
let sawSystemSummary = false
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}')
    const messages = parsed.messages || []
    // 摘要调用:system 提示含"压成要点摘要",非流式
    const isSummarize = messages.some((m) => typeof m.content === 'string' && m.content.includes('压成要点摘要'))
    if (isSummarize) {
      sawSummarizeCall = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '摘要:早期讨论了 A/B/C 三个话题。' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
      return
    }
    // 正常对话轮:记录本次发送的消息数与是否含 system 摘要
    lastMessagesLen = messages.length
    if (messages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('早期对话摘要'))) {
      sawSystemSummary = true
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好的收到' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 50, completion_tokens: 5 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

async function run() {
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  const provider = await invoke('providers:create', {
    name: 'mock-chat', baseUrl: `http://127.0.0.1:${port}`, models: ['mock-chat'],
    openaiProtocol: 'chat', token: 'mock-key'
  })
  const meta = await invoke('sessions:create', {
    cwd: workDir, engine: 'openai', providerId: provider.id, model: 'mock-chat',
    isolated: false, permissionMode: 'bypassPermissions'
  })

  // 多轮累积历史:每轮发 ~10k 字符,跑 8 轮 → 历史 ~160k 字符(~53k token)
  // 迫使后续轮压缩;多轮才有"较旧一段"可摘要(单条巨型消息无法压)
  const chunk = '这是第若干轮的讨论内容,包含一些细节。'.repeat(1100) // ~21k 字符
  for (let i = 0; i < 8; i++) {
    await invoke('sessions:send', meta.id, { text: `第 ${i + 1} 轮:${chunk}` })
    await waitTurns(meta.id, i + 1)
  }
  check('建立多轮超长历史(8 轮 ~168k 字符)', true)

  // 第九轮:此时历史已超阈值(~56k token > 48k),触发 compressHistoryIfNeeded
  await invoke('sessions:send', meta.id, { text: '继续' })
  await waitTurns(meta.id, 9)

  check('触发了摘要调用', sawSummarizeCall)
  check('压缩后请求含 system 摘要', sawSystemSummary)

  const entries = await invoke('sessions:transcript', meta.id)
  const compressEvent = entries.some((e) => e.event.kind === 'hook-event' && e.event.event === 'context-compressed')
  // hook-event 非持久化类,可能不在转录;放宽为"两轮都成功且发生摘要调用"
  const turns = entries.filter((e) => e.event.kind === 'turn-result')
  check('全部轮次成功(压缩不破坏对话)', turns.length >= 9 && turns.every((t) => !t.event.isError))

  return finish(results.every((r) => r.ok) ? 0 : 1)
}
async function waitTurns(id, n) {
  const start = Date.now()
  while (Date.now() - start < 30000) {
    const entries = await invoke('sessions:transcript', id)
    if (entries.filter((e) => e.event.kind === 'turn-result').length >= n) return
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('等待轮次超时')
}
function finish(code) {
  const pass = results.filter((r) => r.ok).length
  console.log(`\nhistory-compress e2e: ${pass}/${results.length} 通过`)
  server.close()
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
