/**
 * 32 子代理并发压测(用户点名场景):真 Electron + 真 IPC + 真模型调用。
 * 验证:一次 dispatchSubagents 派 32 个真实 child session 并发跑,
 * 后端不崩、事件不丢、全部回灌、父 Agent 汇总,统计吞吐/时延/成本。
 *
 * Real calls require CAOGEN_REAL_PROVIDER_E2E=1 and read only
 * ~/.caogen-private/provider-parity.json. Private values and responses are not printed.
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')
const {
  loadPrivateChatProvider,
  suppressRuntimeConsole,
  writePublicLine
} = require('./lib/private-provider-e2e.cjs')

const repoRoot = path.resolve(__dirname, '..')
const repoOut = path.join(repoRoot, 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-stress32-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const N = Number(process.env.STRESS_N || 32)
const TIMEOUT_MS = Number(process.env.CAOGEN_REAL_PROVIDER_E2E_TIMEOUT || process.env.STRESS_TIMEOUT || 300_000)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  writePublicLine(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` (${detail})` : ''}`)
}

async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

async function run() {
  const privateConfig = await loadPrivateChatProvider(repoRoot)
  if (privateConfig.state === 'skipped') return skip()
  if (privateConfig.state !== 'ready') {
    check('私有 Provider 配置可用', false, privateConfig.code)
    return finish(1)
  }
  suppressRuntimeConsole()
  const { baseUrl, model, apiKey } = privateConfig.provider
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  const provider = await invoke('providers:create', {
    name: 'Private Provider Stress', baseUrl, models: [model], openaiProtocol: 'chat', token: apiKey
  })
  const parent = await invoke('sessions:create', {
    cwd: tmpUserData, engine: 'openai', providerId: provider.id, model, isolated: false
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

  // 等全部 child 到达终态(idle 或 error 都算"结束",但两者分开统计 —— 关键修正:
  // 旧脚本把 error 也算"完成",掩盖了失败;现在 idle=成功、error=失败,分别计数)
  const start = Date.now()
  let settledCount = 0
  let sawInject = false
  let sawParentReply = false
  let firstDone = 0
  let lastDone = 0
  while (Date.now() - start < TIMEOUT_MS) {
    const metas = await invoke('sessions:list')
    const children = metas.filter((m) => m.parentSessionId === parent.id)
    const settled = children.filter((m) => m.status === 'idle' || m.status === 'error')
    if (settled.length > settledCount) {
      if (settledCount === 0 && settled.length > 0) firstDone = Date.now() - start
      settledCount = settled.length
      lastDone = Date.now() - start
      const err = children.filter((m) => m.status === 'error').length
      writePublicLine(`progress: ${settledCount}/${N}; errors=${err}; elapsed_seconds=${Math.round(lastDone / 1000)}`)
    }
    if (settledCount >= N) {
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

  // 终态分布:idle=成功,error=失败
  const metas = await invoke('sessions:list')
  const children = metas.filter((m) => m.parentSessionId === parent.id)
  const idleCount = children.filter((m) => m.status === 'idle').length
  const errorChildren = children.filter((m) => m.status === 'error')
  const runningCount = children.filter((m) => m.status === 'running' || m.status === 'starting').length
  writePublicLine(`settled: success=${idleCount}; errors=${errorChildren.length}; running=${runningCount}`)

  check(`${N} 个子代理全部到达终态`, settledCount >= N, `首个 ${Math.round(firstDone / 1000)}s / 最后 ${Math.round(lastDone / 1000)}s`)
  // 独立的硬断言:全部 child 必须成功(error=0)—— 这是压力达标的核心
  check(`全部 ${N} 个 child 成功(error=0)`, errorChildren.length === 0, `error ${errorChildren.length} / idle ${idleCount}`)
  check('汇总自动回灌父会话', sawInject)
  check('父 Agent 产出编排总结', sawParentReply)

  // 结果正确性抽查:transcript 里工人 7 的答案应含 21
  const child7 = children.find((m) => m.childTaskId === 't7')
  if (child7) {
    const entries = await invoke('sessions:transcript', child7.id)
    const text = entries
      .filter((e) => e.event.kind === 'assistant-message')
      .flatMap((e) => e.event.blocks ?? [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    check('抽查 t7 计算正确(7*3=21)', /21/.test(text))
  }

  // 成本统计
  const totalCost = children.reduce((sum, m) => sum + (m.costUsd || 0), 0)
  writePublicLine(`aggregate: cost_usd=${totalCost.toFixed(4)}; first_seconds=${Math.round(firstDone / 1000)}; last_seconds=${Math.round(lastDone / 1000)}`)

  return finish(results.every((r) => r.ok) ? 0 : 1)
}

function finish(code) {
  const pass = results.filter((r) => r.ok).length
  writePublicLine(`stress-32: ${pass}/${results.length} passed`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}

function skip() {
  writePublicLine('stress-32: skipped (explicit opt-in required)')
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(0)
}

app.whenReady().then(() => run().catch(() => { check('真实并发 E2E 运行', false, 'runtime_failed'); finish(1) }))
