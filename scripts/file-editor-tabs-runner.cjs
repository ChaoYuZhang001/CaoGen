const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const root = requiredEnv('CAOGEN_FILE_EDITOR_ROOT')
const statePath = requiredEnv('CAOGEN_FILE_EDITOR_STATE')
const screenshotDir = requiredEnv('CAOGEN_FILE_EDITOR_SCREENSHOTS')
const userDataDir = path.join(root, 'userData')
const projectDir = path.join(root, 'project')
process.env.CAOGEN_USER_DATA_DIR = userDataDir
process.env.CAOGEN_MEMORY_DIR = path.join(root, 'memory')
fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
fs.mkdirSync(path.join(projectDir, 'src', 'components'), { recursive: true })
fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'export const a = 1\n')
fs.writeFileSync(path.join(projectDir, 'src', 'b.ts'), 'export const b = 1\n')
const searchSource = 'export const searchTarget = "needle-e2e"\nexport function calculateInvoice(total: number): number { return total * 2 }\n'
fs.writeFileSync(path.join(projectDir, 'src', 'components', 'search.ts'), searchSource)
fs.writeFileSync(path.join(projectDir, 'src', 'broken.py'), 'def broken():\n    return (\n')
fs.writeFileSync(path.join(projectDir, 'src', 'semantic.ts'), 'export const total: number = "wrong"\n')
const consumerDraft = "import { calculateInvoice } from './components/search'\nexport const invoice = calculateInvo(21)\n"
const consumerCompleted = consumerDraft.replace('calculateInvo(21)', 'calculateInvoice(21)')
fs.writeFileSync(path.join(projectDir, 'src', 'consumer.ts'), consumerDraft)

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  require(outMain)
  await waitFor(() => ipcMain._invokeHandlers?.has('providers:create') && ipcMain._invokeHandlers?.has('sessions:create'), 10_000)
  const provider = await invoke('providers:create', {
    name: 'File Editor Mock',
    baseUrl: 'http://127.0.0.1:9',
    token: 'test-only',
    models: ['mock-editor'],
    engine: 'openai',
    openaiProtocol: 'responses'
  })
  const alpha = await createSession(provider.id, 'Editor Alpha')
  const beta = await createSession(provider.id, 'Editor Beta')
  const win = await waitForWindow()
  win.setSize(1200, 800)
  win.webContents.reload()
  await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
  await selectSession(win, alpha.id)
  await openFiles(win)

  await openFile(win, 'src/a.ts')
  check('project browser renders hierarchical directory rows with basename labels',
    await rendererValue(win, `document.querySelector('.file-row-directory[title="src"] .file-row-path')?.textContent === 'src'`))
  check('opening the first file creates one active tab', await tabState(win, 'src/a.ts') === 'active')
  await setEditorText(win, 'export const a = 2\n')
  check('typing marks the active tab dirty', await tabDirty(win, 'src/a.ts'))

  await openFile(win, 'src/b.ts')
  check('opening another file keeps both tabs', await tabCount(win) === 2)
  check('second file becomes active with disk content',
    await editorText(win) === 'export const b = 1\n' && await tabState(win, 'src/b.ts') === 'active')
  await activateTab(win, 'src/a.ts')
  check('returning to the first tab restores its unsaved draft', await editorText(win) === 'export const a = 2\n')

  await key(win, 'Tab', { ctrlKey: true })
  check('Ctrl+Tab cycles to the next open file', await tabState(win, 'src/b.ts') === 'active')
  await key(win, 'Tab', { ctrlKey: true, shiftKey: true })
  check('Ctrl+Shift+Tab cycles backward', await tabState(win, 'src/a.ts') === 'active')

  await selectSession(win, beta.id)
  await openFiles(win)
  check('a different Session starts with no inherited tabs', await tabCount(win) === 0)
  await openFile(win, 'src/a.ts')
  check('same path in another Session reads the saved disk version', await editorText(win) === 'export const a = 1\n')
  await setEditorText(win, 'export const beta = 1\n')
  await selectSession(win, alpha.id)
  await openFiles(win)
  check('switching back restores the original Session tab set and draft',
    await tabCount(win) === 2 && await editorText(win) === 'export const a = 2\n')

  await rendererValue(win, `(window.confirm = () => false, true)`)
  await closeTab(win, 'src/a.ts')
  check('cancelling dirty close preserves the tab and draft',
    await tabCount(win) === 2 && await editorText(win) === 'export const a = 2\n')
  await rendererValue(win, `(window.confirm = () => true, true)`)
  await closeTab(win, 'src/a.ts')
  check('confirming dirty close discards only that tab and activates its neighbor',
    await tabCount(win) === 1 && await tabState(win, 'src/b.ts') === 'active')

  await setEditorText(win, 'export const b = 2\n')
  await key(win, 's', { ctrlKey: true })
  await waitFor(() => fs.readFileSync(path.join(projectDir, 'src', 'b.ts'), 'utf8') === 'export const b = 2\n', 10_000); await waitForRenderer(win, `document.querySelector('[data-file-tab-active="true"]')?.getAttribute('data-file-tab-dirty') !== 'true'`)
  check('Ctrl+S saves through the production file Effect path', !await tabDirty(win, 'src/b.ts'))

  await selectFileBrowserMode(win, 'search')
  await setInputValue(win, '.file-content-search input', 'needle-e2e')
  await rendererValue(win, `document.querySelector('.file-content-search button')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.file-search-result').length === 1`)
  check('full-text search returns bounded path, line, column, and highlighted snippet',
    await rendererValue(win, `(() => {
      const row = document.querySelector('.file-search-result');
      return row?.querySelector('.file-search-result-path')?.textContent === 'src/components/search.ts'
        && row?.querySelector('.file-search-result-position')?.textContent === '1:30'
        && row?.querySelector('mark')?.textContent === 'needle-e2e';
    })()`))
  await rendererValue(win, `document.querySelector('.file-search-result')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-editor-textarea')?.getAttribute('data-file-editor-path') === 'src/components/search.ts'`)
  check('opening a search result reuses the multi-tab editor path',
    await tabState(win, 'src/components/search.ts') === 'active' && await tabCount(win) === 2)
  await capture(win, 'file-editor-content-search.png')
  await selectFileBrowserMode(win, 'tree')
  await openFile(win, 'src/consumer.ts')
  await setEditorSelection(win, consumerDraft.lastIndexOf('calculateInvo') + 'calculateInvo'.length)
  await key(win, ' ', { ctrlKey: true, code: 'Space' })
  await waitForRenderer(win, `[...document.querySelectorAll('.file-symbol-result strong')].some((item) => item.textContent === 'calculateInvoice')`, 20_000)
  check('Ctrl+Space returns context-aware completion from the TypeScript LSP', await rendererValue(win, `document.querySelector('[data-file-symbol-source="typescript-lsp"]') !== null && [...document.querySelectorAll('.file-symbol-result strong')].filter((item) => item.textContent === 'calculateInvoice').length === 1`))
  await capture(win, 'file-editor-symbol-completion.png')
  await rendererValue(win, `[...document.querySelectorAll('.file-symbol-result')].find((item) => item.querySelector('strong')?.textContent === 'calculateInvoice')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-editor-textarea')?.value.includes('calculateInvoice(21)')`)
  check('selecting an LSP completion replaces only the identifier at the caret', await editorText(win) === consumerCompleted)
  await key(win, 's', { ctrlKey: true })
  await setEditorSelection(win, consumerCompleted.lastIndexOf('calculateInvoice') + 5)
  await key(win, 'F12')
  await waitForRenderer(win, `document.querySelector('.file-editor-textarea')?.getAttribute('data-file-editor-path') === 'src/components/search.ts'`, 20_000)
  check('F12 resolves and opens the LSP source definition', await tabState(win, 'src/components/search.ts') === 'active')
  await setEditorSelection(win, searchSource.indexOf('calculateInvoice') + 5)
  await rendererValue(win, `document.querySelector('.file-editor-hover')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-hover-content')?.textContent.includes('calculateInvoice')`, 20_000)
  const hoverText = await rendererValue(win, `document.querySelector('[data-file-hover-popover]')?.textContent || ''`)
  check('semantic hover shows the real imported function signature',
    hoverText.includes('TypeScript LSP') && hoverText.includes('calculateInvoice') && /number|\(total: number\)/i.test(hoverText),
    JSON.stringify(hoverText))
  await capture(win, 'file-editor-semantic-hover.png')
  await rendererValue(win, `document.querySelector('.file-hover-popover .file-symbol-menu-head button')?.click()`)
  await selectFileBrowserMode(win, 'tree')
  await openFile(win, 'src/semantic.ts')
  await selectFileBrowserMode(win, 'problems')
  await waitForRenderer(win, `document.querySelector('[data-diagnostic-path="src/semantic.ts"][data-diagnostic-code="2322"]') !== null`, 20_000)
  check('Problems view includes a genuine TS2322 semantic type error',
    await rendererValue(win, `Boolean(document.querySelector('[data-diagnostic-path="src/semantic.ts"][data-diagnostic-code="2322"]'))`))
  await rendererValue(win, `document.querySelector('[data-diagnostic-path="src/semantic.ts"][data-diagnostic-code="2322"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-editor-textarea')?.getAttribute('data-file-editor-path') === 'src/semantic.ts'`)
  await setEditorText(win, 'export const total: number = 42\n')
  await key(win, 's', { ctrlKey: true })
  await waitForRenderer(win, `document.querySelector('[data-diagnostic-path="src/semantic.ts"]') === null`, 20_000)
  check('fixing and saving clears the semantic diagnostic', await rendererValue(win, `document.querySelector('[data-diagnostic-path="src/semantic.ts"]') === null`))
  check('non-TypeScript files keep the Tree-sitter diagnostics fallback',
    await rendererValue(win, `(() => {
      const row = document.querySelector('[data-diagnostic-path="src/broken.py"][data-diagnostic-source="tree-sitter"]');
      return Boolean(row && row.querySelector('.file-diagnostic-message')?.textContent && row.querySelector('.file-diagnostic-position')?.textContent);
    })()`))
  const pythonPosition = await rendererValue(win, `document.querySelector('[data-diagnostic-path="src/broken.py"] .file-diagnostic-position')?.textContent || ''`)
  await rendererValue(win, `document.querySelector('[data-diagnostic-path="src/broken.py"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-editor-textarea')?.getAttribute('data-file-editor-path') === 'src/broken.py'`, 20_000)
  await settleRenderer(win)
  const pythonCaret = await rendererValue(win, `document.querySelector('.file-editor-textarea')?.selectionStart ?? -1`)
  const [pythonLine, pythonColumn] = pythonPosition.split(':').map(Number)
  const expectedPythonCaret = offsetForLocation(await editorText(win), pythonLine, pythonColumn)
  check('opening a Problem reuses the editor tab path and positions the caret',
    await tabState(win, 'src/broken.py') === 'active' && pythonCaret === expectedPythonCaret,
    `position=${pythonPosition}, caret=${pythonCaret}, expected=${expectedPythonCaret}`)
  await capture(win, 'file-editor-problems.png')
  await setEditorText(win, 'def fixed():\n    return True\n')
  await key(win, 's', { ctrlKey: true })
  await waitForRenderer(win, `document.querySelectorAll('.file-diagnostic-row').length === 0 && document.querySelector('.file-search-summary')?.textContent.trim().startsWith('0')`)
  check('saving a syntax fix refreshes and clears the Problems view', await rendererValue(win, `document.querySelectorAll('.file-diagnostic-row').length === 0`))
  await closeTab(win, 'src/b.ts')
  await closeTab(win, 'src/consumer.ts')
  await closeTab(win, 'src/components/search.ts')
  await closeTab(win, 'src/semantic.ts')
  await selectFileBrowserMode(win, 'tree')

  await settleRenderer(win)
  const desktop = await layoutState(win)
  check('multi-tab editor fits and fills the desktop workbench panel',
    !desktop.documentOverflow && desktop.tabsContained && desktop.panelFillsSide && desktop.filePanelFillsPanel,
    JSON.stringify(desktop))
  check('desktop file actions and editor stay usable inside the panel',
    desktop.controlsContained && desktop.editorUsable && desktop.treeRowsAligned,
    JSON.stringify(desktop))
  await capture(win, 'file-editor-tabs-desktop.png')
  win.setSize(760, 700)
  await waitForRenderer(win, `window.innerWidth <= 760 && getComputedStyle(document.querySelector('.workbench')).flexDirection === 'column'`)
  await settleRenderer(win)
  const compact = await layoutState(win)
  check('compact file panel uses the full available workbench width',
    !compact.documentOverflow && compact.panelFillsSide && compact.filePanelFillsPanel && compact.sideFillsViewport,
    JSON.stringify(compact))
  check('compact tabs, actions, and editor remain contained and usable',
    compact.tabsContained && compact.controlsContained && compact.editorUsable && compact.treeViewportUsable && compact.treeRowsAligned,
    JSON.stringify(compact))
  await capture(win, 'file-editor-tabs-compact.png')

  fs.writeFileSync(statePath, `${JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: ['file-editor-content-search.png', 'file-editor-symbol-completion.png', 'file-editor-semantic-hover.png', 'file-editor-problems.png', 'file-editor-tabs-desktop.png', 'file-editor-tabs-compact.png'],
    checks
  }, null, 2)}\n`)
  app.exit(0)
}

async function createSession(providerId, title) {
  return invoke('sessions:create', {
    cwd: projectDir,
    engine: 'openai',
    providerId,
    model: 'mock-editor',
    routingScope: 'fixed',
    taskStrategy: 'execute',
    isolated: false,
    title
  })
}

async function selectSession(win, sessionId) {
  await waitForRenderer(win, `Boolean(document.querySelector('.session-card[data-session-id="${sessionId}"]'))`)
  await rendererValue(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.classList.contains('active')`)
  await settleRenderer(win)
}

async function openFiles(win) {
  await rendererValue(win, `document.querySelector('[data-experience-mode-option="studio"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.experience-pane')?.getAttribute('data-experience-mode') === 'studio'`)
  await rendererValue(win, `document.querySelector('[aria-label="打开工具抽屉"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.desk-tool-drawer') !== null`)
  await rendererValue(win, `[...document.querySelectorAll('.desk-tool-item')].find((button) => button.textContent.trim() === '文件')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-panel') !== null`)
  await waitForRenderer(win, `document.querySelector('.file-row-directory[title="src"]') !== null`)
  await expandDirectory(win, 'src')
  await waitForRenderer(win, `document.querySelectorAll('.file-row-file').length >= 2`)
}

async function openFile(win, filePath) {
  const segments = filePath.split('/')
  for (let index = 1; index < segments.length; index += 1) {
    await expandDirectory(win, segments.slice(0, index).join('/'))
  }
  await rendererValue(win, `document.querySelector('.file-row[title=${JSON.stringify(filePath)}]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-editor-textarea')?.getAttribute('data-file-editor-path') === ${JSON.stringify(filePath)}`)
}

async function expandDirectory(win, directoryPath) {
  await waitForRenderer(win, `document.querySelector('.file-row-directory[title=${JSON.stringify(directoryPath)}]') !== null`)
  const expanded = await rendererValue(win, `document.querySelector('.file-row-directory[title=${JSON.stringify(directoryPath)}]')?.getAttribute('aria-expanded') === 'true'`)
  if (!expanded) {
    await rendererValue(win, `document.querySelector('.file-row-directory[title=${JSON.stringify(directoryPath)}]')?.click()`)
    await waitForRenderer(win, `document.querySelector('.file-row-directory[title=${JSON.stringify(directoryPath)}]')?.getAttribute('aria-expanded') === 'true'`)
  }
}

async function selectFileBrowserMode(win, mode) {
  const index = mode === 'tree' ? 1 : mode === 'search' ? 2 : 3
  await rendererValue(win, `document.querySelector('.file-browser-modes button:nth-child(${index})')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-browser-modes button:nth-child(${index})')?.getAttribute('aria-selected') === 'true'`)
}

async function setInputValue(win, selector, value) {
  await rendererValue(win, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitForRenderer(win, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
}

async function activateTab(win, filePath) {
  await rendererValue(win, `document.querySelector('[data-file-tab=${JSON.stringify(filePath)}] .file-editor-tab-select')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-file-tab=${JSON.stringify(filePath)}]')?.getAttribute('data-file-tab-active') === 'true'`)
}

async function closeTab(win, filePath) {
  await rendererValue(win, `document.querySelector('[data-file-tab-close=${JSON.stringify(filePath)}]')?.click()`)
  await settleRenderer(win)
}

async function setEditorText(win, value) {
  await rendererValue(win, `(() => {
    const input = document.querySelector('.file-editor-textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitForRenderer(win, `document.querySelector('.file-editor-textarea')?.value === ${JSON.stringify(value)}`)
  await waitForRenderer(win, `document.querySelector('[data-file-tab-active="true"]')?.getAttribute('data-file-tab-dirty') === 'true'`)
}

async function setEditorSelection(win, position) {
  await rendererValue(win, `(() => {
    const input = document.querySelector('.file-editor-textarea');
    input.focus();
    input.setSelectionRange(${Number(position)}, ${Number(position)});
  })()`)
  await waitForRenderer(win, `document.querySelector('.file-editor-textarea')?.selectionStart === ${Number(position)}`)
}

function editorText(win) {
  return rendererValue(win, `document.querySelector('.file-editor-textarea')?.value || ''`)
}

function offsetForLocation(content, lineValue, columnValue) {
  const lines = content.split('\n')
  const line = Math.max(1, Math.min(Math.floor(lineValue), lines.length))
  return Math.min(content.length, lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + Math.max(0, Math.floor(columnValue) - 1))
}

function tabCount(win) {
  return rendererValue(win, `document.querySelectorAll('[data-file-tab]').length`)
}

function tabState(win, filePath) {
  return rendererValue(win, `document.querySelector('[data-file-tab=${JSON.stringify(filePath)}]')?.getAttribute('data-file-tab-active') === 'true' ? 'active' : 'inactive'`)
}

function tabDirty(win, filePath) {
  return rendererValue(win, `document.querySelector('[data-file-tab=${JSON.stringify(filePath)}]')?.getAttribute('data-file-tab-dirty') === 'true'`)
}

async function key(win, keyValue, modifiers = {}) {
  await rendererValue(win, `(() => {
    const target = ${modifiers.ctrlKey && (keyValue === 's' || keyValue === 'Tab') ? 'window' : '(document.activeElement instanceof HTMLElement ? document.activeElement : window)'};
    const event = new KeyboardEvent('keydown', {
      key: ${JSON.stringify(keyValue)},
      code: ${JSON.stringify(modifiers.code || '')},
      bubbles: true,
      cancelable: true,
      ctrlKey: ${Boolean(modifiers.ctrlKey)},
      shiftKey: ${Boolean(modifiers.shiftKey)}
    });
    target.dispatchEvent(event);
  })()`)
  await settleRenderer(win)
}

async function layoutState(win) {
  return rendererValue(win, `(() => {
    const tabs = [...document.querySelectorAll('[data-file-tab]')];
    const side = document.querySelector('.workbench-side');
    const panel = document.querySelector('.workbench-side > .workbench-panel:not([aria-hidden="true"])');
    const filePanel = document.querySelector('.file-panel');
    const treeViewport = document.querySelector('.file-list-scroll');
    const editor = document.querySelector('.file-editor-textarea');
    const controls = [...document.querySelectorAll('.workspace-diff-actions .btn, .file-row-preview, .file-editor-tab-close, .file-editor-head .btn')];
    const treeRow = document.querySelector('.file-row-directory[title="src"]');
    const sideRect = side?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    const fileRect = filePanel?.getBoundingClientRect();
    const treeViewportRect = treeViewport?.getBoundingClientRect();
    const editorRect = editor?.getBoundingClientRect();
    const treeRowRect = treeRow?.getBoundingClientRect();
    const treeRowChildren = treeRow ? [...treeRow.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return [child.className, rect.left, rect.right];
    }) : [];
    const isContained = (rect, container) => rect.left >= container.left - 1
      && rect.right <= container.right + 1
      && rect.top >= container.top - 1
      && rect.bottom <= container.bottom + 1;
    const controlStates = controls.map((control) => {
      const rect = control.getBoundingClientRect();
      return {
        name: control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent.trim(),
        rect: [rect.left, rect.top, rect.right, rect.bottom],
        contained: Boolean(fileRect && rect.width > 0 && rect.height > 0 && isContained(rect, fileRect))
      };
    });
    return {
      width: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      tabsContained: tabs.every((tab) => tab.scrollWidth <= tab.clientWidth + 1 && (!fileRect || isContained(tab.getBoundingClientRect(), fileRect))),
      panelFillsSide: Boolean(sideRect && panelRect && Math.abs(sideRect.width - panelRect.width) <= 1),
      filePanelFillsPanel: Boolean(panelRect && fileRect && Math.abs(panelRect.width - fileRect.width) <= 1),
      sideFillsViewport: Boolean(sideRect && sideRect.left <= 1 && sideRect.right >= document.documentElement.clientWidth - 1),
      controlsContained: Boolean(fileRect && controls.length >= 6 && controlStates.every((control) => control.contained)),
      editorUsable: Boolean(editorRect && fileRect && editorRect.width >= 160 && editorRect.height >= 80 && isContained(editorRect, fileRect)),
      treeViewportUsable: Boolean(treeViewportRect && treeViewportRect.height >= 48 && fileRect && isContained(treeViewportRect, fileRect)),
      treeRowsAligned: Boolean(treeRowRect && treeRowChildren.length === 3 && treeRowChildren[2][1] - treeRowRect.left <= 60),
      sideWidth: sideRect?.width || 0,
      panelWidth: panelRect?.width || 0,
      filePanelWidth: fileRect?.width || 0,
      editorSize: editorRect ? [editorRect.width, editorRect.height] : [0, 0],
      treeViewportHeight: treeViewportRect?.height || 0,
      treeRowLayout: treeRow ? {
        display: getComputedStyle(treeRow).display,
        columns: getComputedStyle(treeRow).gridTemplateColumns,
        justifyContent: getComputedStyle(treeRow).justifyContent,
        rect: treeRowRect ? [treeRowRect.left, treeRowRect.right] : [],
        children: treeRowChildren
      } : null,
      controlCount: controls.length,
      uncontainedControls: controlStates.filter((control) => !control.contained)
    };
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

function rendererValue(win, expression) { return win.webContents.executeJavaScript(expression, true) }

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
      } catch {
        // Main and renderer state settle independently.
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('file editor E2E wait timed out'))
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
