/**
 * 跨厂商智能路由 E2E:真 Electron + 真 IPC + 真模型调用。
 * 场景:会话挂在"弱厂商"(只有低档模型、且是无效端点)上,auto 模式发复杂任务,
 * 验证路由器跨 Provider 选中私有配置中的兼容目标并真实完成对话。
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
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-route-e2e-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const TIMEOUT_MS = Number(process.env.CAOGEN_REAL_PROVIDER_E2E_TIMEOUT || 120_000)

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

  // 厂商 A:弱(只有低档 mini 模型;端点无效,若路由错选它会直接失败)
  const weak = await invoke('providers:create', {
    name: '弱厂商', baseUrl: 'https://invalid.example.com', models: ['gpt-4o-mini'],
    openaiProtocol: 'chat', token: 'fixture-api-key'
  })
  // Provider B comes from the private local fixture and is never written to public output.
  const strong = await invoke('providers:create', {
    name: 'Private Routing Target', baseUrl, models: [model],
    openaiProtocol: 'chat', token: apiKey
  })

  // 会话挂在弱厂商 + auto 模型
  const meta = await invoke('sessions:create', {
    cwd: tmpUserData, engine: 'openai', providerId: weak.id, model: 'auto', isolated: false
  })
  check('创建 auto 模式会话(挂弱厂商)', meta.model === 'auto' && meta.providerId === weak.id)

  // 复杂任务触发跨 Provider 的质量匹配。
  await invoke('sessions:send', meta.id, {
    text: '请帮我重构整个项目的架构设计:先分析现有模块的依赖关系,再给出分层设计方案和迁移步骤。只回复:方案我知道了'
  })

  const start = Date.now()
  let routing = null
  let turn = null
  while (Date.now() - start < TIMEOUT_MS) {
    const entries = await invoke('sessions:transcript', meta.id)
    routing = entries.find((e) => e.event.kind === 'routing')?.event ?? routing
    turn = entries.find((e) => e.event.kind === 'turn-result')?.event ?? turn
    if (turn) break
    await new Promise((r) => setTimeout(r, 800))
  }

  check('产生路由决策事件', !!routing)
  check('路由跨到了私有目标 Provider', routing?.providerId === strong.id)
  check('选中私有配置模型', routing?.model === model)
  const metas = await invoke('sessions:list')
  const cur = metas.find((m) => m.id === meta.id)
  check('会话 providerId 已切换', cur?.providerId === strong.id)
  check('真实对话完成(经切换后的 Provider)', turn && !turn.isError)

  return finish(results.every((r) => r.ok) ? 0 : 1)
}
function finish(code) {
  const pass = results.filter((r) => r.ok).length
  writePublicLine(`cross-route e2e: ${pass}/${results.length} passed`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
function skip() {
  writePublicLine('cross-route e2e: skipped (explicit opt-in required)')
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(0)
}
app.whenReady().then(() => run().catch(() => { check('真实跨路由 E2E 运行', false, 'runtime_failed'); finish(1) }))
