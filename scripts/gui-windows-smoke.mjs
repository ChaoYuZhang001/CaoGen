#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const checks = []

async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (err) {
    checks.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error([stderr.trim(), err.message].filter(Boolean).join('\n')))
          return
        }
        resolve(stdout)
      }
    )
  })
}

function parseLastJson(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    return JSON.parse(line)
  }
  throw new Error('PowerShell did not return JSON')
}

function evaluateWindowsController() {
  const input = source('src/main/gui/windows-controller.ts')
  const output = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText

  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', 'Buffer', output)(
    require,
    module,
    module.exports,
    process,
    Buffer
  )
  return module.exports
}

await check('windows controller uses UI Automation for top-level windows', () => {
  const text = source('src/main/gui/windows-controller.ts')
  assert(text.includes('UIAutomationClient'), 'missing UIAutomationClient bridge')
  assert(text.includes('AutomationElement'), 'missing AutomationElement window traversal')
  assert(text.includes('WindowPattern'), 'missing WindowPattern activation path')
})

await check('windows controller has Win32 activation and input primitives', () => {
  const text = source('src/main/gui/windows-controller.ts')
  for (const marker of ['SetForegroundWindow', 'BringWindowToTop', 'SetCursorPos', 'mouse_event', 'keybd_event']) {
    assert(text.includes(marker), `missing ${marker}`)
  }
})

await check('windows controller exposes scroll target routing and wheel input', () => {
  const text = source('src/main/gui/windows-controller.ts')
  for (const marker of ['export async function windowsScroll', "'scroll'", 'Move-ToScrollTarget', 'Invoke-MouseScroll', '0x0800', '0x1000']) {
    assert(text.includes(marker), `missing ${marker}`)
  }
})

await check('windows text entry documents clipboard paste behavior', () => {
  const text = source('src/main/gui/windows-controller.ts')
  assert(text.includes('Set-TextClipboardWithRetry'), 'text entry must use retrying clipboard paste path')
  assert(text.includes('Get-TextClipboardSnapshot'), 'clipboard text snapshot must be explicit')
  assert(text.includes('System.Windows.Forms.Clipboard'), 'clipboard retry path must include WinForms fallback')
})

await check('windows bridge uses temp script file to avoid command length limits', () => {
  const text = source('src/main/gui/windows-controller.ts')
  assert(text.includes("'-File', bridgePath, payload"), 'bridge must use -File with payload argument')
  assert(text.includes('ensureWindowsBridgeScript'), 'bridge script path must be managed by code')
})

await check('windows controller exposes UI Automation element discovery', () => {
  const text = source('src/main/gui/windows-controller.ts')
  for (const marker of ['Get-ElementInfos', 'Find-TargetElement', 'Invoke-ElementClick', 'elementName', 'automationId', 'controlType']) {
    assert(text.includes(marker), `missing ${marker}`)
  }
  assert(text.includes('normalizeElementInfo'), 'Windows UIA elements must be normalized into TS results')
  assert(!text.includes('Array.isArray(elementsRaw) ? { elements: [] }'), 'normalizer must not discard UIA elements')
})

await check('gui controller routes Windows before nut.js fallback', () => {
  const text = source('src/main/gui/gui-controller.ts')
  for (const marker of ['windowsListWindows(input)', 'windowsActivateWindow(input)', 'windowsClick(input)', 'windowsTypeText(input)', 'windowsScroll(input)', 'windowsHotkey(keys)']) {
    assert(text.includes(marker), `missing Windows route ${marker}`)
  }
  assert(
    text.indexOf('windowsClick(input)') < text.indexOf('nutClick(input.x, input.y, input.button)'),
    'Windows click path must run before nut.js fallback'
  )
})

await check('runtime windowsListWindows bridge returns structured data', async () => {
  if (process.platform !== 'win32') return
  const controller = evaluateWindowsController()
  const result = await controller.windowsListWindows()
  assert(result.ok === true, `windowsListWindows failed: ${result.error ?? 'unknown error'}`)
  assert(Array.isArray(result.windows), 'windowsListWindows must return an array')
  if (result.windows.length > 0) {
    const first = result.windows[0]
    assert(typeof first.id === 'string' && first.id.startsWith('win32:'), 'window id must use win32: prefix')
    assert(typeof first.title === 'string', 'window title must be a string')
    assert(typeof first.pid === 'number', 'window pid must be a number')
    assert(typeof first.bounds?.width === 'number', 'window bounds must include width')
  }
})

await check('runtime windowsListWindows can include UIA element summaries', async () => {
  if (process.platform !== 'win32') return
  const controller = evaluateWindowsController()
  const base = await controller.windowsListWindows()
  assert(base.ok === true, `base list failed: ${base.error ?? 'unknown error'}`)
  const target = base.windows.find((item) => item.title && item.id)
  if (!target) return
  const result = await controller.windowsListWindows({
    windowId: target.id,
    includeElements: true,
    maxElements: 5
  })
  assert(result.ok === true, `includeElements failed: ${result.error ?? 'unknown error'}`)
  assert(Array.isArray(result.windows), 'includeElements must still return windows')
  const matched = result.windows.find((item) => item.id === target.id)
  assert(matched && Array.isArray(matched.elements), 'matched window must include elements array')
  const firstElement = matched.elements[0]
  if (firstElement) {
    assert(typeof firstElement.id === 'string' && firstElement.id.startsWith('win32el:'), 'element id must use win32el: prefix')
    assert(typeof firstElement.index === 'number', 'element index must be numeric')
    assert(typeof firstElement.name === 'string', 'element name must be a string')
    assert(typeof firstElement.controlType === 'string', 'element controlType must be a string')
    assert(typeof firstElement.bounds?.width === 'number', 'element bounds must include width')
    assert(typeof firstElement.enabled === 'boolean', 'element enabled must be boolean')
    assert(typeof firstElement.offscreen === 'boolean', 'element offscreen must be boolean')
  }
})

await check('current Windows host exposes UI Automation window enumeration', async () => {
  if (process.platform !== 'win32') return
  const stdout = await runPowerShell(`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $Root = [System.Windows.Automation.AutomationElement]::RootElement
  $Children = $Root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $Count = 0
  foreach ($Element in $Children) {
    $Current = $Element.Current
    if ($Current.NativeWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace([string]$Current.Name)) {
      $Count += 1
    }
  }
  @{ ok = $true; count = $Count } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`)
  const result = parseLastJson(stdout)
  assert(result.ok === true, `UI Automation failed: ${result.error ?? 'unknown error'}`)
  assert(Number.isInteger(result.count) && result.count >= 0, `invalid window count: ${result.count}`)
})

const failed = checks.filter((item) => !item.ok)
for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? '' : `: ${item.error}`}`)
}

if (failed.length > 0) {
  process.exitCode = 1
}
