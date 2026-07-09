const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const http = require('node:http')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const root = process.env.CAOGEN_COMPLETION_GAP_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-completion-gap-'))
const phase = process.env.CAOGEN_COMPLETION_GAP_PHASE || 'write'
const userData = path.join(root, 'userData')
const projectDir = path.join(root, 'project')
const marker = 'CG-WF-010-MARKER'

process.env.CAOGEN_USER_DATA_DIR = userData
process.env.CAOGEN_MEMORY_DIR = path.join(root, 'memory')
fs.mkdirSync(projectDir, { recursive: true })

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}

async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

function sessionsJsonText() {
  try {
    return fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8')
  } catch {
    return ''
  }
}

function activeRegistryText() {
  try {
    return fs.readFileSync(path.join(userData, 'active-sessions.json'), 'utf8')
  } catch {
    return ''
  }
}

function readPhaseState() {
  return JSON.parse(fs.readFileSync(path.join(root, 'phase-state.json'), 'utf8'))
}

function writePhaseState(value) {
  fs.writeFileSync(path.join(root, 'phase-state.json'), JSON.stringify(value, null, 2))
}

function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn()
        if (value) return resolve(value)
      } catch {
        // keep polling
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(label))
      setTimeout(tick, 150)
    }
    void tick()
  })
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function withMockResponsesServer(fn) {
  const server = http.createServer((req, res) => {
    if (!req.url.endsWith('/v1/responses')) {
      res.writeHead(404).end()
      return
    }
    req.resume()
    sse(res, [
      { type: 'response.output_text.delta', delta: `restored ${marker}` },
      { type: 'response.completed', response: { id: `resp_${Date.now()}`, usage: { input_tokens: 12, output_tokens: 4 } } }
    ])
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function phaseWrite() {
  await withMockResponsesServer(async (baseUrl) => {
    const invalidCwd = path.join(projectDir, '__path_does_not_exist__')
    const provider = await invoke('providers:create', {
      name: 'Completion Gap Mock',
      baseUrl,
      token: 'mock-key',
      models: ['mock-responses'],
      openaiProtocol: 'responses'
    })

    let invalidError = ''
    try {
      await invoke('sessions:create', {
        cwd: invalidCwd,
        engine: 'openai',
        providerId: provider.id,
        model: 'mock-responses',
        isolated: false
      })
    } catch (err) {
      invalidError = err instanceof Error ? err.message : String(err)
    }
    check('CG-FW-007 invalid cwd rejected', invalidError.includes('项目路径不存在'), invalidError)
    check('CG-FW-007 invalid cwd not persisted', !sessionsJsonText().includes('__path_does_not_exist__'))
    const afterInvalid = await invoke('sessions:list')
    check('CG-FW-007 invalid cwd not active', !afterInvalid.some((item) => item.cwd === invalidCwd))

    const meta = await invoke('sessions:create', {
      cwd: projectDir,
      engine: 'openai',
      providerId: provider.id,
      model: 'mock-responses',
      isolated: false,
      permissionMode: 'bypassPermissions'
    })
    const initialized = await waitFor(
      async () => (await invoke('sessions:list')).find((item) => item.id === meta.id && item.sdkSessionId),
      3000,
      'session sdkSessionId not initialized'
    )
    await invoke('files:write', meta.id, 'marker.txt', marker)
    const readBack = await invoke('files:read', meta.id, 'marker.txt')
    check('CG-WF-010B file IPC works before restart', readBack.ok && readBack.content.includes(marker))
    await invoke('sessions:send', meta.id, { text: marker })
    await waitFor(
      async () => (await invoke('sessions:transcript', meta.id)).some((entry) => entry.event.kind === 'turn-result'),
      8000,
      'turn did not complete before restart'
    )
    const transcript = await invoke('sessions:transcript', meta.id)
    check('CG-WF-010A transcript contains marker', JSON.stringify(transcript).includes(marker))
    check('CG-WF-010A sessions.json contains marker', sessionsJsonText().includes(marker))
    check('CG-WF-010A active registry contains session', activeRegistryText().includes(meta.id))

    const terminal = await invoke('terminals:start', meta.id, { cols: 80, rows: 24, reuse: true })
    check('CG-WF-010B terminal IPC starts before restart', terminal && terminal.id)
    if (terminal?.id) await invoke('terminals:close', terminal.id)

    writePhaseState({ sessionId: meta.id, sdkSessionId: initialized.sdkSessionId, providerId: provider.id })
  })
}

async function phaseRestore() {
  const state = readPhaseState()
  const restored = await waitFor(
    async () => (await invoke('sessions:list')).find((item) => item.id === state.sessionId),
    5000,
    'active session was not restored on restart'
  )
  check('CG-FW-006 active session restored on restart', restored && restored.sdkSessionId === state.sdkSessionId)
  check('CG-FW-006 restored cwd rebound', restored.cwd === projectDir, restored.cwd)
  check('CG-FW-006 restored provider rebound', restored.providerId === state.providerId, restored.providerId)
  check('CG-FW-006 restored model rebound', restored.model === 'mock-responses', restored.model)

  const transcript = await invoke('sessions:transcript', state.sessionId)
  check('CG-WF-010A restored transcript contains marker', JSON.stringify(transcript).includes(marker))
  check('CG-WF-010A restored history contains marker', sessionsJsonText().includes(marker))

  const readBack = await invoke('files:read', state.sessionId, 'marker.txt')
  check('CG-WF-010B file IPC reads after restart', readBack.ok && readBack.content.includes(marker))
  const writeBack = await invoke('files:write', state.sessionId, 'restored.txt', 'after restart')
  check('CG-WF-010B file IPC writes after restart', writeBack.ok && fs.existsSync(path.join(projectDir, 'restored.txt')))
  const terminal = await invoke('terminals:start', state.sessionId, { cols: 80, rows: 24, reuse: true })
  check('CG-WF-010B terminal IPC starts after restart', terminal && terminal.id)
  if (terminal?.id) await invoke('terminals:close', terminal.id)
}

async function run() {
  require(path.join(repoOut, 'index.js'))
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (phase === 'restore') await phaseRestore()
  else await phaseWrite()
  finish(results.every((item) => item.ok) ? 0 : 1)
}

function finish(code) {
  const pass = results.filter((item) => item.ok).length
  const report = { phase, root, pass, total: results.length, ok: code === 0, results }
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true })
  fs.writeFileSync(path.join(root, 'reports', `${phase}.json`), JSON.stringify(report, null, 2))
  console.log(`\ncompletion-gap ${phase}: ${pass}/${results.length} 通过`)
  app.exit(code)
}

app.whenReady().then(() => run().catch((err) => {
  console.error(err)
  check(`${phase} crashed`, false, err instanceof Error ? err.message : String(err))
  finish(1)
}))
