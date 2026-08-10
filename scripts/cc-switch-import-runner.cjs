const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const userDataDir = requiredEnv('CAOGEN_CC_SWITCH_E2E_USER_DATA')
const statePath = requiredEnv('CAOGEN_CC_SWITCH_E2E_STATE')
const screenshotDir = requiredEnv('CAOGEN_CC_SWITCH_E2E_SCREENSHOT_DIR')
const secret = requiredEnv('CAOGEN_CC_SWITCH_E2E_SECRET')
process.env.CAOGEN_USER_DATA_DIR = userDataDir

const checks = []

function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  require(outMain)
  await waitFor(() => ipcMain._invokeHandlers?.has('appFeatures:invoke'), 10_000)
  const win = await openProviderSettings()
  await scanAndVerifyPreview(win)
  const backups = await applyAndVerifyImport(win)
  await verifyCompactPreview(win)
  await rollbackAndVerify(backups)
  writeReport()
  app.exit(0)
}

async function scanAndVerifyPreview(win) {
  const clicked = await rendererValue(win, `(() => {
    const button = document.querySelector('[data-cc-switch-scan]');
    button?.click();
    return Boolean(button);
  })()`)
  check('CC Switch scan action is visible in Provider settings', clicked)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-cc-switch-preview]'))`)
  await settleRenderer(win)
  const preview = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-cc-switch-preview]');
    const rect = panel.getBoundingClientRect();
    return {
      text: panel.innerText,
      rows: panel.querySelectorAll('.cc-switch-import-row').length,
      actions: [...panel.querySelectorAll('.cc-switch-import-row select')].map((node) => node.value),
      hasSecret: document.body.innerText.includes(${JSON.stringify(secret)}),
      insideViewport: rect.left >= 0 && rect.right <= innerWidth + 1,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  })()`)
  check('preview renders both CC Switch Providers', preview.rows === 2, JSON.stringify({ rows: preview.rows }))
  check('preview maps Codex Chat and Claude Anthropic protocols',
    preview.text.includes('OpenAI Chat Completions') && preview.text.includes('Anthropic Messages'))
  check('new Providers default to create', preview.actions.every((action) => action === 'create'), JSON.stringify(preview.actions))
  check('preview shows pricing, monthly budget, and daily-limit status',
    preview.text.includes('$20') && preview.text.includes('\u5b9a\u4ef7') && preview.text.includes('\u65e5\u9650\u989d'))
  check('desktop preview is contained and contains no credential',
    preview.insideViewport && !preview.documentOverflow && !preview.hasSecret)
  await capture(win, 'cc-switch-import-preview.png')
}

async function applyAndVerifyImport(win) {
  await rendererValue(win, `document.querySelector('[data-cc-switch-preview] .btn-primary')?.click()`)
  await waitForRenderer(win, `!document.querySelector('[data-cc-switch-preview]')`)
  const providers = await invoke('providers:list')
  const codex = providers.find((provider) => provider.name === 'CC Switch Codex E2E')
  const claude = providers.find((provider) => provider.name === 'CC Switch Claude E2E')
  check('UI apply creates two ready Providers', codex?.ready && claude?.ready && providers.length === 2)
  check('UI apply retains imported model, budget, and multiplied pricing',
    codex?.models?.includes('cc-switch-model')
      && codex?.budgetUsd === 20
      && codex?.advancedConfig?.modelProfiles?.[0]?.pricing?.inputPerMillion === 3)
  const backups = await invokeProfile('cc-switch-backups')
  check('UI apply creates one batch rollback record', backups.length === 1 && backups[0].providerCount === 2)
  const backupRoot = path.join(userDataDir, 'cc-switch-provider-import-backups')
  const backupText = fs.readdirSync(backupRoot).map((name) => fs.readFileSync(path.join(backupRoot, name), 'utf8')).join('\n')
  check('batch rollback record excludes plaintext credentials', !backupText.includes(secret) && !backupText.includes('encryptedToken'))
  return backups
}

async function verifyCompactPreview(win) {
  win.setSize(700, 850)
  await rendererValue(win, `document.querySelector('[data-cc-switch-scan]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-cc-switch-preview]'))`)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-cc-switch-preview]');
    const facts = panel.querySelector('.cc-switch-import-facts');
    const rect = panel.getBoundingClientRect();
    return {
      columns: getComputedStyle(facts).gridTemplateColumns.split(' ').length,
      insideViewport: rect.left >= 0 && rect.right <= innerWidth + 1,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      hasSecret: document.body.innerText.includes(${JSON.stringify(secret)})
    };
  })()`)
  check('compact preview uses two fact columns with no overflow or credential exposure',
    compact.columns === 2 && compact.insideViewport && !compact.documentOverflow && !compact.hasSecret,
    JSON.stringify(compact))
  await capture(win, 'cc-switch-import-preview-compact.png')
}

async function rollbackAndVerify(backups) {
  await invokeProfile('cc-switch-rollback', backups[0].id)
  check('batch rollback removes both imported Providers', (await invoke('providers:list')).length === 0)
  check('rolled-back batch is no longer offered', (await invokeProfile('cc-switch-backups')).length === 0)
}

function writeReport() {
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: [
      path.join(screenshotDir, 'cc-switch-import-preview.png'),
      path.join(screenshotDir, 'cc-switch-import-preview-compact.png')
    ],
    checks
  }
  const raw = `${JSON.stringify(report, null, 2)}\n`
  if (raw.includes(secret)) throw new Error('CC Switch import E2E report contains credential material')
  fs.writeFileSync(statePath, raw)
}

function invokeProfile(action, ...args) {
  return invoke('appFeatures:invoke', 'provider-profile', action, ...args)
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  await waitForRenderer(win, `location.protocol === 'file:'`)
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}

async function openProviderSettings() {
  const win = await waitForWindow()
  win.setSize(1200, 900)
  await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
  await rendererValue(win, `([...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent.trim().includes('\u8bbe\u7f6e')))?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('.settings-page'))`)
  await rendererValue(win, `document.querySelector('[data-settings-tab="providers"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-cc-switch-scan]'))`)
  return win
}

async function capture(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
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
  await new Promise((resolve) => setTimeout(resolve, 250))
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch { /* startup is asynchronous */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('CC Switch import E2E wait timed out'))
      setTimeout(() => void poll(), 100)
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
