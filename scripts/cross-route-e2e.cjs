/**
 * 跨厂商智能路由 E2E:真 Electron + 真 IPC + 真模型调用。
 * 场景:会话挂在"弱厂商"(只有低档模型、且是无效端点)上,auto 模式发复杂任务,
 * 验证路由器跨厂商选中 DeepSeek(质量更匹配)并真实完成对话。
 *
 * 运行: CHAT_E2E_KEY=<your-api-key> npx electron scripts/cross-route-e2e.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-route-e2e-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const KEY = process.env.CHAT_E2E_KEY || ''
const TIMEOUT_MS = Number(process.env.CHAT_E2E_TIMEOUT || 120_000)

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

  // 厂商 A:弱(只有低档 mini 模型;端点无效,若路由错选它会直接失败)
  const weak = await invoke('providers:create', {
    name: '弱厂商', baseUrl: 'https://invalid.example.com', models: ['gpt-4o-mini'],
    openaiProtocol: 'chat', token: 'fixture-api-key'
  })
  // 厂商 B:DeepSeek(deepseek-reasoner 质量档 3,复杂任务应选它)
  const strong = await invoke('providers:create', {
    name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'],
    openaiProtocol: 'chat', token: KEY
  })

  // 会话挂在弱厂商 + auto 模型
  const meta = await invoke('sessions:create', {
    cwd: tmpUserData, engine: 'openai', providerId: weak.id, model: 'auto', isolated: false
  })
  check('创建 auto 模式会话(挂弱厂商)', meta.model === 'auto' && meta.providerId === weak.id)

  // 复杂任务(触发 complex 分类 → 目标质量档 3 → 应跨到 DeepSeek)
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

  check('产生路由决策事件', !!routing, routing?.reason)
  check('路由跨到了 DeepSeek(非会话原厂商)', routing?.providerId === strong.id, `providerId=${routing?.providerId}`)
  check('选中高质量档模型', /reasoner/.test(routing?.model ?? ''), routing?.model)
  const metas = await invoke('sessions:list')
  const cur = metas.find((m) => m.id === meta.id)
  check('会话 providerId 已切换', cur?.providerId === strong.id)
  check('真实对话完成(经切换后的厂商)', turn && !turn.isError, turn?.resultText?.slice(0, 40) ?? turn?.subtype)

  return finish(results.every((r) => r.ok) ? 0 : 1)
}
function finish(code) {
  const pass = results.filter((r) => r.ok).length
  console.log(`\ncross-route e2e: ${pass}/${results.length} 通过`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
