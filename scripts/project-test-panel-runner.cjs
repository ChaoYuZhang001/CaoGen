const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const root = requiredEnv('CAOGEN_PROJECT_TEST_PANEL_ROOT')
const statePath = requiredEnv('CAOGEN_PROJECT_TEST_PANEL_STATE')
const screenshotDir = requiredEnv('CAOGEN_PROJECT_TEST_PANEL_SCREENSHOTS')
const projectDir = path.join(root, 'project')
process.env.CAOGEN_USER_DATA_DIR = path.join(root, 'userData')
process.env.CAOGEN_MEMORY_DIR = path.join(root, 'memory')
fs.mkdirSync(projectDir, { recursive: true })
fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
  name: 'caogen-project-test-panel-fixture',
  private: true,
  scripts: {
    test: 'node -e "console.log(\'panel-pass\')"',
    'test:fail': 'node -e "console.error(\'panel-failure\'); process.exit(7)"',
    build: 'node -e "console.log(\'excluded\')"'
  }
}, null, 2))

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  require(path.join(repoRoot, 'out', 'main', 'index.js'))
  await waitFor(() => ipcMain._invokeHandlers?.has('providers:create') && ipcMain._invokeHandlers?.has('sessions:create'), 10_000)
  const provider = await invoke('providers:create', {
    name: 'Project Test Mock',
    baseUrl: 'http://127.0.0.1:9',
    token: 'test-only',
    models: ['mock-tests'],
    engine: 'openai',
    openaiProtocol: 'responses'
  })
  const session = await invoke('sessions:create', {
    cwd: projectDir,
    engine: 'openai',
    providerId: provider.id,
    model: 'mock-tests',
    routingScope: 'fixed',
    taskStrategy: 'execute',
    isolated: false,
    title: 'Project Tests'
  })
  const win = await waitForWindow()
  win.setSize(1200, 800)
  win.webContents.reload()
  await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
  await selectSession(win, session.id)
  await openTests(win)

  check('Code workspace exposes Files, Tests, Debug, and Refactor as first-level tabs',
    await rendererValue(win, `document.querySelectorAll('.developer-panel-tabs [role="tab"]').length === 4`))
  check('test discovery exposes only supported package scripts',
    await rendererValue(win, `document.querySelectorAll('[data-project-test-command="package-script"]').length === 2`))
  check('non-test build script is excluded',
    await rendererValue(win, `![...document.querySelectorAll('.test-command-copy strong')].some((item) => item.textContent.includes('build'))`))

  await runCommand(win, 'npm run test')
  await waitForRenderer(win, `document.querySelector('[data-project-test-result="passed"]') !== null`, 20_000)
  check('passing test renders a structured passed result',
    await rendererValue(win, `document.querySelector('[data-project-test-result="passed"]') !== null`))
  check('passing stdout is visible',
    await rendererValue(win, `document.querySelector('.test-output')?.textContent.includes('panel-pass')`))
  check('passing result includes an immutable evidence ID',
    await rendererValue(win, `Boolean(document.querySelector('[data-project-test-evidence] code')?.textContent.trim())`))

  await runCommand(win, 'npm run test:fail')
  await waitForRenderer(win, `document.querySelector('[data-project-test-result="failed"]') !== null`, 20_000)
  check('failing test renders a structured failed result',
    await rendererValue(win, `document.querySelector('[data-project-test-result="failed"]') !== null`))
  check('failing result preserves exit code 7',
    await rendererValue(win, `document.querySelector('.test-result-summary')?.textContent.includes('7')`))
  check('stderr tab exposes bounded failure output',
    await rendererValue(win, `(() => { const tabs = document.querySelectorAll('.test-output-tabs button'); tabs[1]?.click(); return true })()`)
      && await waitForRenderer(win, `document.querySelector('.test-output')?.textContent.includes('panel-failure')`))
  await capture(win, 'project-test-panel-desktop.png')

  win.setSize(760, 700)
  await waitForRenderer(win, `window.innerWidth <= 760`)
  await settleRenderer(win)
  const layout = await rendererValue(win, `(() => {
    const panel = document.querySelector('.test-panel');
    const side = document.querySelector('.workbench-side');
    const output = document.querySelector('.test-output');
    const panelRect = panel?.getBoundingClientRect();
    const sideRect = side?.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      panelContained: Boolean(panelRect && panelRect.left >= -1 && panelRect.right <= innerWidth + 1),
      panelFillsSide: Boolean(panelRect && sideRect && Math.abs(panelRect.width - sideRect.width) <= 1),
      outputUsable: Boolean(output && output.clientWidth >= 220 && output.clientHeight >= 80),
      outputSize: output ? [output.clientWidth, output.clientHeight] : [0, 0],
      commandContained: [...document.querySelectorAll('.test-command-row')].every((row) => row.scrollWidth <= row.clientWidth + 1)
    };
  })()`)
  check('760x700 test panel has no horizontal overflow', !layout.documentOverflow && layout.panelContained && layout.panelFillsSide, JSON.stringify(layout))
  check('compact command rows and output remain usable', layout.outputUsable && layout.commandContained, JSON.stringify(layout))
  await capture(win, 'project-test-panel-compact.png')

  fs.writeFileSync(statePath, `${JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: ['project-test-panel-desktop.png', 'project-test-panel-compact.png'],
    checks
  }, null, 2)}\n`)
  app.exit(0)
}

async function selectSession(win, sessionId) {
  await waitForRenderer(win, `Boolean(document.querySelector('.session-card[data-session-id="${sessionId}"]'))`)
  await rendererValue(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.classList.contains('active')`)
}

async function openTests(win) {
  await rendererValue(win, `document.querySelector('[data-experience-mode-option="studio"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.experience-pane')?.getAttribute('data-experience-mode') === 'studio'`)
  await rendererValue(win, `document.querySelector('[data-studio-projection-tab="session"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.experience-pane')?.getAttribute('data-studio-surface') === 'session'`)
  await rendererValue(win, `document.querySelector('.desk-rail-drawer-anchor .desk-rail-button')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.desk-tool-item').length >= 4`)
  await rendererValue(win, `document.querySelector('.desk-tool-item:nth-child(4)')?.click()`)
  await waitForRenderer(win, `document.querySelector('.developer-panel') !== null`)
  await rendererValue(win, `document.querySelector('.developer-panel-tabs button:nth-child(2)')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-project-test-panel]')?.checkVisibility() === true`)
  await waitForRenderer(win, `[...document.querySelectorAll('[data-project-test-command]')].filter((item) => item.checkVisibility()).length === 2`)
}

async function runCommand(win, label) {
  await rendererValue(win, `(() => {
    const row = [...document.querySelectorAll('[data-project-test-command]')]
      .find((item) => item.querySelector('strong')?.textContent === ${JSON.stringify(label)});
    row?.querySelector('button')?.click();
  })()`)
}

async function capture(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  await waitForRenderer(win, `location.protocol === 'file:'`)
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}

function waitForWindow() {
  return waitFor(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()), 10_000)
}

function waitForRenderer(win, expression, timeoutMs = 10_000) {
  return waitFor(async () => {
    try { return await rendererValue(win, expression) } catch { return false }
  }, timeoutMs)
}

function rendererValue(win, expression) {
  return win.webContents.executeJavaScript(expression, true)
}

async function settleRenderer(win) {
  await rendererValue(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 180))
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch { /* main and renderer state settle independently */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('project test panel E2E wait timed out'))
      setTimeout(() => void poll(), 80)
    }
    void poll()
  })
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

app.whenReady().then(() => run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  app.exit(1)
}))
