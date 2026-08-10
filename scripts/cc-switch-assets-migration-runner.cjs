const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const home = requiredEnv('CAOGEN_MIGRATION_TEST_HOME')
const statePath = requiredEnv('CAOGEN_CC_SWITCH_ASSETS_E2E_STATE')
const screenshotDir = requiredEnv('CAOGEN_CC_SWITCH_ASSETS_E2E_SCREENSHOT_DIR')
const secret = requiredEnv('CAOGEN_CC_SWITCH_ASSETS_E2E_SECRET')
const checks = []

function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  require(path.join(repoRoot, 'out', 'main', 'index.js'))
  await waitFor(() => ipcMain._invokeHandlers?.has('migration:scan'), 10_000)
  const win = await openMigrationSettings()
  const preview = await scanPreview(win)
  await applyAssets(win, preview)
  await rollbackAssets(win)
  writeReport()
  app.exit(0)
}

async function scanPreview(win) {
  const clicked = await rendererValue(win, `(() => {
    const button = document.querySelector('[data-migration-scan]');
    button?.click();
    return Boolean(button);
  })()`)
  check('Migration scan action is visible', clicked)
  await waitForRenderer(win, `document.querySelectorAll('[data-migration-asset]').length === 5`)
  await settleRenderer(win)
  const preview = await rendererValue(win, `(() => {
    const rows = [...document.querySelectorAll('[data-migration-asset]')].map((row) => ({
      kind: row.getAttribute('data-migration-kind'),
      risk: row.getAttribute('data-migration-risk'),
      disabled: row.querySelector('input')?.disabled === true,
      text: row.innerText
    }));
    return {
      rows,
      hasSecret: document.body.innerText.includes(${JSON.stringify(secret)}),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  })()`)
  check('UI classifies MCP, two Prompts, Skill, and usage',
    preview.rows.filter((row) => row.kind === 'mcp').length === 1
      && preview.rows.filter((row) => row.kind === 'prompt').length === 2
      && preview.rows.filter((row) => row.kind === 'skill').length === 1
      && preview.rows.filter((row) => row.kind === 'usage').length === 1,
    JSON.stringify(preview.rows.map(({ kind, risk }) => ({ kind, risk }))))
  check('Secret-bearing Prompt is blocked and disabled',
    preview.rows.some((row) => row.kind === 'prompt' && row.risk === 'blocked' && row.disabled))
  check('Renderer contains no source credential', !preview.hasSecret)
  check('Desktop migration preview has no horizontal overflow', !preview.overflow)
  await capture(win, 'cc-switch-assets-preview.png')
  return preview
}

async function applyAssets(win) {
  const selected = await rendererValue(win, `(() => {
    const inputs = [...document.querySelectorAll('[data-migration-asset] input:not(:disabled)')];
    for (const input of inputs) if (!input.checked) input.click();
    return inputs.length;
  })()`)
  check('Four importable assets can be selected', selected === 4, JSON.stringify({ selected }))
  await rendererValue(win, `document.querySelector('[data-migration-apply]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-migration-rollback]'))`)

  const settingsPath = path.join(home, '.claude', 'settings.json')
  const skillsRoot = path.join(home, '.caogen', 'skills')
  const usagePath = path.join(home, '.caogen', 'usage', 'cc-switch-daily-rollups.json')
  const settingsText = fs.readFileSync(settingsPath, 'utf8')
  const skillDirectories = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const skillTexts = skillDirectories.map((entry) => fs.readFileSync(path.join(skillsRoot, entry.name, 'SKILL.md'), 'utf8'))
  check('MCP target is written through the managed configuration', settingsText.includes('Fixture MCP E2E'))
  check('MCP target strips environment and credential values', !settingsText.includes(secret) && !settingsText.includes('"env"'))
  check('Prompt and Skill are materialized as CaoGen Skills',
    skillDirectories.length === 2
      && skillTexts.some((text) => text.includes('Safe prompt body from CC Switch.'))
      && skillTexts.some((text) => text.includes('Use the safe fixture workflow.')))
  check('Applied targets contain no source credential', !skillTexts.join('\n').includes(secret))
  const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
  check('Historical usage is stored as an external daily rollup',
    usage.rows.length === 1 && usage.rows[0].requestCount === 4 && !JSON.stringify(usage).includes(secret))
  const usageSummary = await invoke('providers:usage', {
    from: new Date(2026, 7, 9).getTime(),
    to: new Date(2026, 7, 10).getTime(),
    limit: 10
  })
  check('Provider Usage merges imported request, token, cost, and success totals',
    usageSummary.historicalRequests === 4
      && usageSummary.requests === 4
      && usageSummary.succeeded === 3
      && usageSummary.inputTokens === 160
      && usageSummary.costUsd === 0.002)
  check('Imported rollups do not impersonate native recent requests',
    usageSummary.nativeRequests === 0 && usageSummary.recentRequests.length === 0)
  await capture(win, 'cc-switch-assets-applied.png')
}

async function rollbackAssets(win) {
  await rendererValue(win, `document.querySelector('[data-migration-rollback]')?.click()`)
  const settingsPath = path.join(home, '.claude', 'settings.json')
  const skillsRoot = path.join(home, '.caogen', 'skills')
  const usagePath = path.join(home, '.caogen', 'usage', 'cc-switch-daily-rollups.json')
  await waitFor(() => !fs.existsSync(settingsPath) && countDirectories(skillsRoot) === 0 && !fs.existsSync(usagePath), 10_000)
  check('UI rollback removes the imported MCP target', !fs.existsSync(settingsPath))
  check('UI rollback removes imported Prompt and Skill targets', countDirectories(skillsRoot) === 0)
  check('UI rollback removes imported historical usage', !fs.existsSync(usagePath))
  const usageAfterRollback = await invoke('providers:usage', {
    from: new Date(2026, 7, 9).getTime(),
    to: new Date(2026, 7, 10).getTime(),
    limit: 10
  })
  check('Provider Usage removes historical totals after rollback', usageAfterRollback.historicalRequests === 0)
  check('Source CC Switch database remains present', fs.existsSync(path.join(home, '.cc-switch', 'cc-switch.db')))
}

async function openMigrationSettings() {
  const win = await waitForWindow()
  win.setSize(1200, 900)
  await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
  await rendererValue(win, `([...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent.trim().includes('\u8bbe\u7f6e')))?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('.settings-page'))`)
  await rendererValue(win, `document.querySelector('[data-settings-tab="migrate"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-migration-manager]'))`)
  return win
}

function writeReport() {
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: [
      path.join(screenshotDir, 'cc-switch-assets-preview.png'),
      path.join(screenshotDir, 'cc-switch-assets-applied.png')
    ],
    checks
  }
  const raw = `${JSON.stringify(report, null, 2)}\n`
  if (raw.includes(secret)) throw new Error('CC Switch assets E2E report contains credential material')
  fs.writeFileSync(statePath, raw)
}

function countDirectories(directory) {
  if (!fs.existsSync(directory)) return 0
  return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
}

async function capture(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
}

function waitForWindow() {
  return waitFor(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()), 10_000)
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
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
      } catch { /* startup and file publication are asynchronous */ }
      if (Date.now() - started > timeoutMs) return reject(new Error('CC Switch assets E2E wait timed out'))
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
