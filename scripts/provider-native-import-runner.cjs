const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const userDataDir = requiredEnv('CAOGEN_PROVIDER_NATIVE_USER_DATA')
const statePath = requiredEnv('CAOGEN_PROVIDER_NATIVE_STATE')
const screenshotDir = requiredEnv('CAOGEN_PROVIDER_NATIVE_SCREENSHOT_DIR')
const secret = requiredEnv('CAOGEN_PROVIDER_NATIVE_SECRET')
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
  await verifyNativeConfigWorkspace(win)
  const clicked = await rendererValue(win, `(() => {
    const button = document.querySelector('[data-provider-native-scan]');
    button?.click();
    return Boolean(button);
  })()`)
  check('native Codex scan action is visible in Provider settings', clicked)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-native-preview]'))`)
  await settleRenderer(win)

  const previewUi = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-native-preview]');
    const body = document.body.innerText;
    const rect = panel.getBoundingClientRect();
    return {
      text: panel.innerText,
      hasSecret: body.includes(${JSON.stringify(secret)}),
      diffRows: panel.querySelectorAll('.provider-native-diff:not(.provider-native-diff-head)').length,
      facts: panel.querySelectorAll('.provider-native-summary > div').length,
      action: panel.querySelector('select')?.value,
      insideViewport: rect.left >= 0 && rect.right <= innerWidth + 1
    };
  })()`)
  check('native preview renders source, protocol, model, runtime, and ignored sections',
    ['config.toml', 'auth.json', 'OpenAI Responses', 'gpt-native-e2e', 'reasoningEffort=high', 'features']
      .every((value) => previewUi.text.includes(value)), JSON.stringify({ diffRows: previewUi.diffRows, facts: previewUi.facts }))
  check('native preview defaults to create for a new target', previewUi.action === 'create')
  check('native preview contains structured facts and diffs', previewUi.facts === 4 && previewUi.diffRows >= 6)
  check('native preview never renders the API key', !previewUi.hasSecret)
  check('native import warnings follow the active UI language',
    previewUi.text.includes('\u5df2\u5217\u51fa\u975e Provider \u7684 Codex \u914d\u7f6e')
      && !previewUi.text.includes('Non-Provider Codex settings'))
  check('desktop preview remains inside the viewport', previewUi.insideViewport)
  await capture(win, 'codex-native-import-preview.png')

  const applied = await rendererValue(win, `(() => {
    const button = document.querySelector('[data-provider-native-preview] .btn-primary');
    button?.click();
    return Boolean(button);
  })()`)
  check('native import can be applied from the preview', applied)
  await waitForRenderer(win, `!document.querySelector('[data-provider-native-preview]')`)
  await waitForRenderer(win, `document.body.innerText.includes('Codex Native E2E')`)
  const providers = await invoke('providers:list')
  const imported = providers.find((provider) => provider.name === 'Codex Native E2E')
  check('applied native Provider is ready with the imported model',
    imported?.ready === true && imported?.hasToken === true && imported?.models?.includes('gpt-native-e2e'))
  const backups = await invokeProfile('native-backups')
  check('apply creates a credential-scrubbed rollback record', backups.length === 1 && backups[0].providerId === imported.id)
  const backupRoot = path.join(userDataDir, 'provider-native-import-backups')
  const backupRaw = fs.readdirSync(backupRoot).map((name) => fs.readFileSync(path.join(backupRoot, name), 'utf8')).join('\n')
  check('native rollback files contain no credential material', !backupRaw.includes(secret) && !backupRaw.includes('encryptedToken'))
  check('renderer body remains free of credential material after apply',
    !(await rendererValue(win, `document.body.innerText.includes(${JSON.stringify(secret)})`)))

  win.setSize(700, 850)
  await rendererValue(win, `document.querySelector('[data-provider-native-scan]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-native-preview]'))`)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => {
    const panel = document.querySelector('[data-provider-native-preview]');
    const rect = panel.getBoundingClientRect();
    return {
      columns: getComputedStyle(panel.querySelector('.provider-native-summary')).gridTemplateColumns.split(' ').length,
      insideViewport: rect.left >= 0 && rect.right <= innerWidth + 1,
      bodyOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      hasSecret: document.body.innerText.includes(${JSON.stringify(secret)})
    };
  })()`)
  check('compact preview uses the responsive two-column fact layout', compact.columns === 2, JSON.stringify(compact))
  check('compact preview has no horizontal overflow or credential exposure', compact.insideViewport && compact.bodyOverflow && !compact.hasSecret)
  await capture(win, 'codex-native-import-preview-compact.png')

  await invokeProfile('native-rollback', backups[0].id)
  const rolledBack = await invoke('providers:list')
  check('native create rollback removes the imported Provider', !rolledBack.some((provider) => provider.id === imported.id))
  check('rolled-back native backup is no longer offered', (await invokeProfile('native-backups')).length === 0)

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: [
      path.join(screenshotDir, 'codex-native-config-workspace.png'),
      path.join(screenshotDir, 'codex-native-config-workspace-compact.png'),
      path.join(screenshotDir, 'codex-native-import-preview.png'),
      path.join(screenshotDir, 'codex-native-import-preview-compact.png')
    ],
    checks
  }
  const raw = `${JSON.stringify(report, null, 2)}\n`
  if (raw.includes(secret)) throw new Error('native import E2E report contains credential material')
  fs.writeFileSync(statePath, raw)
  app.exit(0)
}

async function verifyNativeConfigWorkspace(win) {
  const configPath = path.join(requiredEnv('CODEX_HOME'), 'config.toml')
  const originalSource = fs.readFileSync(configPath, 'utf8')
  const opened = await rendererValue(win, `(() => {
    const button = document.querySelector('[data-codex-native-config-open]');
    button?.click();
    return Boolean(button);
  })()`)
  check('full Codex config workspace is visible in Provider settings', opened)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-codex-native-config-editor]'))`)
  const editor = await rendererValue(win, `(() => {
    const root = document.querySelector('[data-codex-native-config-workspace]');
    const textarea = root.querySelector('[data-codex-native-config-editor]');
    return {
      text: root.innerText,
      value: textarea.value,
      metrics: [...root.querySelectorAll('.codex-native-config-meta strong')].map((item) => item.textContent.trim()),
      hasSecret: document.body.innerText.includes(${JSON.stringify(secret)}),
      placeholderCount: (textarea.value.match(/__CAOGEN_PROTECTED_VALUE_/g) || []).length,
      lineNumbers: root.querySelector('.codex-native-config-gutter')?.textContent.trim().split(/\\s+/).length,
      hasSearch: Boolean(root.querySelector('.codex-native-config-search input'))
    };
  })()`)
  check('config workspace summarizes Provider, MCP, project, feature, and plugin sections',
    editor.metrics.join(',') === 'CODEX_HOME,1,0,0,1,0', JSON.stringify(editor.metrics))
  check('config workspace masks credential values and explains normalization',
    !editor.hasSecret
      && editor.placeholderCount === 1
      && editor.text.includes('1 个敏感值')
      && editor.text.includes('TOML 格式会规范化'))
  check('config workspace exposes synchronized line numbers and configuration search',
    editor.hasSearch && editor.lineNumbers === editor.value.split('\n').length,
    JSON.stringify({ lineNumbers: editor.lineNumbers }))

  const changed = await rendererValue(win, `(() => {
    const textarea = document.querySelector('[data-codex-native-config-editor]');
    const next = 'sandbox_mode = "read-only"\\n' + textarea.value;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, next);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return textarea.value.startsWith('sandbox_mode = "read-only"');
  })()`)
  check('raw config editor accepts arbitrary non-secret TOML fields', changed)
  await waitForRenderer(win, `!document.querySelector('[data-codex-native-config-save]')?.disabled`)
  await rendererValue(win, `document.querySelector('[data-codex-native-config-save]')?.click()`)
  await waitForRenderer(win, `document.body.innerText.includes('Codex 配置已保存')`)
  const savedSource = fs.readFileSync(configPath, 'utf8')
  check('config workspace writes the edited field and restores the protected value in main',
    savedSource.includes('sandbox_mode = "read-only"') && savedSource.includes(secret))
  const backups = await invokeProfile('native-config-backups')
  check('config workspace creates a rollback backup', backups.length === 1 && backups[0].configPresent === true)
  const backupRoot = path.join(userDataDir, 'codex-native-config-backups')
  const backupRaw = fs.readdirSync(backupRoot).map((name) => fs.readFileSync(path.join(backupRoot, name), 'utf8')).join('\n')
  check('config workspace backup is encrypted and contains no plaintext config credential',
    backupRaw.includes('"encryptedSource": "enc:') && !backupRaw.includes(secret))
  check('config workspace keeps the credential out of the DOM after save',
    !(await rendererValue(win, `document.body.innerText.includes(${JSON.stringify(secret)})`)))
  await capture(win, 'codex-native-config-workspace.png')

  win.setSize(700, 850)
  await settleRenderer(win)
  const compact = await rendererValue(win, `(() => {
    const root = document.querySelector('[data-codex-native-config-workspace]');
    const textarea = root.querySelector('[data-codex-native-config-editor]');
    const rect = root.getBoundingClientRect();
    return {
      width: innerWidth,
      columns: getComputedStyle(root.querySelector('.codex-native-config-meta')).gridTemplateColumns.split(' ').length,
      contained: rect.left >= 0 && rect.right <= innerWidth + 1,
      editorFit: textarea.scrollWidth <= textarea.clientWidth + 1 || textarea.scrollWidth > textarea.clientWidth,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  })()`)
  check('config workspace remains contained at 700px with a three-column summary',
    compact.width <= 700 && compact.columns === 3 && compact.contained && !compact.documentOverflow,
    JSON.stringify(compact))
  await capture(win, 'codex-native-config-workspace-compact.png')
  win.setSize(1200, 900)

  await invokeProfile('native-config-rollback', backups[0].id)
  check('config workspace rollback restores exact original config bytes', fs.readFileSync(configPath, 'utf8') === originalSource)
  await rendererValue(win, `document.querySelector('[data-codex-native-config-workspace] .codex-native-config-head .btn-icon-sm')?.click()`)
  await waitForRenderer(win, `!document.querySelector('[data-codex-native-config-editor]')`)
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
  const opened = await rendererValue(win, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim().includes('\u8bbe\u7f6e'));
    button?.click();
    return Boolean(button);
  })()`)
  if (!opened) throw new Error('settings button not found')
  await waitForRenderer(win, `Boolean(document.querySelector('.settings-page'))`)
  await rendererValue(win, `document.querySelector('[data-settings-tab="providers"]')?.click()`)
  await waitForRenderer(win, `Boolean(document.querySelector('[data-provider-native-scan]'))`)
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
      if (Date.now() - started > timeoutMs) return reject(new Error('provider native import E2E wait timed out'))
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
