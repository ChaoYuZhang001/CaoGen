import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const reportPath = path.join(repoRoot, 'test-results', 'office-status-recheck', 'latest.json')
const results = []

function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail || '' })
    console.log(`[PASS] ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, detail: message })
    console.log(`[FAIL] ${name} — ${message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function loadOfficeModel() {
  const input = source('src/renderer/src/components/office/model.ts')
  const output = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  const localRequire = (specifier) => {
    throw new Error(`unexpected runtime require from office model: ${specifier}`)
  }
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports)
  return module.exports
}

function session({ status = 'idle', pendingPermissions = [], items = [], runningTools = {}, toolResults = {} } = {}) {
  return {
    meta: { id: `s-${Math.random()}`, status, title: 'Session', costUsd: 0 },
    items,
    streamText: '',
    streamThinking: '',
    toolResults,
    runningTools,
    pendingPermissions,
    childResults: {},
    lastSeq: 0
  }
}

const officeModel = loadOfficeModel()

check('officeActivityOf covers idle/running/waiting approval/completed/failed', () => {
  const cases = [
    ['idle', session(), 'idle'],
    ['running', session({ status: 'running' }), 'working'],
    ['waiting approval', session({ pendingPermissions: [{ requestId: 'p1', toolName: 'bash', input: {}, toolUseId: 't1' }] }), 'awaiting'],
    ['completed', session({ items: [{ id: 'tr-ok', kind: 'turn-result', subtype: 'success', isError: false }] }), 'completed'],
    ['failed meta', session({ status: 'error' }), 'error'],
    ['failed turn', session({ items: [{ id: 'tr-fail', kind: 'turn-result', subtype: 'tool-error', isError: true }] }), 'error']
  ]
  for (const [label, value, expected] of cases) {
    const actual = officeModel.officeActivityOf(value)
    assert(actual === expected, `${label}: expected ${expected}, got ${actual}`)
  }
})

check('buildOfficeModel maps three sessions to three workstations', () => {
  const sessions = {
    a: session(),
    b: session({ status: 'running' }),
    c: session({ pendingPermissions: [{ requestId: 'p2', toolName: 'write_file', input: {}, toolUseId: 't2' }] })
  }
  const model = officeModel.buildOfficeModel(['a', 'b', 'c'], sessions)
  assert(Object.keys(model.sessions).length === 3, `expected 3 sessions, got ${Object.keys(model.sessions).length}`)
  assert(model.sessions.c.currentTask?.status === 'awaiting', `approval task not surfaced: ${JSON.stringify(model.sessions.c)}`)
  return `sessions=${Object.keys(model.sessions).length}`
})

check('OfficeView exposes machine-readable session status counts', () => {
  const text = source('src/renderer/src/components/office/OfficeView.tsx')
  for (const marker of [
    'data-office-idle-sessions',
    'data-office-running-sessions',
    'data-office-waiting-approval-sessions',
    'data-office-completed-sessions',
    'data-office-failed-sessions'
  ]) {
    assert(text.includes(marker), `missing ${marker}`)
  }
})

check('clicking a workstation focuses the correct session', () => {
  const text = source('src/renderer/src/components/office/OfficeView.tsx')
  assert(text.includes('selectSession(id)'), 'focus() must call selectSession(id)')
  assert(text.includes("setView('list')"), 'focus() must return to list view after selecting')
  assert(text.includes('onSelect={() => focus(id)}'), 'WorkstationPro must receive per-session focus handler')
})

check('3D office canvas has resize-safe rendering hooks', () => {
  const view = source('src/renderer/src/components/office/OfficeView.tsx')
  const css = source('src/renderer/src/styles.css')
  assert(view.includes('resize={{ offsetSize: true }}'), 'Canvas must use offsetSize resize tracking')
  assert(css.includes('.office-canvas-wrap canvas'), 'office canvas CSS rule missing')
  assert(css.includes('width: 100% !important') && css.includes('height: 100% !important'), 'office canvas must fill responsive viewport')
})

const ok = results.every((item) => item.ok)
mkdirSync(path.dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify({ ok, generatedAt: new Date().toISOString(), pass: results.filter((item) => item.ok).length, total: results.length, results }, null, 2))
console.log(`\noffice-status-recheck: ${results.filter((item) => item.ok).length}/${results.length} 通过`)
console.log(`office status report: ${reportPath}`)
if (!ok) process.exitCode = 1
