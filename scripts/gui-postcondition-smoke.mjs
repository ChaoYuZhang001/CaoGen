#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'gui-postcondition')
const reportDir = path.join(reportRoot, runId)
const checks = []

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function evaluatePostconditionModule() {
  const output = ts.transpileModule(source('src/main/gui/gui-postcondition.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    (specifier) => { throw new Error(`unexpected require: ${specifier}`) },
    module,
    module.exports
  )
  return module.exports
}

async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, status: 'pass' })
  } catch (error) {
    checks.push({ name, status: 'fail', error: error instanceof Error ? error.message : String(error) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function rejects(fn, expected) {
  try {
    fn()
  } catch (error) {
    assert(String(error).includes(expected), `expected ${expected}, got ${String(error)}`)
    return
  }
  throw new Error(`expected rejection containing ${expected}`)
}

function observedWindow(overrides = {}) {
  return {
    id: 'win32:101',
    name: 'Editor - project',
    title: 'Editor - project',
    processName: 'editor.exe',
    pid: 42,
    elements: [],
    ...overrides
  }
}

function observedElement(overrides = {}) {
  return {
    id: 'win32el:101:1',
    index: 1,
    name: 'Save',
    automationId: 'save-button',
    className: 'Button',
    controlType: 'Button',
    bounds: { x: 10, y: 10, width: 80, height: 28 },
    enabled: true,
    offscreen: false,
    ...overrides
  }
}

function visualCapture(pixels, overrides = {}) {
  return {
    ok: true,
    sourceId: 'window:101:0',
    width: 2,
    height: 2,
    digest: Buffer.from(pixels).toString('hex').padEnd(64, '0').slice(0, 64),
    pixels: Uint8Array.from(pixels),
    ...overrides
  }
}

const api = evaluatePostconditionModule()

await check('normalizer rejects unknown fields before execution', () => {
  rejects(() => api.normalizeGuiPostcondition({
    kind: 'window', state: 'exists', title: 'Editor', script: 'unsafe'
  }), '未知字段')
})

await check('normalizer requires bounded window and element selectors', () => {
  rejects(() => api.normalizeGuiPostcondition({ kind: 'window', state: 'exists' }), '必须绑定')
  rejects(() => api.normalizeGuiPostcondition({ kind: 'element', state: 'visible', title: 'Editor' }), '明确元素')
  rejects(() => api.normalizeGuiPostcondition({ kind: 'window', state: 'visible', title: 'Editor' }), '不支持')
})

await check('normalizer enforces the five second verification ceiling', () => {
  rejects(() => api.normalizeGuiPostcondition({
    kind: 'window', state: 'exists', title: 'Editor', timeoutMs: 5_001
  }), '0 到 5000')
})

await check('visual normalizer requires a bounded source and state-specific thresholds', () => {
  const changed = api.normalizeGuiPostcondition({
    kind: 'visual', state: 'changed', windowId: 'win32:101', minimumChangedRatio: 0.1
  })
  assert(changed.kind === 'visual' && changed.minimumChangedRatio === 0.1, 'visual condition did not normalize')
  rejects(() => api.normalizeGuiPostcondition({ kind: 'visual', state: 'changed' }), '必须绑定')
  rejects(() => api.normalizeGuiPostcondition({
    kind: 'visual', state: 'changed', sourceId: 'window:101:0', maximumChangedRatio: 0.1
  }), 'changed 不接受')
  rejects(() => api.normalizeGuiPostcondition({
    kind: 'visual', state: 'changed', sourceId: 'window:101:0', minimumChangedRatio: 0
  }), '必须大于 0')
  rejects(() => api.normalizeGuiPostcondition({
    kind: 'window', state: 'exists', sourceId: 'window:101:0'
  }), '仅支持 visual')
})

await check('visual changed compares the frozen source pixels and emits safe evidence', async () => {
  const before = visualCapture(new Array(16).fill(0))
  const afterPixels = new Array(16).fill(0)
  afterPixels[0] = 255
  const condition = api.normalizeGuiPostcondition({
    kind: 'visual', state: 'changed', windowId: 'win32:101',
    minimumChangedRatio: 0.25, pixelDifferenceThreshold: 16, timeoutMs: 0
  })
  const prepared = await api.captureGuiVisualBaseline(async () => before, condition)
  assert(prepared.ok, `baseline failed: ${JSON.stringify(prepared)}`)
  const result = await api.verifyGuiVisualPostcondition(async (input) => {
    assert(input.sourceId === 'window:101:0', 'verification did not freeze the baseline source')
    return visualCapture(afterPixels)
  }, condition, prepared.baseline)
  assert(result.status === 'passed', `visual change should pass: ${JSON.stringify(result)}`)
  assert(result.observed.visual?.changedPixelRatio === 0.25, 'pixel ratio evidence is incorrect')
  assert(!('pixels' in result.observed.visual), 'raw pixels must not be returned as evidence')
})

await check('visual unchanged waits through its bounded window and fails on later change', async () => {
  const before = visualCapture(new Array(16).fill(0))
  const changedPixels = new Array(16).fill(0)
  changedPixels[4] = 255
  const condition = api.normalizeGuiPostcondition({
    kind: 'visual', state: 'unchanged', sourceId: 'window:101:0',
    maximumChangedRatio: 0, timeoutMs: 120, intervalMs: 50
  })
  const prepared = await api.captureGuiVisualBaseline(async () => before, condition)
  let attempts = 0
  const result = await api.verifyGuiVisualPostcondition(async () => {
    attempts += 1
    return attempts >= 2 ? visualCapture(changedPixels) : before
  }, condition, prepared.baseline)
  assert(result.status === 'failed' && attempts === 2, `late visual change must fail: ${JSON.stringify(result)}`)
})

await check('visual capture failures and target drift fail closed', async () => {
  const condition = api.normalizeGuiPostcondition({
    kind: 'visual', state: 'changed', sourceId: 'window:101:0', timeoutMs: 0
  })
  const missing = await api.captureGuiVisualBaseline(async () => ({ ok: false, error: 'blank frame' }), condition)
  assert(!missing.ok && missing.error.includes('blank frame'), 'blank baseline must fail closed')
  const prepared = await api.captureGuiVisualBaseline(async () => visualCapture(new Array(16).fill(0)), condition)
  const drifted = await api.verifyGuiVisualPostcondition(
    async () => visualCapture(new Array(16).fill(255), { sourceId: 'window:202:0' }),
    condition,
    prepared.baseline
  )
  assert(drifted.status === 'failed' && drifted.error.includes('漂移'), 'source drift must fail closed')
})

await check('window exists is matched against the declared target', async () => {
  const condition = api.normalizeGuiPostcondition({ kind: 'window', state: 'exists', processName: 'EDITOR' })
  const result = await api.verifyGuiPostcondition(async () => ({
    ok: true,
    windows: [observedWindow()]
  }), condition)
  assert(result.status === 'passed', `expected pass, got ${JSON.stringify(result)}`)
  assert(result.observed.matchedWindow?.pid === 42, 'matched window evidence is missing')
})

await check('observation failure never proves an absent condition', async () => {
  const condition = api.normalizeGuiPostcondition({
    kind: 'window', state: 'absent', title: 'Dialog', timeoutMs: 0
  })
  const result = await api.verifyGuiPostcondition(async () => ({
    ok: false,
    windows: [],
    error: 'UI Automation unavailable'
  }), condition)
  assert(result.status === 'failed', `observation error must fail closed: ${JSON.stringify(result)}`)
  assert(result.error.includes('UI Automation unavailable'), 'observer error must be retained')
})

await check('verifier polls until a window transition becomes observable', async () => {
  let attempts = 0
  const condition = api.normalizeGuiPostcondition({
    kind: 'window', state: 'exists', title: 'Ready', timeoutMs: 250, intervalMs: 50
  })
  const result = await api.verifyGuiPostcondition(async () => ({
    ok: true,
    windows: ++attempts >= 2 ? [observedWindow({ title: 'Ready', name: 'Ready' })] : []
  }), condition)
  assert(result.status === 'passed' && result.attempts === 2, `poll transition failed: ${JSON.stringify(result)}`)
})

await check('element enabled and visible states use accessibility observations', async () => {
  const observer = async () => ({
    ok: true,
    windows: [observedWindow({ elements: [observedElement()] })]
  })
  for (const state of ['exists', 'enabled', 'visible']) {
    const condition = api.normalizeGuiPostcondition({
      kind: 'element', state, title: 'Editor', automationId: 'save-button', timeoutMs: 0
    })
    const result = await api.verifyGuiPostcondition(observer, condition)
    assert(result.status === 'passed', `${state} should pass: ${JSON.stringify(result)}`)
  }
})

await check('hidden requires an observed hidden element rather than absence', async () => {
  const condition = api.normalizeGuiPostcondition({
    kind: 'element', state: 'hidden', title: 'Editor', automationId: 'save-button', timeoutMs: 0
  })
  const absent = await api.verifyGuiPostcondition(async () => ({
    ok: true, windows: [observedWindow()]
  }), condition)
  assert(absent.status === 'failed', 'missing element must not satisfy hidden')
  const hidden = await api.verifyGuiPostcondition(async () => ({
    ok: true,
    windows: [observedWindow({ elements: [observedElement({ offscreen: true })] })]
  }), condition)
  assert(hidden.status === 'passed', `offscreen element should satisfy hidden: ${JSON.stringify(hidden)}`)
})

await check('pre-aborted verification fails without observing', async () => {
  const controller = new AbortController()
  controller.abort()
  let observations = 0
  const condition = api.normalizeGuiPostcondition({ kind: 'window', state: 'exists', title: 'Editor' })
  const result = await api.verifyGuiPostcondition(async () => {
    observations += 1
    return { ok: true, windows: [] }
  }, condition, controller.signal)
  assert(result.status === 'failed' && observations === 0, 'pre-abort must not query the desktop')
})

await check('all mutating gui schemas expose postcondition and observation tools reject it', () => {
  const tools = source('src/main/agent/tools/gui-tools.ts')
  const controller = source('src/main/gui/gui-controller.ts')
  assert((tools.match(/postcondition: GUI_POSTCONDITION_SCHEMA/g) ?? []).length === 5,
    'activate/click/type/scroll/hotkey must expose postcondition')
  assert(tools.includes("name === 'gui_list_windows' || name === 'gui_screenshot'"),
    'observation tools must reject postcondition input')
  assert(tools.includes("verification: { status: 'not_requested' }"),
    'legacy action results must disclose missing verification')
  assert(tools.includes("verification: { status: 'not_run', reason: 'action_failed' }"),
    'failed actions must not claim postcondition execution')
  assert(tools.includes("reason: 'baseline_failed'"), 'visual baseline failure must prevent the action')
  assert(tools.includes('captureGuiVisualBaseline'), 'visual baseline must be captured before GUI mutation')
  assert(tools.includes('verifyGuiVisualPostcondition'), 'visual verification must run after GUI mutation')
  assert(tools.includes('sharesExactWindowSelector(args, postcondition)'),
    'visual postcondition must bind the same window selector as its action')
  assert(controller.includes("const match = /^win32:(\\d+)$/.exec(windowId)"),
    'only native Windows HWND values may map directly to Electron source ids')
  assert(controller.includes('if (input.sourceId) windows = windows.filter'),
    'sourceId must intersect rather than override the remaining window selectors')
})

await check('hotkey execution binds an explicit window target', () => {
  const tools = source('src/main/agent/tools/gui-tools.ts')
  const controller = source('src/main/gui/gui-controller.ts')
  assert(tools.includes("controller.hotkey({ ...windowSelector(args), keys:"), 'hotkey schema target is not dispatched')
  assert(controller.includes('windowsHotkey(input)'), 'Windows hotkey must receive the complete window-bound input')
  assert(controller.includes('const activated = await macosActivateWindow(input)'), 'macOS hotkey must activate its target first')
  assert(controller.includes('当前平台不能安全绑定快捷键目标窗口'), 'unsupported target binding must fail closed')
})

await check('native runtime passes cancellation into gui verification', () => {
  const openaiTools = source('src/main/openaiTools.ts')
  assert(openaiTools.includes('executeGuiTool(name, args, cwd, options.signal)'),
    'GUI execution must receive the native cancellation signal')
})

const failures = checks.filter((item) => item.status === 'fail')
const report = {
  schemaVersion: 1,
  status: failures.length === 0 ? 'passed' : 'failed',
  required,
  runId,
  reportDir,
  checks,
  failures: failures.map((item) => `${item.name}: ${item.error}`)
}
mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
for (const item of checks) {
  console.log(`${item.status === 'pass' ? 'PASS' : 'FAIL'} ${item.name}${item.error ? `: ${item.error}` : ''}`)
}
if (failures.length > 0) process.exitCode = 1
