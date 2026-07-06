/**
 * Claude Agent SDK 默认引擎真对话 E2E + 诊断(发布级验收阻塞项)。
 * 用官方 Anthropic 端点(空 baseUrl Provider,继承环境登录态)最小提示跑一轮,
 * 超时/失败时打印 AgentSession 透出的 SDK stderr 尾部,定位根因
 * (登录态 / 二进制路径 / 子进程阻塞)。
 *
 * 运行(默认引擎走环境登录态,或设 ANTHROPIC_API_KEY):
 *   npx electron scripts/claude-real-e2e.cjs
 * 可选:CLAUDE_E2E_TIMEOUT(默认 60000,比产品 180s 短,快速暴露诊断)
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-claude-e2e-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const TIMEOUT_MS = Number(process.env.CLAUDE_E2E_TIMEOUT || 60_000)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`)
}
async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

async function run() {
  // 无宿主登录态且无 API key:如实跳过(deep-test 在未登录环境不应硬失败)
  const hasAuth =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.CLAUDE_CODE_HOST_CREDS_FILE ||
    fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json')) ||
    fs.existsSync(path.join(os.homedir(), '.claude.json'))
  if (!hasAuth) {
    console.log('[SKIP] Claude 真对话需宿主登录态或 ANTHROPIC_API_KEY;未检测到,跳过')
    console.log('\nclaude-real e2e: skipped (no auth)')
    app.exit(0)
    return
  }
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  // 官方 Anthropic Provider:空 baseUrl,继承环境登录态(claude CLI 登录 / ANTHROPIC_API_KEY)
  const provider = await invoke('providers:create', {
    name: 'Anthropic 官方(E2E)', baseUrl: '', models: [], openaiProtocol: 'responses', token: process.env.ANTHROPIC_API_KEY || ''
  }).catch(() => null)

  // Claude 默认引擎会话
  const meta = await invoke('sessions:create', {
    cwd: tmpUserData, engine: 'claude',
    providerId: provider?.id, model: '', isolated: false
  })
  check('创建 Claude 引擎会话', meta.engine === 'claude', `id=${meta.id}`)

  await invoke('sessions:send', meta.id, { text: '只回复两个字:收到' })

  const start = Date.now()
  let turn = null
  let lastStatus = ''
  let errorNotice = ''
  while (Date.now() - start < TIMEOUT_MS) {
    const entries = await invoke('sessions:transcript', meta.id)
    turn = entries.filter((e) => e.event.kind === 'turn-result').pop()?.event ?? null
    // 捕获 status/error 事件里的诊断(含我们新加的 SDK stderr 尾部)
    for (const e of entries) {
      if (e.event.kind === 'status' && e.event.error) errorNotice = e.event.error
      if (e.event.kind === 'notice' && e.event.level === 'error') errorNotice = e.event.text
    }
    const metas = await invoke('sessions:list')
    lastStatus = metas.find((m) => m.id === meta.id)?.status ?? ''
    if (turn) break
    if (lastStatus === 'error') break
    await new Promise((r) => setTimeout(r, 1000))
  }

  const text = turn?.resultText || ''
  if (turn && !turn.isError) {
    check('Claude 真对话完成', true, text.slice(0, 60))
    check('回复内容合理', /收到|received|ok/i.test(text), text.slice(0, 60))
  } else {
    // 失败:打印诊断(状态 + 错误 + SDK stderr 尾部),定位根因
    check('Claude 真对话完成', false, `status=${lastStatus} · ${errorNotice || (turn ? turn.resultText : `${TIMEOUT_MS}ms 内无 turn-result`)}`)
    console.log('\n=== 诊断信息 ===')
    console.log('会话终态:', lastStatus)
    console.log('错误/stderr:', errorNotice || '(无 status.error;可能是子进程静默阻塞——查主进程日志的 [claude-sdk stderr])')
    console.log('可用引擎:', (await invoke('engines:list')).map((e) => `${e.kind}:${e.available}`).join(' '))
  }

  return finish(results.every((r) => r.ok) ? 0 : 1)
}
function finish(code) {
  const pass = results.filter((r) => r.ok).length
  console.log(`\nclaude-real e2e: ${pass}/${results.length} 通过`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
