/**
 * OpenAI 引擎原生编码 Agent E2E:验证任何 Chat 协议模型在 CaoGen 里
 * 能真编码 —— 模型经工具调用真实创建/编辑/读取文件、执行命令。
 * 运行: CHAT_E2E_KEY=sk-... npx electron scripts/coding-agent-e2e.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-agent-e2e-'))
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-agent-work-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const BASE_URL = process.env.CHAT_E2E_BASE_URL || 'https://api.deepseek.com'
const KEY = process.env.CHAT_E2E_KEY || ''
const MODEL = process.env.CHAT_E2E_MODEL || 'deepseek-chat'
const TIMEOUT_MS = Number(process.env.CHAT_E2E_TIMEOUT || 180_000)

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
async function waitTurns(id, n) {
  const start = Date.now()
  while (Date.now() - start < TIMEOUT_MS) {
    const entries = await invoke('sessions:transcript', id)
    const turns = entries.filter((e) => e.event.kind === 'turn-result')
    if (turns.length >= n) return entries
    await new Promise((r) => setTimeout(r, 800))
  }
  throw new Error('等待轮次超时')
}

async function run() {
  if (!KEY) { check('CHAT_E2E_KEY 已提供', false); return finish(1) }
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  const provider = await invoke('providers:create', {
    name: 'agent-e2e', baseUrl: BASE_URL, models: [MODEL], openaiProtocol: 'chat', token: KEY
  })
  const meta = await invoke('sessions:create', {
    cwd: workDir, engine: 'openai', providerId: provider.id, model: MODEL,
    isolated: false, permissionMode: 'bypassPermissions'
  })
  check('创建编码 Agent 会话', !!meta.id)

  // 任务 1:创建文件(write_file 工具)
  await invoke('sessions:send', meta.id, {
    text: '在当前目录创建 greeting.txt,内容恰好是一行:hello from caogen。然后告诉我完成了。'
  })
  let entries = await waitTurns(meta.id, 1)
  const file1 = path.join(workDir, 'greeting.txt')
  const content1 = fs.existsSync(file1) ? fs.readFileSync(file1, 'utf8') : null
  check('模型真实创建了文件', content1 !== null, JSON.stringify(content1))
  check('文件内容正确', content1 !== null && /hello from caogen/i.test(content1))
  const toolUses = entries.filter(
    (e) => e.event.kind === 'assistant-message' && (e.event.blocks ?? []).some((b) => b.type === 'tool_use')
  )
  const toolResults = entries.filter((e) => e.event.kind === 'tool-result')
  check('走了真实工具调用(tool_use+tool-result 持久化)', toolUses.length > 0 && toolResults.length > 0, `${toolUses.length} 次调用 / ${toolResults.length} 个结果`)

  // 任务 2:编辑文件(edit_file/read 工具)+ 多轮上下文
  await invoke('sessions:send', meta.id, {
    text: '把 greeting.txt 里的 hello 改成 HELLO(其余不动),改完读回来告诉我最终内容。'
  })
  entries = await waitTurns(meta.id, 2)
  const content2 = fs.readFileSync(file1, 'utf8')
  check('模型真实编辑了文件', /HELLO from caogen/.test(content2), JSON.stringify(content2.trim()))

  // 任务 3:bash 工具
  await invoke('sessions:send', meta.id, {
    text: '用命令统计当前目录有几个 .txt 文件,只告诉我数字。'
  })
  entries = await waitTurns(meta.id, 3)
  const lastTurn = entries.filter((e) => e.event.kind === 'turn-result').pop()
  const bashUsed = entries.filter(
    (e) => e.event.kind === 'assistant-message' && (e.event.blocks ?? []).some((b) => b.type === 'tool_use' && b.name === 'bash')
  )
  check('bash 工具被真实调用', bashUsed.length > 0, `${bashUsed.length} 次`)
  check('三轮全部成功', !lastTurn.event.isError, lastTurn.event.resultText?.slice(0, 60))

  return finish(results.every((r) => r.ok) ? 0 : 1)
}
function finish(code) {
  const pass = results.filter((r) => r.ok).length
  console.log(`\ncoding-agent e2e: ${pass}/${results.length} 通过`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
