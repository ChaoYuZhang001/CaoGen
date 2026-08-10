const { spawn, spawnSync } = require('node:child_process')
const { existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const ts = require('typescript')
const { app } = require('electron')

const repoRoot = process.cwd()
const moduleCache = new Map()

function loadTypeScriptModule(filePath) {
  const resolved = path.resolve(filePath)
  if (moduleCache.has(resolved)) return moduleCache.get(resolved).exports
  const module = { exports: {} }
  moduleCache.set(resolved, module)
  const output = ts.transpileModule(readFileSync(resolved, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: resolved
  }).outputText
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) return require(specifier)
    const target = path.resolve(path.dirname(resolved), specifier)
    const candidate = path.extname(target) ? target : `${target}.ts`
    return existsSync(candidate) ? loadTypeScriptModule(candidate) : require(target)
  }
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', 'Buffer', output)(
    localRequire,
    module,
    module.exports,
    resolved,
    path.dirname(resolved),
    process,
    Buffer
  )
  return module.exports
}

function publicVerification(value) {
  return {
    status: value.status,
    state: value.state,
    attempts: value.attempts,
    durationMs: value.durationMs,
    observed: value.observed?.visual,
    error: value.error
  }
}

async function waitForWindow(controller, pid, titlePart) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const listed = await controller.listWindows({ includeElements: true, maxElements: 120 })
    if (!listed.ok) throw new Error(listed.error || 'GUI window enumeration failed')
    const window = listed.windows.find((item) =>
      item.platform === 'win32' &&
      (item.pid === pid || (
        String(item.processName).toLowerCase().includes('notepad') &&
        String(item.title || item.name).toLowerCase().includes(titlePart.toLowerCase())
      ))
    )
    if (window) return window
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Notepad window did not appear for visual postcondition')
}

async function main() {
  if (process.platform !== 'win32') throw new Error('visual postcondition worker requires Windows')
  const { createGuiController } = loadTypeScriptModule(path.join(repoRoot, 'src/main/gui/gui-controller.ts'))
  const {
    captureGuiVisualBaseline,
    normalizeGuiPostcondition,
    verifyGuiVisualPostcondition
  } = loadTypeScriptModule(path.join(repoRoot, 'src/main/gui/gui-postcondition.ts'))
  const {
    buildGuiPostconditionEffectTarget,
    reconcileGuiPostconditionEffectTarget
  } = loadTypeScriptModule(path.join(repoRoot, 'src/main/gui/gui-effect.ts'))
  const controller = createGuiController(repoRoot)
  const targetPath = path.join(tmpdir(), `caogen-visual-postcondition-${process.pid}-${Date.now()}.txt`)
  const text = `caogen-visual-${Date.now()}`
  writeFileSync(targetPath, '', 'utf8')
  const child = spawn('notepad.exe', [targetPath], {
    cwd: tmpdir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  try {
    const window = await waitForWindow(controller, child.pid, path.basename(targetPath))
    const editable = (window.elements || []).find((item) =>
      /(?:Document|Edit)/i.test(String(item.controlType)) &&
      item.enabled !== false && !item.offscreen && item.bounds?.width > 0 && item.bounds?.height > 0
    )
    if (!editable) throw new Error('Notepad editable element was not found for visual postcondition')
    const condition = normalizeGuiPostcondition({
      kind: 'visual',
      state: 'changed',
      windowId: window.id,
      minimumChangedRatio: 0.00001,
      pixelDifferenceThreshold: 16,
      timeoutMs: 5_000,
      intervalMs: 150
    })
    const baseline = await captureGuiVisualBaseline((input) => controller.captureVisual(input), condition)
    if (!baseline.ok) throw new Error(baseline.error)
    const action = await controller.typeText({
      windowId: window.id,
      elementId: editable.id,
      maxElements: 120,
      text
    })
    if (!action.ok) throw new Error(action.error || 'Notepad visual mutation failed')
    const verification = await verifyGuiVisualPostcondition(
      (input) => controller.captureVisual(input),
      condition,
      baseline.baseline
    )
    const saved = await controller.hotkey({ windowId: window.id, keys: ['ctrl', 's'] })
    if (!saved.ok) throw new Error(saved.error || 'Notepad save before recovery test failed')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const recoveryTarget = await buildGuiPostconditionEffectTarget('gui_hotkey', {
      windowId: window.id,
      keys: ['alt', 'f4'],
      postcondition: { kind: 'window', state: 'absent', windowId: window.id }
    })
    if (!recoveryTarget) throw new Error('Queryable GUI recovery target was not built')
    const closeAction = await controller.hotkey({ windowId: window.id, keys: ['alt', 'f4'] })
    if (!closeAction.ok) throw new Error(closeAction.error || 'Notepad close for recovery test failed')
    let recovery
    const recoveryDeadline = Date.now() + 5_000
    do {
      recovery = await reconcileGuiPostconditionEffectTarget(recoveryTarget)
      if (recovery.kind === 'confirmed') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < recoveryDeadline)
    return {
      name: 'notepad_visual_changed_postcondition',
      status: verification.status === 'passed' && recovery.kind === 'confirmed' ? 'pass' : 'fail',
      actionOk: action.ok,
      verification: publicVerification(verification),
      recovery: {
        targetKind: recoveryTarget.kind,
        preconditionSatisfied: recoveryTarget.preconditionSatisfied,
        closeActionOk: closeAction.ok,
        reconciliationKind: recovery.kind,
        verifier: recovery.verifier,
        reason: recovery.reason
      }
    }
  } finally {
    if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    rmSync(targetPath, { force: true })
  }
}

app.whenReady()
  .then(main)
  .then((result) => {
    console.log(`CAOGEN_VISUAL_RESULT:${JSON.stringify(result)}`)
    app.exit(result.status === 'pass' ? 0 : 1)
  })
  .catch((error) => {
    console.log(`CAOGEN_VISUAL_RESULT:${JSON.stringify({
      name: 'notepad_visual_changed_postcondition',
      status: 'fail',
      error: error instanceof Error ? error.message : String(error)
    })}`)
    app.exit(1)
  })
