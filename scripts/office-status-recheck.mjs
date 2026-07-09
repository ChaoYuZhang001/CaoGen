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

check('clicking a workstation selects in office and double-click opens the session', () => {
  const text = source('src/renderer/src/components/office/OfficeView.tsx')
  assert(text.includes('selectSession(id)'), 'focus() must call selectSession(id)')
  assert(text.includes("setView('list')"), 'focus() must return to list view after selecting')
  assert(text.includes('onSelect={() => selectOfficeSession(id)}'), 'WorkstationPro single-click must select inside office')
  assert(text.includes('onOpen={() => focus(id)}'), 'WorkstationPro double-click must open the matching session')
})

check('OfficeView exposes clickable facility targets', () => {
  const view = source('src/renderer/src/components/office/OfficeView.tsx')
  const facilities = source('src/renderer/src/components/office/kit/FacilityHotspots.tsx')
  assert(view.includes('data-office-clickable-facilities'), 'missing clickable facilities semantic attribute')
  assert(view.includes('data-office-facility-hit-targets'), 'missing facility hit target semantic attribute')
  assert(view.includes('data-office-restroom-walkers'), 'missing restroom walker semantic attribute')
  assert(view.includes('data-office-dining-walkers'), 'missing dining walker semantic attribute')
  assert(view.includes('data-office-one-robot-per-agent'), 'missing one-robot-per-agent semantic attribute')
  assert(view.includes('data-office-restroom-stations'), 'missing restroom station semantic attribute')
  assert(view.includes('data-office-dining-stations'), 'missing dining station semantic attribute')
  assert(view.includes('data-office-facility-fixtures'), 'missing facility fixture semantic attribute')
  assert(view.includes('<FacilityHotspots'), 'OfficeView must render 3D facility hotspots')
  assert(facilities.includes("'hydration'") && facilities.includes("'restroom'") && facilities.includes("'dining'"), 'facility hotspot set must cover hydration/restroom/dining')
  const walkers = source('src/renderer/src/components/office/kit/AgentWalkers.tsx')
  assert(walkers.includes("'restroom'") && walkers.includes("'dining'"), 'AgentWalkers must support restroom/dining route reasons')
  assert(walkers.includes('holdAtTarget'), 'AgentWalkers must support stable facility target presentation')
  const wayfinding = source('src/renderer/src/components/office/kit/ServiceWayfinding.tsx')
  assert(wayfinding.includes('RestroomFixture') && wayfinding.includes('DiningFixture'), 'ServiceWayfinding must include restroom/dining facility fixtures')
})

check('failed office sessions expose a visible maintenance response', () => {
  const view = source('src/renderer/src/components/office/OfficeView.tsx')
  const workstation = source('src/renderer/src/components/office/kit/WorkstationPro.tsx')
  assert(view.includes('data-office-maintenance-units'), 'missing maintenance unit semantic attribute')
  assert(view.includes('data-office-diagnostic-beams'), 'missing diagnostic beam semantic attribute')
  assert(view.includes('data-office-fault-response-rigs'), 'missing fault response rig semantic attribute')
  assert(view.includes('data-office-fault-hit-targets'), 'missing fault hit target semantic attribute')
  assert(workstation.includes('function FaultDiagnosticRig'), 'WorkstationPro must render a fault diagnostic rig')
  assert(workstation.includes('<FaultDiagnosticRig />'), 'fault diagnostic rig must be attached to error workstations')
})

check('OfficeView exposes final 3D optimization completion controls', () => {
  const view = source('src/renderer/src/components/office/OfficeView.tsx')
  const i18n = source('src/renderer/src/i18n.ts')
  assert(view.includes("'incidents'"), 'camera presets must include incidents view')
  assert(view.includes('data-office-incident-camera'), 'missing incident camera semantic attribute')
  assert(view.includes('data-office-incident-camera-available'), 'missing incident camera availability attribute')
  assert(view.includes('data-office-3d-optimization-complete'), 'missing final 3D optimization completion attribute')
  assert(view.includes('selectCameraPreset'), 'camera preset selection must route through behavior-aware handler')
  assert(i18n.includes('officePresetIncidents'), 'missing incidents camera i18n label')
})

check('AvatarRig uses current humanoid robot design language', () => {
  const view = source('src/renderer/src/components/office/OfficeView.tsx')
  const avatar = source('src/renderer/src/components/office/kit/AvatarRig.tsx')
  assert(view.includes('data-office-humanoid-robot-silhouettes'), 'missing humanoid silhouette semantic attribute')
  assert(view.includes('data-office-humanoid-face-visors'), 'missing humanoid visor semantic attribute')
  assert(view.includes('data-office-humanoid-shell-panels'), 'missing humanoid shell panel semantic attribute')
  assert(view.includes('data-office-humanoid-articulated-joints'), 'missing humanoid articulated joint semantic attribute')
  assert(view.includes('data-office-humanoid-back-shells'), 'missing humanoid back shell semantic attribute')
  assert(view.includes('data-office-humanoid-neutral-shells'), 'missing humanoid neutral shell semantic attribute')
  assert(avatar.includes('function HumanoidFaceHalo'), 'AvatarRig must include a humanoid face halo')
  assert(avatar.includes('function HumanoidChestArmor'), 'AvatarRig must include humanoid chest armor')
  assert(avatar.includes('function HumanoidBackArmor'), 'AvatarRig must include a readable rear shell')
  assert(avatar.includes('function HumanoidPelvisArmor'), 'AvatarRig must include a narrow humanoid pelvis shell')
  assert(avatar.includes('function HumanoidJointBearing'), 'AvatarRig must include visible articulated joint bearings')
  assert(avatar.includes("const body = '#17202a'") && avatar.includes('const shell = HUMANOID_SILVER'), 'AvatarRig must keep provider color off the main robot body')
  assert(!avatar.includes('catEars &&'), 'AvatarRig must not render mascot ears on humanoid robots')
  assert(avatar.includes('HUMANOID_SILVER') && avatar.includes('JOINT_BLACK'), 'AvatarRig must use silver hard shell and black joints')
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
