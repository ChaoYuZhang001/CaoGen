#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'

const checks = [
  {
    name: 'gui_input_preflight_required',
    command: ['node', 'scripts/gui-input-preflight.mjs', '--required'],
    timeoutMs: 60_000,
    advisory: false
  },
  {
    name: 'gui_vscode_create_e2e',
    command: ['node', 'scripts/gui-vscode-create-e2e.mjs'],
    env: {
      CAOGEN_GUI_VSCODE_NATIVE_CREATE_E2E: '1',
      CAOGEN_GUI_VSCODE_STRICT_INPUT_E2E: '1',
      CAOGEN_GUI_VSCODE_TERMINAL_E2E: '1',
      CAOGEN_GUI_VSCODE_CDP_INPUT_E2E: '1'
    },
    timeoutMs: 180_000,
    advisory: false
  },
  {
    name: 'gui_cross_app_e2e_required',
    command: ['node', 'scripts/gui-cross-app-e2e.mjs', '--required'],
    env: {
      CAOGEN_GUI_CROSS_APP_STRICT_INPUT_E2E: '1'
    },
    timeoutMs: 120_000,
    advisory: false
  }
]

const failures = []

if (hasFreshRequiredEvidence()) {
  console.log(JSON.stringify({ status: 'passed', reusedFreshEvidence: true }, null, 2))
  process.exit(0)
}

for (const check of checks) {
  cleanupGuiTestState()
  const result = spawnSync(check.command[0], check.command.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, ...(check.env ?? {}) },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: check.timeoutMs,
    stdio: 'pipe'
  })

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.status !== 0) {
    const failure = {
      name: check.name,
      exitCode: result.status,
      signal: result.signal,
      error: result.error ? String(result.error.message || result.error) : undefined
    }
    if (check.advisory) {
      console.warn(`WARN ${check.name} failed as advisory evidence; continuing desktop GUI E2E gate`)
      continue
    }
    failures.push(failure)
  }
  cleanupGuiTestState()
}

const evidenceFailures = validateRequiredEvidence()
failures.push(...evidenceFailures)

if (failures.length > 0) {
  console.error(JSON.stringify({ status: 'failed', failures }, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ status: 'passed' }, null, 2))
}

function validateRequiredEvidence() {
  const problems = []
  const vscode = readJson('test-results/gui-vscode-e2e/latest.json')
  const crossApp = readJson('test-results/gui-cross-app-e2e/latest.json')
  if (!vscode) {
    problems.push({ name: 'gui_vscode_strict_evidence', error: 'missing test-results/gui-vscode-e2e/latest.json' })
    return problems
  }

  const limitations = Array.isArray(vscode.prototypeOnlyLimitations) ? vscode.prototypeOnlyLimitations : []
  const vscodeStrictEvidence = validateVscodeStrictEvidence(vscode)
  if (
    !vscodeStrictEvidence.ok
  ) {
    problems.push({
      name: 'gui_vscode_strict_evidence',
      error: 'VS Code GUI E2E did not prove native create + strict editor input + integrated terminal command without clipboard/filesystem fallback',
      status: vscode.status,
      nativeStrictCreateMode: vscode.nativeStrictCreateMode === true,
      strictEditorInputE2E: vscode.strictEditorInputE2E === true,
      terminalCommandE2E: vscode.terminalCommandE2E === true,
      markerExecutionMode: vscode.markerExecutionMode,
      cdpInputE2E: vscode.cdpInputE2E === true,
      editorInputMethod: vscode.editorInputMethod ?? null,
      terminalInputMethod: vscode.terminalInputMethod ?? null,
      sourceChars: Number(vscode.sourceChars) || 0,
      markerChars: Number(vscode.markerChars) || 0,
      evidenceFailures: vscodeStrictEvidence.failures,
      prototypeOnlyLimitations: limitations
    })
  }
  const crossAppLimitations = Array.isArray(crossApp?.prototypeOnlyLimitations) ? crossApp.prototypeOnlyLimitations : []
  if (
    !crossApp
    || crossApp.status !== 'passed'
    || crossApp.strictCrossAppInputE2E !== true
    || crossAppLimitations.length > 0
    || !(Number(crossApp.noteChars) > 0)
    || !(Number(crossApp.codeChars) > 0)
  ) {
    problems.push({
      name: 'gui_cross_app_strict_evidence',
      error: 'Cross-app GUI E2E did not prove strict Notepad + VS Code input without prototype fallback',
      status: crossApp?.status,
      strictCrossAppInputE2E: crossApp?.strictCrossAppInputE2E === true,
      noteChars: Number(crossApp?.noteChars) || 0,
      codeChars: Number(crossApp?.codeChars) || 0,
      prototypeOnlyLimitations: crossAppLimitations
    })
  }
  return problems
}

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(relativePath, 'utf8'))
  } catch {
    return null
  }
}

function hasFreshRequiredEvidence() {
  const maxAgeMs = 30 * 60 * 1000
  const preflight = readJson('test-results/gui-input-preflight/latest.json')
  const vscode = readJson('test-results/gui-vscode-e2e/latest.json')
  const crossApp = readJson('test-results/gui-cross-app-e2e/latest.json')
  return isFresh('test-results/gui-input-preflight/latest.json', maxAgeMs)
    && isFresh('test-results/gui-vscode-e2e/latest.json', maxAgeMs)
    && isFresh('test-results/gui-cross-app-e2e/latest.json', maxAgeMs)
    && preflight?.status === 'passed'
    && validateVscodeStrictEvidence(vscode).ok
    && crossApp?.status === 'passed'
    && crossApp?.strictCrossAppInputE2E === true
    && !(Array.isArray(crossApp?.prototypeOnlyLimitations) && crossApp.prototypeOnlyLimitations.length > 0)
    && Number(crossApp?.noteChars) > 0
    && Number(crossApp?.codeChars) > 0
}

function validateVscodeStrictEvidence(vscode) {
  const failures = []
  if (!vscode) {
    return { ok: false, failures: ['missing VS Code GUI report'] }
  }
  if (vscode.status !== 'passed') failures.push(`status=${String(vscode.status)}`)
  if (vscode.nativeStrictCreateMode !== true) failures.push('nativeStrictCreateMode is not true')
  if (vscode.strictEditorInputE2E !== true) failures.push('strictEditorInputE2E is not true')
  if (vscode.terminalCommandE2E !== true) failures.push('terminalCommandE2E is not true')
  if (vscode.markerExecutionMode !== 'vscode-terminal') failures.push(`markerExecutionMode=${String(vscode.markerExecutionMode)}`)
  if (vscode.cdpInputE2E !== true) failures.push('cdpInputE2E is not true for required VS Code renderer input evidence')
  if (vscode.editorInputMethod !== 'cdp-insertText') failures.push(`editorInputMethod=${String(vscode.editorInputMethod)}`)
  if (vscode.terminalInputMethod !== 'cdp-insertText') failures.push(`terminalInputMethod=${String(vscode.terminalInputMethod)}`)
  if (Number(vscode.sourceChars) <= 0) failures.push('sourceChars is empty')
  if (Number(vscode.markerChars) <= 0) failures.push('markerChars is empty')
  if (vscode.strictCreateFallback) failures.push('strictCreateFallback is set')
  if (vscode.markerFallback) failures.push('markerFallback is set')
  if (vscode.editorDirectWriteFallback) failures.push('editorDirectWriteFallback is set')
  if (vscode.editorSendKeysFallback) failures.push('editorSendKeysFallback is set')
  if (Array.isArray(vscode.prototypeOnlyLimitations) && vscode.prototypeOnlyLimitations.length > 0) {
    failures.push('prototypeOnlyLimitations is not empty')
  }
  if (containsClipboardMethod(vscode.terminalAttempts)) failures.push('terminalAttempts contains clipboard method')
  if (Array.isArray(vscode.editorTypeFallbacks) && vscode.editorTypeFallbacks.length > 0) {
    failures.push('editorTypeFallbacks is not empty')
  }
  if (Array.isArray(vscode.terminalTypeFallbacks) && vscode.terminalTypeFallbacks.length > 0) {
    failures.push('terminalTypeFallbacks is not empty')
  }
  return { ok: failures.length === 0, failures }
}

function containsClipboardMethod(value) {
  if (!Array.isArray(value)) return false
  return value.some((entry) => String(entry?.method ?? '').toLowerCase().includes('clipboard'))
}

function isFresh(relativePath, maxAgeMs) {
  try {
    return Date.now() - statSync(relativePath).mtimeMs <= maxAgeMs
  } catch {
    return false
  }
}

function cleanupGuiTestState() {
  if (process.platform !== 'win32') return
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `
$targets = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -like '*notepad*' -and ($_.CommandLine -like '*caogen-gui-preflight*' -or $_.CommandLine -like '*desktop-note.txt*')) -or
  ($_.ExecutablePath -like '*Code.exe' -and $_.CommandLine -like '*test-results*gui-*e2e*')
} | Select-Object -ExpandProperty ProcessId
foreach ($targetPid in $targets) {
  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
}
`
    ],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, stdio: 'ignore' }
  )

  for (const lockPath of ['test-results/gui-vscode-e2e/.lock', 'test-results/gui-cross-app-e2e/.lock']) {
    if (existsSync(lockPath)) rmSync(lockPath, { recursive: true, force: true })
  }
}
