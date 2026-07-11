/**
 * Claude Agent SDK 显式引擎真对话 E2E + 诊断(发布级验收阻塞项)。
 * 用显式创建的 Anthropic Provider + API key 最小提示跑一轮,
 * 超时/失败时打印 AgentSession 透出的 SDK stderr 尾部,定位根因
 * (凭据 / 二进制路径 / 子进程阻塞)。
 *
 * 运行(必须显式提供 ANTHROPIC_API_KEY):
 *   npx electron scripts/claude-real-e2e.cjs
 * 可选:CLAUDE_E2E_TIMEOUT(默认 60000,比产品 180s 短,快速暴露诊断)
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')
const { reportDeepTestStatus } = require('./deep-test-status.cjs')

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
  const apiKey = process.env.ANTHROPIC_API_KEY || ''
  if (!apiKey) {
    reportDeepTestStatus('skip', { reason: 'missing explicit ANTHROPIC_API_KEY' })
    console.log('[SKIP] Claude 真对话需显式 ANTHROPIC_API_KEY;当前未配置,跳过。')
    console.log('\nclaude-real e2e: skipped (no explicit api key)')
    app.exit(0)
    return
  }
  // 只接受"真实凭据":API key / 存在的 host-creds 文件 / .credentials.json。
  // 注意 ~/.claude.json 是配置文件(人人都有,不含 token),绝不能当登录凭据 ——
  // 外部验收发现旧逻辑误把它当凭据,导致无登录环境不跳过反而硬失败(Not logged in)。
  const hostCreds = process.env.CLAUDE_CODE_HOST_CREDS_FILE
  const hasAuth =
    !!apiKey ||
    (!!hostCreds && fs.existsSync(hostCreds)) ||
    fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'))
  if (!hasAuth) {
    reportDeepTestStatus('skip', { reason: 'missing Claude host credentials or login state' })
    console.log('[SKIP] Claude 真对话需真实登录态(host-creds / ~/.claude/.credentials.json)')
    console.log('       ~/.claude.json 是配置文件,不算凭据。当前环境无有效凭据,跳过。')
    console.log('\nclaude-real e2e: skipped (no auth)')
    app.exit(0)
    return
  }
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  // 显式 Anthropic Provider:用户提供 API key,不使用隐藏默认 Provider。
  const provider = await invoke('providers:create', {
    name: 'Anthropic API Key(E2E)', baseUrl: '', models: [], openaiProtocol: 'responses', token: apiKey
  }).catch(() => null)

  // Claude 显式引擎会话
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
  reportDeepTestStatus(code === 0 ? 'pass' : 'fail', {
    ...(code === 0 ? {} : { reason: 'Claude real conversation assertions failed' }),
    details: { passed: pass, total: results.length }
  })
  console.log(`\nclaude-real e2e: ${pass}/${results.length} 通过`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
