/**
 * Codex / Gemini CLI 原生引擎真对话 E2E(DoD #3):
 * 真 Electron + 真 IPC + 真 CLI 子进程 + 真模型调用。
 * 前提:本机已装并登录 codex / gemini CLI(引擎探测可用才测,否则如实跳过)。
 *
 * 运行: npx electron scripts/cli-engines-e2e.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-cli-e2e-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const TIMEOUT_MS = Number(process.env.CLI_E2E_TIMEOUT || 240_000)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}
function skip(name, why) {
  console.log(`[SKIP] ${name} — ${why}`)
}
async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

async function testEngine(kind, prompt, expectPattern) {
  const meta = await invoke('sessions:create', {
    cwd: tmpUserData,
    engine: kind,
    isolated: false
  })
  check(`[${kind}] 创建会话`, meta.engine === kind, `id=${meta.id}`)
  await invoke('sessions:send', meta.id, { text: prompt })

  const start = Date.now()
  let turn = null
  let text = ''
  while (Date.now() - start < TIMEOUT_MS) {
    const entries = await invoke('sessions:transcript', meta.id)
    turn = entries.find((e) => e.event.kind === 'turn-result')?.event ?? null
    text = entries
      .filter((e) => e.event.kind === 'assistant-message')
      .flatMap((e) => e.event.blocks ?? [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    if (turn) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  check(`[${kind}] 真对话完成`, turn && !turn.isError, turn ? turn.resultText?.slice(0, 80) ?? '' : `超时(${TIMEOUT_MS}ms)`)
  check(`[${kind}] 回复内容合理`, expectPattern.test(text) || expectPattern.test(turn?.resultText ?? ''), (text || turn?.resultText || '').slice(0, 80))
  await invoke('sessions:close', meta.id).catch(() => undefined)
}

async function run() {
  require(path.join(repoOut, 'index.js'))
  await new Promise((r) => setTimeout(r, 900))

  const engines = await invoke('engines:list')
  console.log('引擎清单:', engines.map((e) => `${e.kind}:${e.available ? '可用' : '不可用'}`).join(' '))

  const codex = engines.find((e) => e.kind === 'codex')
  if (codex?.available) {
    await testEngine('codex', '只回复两个字:收到', /收到|received|ok/i)
  } else {
    skip('codex 引擎', 'CLI 未安装或未登录(探测不可用)')
  }

  const gemini = engines.find((e) => e.kind === 'gemini')
  if (gemini?.available) {
    await testEngine('gemini', '只回复两个字:收到', /收到|received|ok/i)
  } else {
    skip('gemini 引擎', 'CLI 未安装或未登录(探测不可用)')
  }

  return finish(results.every((r) => r.ok) ? 0 : 1)
}
function finish(code) {
  const pass = results.filter((r) => r.ok).length
  console.log(`\ncli-engines e2e: ${pass}/${results.length} 通过`)
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
app.whenReady().then(() => run().catch((e) => { console.error(e); finish(1) }))
