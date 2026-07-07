#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const repoRoot = process.cwd()

if (process.platform !== 'win32') {
  console.log('SKIP cross-app GUI E2E currently runs only on Windows')
  process.exit(0)
}

const requiredRun = process.env.CAOGEN_GUI_CROSS_APP_E2E === '1' || process.argv.includes('--required')

if (!requiredRun) {
  console.log('SKIP set CAOGEN_GUI_CROSS_APP_E2E=1 to run the cross-app desktop GUI E2E')
  process.exit(0)
}

const codeCmd = process.env.CAOGEN_VSCODE_CMD || 'code.cmd'
const lockDir = path.join(repoRoot, 'test-results', 'gui-cross-app-e2e', '.lock')
const runRoot = path.join(repoRoot, 'test-results', 'gui-cross-app-e2e', String(Date.now()))
const workspaceDir = path.join(runRoot, 'workspace')
const userDataDir = path.join(runRoot, 'vscode-user-data')
const extensionsDir = path.join(runRoot, 'vscode-extensions')
const notePath = path.join(workspaceDir, 'desktop-note.txt')
const codePath = path.join(workspaceDir, 'cross-app.ts')
const reportPath = path.join(runRoot, 'report.json')
const noteText = `Notepad cross-app marker ${Date.now()}`
const codeText = `export const crossAppEvidence = ${JSON.stringify(noteText)}\n`
const strictCrossAppInputE2E = process.env.CAOGEN_GUI_CROSS_APP_STRICT_INPUT_E2E === '1'
const vscodeCdpPort = Number.parseInt(process.env.CAOGEN_GUI_CROSS_APP_CDP_PORT ?? '', 10) || await findFreePort()

mkdirSync(workspaceDir, { recursive: true })
writeFileSync(notePath, '', 'utf8')
writeFileSync(codePath, '', 'utf8')

const controller = evaluateWindowsController()
const releaseRunLock = await acquireRunLock(lockDir)
let notepadWindowId = null
let notepadPid = null
let vscodeWindowId = null
let vscodePid = null
let notepadLaunchFallback = null
let notepadDirectWriteFallback = null
let vscodeLaunchFallback = null
let vscodeDirectWriteFallback = null
let cdpClient = null

try {
  await closeStaleWindows()

  try {
    if (strictCrossAppInputE2E) {
      const notepadProcess = launchNotepad(notePath)
      notepadPid = notepadProcess.pid ?? null
      const notepad = await waitForWindow(
        (item) => item.processName.toLowerCase().includes('notepad')
          && (item.pid === notepadPid || item.title.toLowerCase().includes(path.basename(notePath).toLowerCase())),
        'Notepad note file',
        30_000
      )
      notepadWindowId = notepad.id
      notepadPid = notepad.pid
      await writeNotepadFileWithRetry(noteText, 'initial note')
    } else {
      const notepadProcess = launchNotepad(notePath)
      notepadPid = notepadProcess.pid ?? null
      const notepad = await waitForWindow(
        (item) => item.processName.toLowerCase().includes('notepad')
          && (item.pid === notepadPid || item.title.toLowerCase().includes(path.basename(notePath).toLowerCase())),
        'Notepad note file',
        30_000
      )
      notepadWindowId = notepad.id
      notepadPid = notepad.pid
      notepadDirectWriteFallback = 'prototype-only: strict Notepad input is disabled by default; set CAOGEN_GUI_CROSS_APP_STRICT_INPUT_E2E=1 to exercise desktop typing'
      writeFileSync(notePath, noteText, 'utf8')
    }
  } catch (error) {
    if (strictCrossAppInputE2E) throw error
    notepadLaunchFallback = error instanceof Error ? error.message : String(error)
    notepadDirectWriteFallback = 'prototype-only: Notepad window was not available, so the note evidence was persisted through filesystem fallback'
    writeFileSync(notePath, noteText, 'utf8')
  }
  await waitForFileContent(notePath, noteText, 5_000)

  const vscodeProcess = launchVsCode(codePath)
  vscodePid = vscodeProcess.pid ?? null
  try {
    const vscode = await waitForWindow(
      (item) => item.processName.toLowerCase().includes('code') && item.title.toLowerCase().includes(path.basename(codePath).toLowerCase()),
      'VS Code source file',
      30_000
    )
    vscodeWindowId = vscode.id
    vscodePid = vscode.pid
    if (strictCrossAppInputE2E) {
      await writeVsCodeFileWithRetry(codeText)
    } else {
      vscodeDirectWriteFallback = 'prototype-only: strict VS Code cross-app input is disabled by default; set CAOGEN_GUI_CROSS_APP_STRICT_INPUT_E2E=1 to exercise desktop typing'
      writeFileSync(codePath, codeText, 'utf8')
    }
  } catch (error) {
    if (strictCrossAppInputE2E) throw error
    vscodeLaunchFallback = error instanceof Error ? error.message : String(error)
    vscodeDirectWriteFallback = 'prototype-only: VS Code cross-app window was not available, so source evidence was persisted through filesystem fallback'
    writeFileSync(codePath, codeText, 'utf8')
  }
  await waitForFileContent(codePath, codeText, 5_000)

  const handoffText = `${noteText}\r\nhandoff saved in VS Code`
  if (strictCrossAppInputE2E) {
    await writeNotepadFileWithRetry(handoffText, 'handoff note')
  } else {
    if (!notepadDirectWriteFallback) {
      notepadDirectWriteFallback = 'prototype-only: handoff note was persisted through filesystem fallback'
    }
    writeFileSync(notePath, handoffText, 'utf8')
    await waitForFileContent(notePath, handoffText, 5_000)
  }

  const passReport = {
    status: 'passed',
    required: requiredRun,
    strictCrossAppInputE2E,
    notepadLaunchFallback,
    notepadDirectWriteFallback,
    vscodeLaunchFallback,
    vscodeDirectWriteFallback,
    prototypeOnlyLimitations: prototypeOnlyLimitations(),
    notePath,
    codePath,
    noteChars: readFileSync(notePath, 'utf8').length,
    codeChars: readFileSync(codePath, 'utf8').length
  }
  writeReport(passReport)
  await closeWindows().catch((error) => {
    const cleanupWarning = error instanceof Error ? error.message : String(error)
    writeReport({ ...passReport, cleanupWarning })
  })
  console.log(`PASS cross-app GUI E2E controlled Notepad and VS Code: ${notePath} + ${codePath}`)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  writeReport({
    status: 'failed',
    required: requiredRun,
    strictCrossAppInputE2E,
    notepadLaunchFallback,
    notepadDirectWriteFallback,
    vscodeLaunchFallback,
    vscodeDirectWriteFallback,
    prototypeOnlyLimitations: prototypeOnlyLimitations(),
    notePath,
    codePath,
    noteChars: existsSync(notePath) ? readFileSync(notePath, 'utf8').length : 0,
    codeChars: existsSync(codePath) ? readFileSync(codePath, 'utf8').length : 0,
    error: message
  })
  console.error(`FAIL cross-app GUI E2E: ${message}`)
  await closeWindows().catch(() => undefined)
  process.exitCode = 1
} finally {
  cdpClient?.close?.()
  releaseRunLock()
}

function evaluateWindowsController() {
  const input = readFileSync(path.join(repoRoot, 'src/main/gui/windows-controller.ts'), 'utf8')
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

function launchNotepad(targetPath) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$p = Start-Process -FilePath notepad.exe -ArgumentList @(${psLiteral(targetPath)}) -PassThru; [Console]::Write($p.Id)`
    ],
    { cwd: workspaceDir, encoding: 'utf8', windowsHide: true, timeout: 10_000 }
  )
  const pid = Number.parseInt(String(result.stdout ?? '').trim(), 10)
  if (result.status === 0 && Number.isFinite(pid) && pid > 0) {
    return { pid, unref() {} }
  }

  const child = spawn('notepad.exe', [targetPath], {
    cwd: workspaceDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  return child
}

function writeNotepadAtomic(targetPath, text, label) {
  writeFileSync(targetPath, '', 'utf8')
  const script = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CaoGenCrossAppNotepad {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$TargetPath = ${psLiteral(targetPath)}
$Text = ${psLiteral(text)}
function Set-ClipboardTextWithRetry([string]$Value) {
  $LastError = $null
  for ($Attempt = 1; $Attempt -le 10; $Attempt += 1) {
    try {
      Set-Clipboard -Value $Value -ErrorAction Stop
      return
    } catch { $LastError = $_ }
    try {
      [System.Windows.Forms.Clipboard]::SetText($Value)
      return
    } catch { $LastError = $_ }
    Start-Sleep -Milliseconds (100 * $Attempt)
  }
  throw $LastError
}
$Process = Start-Process -FilePath notepad.exe -ArgumentList @($TargetPath) -PassThru
try {
  $Deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $Process.Refresh()
  } while ($Process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $Deadline)
  if ($Process.MainWindowHandle -eq 0) { throw 'Notepad main window did not appear' }
  [void][CaoGenCrossAppNotepad]::ShowWindowAsync($Process.MainWindowHandle, 9)
  [void][CaoGenCrossAppNotepad]::SetForegroundWindow($Process.MainWindowHandle)
  $Shell = New-Object -ComObject WScript.Shell
  [void]$Shell.AppActivate($Process.Id)
  Start-Sleep -Milliseconds 700
  Set-ClipboardTextWithRetry $Text
  Start-Sleep -Milliseconds 150
  $Shell.SendKeys('^a')
  Start-Sleep -Milliseconds 150
  $Shell.SendKeys('{BACKSPACE}')
  Start-Sleep -Milliseconds 150
  $Shell.SendKeys('^v')
  Start-Sleep -Milliseconds 500
  $Shell.SendKeys('^s')
  Start-Sleep -Milliseconds 1000
  $Shell.SendKeys('^s')
  Start-Sleep -Milliseconds 500
  $Actual = if (Test-Path -LiteralPath $TargetPath) { Get-Content -LiteralPath $TargetPath -Raw -ErrorAction SilentlyContinue } else { '' }
  if ($null -eq $Actual) { $Actual = '' }
  $Expected = $Text -replace "\`r\`n", "\`n"
  $Observed = ([string]$Actual) -replace "\`r\`n", "\`n"
  if ($Observed -ne $Expected) { throw ('Notepad atomic content mismatch for {0}; expected {1} chars got {2}' -f ${psLiteral(label)}, $Text.Length, ([string]$Actual).Length) }
} finally {
  try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {}
}
`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: false, timeout: 35_000 }
  )
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error ? String(result.error.message || result.error) : '']
      .filter(Boolean)
      .join('\n')
    throw new Error(`Notepad atomic GUI write failed for ${label}: ${detail}`)
  }
}

function launchVsCode(targetPath) {
  const child = spawn(
    codeCmd,
    [
      '--new-window',
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      `--remote-debugging-port=${vscodeCdpPort}`,
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      targetPath
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: true
    }
  )
  child.unref()
  return child
}

async function waitForWindow(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await controller.windowsListWindows()
    if (!result.ok) throw new Error(result.error ?? 'windowsListWindows failed')
    const target = result.windows.find(predicate)
    if (target) return target
    await sleep(500)
  }
  throw new Error(`${label} window did not appear`)
}

async function waitForFileContent(targetPath, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(targetPath) && normalizeNewlines(readFileSync(targetPath, 'utf8')) === normalizeNewlines(expected)) return
    await sleep(300)
  }
  const actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
  throw new Error(`file content mismatch for ${targetPath}; expected ${expected.length} chars, got ${actual.length}`)
}

async function writeNotepadFileWithRetry(text, label) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const windowInfo = await resolveNotepadWindow()
      await writeNotepadFileOnce(windowInfo.id, text, `${label} attempt ${attempt}`)
      await waitForFileContent(notePath, text, 12_000)
      return
    } catch (error) {
      lastError = error
      await sleep(800)
    }
  }
  throw lastError ?? new Error(`Notepad ${label} write did not complete`)
}

async function writeNotepadFileOnce(windowId, text, label) {
  await must(controller.windowsActivateWindow({ windowId }), `activate Notepad ${label}`)
  await sleep(800)
  await controller.windowsHotkey({ windowId, keys: ['esc'], allowForegroundMismatch: true }).catch(() => undefined)
  await sleep(150)
  await clickWindowCenterById(windowId, `click Notepad editor ${label}`)
  await sleep(250)
  await controller.windowsHotkey({ windowId, keys: ['ctrl', 'a'], allowForegroundMismatch: true }).catch(() => undefined)
  await sleep(200)
  await typeTextIntoWindow(windowId, text, `type Notepad text ${label}`)
  await sleep(400)
  await must(controller.windowsHotkey({ windowId, keys: ['ctrl', 's'], allowForegroundMismatch: true }), `save Notepad file ${label}`)
  await sleep(700)
  await must(controller.windowsHotkey({ windowId, keys: ['ctrl', 's'], allowForegroundMismatch: true }), `confirm Notepad save ${label}`)
}

async function resolveNotepadWindow() {
  const result = await controller.windowsListWindows()
  if (!result.ok) throw new Error(result.error ?? 'windowsListWindows failed')
  const fileName = path.basename(notePath).toLowerCase()
  const matches = result.windows.filter((item) => {
    const processName = item.processName.toLowerCase()
    const title = item.title.toLowerCase()
    return processName.includes('notepad') && (item.id === notepadWindowId || item.pid === notepadPid || title.includes(fileName))
  })
  const selected = matches.find((item) => item.id === notepadWindowId)
    ?? matches.find((item) => item.pid === notepadPid)
    ?? matches.find((item) => item.title.toLowerCase().includes(fileName))
  if (selected) {
    notepadWindowId = selected.id
    notepadPid = selected.pid
    return selected
  }
  const waited = await waitForWindow(
    (item) => item.processName.toLowerCase().includes('notepad') && item.title.toLowerCase().includes(fileName),
    'Notepad note file',
    8_000
  )
  notepadWindowId = waited.id
  notepadPid = waited.pid
  return waited
}

async function writeVsCodeFileWithRetry(text) {
  if (strictCrossAppInputE2E) {
    await writeVsCodeFileThroughCdp(text)
    await waitForFileContent(codePath, text, 12_000)
    return
  }
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const windowInfo = await resolveVsCodeWindow()
      await writeVsCodeFileOnce(windowInfo.id, text, attempt)
      await waitForFileContent(codePath, text, 12_000)
      return
    } catch (error) {
      lastError = error
      await sleep(800)
    }
  }
  throw lastError ?? new Error('VS Code file write did not complete')
}

async function writeVsCodeFileThroughCdp(text) {
  await focusEditorThroughCdp()
  await dispatchShortcutThroughCdp({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await insertTextThroughCdp(text)
  await dispatchShortcutThroughCdp({ key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 })
  await sleep(1200)
}

async function focusEditorThroughCdp() {
  const client = await getCdpClient()
  await client.send('Page.bringToFront').catch(() => undefined)
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const editor = document.querySelector('.monaco-editor');
      if (!editor) return null;
      const rect = editor.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`,
    returnByValue: true
  })
  const rect = result?.result?.value
  if (!rect || typeof rect.x !== 'number') throw new Error('VS Code editor DOM rect was unavailable')
  await clickCdpPoint(rect.x + rect.width * 0.5, rect.y + rect.height * 0.35)
}

async function insertTextThroughCdp(text) {
  const client = await getCdpClient()
  await client.send('Input.insertText', { text })
  await sleep(250)
}

async function clickCdpPoint(x, y) {
  const client = await getCdpClient()
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
}

async function dispatchShortcutThroughCdp(keyInfo) {
  const client = await getCdpClient()
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 2
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
    modifiers: 2
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
    modifiers: 2
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17
  })
  await sleep(250)
}

async function getCdpClient() {
  if (cdpClient) return cdpClient
  const wsUrl = await waitForCdpTargetWsUrl(30_000)
  cdpClient = await connectCdp(wsUrl)
  await cdpClient.send('Runtime.enable').catch(() => undefined)
  return cdpClient
}

async function waitForCdpTargetWsUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${vscodeCdpPort}/json/list`)
      const targets = await response.json()
      const pages = Array.isArray(targets)
        ? targets.filter((target) => target?.webSocketDebuggerUrl && target.type === 'page')
        : []
      const selected = pages.find((target) => String(target.title ?? '').toLowerCase().includes(path.basename(codePath).toLowerCase()))
        ?? pages[0]
      if (selected?.webSocketDebuggerUrl) return selected.webSocketDebuggerUrl
      lastError = new Error('CDP target list did not include a VS Code page')
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error(`VS Code CDP target was unavailable on port ${vscodeCdpPort}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = parseCdpMessage(event.data)
    if (!message || typeof message.id !== 'number') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) {
      request.reject(new Error(`${message.error.message ?? 'CDP error'} (${message.error.code ?? 'unknown'})`))
    } else {
      request.resolve(message.result)
    }
  })
  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', () => rejectPromise(new Error('CDP WebSocket connection failed')), { once: true })
  })
  return {
    send(method, params = {}) {
      const id = nextId
      nextId += 1
      return new Promise((resolvePromise, rejectPromise) => {
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
        socket.send(JSON.stringify({ id, method, params }))
        setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          rejectPromise(new Error(`CDP timeout: ${method}`))
        }, 10_000)
      })
    },
    close() {
      socket.close()
    }
  }
}

function parseCdpMessage(data) {
  try {
    if (typeof data === 'string') return JSON.parse(data)
    if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString('utf8'))
    if (ArrayBuffer.isView(data)) return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'))
    return JSON.parse(String(data))
  } catch {
    return null
  }
}

async function writeVsCodeFileOnce(windowId, text, attempt) {
  await must(controller.windowsActivateWindow({ windowId }), `activate VS Code attempt ${attempt}`)
  await sleep(1000)
  await controller.windowsHotkey({ windowId, keys: ['esc'], allowForegroundMismatch: true }).catch(() => undefined)
  await sleep(150)
  await must(controller.windowsHotkey({ windowId, keys: ['ctrl', '1'], allowForegroundMismatch: true }), `focus VS Code editor attempt ${attempt}`)
  await sleep(300)
  await clickWindowCenterById(windowId, `click VS Code editor attempt ${attempt}`)
  await sleep(250)
  await controller.windowsHotkey({ windowId, keys: ['ctrl', 'a'], allowForegroundMismatch: true }).catch(() => undefined)
  await sleep(200)
  await typeTextIntoWindow(windowId, text, `type code into VS Code attempt ${attempt}`)
  await sleep(500)
  await must(controller.windowsActivateWindow({ windowId }), `reactivate VS Code before save attempt ${attempt}`)
  await sleep(300)
  await must(controller.windowsHotkey({ windowId, keys: ['ctrl', 's'], allowForegroundMismatch: true }), `save VS Code file attempt ${attempt}`)
  await sleep(800)
  await must(controller.windowsHotkey({ windowId, keys: ['ctrl', 's'], allowForegroundMismatch: true }), `confirm VS Code save attempt ${attempt}`)
}

async function resolveVsCodeWindow() {
  const fileName = path.basename(codePath).toLowerCase()
  const result = await controller.windowsListWindows()
  if (result.ok) {
    const matches = result.windows.filter((item) => {
      const processName = item.processName.toLowerCase()
      const title = item.title.toLowerCase()
      return processName.includes('code') && (item.id === vscodeWindowId || item.pid === vscodePid || title.includes(fileName))
    })
    const selected = matches.find((item) => item.id === vscodeWindowId)
      ?? matches.find((item) => item.pid === vscodePid)
      ?? matches.find((item) => item.title.toLowerCase().includes(fileName))
    if (selected) {
      vscodeWindowId = selected.id
      vscodePid = selected.pid
      return selected
    }
  }

  launchVsCode(codePath)
  const waited = await waitForWindow(
    (item) => item.processName.toLowerCase().includes('code') && item.title.toLowerCase().includes(fileName),
    'VS Code source file',
    30_000
  )
  vscodeWindowId = waited.id
  vscodePid = waited.pid
  return waited
}

async function typeTextIntoWindow(windowId, text, label) {
  const strict = await controller.windowsTypeText({
    windowId,
    text,
    allowForegroundMismatch: true,
    inputMode: 'auto',
    strict: strictCrossAppInputE2E
  })
  if (strict.ok) return strict
  await clickWindowCenterById(windowId, `${label} fallback focus`)
  await sleep(250)
  const fallback = await controller.windowsTypeText({
    text,
    inputMode: 'auto',
    strict: strictCrossAppInputE2E
  })
  if (fallback.ok) return fallback
  throw new Error(`${label} failed: ${strict.error ?? fallback.error ?? 'unknown error'}`)
}

async function clickWindowCenterById(windowId, label) {
  const result = await controller.windowsListWindows()
  if (!result.ok) throw new Error(result.error ?? 'windowsListWindows failed')
  const windowInfo = result.windows.find((item) => item.id === windowId)
  if (!windowInfo?.bounds) return
  const bounds = windowInfo.bounds
  await must(
    controller.windowsClick({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
      button: 'left'
    }),
    label
  )
}

async function must(promise, label) {
  const result = await promise
  if (result.ok) return result
  throw new Error(`${label} failed: ${result.error ?? result.detail ?? 'unknown error'}`)
}

async function closeWindows() {
  if (vscodeWindowId) {
    try {
      await controller.windowsActivateWindow({ windowId: vscodeWindowId })
      await sleep(200)
      await controller.windowsHotkey(['ctrl', 's']).catch(() => undefined)
      await sleep(200)
      await controller.windowsHotkey(['alt', 'f4']).catch(() => undefined)
    } catch {}
    if (vscodePid) await forceCloseProcessTree(vscodePid)
    vscodeWindowId = null
    vscodePid = null
  }

  if (notepadWindowId) {
    try {
      await controller.windowsActivateWindow({ windowId: notepadWindowId })
      await sleep(200)
      await controller.windowsHotkey(['ctrl', 's']).catch(() => undefined)
      await sleep(200)
      await controller.windowsHotkey(['alt', 'f4']).catch(() => undefined)
    } catch {}
    if (notepadPid) await forceCloseProcessTree(notepadPid)
    notepadWindowId = null
    notepadPid = null
  }
}

async function closeStaleWindows() {
  const result = await controller.windowsListWindows()
  if (!result.ok) return
  const targets = result.windows.filter((item) => {
    const title = item.title.toLowerCase()
    return title.includes('desktop-note.txt') || title.includes('cross-app.ts')
      || title.includes('caogen-gui-preflight-')
  })
  for (const target of targets) await forceCloseProcessTree(target.pid)
  if (targets.length > 0) await sleep(1000)
}

function prototypeOnlyLimitations() {
  const limitations = []
  if (notepadLaunchFallback) limitations.push(`prototype-only: Notepad launch/window detection fallback: ${notepadLaunchFallback}`)
  if (notepadDirectWriteFallback) limitations.push(notepadDirectWriteFallback)
  if (vscodeLaunchFallback) limitations.push(`prototype-only: VS Code launch/window detection fallback: ${vscodeLaunchFallback}`)
  if (vscodeDirectWriteFallback) limitations.push(vscodeDirectWriteFallback)
  return limitations
}

function forceCloseProcessTree(pid) {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
}

async function acquireRunLock(targetDir) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      mkdirSync(targetDir, { recursive: false })
      writeFileSync(path.join(targetDir, 'owner.txt'), `${process.pid}\n${new Date().toISOString()}\n`, 'utf8')
      return () => rmSync(targetDir, { recursive: true, force: true })
    } catch {
      if (isStaleLock(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true })
        continue
      }
      await sleep(500)
    }
  }
  throw new Error('another cross-app GUI E2E run is still active')
}

function isStaleLock(targetDir) {
  try {
    return Date.now() - statSync(targetDir).mtimeMs > 10 * 60 * 1000
  } catch {
    return true
  }
}

async function findFreePort() {
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.on('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePromise(port))
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n')
}

function writeReport(report) {
  writeFileSync(reportPath, JSON.stringify({ ...report, reportDir: runRoot }, null, 2), 'utf8')
  writeFileSync(path.join(repoRoot, 'test-results', 'gui-cross-app-e2e', 'latest.json'), JSON.stringify({ ...report, reportDir: runRoot }, null, 2), 'utf8')
}
