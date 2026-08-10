#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'gui-effect-recovery')
const reportDir = path.join(reportRoot, runId)
const checks = []

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function evaluate(relativePath, dependencies) {
  const output = ts.transpileModule(source(relativePath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', output)(
    (specifier) => {
      if (specifier in dependencies) return dependencies[specifier]
      throw new Error(`unexpected require from ${relativePath}: ${specifier}`)
    },
    module,
    module.exports,
    process
  )
  return module.exports
}

function postconditionApi() {
  return evaluate('src/main/gui/gui-postcondition.ts', {})
}

function effectResult(kind, payload, reason) {
  return {
    kind,
    evidenceDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    verifier: 'gui-effect-recovery-smoke',
    reason
  }
}

function guiEffectApi() {
  return evaluate('src/main/gui/gui-effect.ts', {
    './gui-postcondition': postconditionApi(),
    './windows-controller': { windowsListWindows: async () => ({ ok: false, windows: [], error: 'stub' }) },
    './macos-controller': { macosListWindows: async () => ({ ok: false, windows: [], error: 'stub' }) },
    '../task/effect-reconciliation-result': {
      confirmed: (payload, reason) => effectResult('confirmed', payload, reason),
      unresolved: (payload) => effectResult('unresolved', payload, payload.reason)
    }
  })
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

function windowInfo(overrides = {}) {
  return {
    id: 'win32:101',
    name: 'redacted',
    title: 'redacted',
    processName: 'redacted.exe',
    pid: 42,
    elements: [],
    ...overrides
  }
}

function elementInfo(overrides = {}) {
  return {
    id: 'win32el:101:7',
    index: 7,
    name: 'redacted',
    automationId: 'redacted',
    className: 'Button',
    controlType: 'Button',
    bounds: { x: 10, y: 10, width: 80, height: 28 },
    enabled: true,
    offscreen: false,
    ...overrides
  }
}

const api = guiEffectApi()

await check('exact false-before window postcondition becomes a queryable safe target', async () => {
  const target = await api.buildGuiPostconditionEffectTarget('gui_hotkey', {
    windowId: 'win32:101',
    keys: ['alt', 'f4'],
    postcondition: { kind: 'window', state: 'absent', windowId: 'win32:101' }
  }, {
    platform: 'win32',
    observe: async () => ({ ok: true, windows: [windowInfo()] })
  })
  assert(target?.kind === 'gui_postcondition', 'exact GUI postcondition target was not built')
  assert(target.preconditionSatisfied === false, 'target must prove the expected state was false before execution')
  const serialized = JSON.stringify(target)
  for (const forbidden of ['keys', 'title', 'processName', 'redacted']) {
    assert(!serialized.includes(forbidden), `persisted GUI target leaked ${forbidden}`)
  }
})

await check('already-satisfied and fuzzy postconditions remain opaque', async () => {
  const alreadySatisfied = await api.buildGuiPostconditionEffectTarget('gui_hotkey', {
    windowId: 'win32:101', keys: ['alt', 'f4'],
    postcondition: { kind: 'window', state: 'absent', windowId: 'win32:101' }
  }, { platform: 'win32', observe: async () => ({ ok: true, windows: [] }) })
  assert(alreadySatisfied === undefined, 'pre-satisfied condition cannot prove action causality')
  const fuzzy = await api.buildGuiPostconditionEffectTarget('gui_click', {
    windowId: 'win32:101',
    postcondition: { kind: 'window', state: 'absent', windowId: 'win32:101', title: 'private title' }
  }, { platform: 'win32', observe: async () => ({ ok: true, windows: [windowInfo()] }) })
  assert(fuzzy === undefined, 'fuzzy selector must remain opaque')
  const visual = await api.buildGuiPostconditionEffectTarget('gui_type', {
    windowId: 'win32:101', text: 'private input',
    postcondition: { kind: 'visual', state: 'changed', windowId: 'win32:101' }
  }, { platform: 'win32', observe: async () => ({ ok: true, windows: [windowInfo()] }) })
  assert(visual === undefined, 'visual condition must remain opaque without persisted raw baseline pixels')
})

await check('persisted window target confirms after module reload without replay', async () => {
  const target = await api.buildGuiPostconditionEffectTarget('gui_hotkey', {
    windowId: 'win32:101', keys: ['alt', 'f4'],
    postcondition: { kind: 'window', state: 'absent', windowId: 'win32:101' }
  }, { platform: 'win32', observe: async () => ({ ok: true, windows: [windowInfo()] }) })
  const restartedApi = guiEffectApi()
  let observations = 0
  const result = await restartedApi.reconcileGuiPostconditionEffectTarget(
    JSON.parse(JSON.stringify(target)),
    { platform: 'win32', observe: async () => { observations += 1; return { ok: true, windows: [] } } }
  )
  assert(result.kind === 'confirmed', `restart reconciliation failed: ${JSON.stringify(result)}`)
  assert(observations === 1, 'restart reconciliation must perform exactly one read-only observation')
})

await check('element transition confirms while unchanged or cross-platform state remains unresolved', async () => {
  const target = await api.buildGuiPostconditionEffectTarget('gui_click', {
    windowId: 'win32:101', elementId: 'win32el:101:7',
    postcondition: {
      kind: 'element', state: 'disabled', windowId: 'win32:101', elementId: 'win32el:101:7'
    }
  }, {
    platform: 'win32',
    observe: async () => ({ ok: true, windows: [windowInfo({ elements: [elementInfo()] })] })
  })
  assert(target?.postcondition.elementId === 'win32el:101:7', 'exact element target was not frozen')
  const unchanged = await api.reconcileGuiPostconditionEffectTarget(target, {
    platform: 'win32',
    observe: async () => ({ ok: true, windows: [windowInfo({ elements: [elementInfo()] })] })
  })
  assert(unchanged.kind === 'unresolved', 'unchanged element must not be confirmed or replayed')
  const changed = await api.reconcileGuiPostconditionEffectTarget(target, {
    platform: 'win32',
    observe: async () => ({ ok: true, windows: [windowInfo({ elements: [elementInfo({ enabled: false })] })] })
  })
  assert(changed.kind === 'confirmed', 'expected element transition should confirm')
  const platformDrift = await api.reconcileGuiPostconditionEffectTarget(target, {
    platform: 'darwin', observe: async () => ({ ok: true, windows: [] })
  })
  assert(platformDrift.kind === 'unresolved', 'cross-platform recovery must fail closed')
})

await check('effect builder ledger validator reconciler and inventory wire the target end to end', () => {
  const builder = source('src/main/task/effect-target-builder.ts')
  const reconciler = source('src/main/task/effect-reconciler.ts')
  const validator = source('src/main/task/effect-target-validation.ts')
  const ledger = source('src/main/task/effect-ledger.ts')
  const inventory = source('src/main/task/effect-entry-inventory.ts')
  assert(builder.includes('buildGuiPostconditionEffectTarget(toolName, input.toolInput)'), 'Effect builder integration missing')
  assert(reconciler.includes('reconcileGuiPostconditionEffectTarget(effect.target)'), 'GUI Reconciler integration missing')
  assert(validator.includes("value.kind === 'gui_postcondition'"), 'persisted target validator integration missing')
  assert(ledger.includes("scope: 'gui-window'"), 'GUI window resource fencing key missing')
  assert(inventory.includes('EFFECT_ENTRY_INVENTORY_VERSION = 10'), 'Effect entry inventory version was not advanced')
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
