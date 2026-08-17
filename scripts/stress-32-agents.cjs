/**
 * 32 任务排队压测:真 Electron + 真 IPC + 真模型调用。
 * 验证:DAG 保留 32 个任务,每个主 Agent 同时只运行 2 个 child session,
 * 后端不崩、事件不丢、队列全部完成,并统计吞吐/时延/成本。
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
    title: `${i + 1} 号计算任务`,
    description: `计算 ${i + 1} * 3`,
    dependencies: [],
    role: 'general',
    prompt: `你是 ${i + 1} 号。计算 ${i + 1} * 3 等于几?只回复数字。`
  }))

  const t0 = Date.now()
  const dispatch = await invoke('sessions:dispatchTaskDag', parent.id, {
    isolated: false,
    dag: {
      id: `stress-${N}-${Date.now()}`,
      title: `${N} 任务双槽排队压测`,
      source: 'real provider queued child capacity stress',
      complexity: N === 1 ? 'single' : 'multi',
      createdAt: Date.now(),
      tasks
    }
  })
  check(
    `${N} 个任务进入 DAG,首批最多 2 个`,
    dispatch.execution?.tasks?.length === N && dispatch.children?.length === Math.min(N, 2),
    `dispatch 耗时 ${Date.now() - t0}ms`
  )

  // 等全部 child 到达终态(idle 或 error 都算"结束",但两者分开统计 —— 关键修正:
  // 旧脚本把 error 也算"完成",掩盖了失败;现在 idle=成功、error=失败,分别计数)
  const start = Date.now()
  let settledCount = 0
  let dagTerminal = false
  let maximumRunning = 0
  let firstDone = 0
  let lastDone = 0
  while (Date.now() - start < TIMEOUT_MS) {
    const metas = await invoke('sessions:list')
    const children = metas.filter((m) => m.parentSessionId === parent.id)
    const running = children.filter((m) => m.status === 'running' || m.status === 'starting').length
    maximumRunning = Math.max(maximumRunning, running)
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
      dagTerminal = entries.some((entry) =>
        entry.event.kind === 'task-dag-update' &&
        (entry.event.execution?.status === 'success' || entry.event.execution?.status === 'failed'))
      if (dagTerminal) break
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
  check('每个主 Agent 同时不超过 2 个子 Agent', maximumRunning <= 2, `observed ${maximumRunning}`)
  check('DAG 发布终态', dagTerminal)

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
