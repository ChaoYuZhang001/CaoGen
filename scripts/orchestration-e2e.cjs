/**
 * 真子代理编排 E2E:真 Electron + 真 IPC + 真模型调用(chat 协议)。
 * 验证闭环:父会话派发 2 个子代理 → 子代理真实跑完首轮 →
 * 汇总自动回灌父 Agent → 父 Agent 真实产出编排总结。
 *
 * 运行: CHAT_E2E_KEY=sk-... npx electron scripts/orchestration-e2e.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-orch-e2e-'))
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

async function run() {
  if (!KEY) {
    check('CHAT_E2E_KEY 已提供', false)
    return finish(1)
  }
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  const provider = await invoke('providers:create', {
    name: 'orch-e2e',
    baseUrl: BASE_URL,
    models: [MODEL],
    openaiProtocol: 'chat',
    token: KEY
  })
  check('创建 Provider', !!provider.id)

  // 父会话(不隔离,免 git 依赖)
  const parent = await invoke('sessions:create', {
    cwd: tmpUserData,
    engine: 'openai',
    providerId: provider.id,
    model: MODEL,
    isolated: false
  })
  check('创建父会话', !!parent.id)

  // 派发 2 个子代理(不隔离:tmp 目录不是 git 仓库)
  const dispatch = await invoke('sessions:dispatchSubagents', parent.id, {
    isolated: false,
    tasks: [
      { id: 'poem', role: '诗人', prompt: '写一句五言诗,只回复诗句本身。' },
      { id: 'math', role: '数学家', prompt: '3+4 等于几?只回复数字。' }
    ]
  })
  check('派发 2 个子代理', dispatch.children?.length === 2, `orchestrationId=${dispatch.orchestrationId}`)

  // 等父会话出现编排回灌(user-message 含 [子代理编排完成])+ 父 Agent 的总结回复
  const start = Date.now()
  let sawSummaryInject = false
  let sawParentReply = false
  while (Date.now() - start < TIMEOUT_MS) {
    const entries = await invoke('sessions:transcript', parent.id)
    for (let i = 0; i < entries.length; i++) {
      const ev = entries[i].event
      if (ev.kind === 'user-message' && typeof ev.text === 'string' && ev.text.includes('[子代理编排完成]')) {
        sawSummaryInject = true
        // 注入之后是否有 assistant 回复完成
        const later = entries.slice(i + 1)
        if (later.some((e) => e.event.kind === 'turn-result' && !e.event.isError)) sawParentReply = true
      }
    }
    if (sawSummaryInject && sawParentReply) break
    await new Promise((r) => setTimeout(r, 1200))
  }
  check('子代理结果自动回灌父会话(含任务清单)', sawSummaryInject)
  check('父 Agent 真实产出编排总结', sawParentReply)

  // 子会话确实真实跑完
  const children = await invoke('sessions:list')
  const childMetas = children.filter((m) => m.parentSessionId === parent.id)
  check('子会话记录 parent/orchestration 元数据', childMetas.length === 2 && childMetas.every((m) => m.orchestrationId === dispatch.orchestrationId))

  return finish(results.every((r) => r.ok) ? 0 : 1)
}

function finish(code) {
  const pass = results.filter((r) => r.ok).length
  console.log(`\norchestration e2e: ${pass}/${results.length} 通过`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}

app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
