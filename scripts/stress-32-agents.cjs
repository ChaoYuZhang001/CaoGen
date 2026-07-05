/**
 * 32 子代理并发压测(用户点名场景):真 Electron + 真 IPC + 真模型调用。
 * 验证:一次 dispatchSubagents 派 32 个真实 child session 并发跑,
 * 后端不崩、事件不丢、全部回灌、父 Agent 汇总,统计吞吐/时延/成本。
 *
 * 运行: CHAT_E2E_KEY=sk-... npx electron scripts/stress-32-agents.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-stress32-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const BASE_URL = process.env.CHAT_E2E_BASE_URL || 'https://api.deepseek.com'
const KEY = process.env.CHAT_E2E_KEY || ''
const MODEL = process.env.CHAT_E2E_MODEL || 'deepseek-chat'
const N = Number(process.env.STRESS_N || 32)
const TIMEOUT_MS = Number(process.env.STRESS_TIMEOUT || 300_000)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}

async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

async function run() {
  if (!KEY) { check('CHAT_E2E_KEY 已提供', false); return finish(1) }
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  const provider = await invoke('providers:create', {
    name: 'stress32', baseUrl: BASE_URL, models: [MODEL], openaiProtocol: 'chat', token: KEY
  })
  const parent = await invoke('sessions:create', {
    cwd: tmpUserData, engine: 'openai', providerId: provider.id, model: MODEL, isolated: false
  })
  check('创建父会话', !!parent.id)

  const tasks = Array.from({ length: N }, (_, i) => ({
    id: `t${i + 1}`,
    role: `工人${i + 1}`,
    prompt: `你是 ${i + 1} 号。计算 ${i + 1} * 3 等于几?只回复数字。`
  }))

  const t0 = Date.now()
  const dispatch = await invoke('sessions:dispatchSubagents', parent.id, { isolated: false, tasks })
  check(`一次派发 ${N} 个子代理`, dispatch.children?.length === N, `dispatch 耗时 ${Date.now() - t0}ms`)

  // 等全部 child 完成 + 回灌 + 父总结
  const start = Date.now()
  let doneCount = 0
  let sawInject = false
  let sawParentReply = false
  let firstDone = 0
  let lastDone = 0
  while (Date.now() - start < TIMEOUT_MS) {
    const metas = await invoke('sessions:list')
    const children = metas.filter((m) => m.parentSessionId === parent.id)
    const done = children.filter((m) => m.status === 'idle' || m.status === 'error')
    if (done.length > doneCount) {
      if (doneCount === 0 && done.length > 0) firstDone = Date.now() - start
      doneCount = done.length
      lastDone = Date.now() - start
      console.log(`  进度: ${doneCount}/${N} 完成(${Math.round(lastDone / 1000)}s)`)
    }
    if (doneCount >= N) {
      const entries = await invoke('sessions:transcript', parent.id)
      for (let i = 0; i < entries.length; i++) {
        const ev = entries[i].event
        if (ev.kind === 'user-message' && String(ev.text ?? '').includes('[子代理编排完成]')) {
          sawInject = true
          if (entries.slice(i + 1).some((e) => e.event.kind === 'turn-result' && !e.event.isError)) sawParentReply = true
        }
      }
      if (sawInject && sawParentReply) break
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  check(`${N} 个子代理全部完成`, doneCount >= N, `首个 ${Math.round(firstDone / 1000)}s / 最后 ${Math.round(lastDone / 1000)}s`)
  check('汇总自动回灌父会话', sawInject)
  check('父 Agent 产出编排总结', sawParentReply)

  // 结果正确性抽查:transcript 里工人 7 的答案应含 21
  const metas = await invoke('sessions:list')
  const child7 = metas.find((m) => m.parentSessionId === parent.id && m.childTaskId === 't7')
  if (child7) {
    const entries = await invoke('sessions:transcript', child7.id)
    const text = entries
      .filter((e) => e.event.kind === 'assistant-message')
      .flatMap((e) => e.event.blocks ?? [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    check('抽查 t7 计算正确(7*3=21)', /21/.test(text), text.slice(0, 40))
  }

  // 成本统计
  const children = metas.filter((m) => m.parentSessionId === parent.id)
  const totalCost = children.reduce((sum, m) => sum + (m.costUsd || 0), 0)
  console.log(`  总成本: $${totalCost.toFixed(4)} · 平均并发时延: 首完 ${Math.round(firstDone / 1000)}s → 全完 ${Math.round(lastDone / 1000)}s`)

  return finish(results.every((r) => r.ok) ? 0 : 1)
}

function finish(code) {
  const pass = results.filter((r) => r.ok).length
  console.log(`\nstress-32: ${pass}/${results.length} 通过`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}

app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
