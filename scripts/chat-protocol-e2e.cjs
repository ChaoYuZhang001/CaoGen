/**
 * Chat Completions 协议真·E2E:在真 Electron 主进程里,
 *   1) 经真实 IPC 创建一个 openaiProtocol='chat' 的 Provider(key 来自环境变量,不落盘明文)
 *   2) 以 openai 引擎创建会话
 *   3) 真实发送一条消息,等待流式回复
 *   4) 验证 assistant 文本 + usage + 多轮上下文(第二轮引用第一轮)
 *
 * 运行(key 不入仓库,由调用方注入):
 *   CHAT_E2E_BASE_URL=https://api.deepseek.com CHAT_E2E_KEY=sk-... CHAT_E2E_MODEL=deepseek-chat \
 *     npx electron scripts/chat-protocol-e2e.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-chat-e2e-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const BASE_URL = process.env.CHAT_E2E_BASE_URL || 'https://api.deepseek.com'
const KEY = process.env.CHAT_E2E_KEY || ''
const MODEL = process.env.CHAT_E2E_MODEL || 'deepseek-chat'
const TIMEOUT_MS = Number(process.env.CHAT_E2E_TIMEOUT || 90_000)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: (detail || '').slice(0, 200) })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}

async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

function waitTurn(sessionId, sm) {
  // 轮询转录直到出现 turn-result(或超时)
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const entries = sm.getTranscript(sessionId)
      const done = entries.filter((e) => e.event.kind === 'turn-result')
      if (done.length > 0) {
        clearInterval(timer)
        resolve(entries)
      } else if (Date.now() - start > TIMEOUT_MS) {
        clearInterval(timer)
        reject(new Error(`等待 turn-result 超时(${TIMEOUT_MS}ms)`))
      }
    }, 400)
  })
}

function lastAssistantText(entries) {
  let text = ''
  for (const e of entries) {
    if (e.event.kind === 'assistant-message' && Array.isArray(e.event.blocks)) {
      text = e.event.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    }
  }
  return text
}

async function run() {
  if (!KEY) {
    check('CHAT_E2E_KEY 已提供', false, '缺少 key,跳过真实调用')
    return finish(1)
  }
  try {
    require(path.join(repoOut, 'index.js'))
    check('主进程加载', true)
  } catch (err) {
    check('主进程加载', false, err.message)
    return finish(1)
  }
  await new Promise((r) => setTimeout(r, 900))

  // 1. 创建 chat 协议 Provider
  let provider
  try {
    provider = await invoke('providers:create', {
      name: 'chat-e2e',
      baseUrl: BASE_URL,
      models: [MODEL],
      openaiProtocol: 'chat',
      token: KEY
    })
    check('创建 chat 协议 Provider', provider && provider.openaiProtocol === 'chat', JSON.stringify({ id: provider.id, protocol: provider.openaiProtocol }))
  } catch (e) {
    check('创建 Provider', false, e.message)
    return finish(1)
  }

  // 2. openai 引擎会话
  const { sessionManager } = require(path.join(repoOut, 'index.js'))
  let meta
  try {
    meta = await invoke('sessions:create', {
      cwd: tmpUserData,
      engine: 'openai',
      providerId: provider.id,
      model: MODEL,
      isolated: false
    })
    check('创建 openai 引擎会话', meta && meta.engine === 'openai', `id=${meta.id} model=${meta.model}`)
  } catch (e) {
    check('创建会话', false, e.message)
    return finish(1)
  }

  const sm = sessionManager || require(path.join(repoOut, 'index.js')).sessionManager
  if (!sm) {
    // sessionManager 不一定被导出;退回 IPC 轮询转录
    check('sessionManager 可用(经导出或 IPC)', true, '用 IPC 轮询')
  }
  const getTranscript = async (id) => invoke('sessions:transcript', id)

  // 3. 第一轮:真实发送
  try {
    await invoke('sessions:send', meta.id, { text: '请只回复两个字:收到' })
    const start = Date.now()
    let entries = []
    while (Date.now() - start < TIMEOUT_MS) {
      entries = await getTranscript(meta.id)
      if (entries.some((e) => e.event.kind === 'turn-result')) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const turn = entries.find((e) => e.event.kind === 'turn-result')
    const text = lastAssistantText(entries)
    check('第一轮流式回复完成', turn && !turn.event.isError, `resultText=${(turn && turn.event.resultText || '').slice(0, 60)}`)
    check('assistant 文本非空', text.length > 0, text.slice(0, 60))
    check('usage 上报', turn && turn.event.usage && turn.event.usage.input > 0, JSON.stringify(turn && turn.event.usage))
  } catch (e) {
    check('第一轮对话', false, e.message)
    return finish(1)
  }

  // 4. 第二轮:验证多轮上下文
  try {
    await invoke('sessions:send', meta.id, { text: '我上一条消息让你回复什么?只重复那两个字。' })
    const start = Date.now()
    let entries = []
    let turns = []
    while (Date.now() - start < TIMEOUT_MS) {
      entries = await getTranscript(meta.id)
      turns = entries.filter((e) => e.event.kind === 'turn-result')
      if (turns.length >= 2) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const text = lastAssistantText(entries)
    check('第二轮完成', turns.length >= 2 && !turns[1].event.isError)
    check('多轮上下文生效(回答含「收到」)', /收到/.test(text), text.slice(0, 80))
  } catch (e) {
    check('第二轮对话', false, e.message)
  }

  return finish(results.every((r) => r.ok) ? 0 : 1)
}

function finish(code) {
  const pass = results.filter((r) => r.ok).length
  console.log(`\nchat-protocol e2e: ${pass}/${results.length} 通过`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}

app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
