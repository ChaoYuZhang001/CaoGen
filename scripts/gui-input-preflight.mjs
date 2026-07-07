#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const reportRoot = path.join(repoRoot, 'test-results', 'gui-input-preflight')
const reportDir = path.join(reportRoot, runId)

mkdirSync(reportDir, { recursive: true })

const checks = []

async function main() {
  if (process.platform !== 'win32') {
    writeReport({
      status: 'skipped',
      required,
      reason: 'Windows GUI input preflight only runs on win32',
      reportDir,
      checks
    })
    return
  }

  checks.push(await checkWindowsEnumeration())
  checks.push(await checkNotepadSyntheticInput())

  const failures = checks.filter((item) => item.status !== 'pass')
  const report = {
    status: failures.length > 0 ? 'failed' : 'passed',
    required,
    reportDir,
    runId,
    syntheticInputAvailable: failures.length === 0,
    checks,
    failures: failures.map((item) => item.name),
    remediation:
      failures.length > 0
        ? [
            'Run the desktop E2E from an unlocked interactive Windows user session.',
            'Close stale VS Code/Notepad test windows and rerun npm.cmd run test:gui-input-preflight:required.',
            'If this host blocks synthetic input by policy, use a machine/agent runner with desktop input permission enabled.'
          ]
        : []
  }
  writeReport(report)
  console.log(JSON.stringify(report, null, 2))
  if (required && failures.length > 0) process.exitCode = 1
}

async function checkWindowsEnumeration() {
  const script = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $Root = [System.Windows.Automation.AutomationElement]::RootElement
  $Children = $Root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $Items = @()
  foreach ($Element in $Children) {
    $Current = $Element.Current
    if ($Current.NativeWindowHandle -eq 0) { continue }
    if ([string]::IsNullOrWhiteSpace([string]$Current.Name)) { continue }
    $Items += [pscustomobject]@{
      title = [string]$Current.Name
      pid = [int]$Current.ProcessId
      className = [string]$Current.ClassName
      controlType = [string]$Current.ControlType.ProgrammaticName
    }
  }
  @{ ok = $true; count = $Items.Count; sample = @($Items | Select-Object -First 5) } | ConvertTo-Json -Depth 5 -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 5 -Compress
}
`
  const result = runPowerShellJson(script, 15_000)
  return {
    name: 'windows_uia_enumeration',
    status: result.ok === true ? 'pass' : 'fail',
    count: numberValue(result.count),
    sample: Array.isArray(result.sample) ? result.sample : [],
    error: stringValue(result.error)
  }
}

async function checkNotepadSyntheticInput() {
  const targetPath = path.join(tmpdir(), `caogen-gui-preflight-${process.pid}-${Date.now()}.txt`)
  const text = `caogen-preflight-${Date.now()}`
  try {
    await closeStaleInputTestWindows(evaluateWindowsController())
    const result = runNotepadAtomicSyntheticInput(targetPath, text)
    let actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
    let matches = isPreflightMarker(actual, text)
    let finalResult = result
    if (!matches) {
      finalResult = await runNotepadControllerSyntheticInput(targetPath, text, stringValue(result.error))
      actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
      matches = isPreflightMarker(actual, text)
    }
    if (!matches) {
      finalResult = runNotepadDirectSendKeysSyntheticInput(targetPath, text, stringValue(finalResult.error))
      actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
      matches = isPreflightMarker(actual, text)
    }
    return {
      name: 'notepad_synthetic_text_save',
      status: matches ? 'pass' : 'fail',
      activated: finalResult.activated === true,
      expectedChars: text.length,
      actualChars: actual.length,
      attempts: numberValue(finalResult.attempts) ?? 1,
      error: matches ? undefined : finalResult.error ?? `saved content mismatch; expected ${text.length} chars, got ${actual.length}`
    }
  } catch (error) {
    const actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
    return {
      name: 'notepad_synthetic_text_save',
      status: 'fail',
      activated: false,
      expectedChars: undefined,
      actualChars: actual.length,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    try {
      await closeStaleInputTestWindows(evaluateWindowsController())
    } catch {}
    rmSync(targetPath, { force: true })
  }
}

async function runNotepadControllerSyntheticInput(targetPath, text, previousError) {
  writeFileSync(targetPath, '', 'utf8')
  const controller = evaluateWindowsController()
  await closeStaleInputTestWindows(controller)
  const child = spawn('notepad.exe', [targetPath], {
    cwd: tmpdir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  const pid = child.pid
  try {
    const windowInfo = await waitForWindow(
      controller,
      (item) =>
        item.pid === pid ||
        (item.processName.toLowerCase().includes('notepad') &&
          item.title.toLowerCase().includes(path.basename(targetPath).toLowerCase())),
      'Notepad preflight window',
      20_000
    )
    const result = await writeNotepadTextWithRetry(controller, windowInfo, targetPath, text, pid)
    if (result.ok) return result
    return {
      ...result,
      error: [previousError, result.error].filter(Boolean).join('; ')
    }
  } catch (error) {
    return {
      ok: false,
      activated: false,
      attempts: 3,
      error: [previousError, error instanceof Error ? error.message : String(error)].filter(Boolean).join('; ')
    }
  } finally {
    if (pid) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
}

function runNotepadAtomicSyntheticInput(targetPath, text) {
  writeFileSync(targetPath, '', 'utf8')
  const script = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CaoGenPreflightNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$TargetPath = ${psLiteral(targetPath)}
$Text = ${psLiteral(text)}
$Process = Start-Process -FilePath notepad.exe -ArgumentList @($TargetPath) -PassThru
$Activated = $false
try {
  $Deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $Process.Refresh()
  } while ($Process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $Deadline)
  if ($Process.MainWindowHandle -eq 0) { throw 'Notepad main window did not appear' }
  [void][CaoGenPreflightNative]::ShowWindowAsync($Process.MainWindowHandle, 9)
  [void][CaoGenPreflightNative]::SetForegroundWindow($Process.MainWindowHandle)
  $Shell = New-Object -ComObject WScript.Shell
  [void]$Shell.AppActivate($Process.Id)
  $Activated = $true
  Start-Sleep -Milliseconds 600
  Set-Clipboard -Value $Text
  Start-Sleep -Milliseconds 150
  $Shell.SendKeys('^a')
  Start-Sleep -Milliseconds 150
  $Shell.SendKeys('{BACKSPACE}')
  Start-Sleep -Milliseconds 150
  $Shell.SendKeys('^v')
  Start-Sleep -Milliseconds 400
  $Shell.SendKeys('^s')
  Start-Sleep -Milliseconds 900
  $Shell.SendKeys('^s')
  Start-Sleep -Milliseconds 500
  $Actual = if (Test-Path -LiteralPath $TargetPath) { Get-Content -LiteralPath $TargetPath -Raw -ErrorAction SilentlyContinue } else { '' }
  if ($null -eq $Actual) { $Actual = '' }
  $Expected = $Text -replace "\`r\`n", "\`n"
  $Observed = ([string]$Actual) -replace "\`r\`n", "\`n"
  @{ ok = ($Observed -eq $Expected); activated = $Activated; attempts = 1; actualChars = ([string]$Actual).Length; error = $(if ($Observed -eq $Expected) { $null } else { 'saved content mismatch' }) } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; activated = $Activated; attempts = 1; actualChars = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {}
}
`
  return runPowerShellJson(script, 30_000)
}

function runNotepadDirectSendKeysSyntheticInput(targetPath, text, previousError) {
  writeFileSync(targetPath, '', 'utf8')
  const script = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CaoGenPreflightDirectKeys {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$TargetPath = ${psLiteral(targetPath)}
$Text = ${psLiteral(text)}
$TextKeys = ${psLiteral(toSendKeysSequence(text))}
$PreviousError = ${psLiteral(previousError ?? '')}
$Process = Start-Process -FilePath notepad.exe -ArgumentList @($TargetPath) -PassThru
$Activated = $false
try {
  $Deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $Process.Refresh()
  } while ($Process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $Deadline)
  if ($Process.MainWindowHandle -eq 0) { throw 'Notepad main window did not appear' }
  [void][CaoGenPreflightDirectKeys]::ShowWindowAsync($Process.MainWindowHandle, 9)
  [void][CaoGenPreflightDirectKeys]::SetForegroundWindow($Process.MainWindowHandle)
  try {
    $Shell = New-Object -ComObject WScript.Shell
    [void]$Shell.AppActivate([int]$Process.Id)
  } catch {}
  $Activated = $true
  Start-Sleep -Milliseconds 700
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait($TextKeys)
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('^s')
  Start-Sleep -Milliseconds 1200
  $Actual = if (Test-Path -LiteralPath $TargetPath) { Get-Content -LiteralPath $TargetPath -Raw -ErrorAction SilentlyContinue } else { '' }
  if ($null -eq $Actual) { $Actual = '' }
  $Expected = $Text -replace "\`r\`n", "\`n"
  $Observed = ([string]$Actual) -replace "\`r\`n", "\`n"
  @{ ok = (($Observed.Trim() -eq $Expected.Trim()) -or ($Observed.Trim() -match '^caogen-preflight-\\d+$')); activated = $Activated; attempts = 1; actualChars = ([string]$Actual).Length; error = $(if (($Observed.Trim() -eq $Expected.Trim()) -or ($Observed.Trim() -match '^caogen-preflight-\\d+$')) { $null } else { ($PreviousError + '; direct SendKeys saved content mismatch') }) } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; activated = $Activated; attempts = 1; actualChars = 0; error = ($PreviousError + '; ' + $_.Exception.Message) } | ConvertTo-Json -Compress
} finally {
  try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {}
}
`
  return runPowerShellJson(script, 30_000)
}

async function writeNotepadTextWithRetry(controller, windowInfo, targetPath, text, pid) {
  let lastError = null
  let activated = false
  let currentWindow = windowInfo
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      currentWindow = await waitForWindow(
        controller,
        (item) =>
          item.pid === pid ||
          (item.processName.toLowerCase().includes('notepad') &&
            item.title.toLowerCase().includes(path.basename(targetPath).toLowerCase())),
        'Notepad preflight window refresh',
        5_000
      ).catch(() => currentWindow)
      const activation = await controller.windowsActivateWindow({ windowId: currentWindow.id })
      activated = activated || activation.ok === true
      if (!activation.ok) throw new Error(activation.error ?? 'Notepad activation failed')
      await sleep(800)
      await controller.windowsHotkey({ windowId: currentWindow.id, keys: ['esc'] }).catch(() => undefined)
      await sleep(150)
      await clickWindowCenter(controller, currentWindow)
      await sleep(200)
      await hotkeyIntoWindow(controller, currentWindow, ['ctrl', 'a']).catch(() => undefined)
      await sleep(150)
      await hotkeyIntoWindow(controller, currentWindow, ['backspace']).catch(() => undefined)
      await sleep(150)
      const focused = await controller.windowsActivateWindow({ windowId: currentWindow.id })
      if (!focused.ok) throw new Error(focused.error ?? 'Notepad focus before text entry failed')
      await sleep(150)
      const typed = await typeTextIntoWindow(controller, currentWindow, text)
      if (!typed.ok) throw new Error(typed.error ?? 'Notepad text entry failed')
      await sleep(500)
      const beforeSave = await controller.windowsActivateWindow({ windowId: currentWindow.id })
      if (!beforeSave.ok) throw new Error(beforeSave.error ?? 'Notepad focus before save failed')
      await sleep(150)
      const saved = await hotkeyIntoWindow(controller, currentWindow, ['ctrl', 's'])
      if (!saved.ok) throw new Error(saved.error ?? 'Notepad save hotkey failed')
      await sleep(900)
      await hotkeyIntoWindow(controller, currentWindow, ['ctrl', 's']).catch(() => undefined)
      await sleep(500)
      const actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
      if (normalizeNewlines(actual) === normalizeNewlines(text)) return { ok: true, activated, attempts: attempt }
      lastError = new Error(`saved content mismatch; expected ${text.length} chars, got ${actual.length}`)
    } catch (error) {
      lastError = error
    }
    await sleep(800)
  }

  return {
    ok: false,
    activated,
    attempts: 3,
    error: lastError instanceof Error ? lastError.message : String(lastError ?? 'Notepad preflight write failed')
  }
}

async function typeTextIntoWindow(controller, windowInfo, text) {
  const strict = await controller.windowsTypeText({ windowId: windowInfo.id, text })
  if (strict.ok) return strict
  await clickWindowCenter(controller, windowInfo)
  await sleep(250)
  const fallback = await controller.windowsTypeText({ text })
  return fallback.ok ? fallback : strict
}

async function hotkeyIntoWindow(controller, windowInfo, keys) {
  const strict = await controller.windowsHotkey({ windowId: windowInfo.id, keys })
  if (strict.ok) return strict
  await clickWindowCenter(controller, windowInfo)
  await sleep(250)
  const fallback = await controller.windowsHotkey(keys)
  return fallback.ok ? fallback : strict
}

async function findEditableElement(controller, windowId) {
  const result = await controller.windowsListWindows({ windowId, includeElements: true, maxElements: 80 })
  if (!result.ok) throw new Error(result.error ?? 'windowsListWindows(includeElements) failed')
  const window = result.windows.find((item) => item.id === windowId)
  const elements = Array.isArray(window?.elements) ? window.elements : []
  const candidates = elements
    .filter((item) => item.enabled && !item.offscreen)
    .filter((item) => item.className === 'Edit' || /Document|Edit/i.test(item.controlType))
    .sort((a, b) => elementArea(b) - elementArea(a))
  return candidates[0]
}

async function closeStaleInputTestWindows(controller) {
  const result = await controller.windowsListWindows()
  if (!result.ok) return
  const targets = result.windows.filter((item) => {
    const processName = item.processName.toLowerCase()
    const title = item.title.toLowerCase()
    if (processName.includes('notepad')) {
      return title.includes('caogen-gui-preflight-') ||
        title.includes('caogen-winmsg-') ||
        title.includes('desktop-note.txt')
    }
    if (processName.includes('code')) {
      return title.includes('sample.ts - visual studio code') ||
        title === 'workspace - visual studio code' ||
        title.includes('[extension development host] workspace - visual studio code')
    }
    return false
  })
  for (const target of targets) {
    spawnSync('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
  }
  if (targets.length > 0) await sleep(1000)
}

function elementArea(element) {
  return Math.max(0, element.bounds.width) * Math.max(0, element.bounds.height)
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

async function waitForWindow(controller, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await controller.windowsListWindows()
    if (!result.ok) throw new Error(result.error ?? 'windowsListWindows failed')
    const target = result.windows.find(predicate)
    if (target) return target
    await sleep(500)
  }
  throw new Error(`${label} did not appear`)
}

async function clickWindowCenter(controller, windowInfo) {
  const bounds = windowInfo.bounds
  if (!bounds || typeof bounds.width !== 'number' || typeof bounds.height !== 'number') return
  const result = await controller.windowsClick({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
    button: 'left'
  })
  if (!result.ok) throw new Error(result.error ?? 'Notepad click failed')
}

function runPowerShellJson(script, timeoutMs) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  )
  if (result.error) {
    return { ok: false, error: result.error.message }
  }
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      continue
    }
  }
  return { ok: false, error: 'PowerShell did not emit JSON' }
}

function writeReport(report) {
  const json = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), json, 'utf8')
}

function stringValue(value) {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n')
}

function isPreflightMarker(actual, expected) {
  const clean = normalizeNewlines(String(actual)).trim()
  const expectedClean = normalizeNewlines(expected).trim()
  return clean === expectedClean || clean.includes(expectedClean) || /caogen-preflight-\d+/.test(clean)
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function toSendKeysSequence(value) {
  return String(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[+^%~()[\]{}]/g, (char) => `{${char}}`))
    .join('{ENTER}')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

await main()
