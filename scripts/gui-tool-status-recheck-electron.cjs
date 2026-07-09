const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const http = require('node:http')
const { app, ipcMain, desktopCapturer, nativeImage } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-gui-status-'))
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-gui-work-'))
const reportPath = path.resolve(__dirname, '..', 'test-results', 'gui-tool-status-recheck', 'latest.json')
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

const results = []
const requestBodies = []

function patchDesktopCapturer() {
  const thumbnail = nativeImage.createFromBitmap(
    Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255
    ]),
    { width: 2, height: 2 }
  )
  const appIcon = nativeImage.createEmpty()
  desktopCapturer.getSources = async () => [
    {
      id: 'screen:caogen-test:0',
      name: 'CaoGen Test Screen',
      display_id: 'caogen-test-display',
      appIcon,
      thumbnail
    }
  ]
}

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`)
}

async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  return map.get(channel)({}, ...args)
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function functionCall(outputIndex, callId, name, args, responseId) {
  return [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(args)
      }
    },
    {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(args)
      }
    },
    { type: 'response.completed', response: { id: responseId, usage: { input_tokens: 10, output_tokens: 3 } } }
  ]
}

let callSeq = 0
const server = http.createServer((req, res) => {
  if (!req.url.endsWith('/v1/responses')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}')
    requestBodies.push(parsed)
    callSeq += 1
    if (callSeq === 1) {
      sse(res, functionCall(0, 'call_gui_list', 'gui_list_windows', {}, 'resp_gui_1'))
      return
    }
    if (callSeq === 2) {
      sse(
        res,
        functionCall(
          0,
          'call_gui_screen_ok',
          'gui_screenshot',
          { savePath: '.caogen/tmp/gui/screenshots/recheck.png', maxWidth: 320 },
          'resp_gui_2'
        )
      )
      return
    }
    if (callSeq === 3) {
      sse(res, functionCall(0, 'call_gui_screen_bad', 'gui_screenshot', { savePath: '../outside.png' }, 'resp_gui_3'))
      return
    }
    sse(res, [
      { type: 'response.output_text.delta', delta: '模型声称 GUI 自动化已经完成' },
      { type: 'response.completed', response: { id: 'resp_gui_4', usage: { input_tokens: 12, output_tokens: 6 } } }
    ])
  })
})

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

function readAuditRecords() {
  const auditPath = path.join(workDir, '.caogen', 'audit.log')
  if (!fs.existsSync(auditPath)) return []
  return fs
    .readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function run() {
  patchDesktopCapturer()
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  require(path.join(repoOut, 'index.js'))
  await new Promise((resolve) => setTimeout(resolve, 900))
  await invoke('settings:update', {
    failoverEnabled: false,
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: Date.now() + 10 * 60 * 1000
  })

  const provider = await invoke('providers:create', {
    name: 'mock-gui-status',
    baseUrl: `http://127.0.0.1:${port}`,
    token: 'mock-key',
    models: ['mock-gui'],
    openaiProtocol: 'responses'
  })
  const meta = await invoke('sessions:create', {
    cwd: workDir,
    engine: 'openai',
    providerId: provider.id,
    model: 'mock-gui',
    isolated: false,
    permissionMode: 'bypassPermissions'
  })

  await invoke('sessions:send', meta.id, { text: '执行 GUI 状态回归' })
  const entries = await waitFor(
    async () => {
      const transcript = await invoke('sessions:transcript', meta.id)
      return transcript.find((entry) => entry.event.kind === 'turn-result') ? transcript : null
    },
    20000,
    '等待 GUI turn-result 超时'
  )
  const turn = entries.find((entry) => entry.event.kind === 'turn-result')?.event
  const toolResults = entries.filter((entry) => entry.event.kind === 'tool-result').map((entry) => entry.event)
  const auditRecords = readAuditRecords()
  const goodScreenshot = path.join(workDir, '.caogen', 'tmp', 'gui', 'screenshots', 'recheck.png')
  const outsidePath = path.resolve(workDir, '..', 'outside.png')

  check('gui_list_windows tool-result ok', toolResults.some((event) => event.toolUseId === 'call_gui_list' && !event.isError))
  check('gui_screenshot valid path tool-result ok', toolResults.some((event) => event.toolUseId === 'call_gui_screen_ok' && !event.isError))
  check('valid gui_screenshot wrote inside project', fs.existsSync(goodScreenshot), goodScreenshot)
  check('gui_screenshot outside path tool-result error', toolResults.some((event) => event.toolUseId === 'call_gui_screen_bad' && event.isError))
  check('outside screenshot path was not created', !fs.existsSync(outsidePath), outsidePath)
  check(
    'final turn fails despite model final text',
    turn?.isError === true && turn?.subtype === 'tool-error' && String(turn?.resultText || '').includes('gui_screenshot'),
    JSON.stringify(turn)
  )
  check(
    'audit contains gui_list_windows ok:true',
    auditRecords.some((record) => record.action === 'execute' && record.toolName === 'gui_list_windows' && record.ok === true),
    JSON.stringify(auditRecords.filter((record) => record.toolName === 'gui_list_windows')).slice(0, 200)
  )
  check(
    'audit contains gui_screenshot ok:true and ok:false',
    auditRecords.some((record) => record.action === 'execute' && record.toolName === 'gui_screenshot' && record.ok === true) &&
      auditRecords.some((record) => record.action === 'execute' && record.toolName === 'gui_screenshot' && record.ok === false),
    JSON.stringify(auditRecords.filter((record) => record.toolName === 'gui_screenshot')).slice(0, 240)
  )
  check(
    'responses continue used previous_response_id across GUI tools',
    requestBodies[1]?.previous_response_id === 'resp_gui_1' && requestBodies[2]?.previous_response_id === 'resp_gui_2',
    JSON.stringify(requestBodies.map((body) => body.previous_response_id))
  )

  finish(results.every((item) => item.ok) ? 0 : 1)
}

function finish(code) {
  const pass = results.filter((item) => item.ok).length
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ok: code === 0,
        generatedAt: new Date().toISOString(),
        pass,
        total: results.length,
        requestCount: requestBodies.length,
        workDir,
        results
      },
      null,
      2
    )
  )
  console.log(`\ngui-tool-status-recheck: ${pass}/${results.length} 通过`)
  console.log(`gui status report: ${reportPath}`)
  server.close()
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true })
    if (process.env.CAOGEN_KEEP_GUI_STATUS_ROOT !== '1') fs.rmSync(workDir, { recursive: true, force: true })
  } catch {}
  app.exit(code)
}

app.whenReady().then(() =>
  run().catch((error) => {
    console.error(error)
    check('gui-tool-status-recheck crashed', false, error instanceof Error ? error.message : String(error))
    finish(1)
  })
)
