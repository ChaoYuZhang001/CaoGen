#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const repoRoot = process.cwd()

if (process.platform !== 'win32') {
  console.log('SKIP VS Code GUI E2E currently runs only on Windows')
  process.exit(0)
}

const requiredRun = process.env.CAOGEN_GUI_VSCODE_E2E === '1' || process.argv.includes('--required')

if (!requiredRun) {
  console.log('SKIP set CAOGEN_GUI_VSCODE_E2E=1 to run the desktop-control VS Code E2E')
  process.exit(0)
}

const codeCmd = process.env.CAOGEN_VSCODE_CMD || 'code.cmd'
const lockDir = path.join(repoRoot, 'test-results', 'gui-vscode-e2e', '.lock')
const runRoot = path.join(repoRoot, 'test-results', 'gui-vscode-e2e', String(Date.now()))
const workspaceDir = path.join(runRoot, 'workspace')
const userDataDir = path.join(runRoot, 'user-data')
const extensionsDir = path.join(runRoot, 'extensions')
const filePath = path.join(workspaceDir, 'sample.ts')
const markerPath = path.join(workspaceDir, 'command-ran.txt')
const reportPath = path.join(runRoot, 'report.json')
const strictCreateMode = process.env.CAOGEN_GUI_VSCODE_CREATE_E2E === '1'
const nativeStrictCreateMode = strictCreateMode && process.env.CAOGEN_GUI_VSCODE_NATIVE_CREATE_E2E === '1'
const terminalCommandE2E = process.env.CAOGEN_GUI_VSCODE_TERMINAL_E2E === '1'
const strictEditorInputE2E = process.env.CAOGEN_GUI_VSCODE_STRICT_INPUT_E2E === '1'
const cdpInputE2E = process.env.CAOGEN_GUI_VSCODE_CDP_INPUT_E2E !== '0'
const cdpPort = Number.parseInt(process.env.CAOGEN_GUI_VSCODE_CDP_PORT ?? '', 10) || await findFreePort()
const strictCreateBootstrapNote = strictCreateMode && !nativeStrictCreateMode
  ? 'prototype-only: target file is bootstrapped on filesystem before VS Code opens it; set CAOGEN_GUI_VSCODE_NATIVE_CREATE_E2E=1 for native create coverage'
  : null
const content = "export const generatedByGuiAutomation = 'hello gui'\n"

mkdirSync(workspaceDir, { recursive: true })
if (!strictCreateMode || !nativeStrictCreateMode) writeFileSync(filePath, '', 'utf8')

const controller = evaluateWindowsController()
let targetWindowId = null
let targetPid = null
let strictCreateFallback = strictCreateBootstrapNote
let markerFallback = null
let markerExecutionMode = null
const editorTypeFallbacks = []
const terminalTypeFallbacks = []
const terminalAttempts = []
const hotkeyFallbacks = []
let editorSendKeysFallback = null
let editorDirectWriteFallback = null
let lastTerminalTarget = null
let cdpClient = null
let editorInputMethod = null
let terminalInputMethod = null
const releaseRunLock = await acquireRunLock(lockDir)

try {
  writeReport({
    status: 'running',
    required: requiredRun,
    strictCreateMode,
    nativeStrictCreateMode,
    terminalCommandE2E,
    strictEditorInputE2E,
    cdpInputE2E,
    cdpPort,
    strictCreateFallback,
    filePath,
    markerPath,
    sourceChars: existsSync(filePath) ? readFileSync(filePath, 'utf8').length : 0,
    markerChars: existsSync(markerPath) ? readFileSync(markerPath, 'utf8').length : 0
  })
  await closeStaleTestWindows()
  launchVsCode(filePath)
  let target
  try {
    target = await waitForVsCodeWindow(path.basename(filePath), 30_000)
  } catch (error) {
    if (!strictCreateMode) throw error
    strictCreateFallback = `VS Code did not open non-existing target directly: ${error instanceof Error ? error.message : String(error)}`
    writeFileSync(filePath, '', 'utf8')
    reopenVsCodeFile(filePath)
    target = await waitForVsCodeWindow(path.basename(filePath), 30_000)
  }
  targetWindowId = target.id
  targetPid = target.pid
  await activateVsCodeWindow('activate VS Code')
  await sleep(800)
  if (strictEditorInputE2E) {
    await writeVsCodeFileWithRetry(content)
  } else {
    editorDirectWriteFallback = 'prototype-only: strict VS Code editor input is disabled by default; set CAOGEN_GUI_VSCODE_STRICT_INPUT_E2E=1 to exercise desktop typing'
    writeFileSync(filePath, content, 'utf8')
    await waitForFileContent(filePath, content, 5_000)
  }
  if (terminalCommandE2E) {
    try {
      const markerCommand = `Set-Content -LiteralPath ${psLiteral(markerPath)} -Value 'ok' -NoNewline`
      await runCommandAndWaitForFileContent(
        markerCommand,
        'write command marker',
        markerPath,
        'ok',
        15_000
      )
      markerExecutionMode = 'vscode-terminal'
    } catch (error) {
      markerFallback = error instanceof Error ? error.message : String(error)
      throw new Error(`VS Code integrated terminal command failed: ${markerFallback}`)
    }
  } else {
    markerFallback = 'prototype-only: VS Code integrated terminal command path is disabled by default; set CAOGEN_GUI_VSCODE_TERMINAL_E2E=1 to exercise it'
    await writeCommandMarkerFallback(markerFallback)
  }
  const strictFailures = strictModeFailures()
  if (strictFailures.length > 0) {
    throw new Error(`strict VS Code GUI E2E evidence failed: ${strictFailures.join('; ')}`)
  }
  const createLabel = strictCreateMode ? 'created' : 'opened precreated'
  const markerLabel = markerFallback ? 'created marker through fallback' : 'ran command marker'
  const passReport = {
    status: 'passed',
    required: requiredRun,
    strictCreateMode,
    nativeStrictCreateMode,
    terminalCommandE2E,
    strictEditorInputE2E,
    cdpInputE2E,
    cdpPort,
    strictCreateFallback,
    markerFallback,
    markerExecutionMode,
    editorInputMethod,
    terminalInputMethod,
    editorSendKeysFallback,
    editorDirectWriteFallback,
    editorTypeFallbacks,
    terminalTypeFallbacks,
    terminalAttempts,
    hotkeyFallbacks,
    prototypeOnlyLimitations: prototypeOnlyLimitations(),
    filePath,
    markerPath,
    sourceChars: readFileSync(filePath, 'utf8').length,
    markerChars: readFileSync(markerPath, 'utf8').length
  }
  writeReport(passReport)
  await closeTestWindow().catch((error) => {
    const closeError = error instanceof Error ? error.message : String(error)
    writeReport({ ...passReport, cleanupWarning: closeError })
  })
  console.log(`PASS VS Code GUI E2E ${createLabel} ${filePath}, wrote code, and ${markerLabel} ${markerPath}`)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  writeReport({
    status: 'failed',
    required: requiredRun,
    strictCreateMode,
    nativeStrictCreateMode,
    terminalCommandE2E,
    strictEditorInputE2E,
    cdpInputE2E,
    cdpPort,
    strictCreateFallback,
    markerFallback,
    markerExecutionMode,
    editorInputMethod,
    terminalInputMethod,
    editorSendKeysFallback,
    editorDirectWriteFallback,
    editorTypeFallbacks,
    terminalTypeFallbacks,
    terminalAttempts,
    hotkeyFallbacks,
    prototypeOnlyLimitations: prototypeOnlyLimitations(),
    filePath,
    markerPath,
    sourceChars: existsSync(filePath) ? readFileSync(filePath, 'utf8').length : 0,
    markerChars: existsSync(markerPath) ? readFileSync(markerPath, 'utf8').length : 0,
    error: message,
    windowSnapshot: await safeWindowSnapshot()
  })
  console.error(`FAIL VS Code GUI E2E: ${message}`)
  await closeTestWindow().catch(() => undefined)
  process.exitCode = 1
} finally {
  cdpClient?.close?.()
  releaseRunLock()
}

async function waitForCreatedFileWindow() {
  strictCreateFallback = strictCreateFallback ?? 'created file opened in a fresh VS Code window after workspace bootstrap'
  if (targetPid) await forceCloseProcessTree(targetPid).catch(() => undefined)
  targetWindowId = null
  targetPid = null
  await sleep(1000)
  launchVsCode(filePath)
  return await waitForVsCodeWindow(path.basename(filePath), 30_000)
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

function launchVsCode(targetPath) {
  const child = spawn(
    codeCmd,
    [
      '--new-window',
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      `--remote-debugging-port=${cdpPort}`,
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
}

function reopenVsCodeFile(targetPath) {
  const child = spawn(
    codeCmd,
    [
      '--reuse-window',
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      `--remote-debugging-port=${cdpPort}`,
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
}

async function waitForVsCodeWindow(fileName, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await controller.windowsListWindows()
    if (!result.ok) throw new Error(result.error ?? 'windowsListWindows failed')
    const target = pickVsCodeWindowCandidate(result.windows, fileName)
    if (target) return target
    await sleep(500)
  }
  throw new Error(`VS Code window for ${fileName} did not appear`)
}

function pickVsCodeWindowCandidate(windows, fileName) {
  const normalizedFileName = fileName.toLowerCase()
  const workspaceName = path.basename(workspaceDir).toLowerCase()
  const candidates = windows.filter((windowInfo) => windowInfo.processName.toLowerCase().includes('code'))
  return candidates.find((windowInfo) => windowInfo.title.toLowerCase().includes(normalizedFileName))
    ?? candidates.find((windowInfo) => windowInfo.title.toLowerCase().includes(workspaceName))
    ?? candidates.find((windowInfo) => targetWindowId && windowInfo.id === targetWindowId)
    ?? candidates.find((windowInfo) => targetPid && windowInfo.pid === targetPid)
    ?? candidates.find((windowInfo) => processCommandLineIncludes(windowInfo.pid, userDataDir))
    ?? null
}

function processCommandLineIncludes(pid, needle) {
  if (!pid || !needle) return false
  try {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$process = Get-CimInstance Win32_Process -Filter ${psDoubleQuoted(`ProcessId=${pid}`)}`,
      'if ($null -eq $process) { exit 2 }',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      'Write-Output $process.CommandLine'
    ].join('\n')
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 5_000 }
    )
    return stdout.toLowerCase().includes(needle.toLowerCase())
  } catch {
    return false
  }
}

async function waitForFileContent(targetPath, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(targetPath) && normalizeNewlines(readFileSync(targetPath, 'utf8')) === normalizeNewlines(expected)) return
    await sleep(300)
  }
  const actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
  throw new Error(`saved file content mismatch; expected ${expected.length} chars, got ${actual.length}`)
}

async function waitForFileExists(targetPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(targetPath)) return
    await sleep(300)
  }
  throw new Error(`file was not created: ${targetPath}`)
}

async function writeVsCodeFileWithRetry(text) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await writeVsCodeFileOnce(text, attempt)
      await waitForFileContent(filePath, text, 10_000)
      return
    } catch (error) {
      lastError = error
      await sleep(900)
    }
  }
  editorSendKeysFallback = lastError instanceof Error ? lastError.message : String(lastError ?? 'VS Code file write did not complete')
  if (strictEditorInputE2E) {
    throw new Error(`strict VS Code editor input failed before SendKeys/filesystem fallback: ${editorSendKeysFallback}`)
  }
  try {
    await reopenVsCodeFileForFallback()
    await writeVsCodeFileViaSendKeys(text)
    await waitForFileContent(filePath, text, 15_000)
  } catch (error) {
    const sendKeysReason = error instanceof Error ? error.message : String(error)
    editorDirectWriteFallback = [editorSendKeysFallback, sendKeysReason].filter(Boolean).join('; ')
    if (strictEditorInputE2E) {
      throw new Error(`strict VS Code editor input failed before filesystem fallback: ${editorDirectWriteFallback}`)
    }
    writeFileSync(filePath, text, 'utf8')
    await waitForFileContent(filePath, text, 5_000)
  }
}

async function writeCommandMarkerFallback(reason) {
  markerExecutionMode = 'filesystem-fallback'
  markerFallback = reason
  writeFileSync(markerPath, 'ok', 'utf8')
  await waitForFileContent(markerPath, 'ok', 5_000)
}

async function reopenVsCodeFileForFallback() {
  if (!existsSync(filePath)) writeFileSync(filePath, '', 'utf8')
  reopenVsCodeFile(filePath)
  const fileWindow = await waitForVsCodeWindow(path.basename(filePath), 30_000)
  targetWindowId = fileWindow.id
  targetPid = fileWindow.pid
  await activateVsCodeWindow('activate VS Code before SendKeys fallback').catch(() => undefined)
  await sleep(500)
  await focusVsCodeEditor(fileWindow.id, 'focus VS Code editor before SendKeys fallback')
    .catch(() => clickEditorRegion(fileWindow, 'click editor region before SendKeys fallback').catch(() => undefined))
  await sleep(1000)
}

async function writeVsCodeFileViaSendKeys(text) {
  const encodedText = Buffer.from(text, 'utf16le').toString('base64')
  const title = `${path.basename(filePath)} - Visual Studio Code`
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CaoGenVsCodeSendKeysNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$shell = New-Object -ComObject WScript.Shell
$activated = $false
$targetPid = ${Number.isFinite(targetPid) ? targetPid : 0}
if ($targetPid -gt 0) {
  $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
    [void][CaoGenVsCodeSendKeysNative]::ShowWindowAsync($process.MainWindowHandle, 9)
    Start-Sleep -Milliseconds 120
    [void][CaoGenVsCodeSendKeysNative]::SetForegroundWindow($process.MainWindowHandle)
    Start-Sleep -Milliseconds 180
  }
  $activated = [bool]$shell.AppActivate($targetPid)
}
if (-not $activated) {
  $activated = [bool]$shell.AppActivate(${psDoubleQuoted(title)})
}
if (-not $activated) {
  throw 'VS Code AppActivate failed'
}
Start-Sleep -Milliseconds 500
$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedText}'))
Set-Clipboard -Value $text
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait('^s')
Start-Sleep -Milliseconds 1200
`
  await runPowerShellScript(script, 'write VS Code editor through SendKeys fallback')
}

async function writeVsCodeFileOnce(text, attempt) {
  const windowInfo = await activateVsCodeWindow(`activate VS Code for write attempt ${attempt}`)
  await sleep(500)
  await pressVsCodeHotkey(['esc'], `dismiss transient UI attempt ${attempt}`, { ignoreFailure: true })
  await sleep(200)
  await pressVsCodeHotkey(['ctrl', '1'], `focus editor group attempt ${attempt}`, { ignoreFailure: true })
  await sleep(300)
  await focusVsCodeEditor(windowInfo.id, `focus VS Code editor attempt ${attempt}`)
  await sleep(250)
  await pressVsCodeHotkey(['ctrl', 'a'], `select editor content attempt ${attempt}`, { focus: 'editor' })
  await sleep(200)
  await typeEditorText(text, attempt)
  if (strictEditorInputE2E && cdpInputE2E && editorInputMethod === 'cdp-insertText') {
    await sleep(300)
    await saveThroughCdp(`save file attempt ${attempt}`)
    await sleep(1200)
    return
  }
  await sleep(600)
  await activateVsCodeWindow(`reactivate VS Code before save attempt ${attempt}`)
  await sleep(250)
  await pressVsCodeHotkey(['ctrl', 's'], `save file attempt ${attempt}`, { focus: 'editor' })
  await sleep(900)
  await pressVsCodeHotkey(['ctrl', 's'], `confirm save file attempt ${attempt}`, { focus: 'editor' })
}

async function typeEditorText(text, attempt) {
  if (strictEditorInputE2E && cdpInputE2E) {
    await focusEditorThroughCdp(`editor attempt ${attempt}`)
    await selectAllThroughCdp(`editor attempt ${attempt}`)
    await insertTextThroughCdp(text, `editor attempt ${attempt}`)
    editorInputMethod = 'cdp-insertText'
    return
  }
  try {
    await must(
      controller.windowsTypeText({
        windowId: targetWindowId ?? undefined,
        text,
        allowForegroundMismatch: true,
        inputMode: 'auto',
        strict: strictEditorInputE2E
      }),
      `type code into VS Code attempt ${attempt}`
    )
    return
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const windowInfo = await activateVsCodeWindow(`reactivate VS Code before editor type fallback attempt ${attempt}`)
    await sleep(250)
    await focusVsCodeEditor(windowInfo.id, `focus VS Code editor fallback attempt ${attempt}`)
    await sleep(250)
    await must(
      controller.windowsTypeText({
        windowId: windowInfo.id,
        text,
        allowForegroundMismatch: true,
        inputMode: 'auto',
        strict: strictEditorInputE2E
      }),
      `type code into focused VS Code editor attempt ${attempt}`
    )
    editorTypeFallbacks.push({ attempt, reason })
  }
}

async function runCommandInVsCodeTerminalWithRetry(command, label) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await runCommandInVsCodeTerminal(command, `${label} attempt ${attempt}`)
      return
    } catch (error) {
      lastError = error
      await sleep(1000)
    }
  }
  throw lastError ?? new Error(`VS Code terminal command failed: ${label}`)
}

async function runCommandAndWaitForFileContent(command, label, targetPath, expected, timeoutMs) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await runCommandInVsCodeTerminal(command, `${label} attempt ${attempt}`)
      await waitForFileContent(targetPath, expected, timeoutMs)
      return
    } catch (error) {
      lastError = error
      await sleep(1000)
    }
  }
  throw lastError ?? new Error(`VS Code terminal command did not produce expected file content: ${label}`)
}

async function runCommandInVsCodeTerminal(command, label) {
  await activateVsCodeWindow('reactivate VS Code before terminal command')
  await sleep(300)
  await pressVsCodeHotkey(['esc'], `dismiss transient UI before terminal command: ${label}`, { ignoreFailure: true })
  await sleep(150)
  await openTerminalPanel(label)
  await sleep(1200)
  const terminalTarget = await focusTerminalRegion(label)
  await sleep(250)
  await typeTerminalCommand(command, label, terminalTarget)
  await sleep(200)
  await pressVsCodeHotkey(['enter'], `run terminal command: ${label}`, { focus: 'terminal' })
  await sleep(1500)
}

async function pressVsCodeHotkey(keys, label, options = {}) {
  try {
    await must(controller.windowsHotkey({ windowId: targetWindowId ?? undefined, keys, allowForegroundMismatch: true }), label)
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      const windowInfo = await activateVsCodeWindow(`reactivate VS Code before hotkey fallback: ${label}`)
      await sleep(200)
      if (options.focus === 'editor') {
        await focusVsCodeEditor(windowInfo.id, `focus editor before hotkey fallback: ${label}`)
      } else if (options.focus === 'terminal') {
        await focusTerminalRegion(`focus terminal before hotkey fallback: ${label}`)
      } else {
        await clickWindowCenter(windowInfo, `center click before hotkey fallback: ${label}`)
      }
      await sleep(200)
      await must(controller.windowsHotkey(keys), `${label} without window selector`)
      hotkeyFallbacks.push({ label, keys, reason })
      return true
    } catch (fallbackError) {
      if (options.ignoreFailure) return false
      const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new Error(`${label} failed: ${reason}; fallback failed: ${fallbackReason}`)
    }
  }
}

async function typeTerminalCommand(command, label, terminalTarget = lastTerminalTarget) {
  if (terminalCommandE2E && cdpInputE2E) {
    await focusTerminalThroughCdp(`terminal command: ${label}`).catch(() => undefined)
    await insertTextThroughCdp(command, `terminal command: ${label}`)
    await dispatchEnterThroughCdp(`terminal command: ${label}`)
    terminalInputMethod = 'cdp-insertText'
    terminalAttempts.push({ label, stage: 'type-terminal-command', ok: true, method: terminalInputMethod })
    return
  }
  const terminalText = terminalCommandE2E ? `${command}\r\n` : command
  const targetInput = terminalTarget?.element?.id
    ? {
        windowId: terminalTarget.windowInfo.id,
        elementId: terminalTarget.element.id,
        text: terminalText,
        allowForegroundMismatch: true,
        inputMode: 'auto',
        strict: terminalCommandE2E
      }
    : {
        windowId: targetWindowId ?? undefined,
        text: terminalText,
        allowForegroundMismatch: true,
        inputMode: 'auto',
        strict: terminalCommandE2E
      }
  try {
    const result = await must(
      controller.windowsTypeText(targetInput),
      `type terminal command: ${label}`
    )
    terminalAttempts.push({ label, stage: 'type-terminal-command', ok: true, method: result.method })
    return
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await activateVsCodeWindow(`reactivate VS Code before terminal type fallback: ${label}`).catch(() => undefined)
    await sleep(250)
    const fallbackTarget = await focusTerminalRegion(`${label} fallback`)
    await sleep(250)
    const fallbackInput = fallbackTarget?.element?.id
      ? {
          windowId: fallbackTarget.windowInfo.id,
          elementId: fallbackTarget.element.id,
          text: terminalText,
          allowForegroundMismatch: true,
          inputMode: 'auto',
          strict: terminalCommandE2E
        }
      : {
          text: terminalText,
          inputMode: 'auto',
          strict: terminalCommandE2E
        }
    const result = await must(
      controller.windowsTypeText(fallbackInput),
      `type terminal command without window selector: ${label}`
    )
    terminalAttempts.push({ label, stage: 'type-terminal-command-without-window-selector', ok: true, method: result.method })
    terminalTypeFallbacks.push({ label, reason })
  }
}

async function openTerminalPanel(label) {
  if (terminalCommandE2E && cdpInputE2E) {
    try {
      await openTerminalPanelThroughCdp(label)
      await waitForTerminalVisible(`${label} after CDP command palette`, 12_000)
      terminalAttempts.push({ label, stage: 'cdp-open-terminal', ok: true })
      return
    } catch (error) {
      terminalAttempts.push({
        label,
        stage: 'cdp-open-terminal',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  let paletteError = null
  try {
    await pressVsCodeHotkey(['ctrl', 'shift', 'p'], `open command palette: ${label}`)
    await sleep(500)
    await must(
      controller.windowsTypeText({
        windowId: targetWindowId ?? undefined,
        text: '>Terminal: Create New Terminal',
        allowForegroundMismatch: true,
        inputMode: 'auto',
        strict: terminalCommandE2E
      }),
      `type terminal command palette action: ${label}`
    )
    await sleep(200)
    await pressVsCodeHotkey(['enter'], `confirm command palette terminal action: ${label}`)
    await sleep(1200)
    await waitForTerminalVisible(`${label} after command palette`, 8_000)
    return
  } catch (error) {
    paletteError = error instanceof Error ? error.message : String(error)
    terminalAttempts.push({ label, stage: 'command-palette-open', ok: false, error: paletteError })
  }

  await pressVsCodeHotkey(['ctrl', 'shift', 'grave'], `open terminal shortcut: ${label}`)
  try {
    await waitForTerminalVisible(`${label} after shortcut`, 8_000)
    terminalAttempts.push({ label, stage: 'shortcut-open', ok: true, previousError: paletteError })
  } catch (error) {
    const shortcutError = error instanceof Error ? error.message : String(error)
    terminalAttempts.push({ label, stage: 'shortcut-open', ok: false, error: shortcutError, previousError: paletteError })
    throw new Error(`VS Code terminal did not become visible; command palette failed: ${paletteError}; shortcut failed: ${shortcutError}`)
  }
}

async function focusTerminalRegion(label) {
  const terminal = await waitForTerminalVisible(label, 5_000).catch(() => null)
  if (terminal?.element) {
    await must(
      controller.windowsClick({
        windowId: terminal.windowInfo.id,
        elementId: terminal.element.id,
        button: 'left'
      }),
      `focus VS Code terminal element: ${label}`
    )
    terminalAttempts.push({
      label,
      stage: 'focus-terminal-element',
      ok: true,
      element: describeTerminalElement(terminal.element)
    })
    lastTerminalTarget = terminal
    return terminal
  }

  const windowInfo = terminal?.windowInfo ?? await resolveCurrentVsCodeWindow()
  const bounds = windowInfo.bounds
  await must(
    controller.windowsClick({
      x: Math.round(bounds.x + bounds.width * 0.55),
      y: Math.round(bounds.y + bounds.height * 0.84),
      button: 'left'
    }),
    `focus VS Code terminal region: ${label}`
  )
  terminalAttempts.push({ label, stage: 'focus-terminal-region', ok: true })
  lastTerminalTarget = { windowInfo, element: null }
  return lastTerminalTarget
}

async function waitForTerminalVisible(label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot = null
  while (Date.now() < deadline) {
    const windowInfo = await resolveCurrentVsCodeWindow()
    const result = await controller.windowsListWindows({
      windowId: windowInfo.id,
      includeElements: true,
      maxElements: 500
    })
    if (result.ok && result.windows.length > 0) {
      const inspectedWindow = result.windows[0]
      const terminalElement = pickLikelyTerminalElement(inspectedWindow)
      lastSnapshot = {
        title: inspectedWindow.title,
        elements: (inspectedWindow.elements ?? []).slice(0, 25).map(describeTerminalElement)
      }
      if (terminalElement) {
        terminalAttempts.push({
          label,
          stage: 'terminal-visible',
          ok: true,
          element: describeTerminalElement(terminalElement)
        })
        targetWindowId = inspectedWindow.id
        targetPid = inspectedWindow.pid
        return { windowInfo: inspectedWindow, element: terminalElement }
      }
    }
    await sleep(400)
  }
  throw new Error(`VS Code terminal was not visible for ${label}; last snapshot: ${JSON.stringify(lastSnapshot)}`)
}

function pickLikelyTerminalElement(windowInfo) {
  const elements = Array.isArray(windowInfo.elements) ? windowInfo.elements : []
  const windowArea = Math.max(1, windowInfo.bounds.width * windowInfo.bounds.height)
  const scored = elements
    .filter((element) => element.enabled !== false && element.offscreen !== true)
    .map((element) => ({ element, score: scoreTerminalElement(element, windowInfo, windowArea) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored[0]?.element ?? null
}

function scoreTerminalElement(element, windowInfo, windowArea) {
  const text = [
    element.name,
    element.automationId,
    element.className,
    element.controlType
  ].join(' ').toLowerCase()
  const hasTerminalSignal = text.includes('terminal')
    || text.includes('powershell')
    || text.includes('cmd')
    || text.includes('shell')
    || text.includes('xterm')
  if (!hasTerminalSignal) return 0
  const area = Math.max(1, element.bounds.width * element.bounds.height)
  let score = 0
  if (text.includes('terminal')) score += 55
  if (text.includes('powershell')) score += 45
  if (text.includes('cmd')) score += 25
  if (text.includes('shell')) score += 25
  if (text.includes('xterm')) score += 35
  if (text.includes('panel')) score += 10
  if (text.includes('document')) score += 8
  if (area > windowArea * 0.05) score += 8
  if (element.bounds.y > windowInfo.bounds.y + windowInfo.bounds.height * 0.45) score += 14
  if (text.includes('activity') || text.includes('status') || text.includes('menu')) score -= 25
  if (text.includes('editor') || text.includes(path.basename(filePath).toLowerCase())) score -= 35
  return score
}

function describeTerminalElement(element) {
  return {
    name: element.name,
    automationId: element.automationId,
    className: element.className,
    controlType: element.controlType,
    bounds: element.bounds
  }
}

async function activateVsCodeWindow(label) {
  let lastError = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const windowInfo = await resolveCurrentVsCodeWindow()
      targetWindowId = windowInfo.id
      targetPid = windowInfo.pid
      await must(controller.windowsActivateWindow({ windowId: windowInfo.id }), `${label} attempt ${attempt}`)
      await sleep(150)
      await clickWindowCenter(windowInfo, `${label} center click attempt ${attempt}`).catch(() => undefined)
      return windowInfo
    } catch (error) {
      lastError = error
      await sleep(700)
    }
  }
  throw lastError ?? new Error(`${label} failed`)
}

async function focusVsCodeEditor(windowId, label) {
  const result = await controller.windowsListWindows({
    windowId,
    includeElements: true,
    maxElements: 250
  })
  if (result.ok && result.windows.length > 0) {
    const windowInfo = result.windows[0]
    const candidate = pickLikelyEditorElement(windowInfo)
    if (candidate) {
      await must(
        controller.windowsClick({
          windowId,
          elementId: candidate.id,
          button: 'left'
        }),
        `${label} via ${candidate.controlType || candidate.className || candidate.name || candidate.id}`
      )
      return
    }
    await clickEditorRegion(windowInfo, `${label} editor region fallback`)
    return
  }
  await clickWindowCenterById(windowId, `${label} center fallback`)
}

function pickLikelyEditorElement(windowInfo) {
  const elements = Array.isArray(windowInfo.elements) ? windowInfo.elements : []
  const windowArea = Math.max(1, windowInfo.bounds.width * windowInfo.bounds.height)
  const scored = elements
    .filter((element) => element.enabled !== false && element.offscreen !== true)
    .map((element) => ({ element, score: scoreEditorElement(element, windowInfo, windowArea) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored[0]?.element ?? null
}

function scoreEditorElement(element, windowInfo, windowArea) {
  const text = [
    element.name,
    element.automationId,
    element.className,
    element.controlType
  ].join(' ').toLowerCase()
  const area = Math.max(1, element.bounds.width * element.bounds.height)
  let score = 0
  if (text.includes('document')) score += 40
  if (text.includes('edit')) score += 35
  if (text.includes('editor')) score += 30
  if (text.includes('monaco')) score += 30
  if (text.includes(path.basename(filePath).toLowerCase())) score += 20
  if (text.includes('workbench')) score += 10
  if (area > windowArea * 0.12) score += 8
  if (element.bounds.x > windowInfo.bounds.x + windowInfo.bounds.width * 0.15) score += 5
  if (text.includes('title') || text.includes('status') || text.includes('activity') || text.includes('terminal')) score -= 25
  return score
}

async function clickEditorRegion(windowInfo, label) {
  const bounds = windowInfo.bounds
  if (!bounds || typeof bounds.width !== 'number' || typeof bounds.height !== 'number') return
  await must(
    controller.windowsClick({
      x: Math.round(bounds.x + bounds.width * 0.62),
      y: Math.round(bounds.y + bounds.height * 0.46),
      button: 'left'
    }),
    label
  )
}

async function resolveCurrentVsCodeWindow() {
  const result = await controller.windowsListWindows()
  if (!result.ok) throw new Error(result.error ?? 'windowsListWindows failed')
  const fileName = path.basename(filePath).toLowerCase()
  const selected = pickVsCodeWindowCandidate(result.windows, fileName)
  if (selected) {
    targetWindowId = selected.id
    targetPid = selected.pid
    return selected
  }

  if (existsSync(filePath)) {
    reopenVsCodeFile(filePath)
    const reopened = await waitForVsCodeWindow(path.basename(filePath), 30_000)
    targetWindowId = reopened.id
    targetPid = reopened.pid
    return reopened
  }

  if (strictCreateMode && nativeStrictCreateMode) {
    launchVsCode(filePath)
    const relaunched = await waitForVsCodeWindow(path.basename(filePath), 30_000)
    targetWindowId = relaunched.id
    targetPid = relaunched.pid
    return relaunched
  }

  throw new Error(`VS Code window for ${path.basename(filePath)} is no longer available`)
}

async function clickWindowCenterById(windowId, label) {
  const result = await controller.windowsListWindows()
  if (!result.ok) throw new Error(result.error ?? 'windowsListWindows failed')
  const windowInfo = result.windows.find((item) => item.id === windowId)
  if (!windowInfo) return
  await clickWindowCenter(windowInfo, label)
}

async function clickWindowCenter(windowInfo, label) {
  const bounds = windowInfo.bounds
  if (!bounds || typeof bounds.width !== 'number' || typeof bounds.height !== 'number') return
  await must(
    controller.windowsClick({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
      button: 'left'
    }),
    label
  )
}

async function safeWindowSnapshot() {
  try {
    const selector = targetWindowId ? { windowId: targetWindowId, includeElements: true, maxElements: 30 } : { includeElements: true, maxElements: 30 }
    const result = await controller.windowsListWindows(selector)
    if (!result.ok) return { ok: false, error: result.error ?? 'windowsListWindows failed' }
    return {
      ok: true,
      windows: result.windows.map((windowInfo) => ({
        title: windowInfo.title,
        processName: windowInfo.processName,
        pid: windowInfo.pid,
        bounds: windowInfo.bounds,
        elements: (windowInfo.elements ?? []).slice(0, 20).map((element) => ({
          name: element.name,
          automationId: element.automationId,
          className: element.className,
          controlType: element.controlType,
          bounds: element.bounds,
          enabled: element.enabled,
          offscreen: element.offscreen
        }))
      }))
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
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

async function insertTextThroughCdp(text, label) {
  const client = await getCdpClient()
  await client.send('Page.bringToFront').catch(() => undefined)
  await sleep(100)
  await client.send('Input.insertText', { text })
  await sleep(250)
  if (label) {
    terminalAttempts.push({ label, stage: 'cdp-insert-text', ok: true })
  }
}

async function focusEditorThroughCdp(label) {
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
  terminalAttempts.push({ label, stage: 'cdp-focus-editor', ok: true })
}

async function focusTerminalThroughCdp(label) {
  const client = await getCdpClient()
  await client.send('Page.bringToFront').catch(() => undefined)
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const terminal = document.querySelector('.xterm-helper-textarea')
        ?? document.querySelector('.terminal-wrapper')
        ?? document.querySelector('.panel');
      if (!terminal) return null;
      const rect = terminal.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`,
    returnByValue: true
  })
  const rect = result?.result?.value
  if (!rect || typeof rect.x !== 'number') throw new Error('VS Code terminal DOM rect was unavailable')
  await clickCdpPoint(rect.x + Math.max(4, rect.width * 0.5), rect.y + Math.max(4, rect.height * 0.5))
  terminalAttempts.push({ label, stage: 'cdp-focus-terminal', ok: true })
}

async function clickCdpPoint(x, y) {
  const client = await getCdpClient()
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
}

async function dispatchEnterThroughCdp(label) {
  const client = await getCdpClient()
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
  terminalAttempts.push({ label, stage: 'cdp-enter', ok: true })
}

async function openTerminalPanelThroughCdp(label) {
  await dispatchShortcutThroughCdp(
    { key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80 },
    label,
    'cdp-open-command-palette',
    { ctrl: true, shift: true }
  )
  await sleep(500)
  await insertTextThroughCdp('>Terminal: Create New Terminal', `${label} command palette`)
  await sleep(200)
  await dispatchEnterThroughCdp(`${label} command palette`)
  await sleep(1800)
}

async function selectAllThroughCdp(label) {
  await dispatchShortcutThroughCdp({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, label, 'cdp-select-all', { ctrl: true })
}

async function saveThroughCdp(label) {
  await dispatchShortcutThroughCdp({ key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 }, label, 'cdp-save', { ctrl: true })
}

async function dispatchShortcutThroughCdp(keyInfo, label, stage, modifiersInput = { ctrl: true }) {
  const client = await getCdpClient()
  const modifiers = (modifiersInput.ctrl ? 2 : 0) | (modifiersInput.shift ? 8 : 0) | (modifiersInput.alt ? 1 : 0)
  if (modifiersInput.ctrl) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers
    })
  }
  if (modifiersInput.shift) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16,
      modifiers
    })
  }
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
    modifiers
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyInfo.key,
    code: keyInfo.code,
    windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
    modifiers
  })
  if (modifiersInput.shift) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16,
      modifiers: modifiersInput.ctrl ? 2 : 0
    })
  }
  if (modifiersInput.ctrl) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17
    })
  }
  terminalAttempts.push({ label, stage, ok: true })
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
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await response.json()
      const pages = Array.isArray(targets)
        ? targets.filter((target) => target?.webSocketDebuggerUrl && (target.type === 'page' || target.type === 'webview' || target.type === 'other'))
        : []
      const fileName = path.basename(filePath).toLowerCase()
      const selected = pages.find((target) => String(target.title ?? '').toLowerCase().includes(fileName))
        ?? pages.find((target) => String(target.url ?? '').toLowerCase().includes('workbench'))
        ?? pages[0]
      if (selected?.webSocketDebuggerUrl) return selected.webSocketDebuggerUrl
      lastError = new Error('CDP target list did not include a debuggable VS Code page')
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error(`VS Code CDP target was unavailable on port ${cdpPort}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
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

async function must(promise, label) {
  const result = await promise
  if (result.ok) return result
  throw new Error(`${label} failed: ${result.error ?? result.detail ?? 'unknown error'}`)
}

async function closeTestWindow() {
  if (!targetWindowId) return
  const pidToClose = targetPid
  try {
    await must(controller.windowsActivateWindow({ windowId: targetWindowId }), 'reactivate VS Code before close')
    await sleep(200)
    await controller.windowsHotkey(['ctrl', 's']).catch(() => undefined)
    await sleep(300)
    await must(controller.windowsHotkey(['alt', 'f4']), 'close VS Code test window')
    await sleep(800)
    if (pidToClose) await forceCloseProcessTree(pidToClose).catch(() => undefined)
  } catch (err) {
    if (pidToClose) await forceCloseProcessTree(pidToClose).catch(() => undefined)
    throw err
  }
  targetWindowId = null
  targetPid = null
}

async function closeStaleTestWindows() {
  const result = await controller.windowsListWindows()
  if (!result.ok) return
  const targets = result.windows.filter((windowInfo) => {
    const processName = windowInfo.processName.toLowerCase()
    const title = windowInfo.title.toLowerCase()
    return processName.includes('code') && title.includes('sample.ts')
  })
  for (const target of targets) {
    await forceCloseProcessTree(target.pid)
  }
  if (targets.length > 0) await sleep(1000)
}

function prototypeOnlyLimitations() {
  const limitations = []
  if (strictCreateFallback) limitations.push(strictCreateFallback)
  if (editorDirectWriteFallback) {
    limitations.push('prototype-only: editor text required filesystem fallback after desktop typing was blocked')
  }
  if (markerExecutionMode === 'filesystem-fallback') {
    limitations.push('prototype-only: command marker was persisted through filesystem fallback instead of VS Code integrated terminal')
  }
  return limitations
}

function strictModeFailures() {
  const failures = []
  if (nativeStrictCreateMode && strictCreateFallback) {
    failures.push('native file creation fell back')
  }
  if (strictEditorInputE2E && editorDirectWriteFallback) {
    failures.push('strict editor input fell back to filesystem write')
  }
  if (terminalCommandE2E && markerExecutionMode !== 'vscode-terminal') {
    failures.push('integrated terminal command marker was not produced by VS Code terminal')
  }
  return failures
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n')
}

function psLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`
}

function jsSingleQuoted(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function psDoubleQuoted(value) {
  return `"${value.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"')}"`
}

function runPowerShellScript(script, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-Sta', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        cwd: repoRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${label} failed with exit ${code}: ${stderr.trim() || stdout.trim() || 'no output'}`))
    })
  })
}

function forceCloseProcessTree(pid) {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    const timeout = setTimeout(() => {
      child.kill()
      resolve()
    }, 5000)
    const done = () => {
      clearTimeout(timeout)
      resolve()
    }
    child.on('exit', done)
    child.on('error', done)
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
  throw new Error('another VS Code GUI E2E run is still active')
}

function isStaleLock(targetDir) {
  try {
    const ageMs = Date.now() - statSync(targetDir).mtimeMs
    return ageMs > 10 * 60 * 1000
  } catch {
    return true
  }
}

function writeReport(report) {
  const json = JSON.stringify({ ...report, reportDir: runRoot }, null, 2)
  writeFileSync(reportPath, json, 'utf8')
  writeFileSync(path.join(repoRoot, 'test-results', 'gui-vscode-e2e', 'latest.json'), json, 'utf8')
}
