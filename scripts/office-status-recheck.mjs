import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const reportPath = path.join(repoRoot, 'test-results', 'office-status-recheck', 'latest.json')
const results = []
const unitreeG1Rev1Commit = '276801e46c5d433564f24658bac64f254b7d2d4b'
const referenceRobotAnimationRoots = ['helmet_head', 'left_arm', 'right_arm', 'left_leg', 'right_leg']
const referenceRobotOfficialMeshes = [
  {
    label: 'head',
    nodeNames: ['official_head_link'],
    meshNames: ['head_link'],
    sourceMeshNames: ['head_link'],
    animationRoot: 'helmet_head'
  },
  {
    label: '23-DOF torso',
    nodeNames: ['official_torso_link', 'official_torso_link_23dof_rev_1_0'],
    meshNames: ['torso_link_23dof_rev_1_0'],
    sourceMeshNames: ['torso_link', 'torso_link_23dof_rev_1_0']
  },
  {
    label: 'left rubber hand',
    nodeNames: ['official_left_rubber_hand', 'official_left_wrist_roll_rubber_hand'],
    meshNames: ['left_rubber_hand', 'left_wrist_roll_rubber_hand'],
    sourceMeshNames: ['left_rubber_hand', 'left_wrist_roll_rubber_hand'],
    animationRoot: 'left_arm'
  },
  {
    label: 'right rubber hand',
    nodeNames: ['official_right_rubber_hand', 'official_right_wrist_roll_rubber_hand'],
    meshNames: ['right_rubber_hand', 'right_wrist_roll_rubber_hand'],
    sourceMeshNames: ['right_rubber_hand', 'right_wrist_roll_rubber_hand'],
    animationRoot: 'right_arm'
  }
]

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

function loadGlb(relativePath) {
  const filePath = path.join(repoRoot, relativePath)
  assert(existsSync(filePath), `missing GLB asset: ${relativePath}`)
  const bytes = readFileSync(filePath)
  assert(bytes.length >= 20, `GLB asset is too small to contain a header: ${relativePath}`)
  assert(bytes.subarray(0, 4).toString('ascii') === 'glTF', `invalid GLB magic for ${relativePath}`)
  const version = bytes.readUInt32LE(4)
  const declaredLength = bytes.readUInt32LE(8)
  const jsonLength = bytes.readUInt32LE(12)
  const jsonType = bytes.readUInt32LE(16)
  assert(version === 2, `expected GLB version 2, got ${version}`)
  assert(declaredLength === bytes.length, `GLB length header ${declaredLength} does not match ${bytes.length} bytes`)
  assert(jsonType === 0x4e4f534a, `first GLB chunk is not JSON: 0x${jsonType.toString(16)}`)
  assert(jsonLength > 0 && 20 + jsonLength <= bytes.length, `invalid GLB JSON chunk length: ${jsonLength}`)
  const jsonText = bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/\0+$/u, '').trimEnd()
  return { bytes, json: JSON.parse(jsonText) }
}

function nodeContains(nodes, ancestorIndex, descendantIndex) {
  if (ancestorIndex === descendantIndex) return true
  const pending = [...(Array.isArray(nodes[ancestorIndex]?.children) ? nodes[ancestorIndex].children : [])]
  const visited = new Set()
  while (pending.length > 0) {
    const index = pending.pop()
    if (!Number.isInteger(index) || visited.has(index)) continue
    if (index === descendantIndex) return true
    visited.add(index)
    const children = nodes[index]?.children
    if (Array.isArray(children)) pending.push(...children)
  }
  return false
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

check('buildOfficeModel surfaces routing, provider/key failover, budget, and duration signals', () => {
  const routed = session({
    items: [
      {
        id: 'route-1',
        kind: 'routing',
        providerId: 'a',
        providerName: 'Primary',
        model: 'strong-model',
        reason: '自定义调度规则:发布审查',
        decision: {
          providerId: 'a',
          providerName: 'Primary',
          model: 'strong-model',
          strategy: 'quality',
          taskKinds: ['coding', 'review'],
          riskLevel: 'high',
          candidateCount: 3,
          score: 82,
          reliability: 0.96,
          estimatedCostUsd: 0.03,
          remainingBudgetUsd: 0.8,
          manualOverrideApplied: true,
          selectionReason: '自定义调度规则:发布审查',
          selectedReasons: ['能力匹配 42.0', '可靠性 0.96'],
          budgetDowngraded: false,
          switchedProvider: true,
          warnings: [],
          alternatives: [
            {
              providerId: 'b',
              providerName: 'Backup',
              model: 'review-model',
              score: 76,
              reliability: 0.9,
              estimatedCostUsd: 0.02
            }
          ],
          createdAt: Date.now()
        },
        crossValidationPlan: {
          enabled: true,
          primary: { providerId: 'a', model: 'strong-model' },
          validators: [{ providerId: 'b', model: 'review-model' }],
          policy: 'review-primary',
          reason: 'high risk'
        }
      },
      {
        id: 'failover-1',
        kind: 'failover',
        fromName: 'Primary',
        toName: 'Backup',
        model: 'backup-model',
        reason: '限流'
      },
      {
        id: 'key-failover-1',
        kind: 'provider-key-failover',
        providerName: 'Primary',
        fromKeyLabel: '主密钥',
        toKeyLabel: '备用密钥',
        reason: '鉴权失败'
      },
      { id: 'turn-1', kind: 'turn-result', subtype: 'success', isError: false, costUsd: 0.2, durationMs: 45_000 }
    ]
  })
  routed.meta.costUsd = 0.2
  routed.meta.budgetUsd = 1
  routed.meta.isolated = true
  routed.meta.branch = 'caogen/workspace-slice'
  routed.meta.worktreeState = 'active'
  routed.items.push({
    id: 'workspace-1',
    kind: 'workspace',
    event: 'checkpoint-restore',
    filesChanged: ['src/a.ts', 'src/b.ts'],
    insertions: 12,
    deletions: 3
  })
  const model = officeModel.buildOfficeModel(['routed'], { routed })
  const signal = model.sessions.routed.signal
  assert(signal.routing?.providerId === 'a', `routing provider id missing: ${JSON.stringify(signal)}`)
  assert(signal.routing?.providerName === 'Primary', `routing provider name missing: ${JSON.stringify(signal)}`)
  assert(signal.routing?.model === 'strong-model', `routing model missing: ${JSON.stringify(signal)}`)
  assert(signal.routing?.basis === '自定义调度规则:发布审查', `routing basis missing: ${JSON.stringify(signal)}`)
  assert(signal.routing?.strategy === 'quality', `routing strategy missing: ${JSON.stringify(signal)}`)
  assert(signal.routing?.taskKinds.join(',') === 'coding,review', `routing task kinds missing: ${JSON.stringify(signal)}`)
  assert(signal.routing?.validators === 1, `routing validator count missing: ${JSON.stringify(signal)}`)
  assert(signal.failover?.toName === 'Backup', `failover target missing: ${JSON.stringify(signal)}`)
  assert(signal.keyFailover?.toKeyLabel === '备用密钥', `key failover target missing: ${JSON.stringify(signal)}`)
  assert(signal.budget.ratio === 0.2, `budget ratio missing: ${JSON.stringify(signal)}`)
  assert(signal.budget.latestDurationMs === 45_000, `duration missing: ${JSON.stringify(signal)}`)
  assert(signal.workspace.isolated === true, `workspace isolation missing: ${JSON.stringify(signal)}`)
  assert(signal.workspace.branch === 'caogen/workspace-slice', `workspace branch missing: ${JSON.stringify(signal)}`)
  assert(signal.workspace.changedFiles === 2, `workspace changed files missing: ${JSON.stringify(signal)}`)
  assert(signal.workspace.insertions === 12 && signal.workspace.deletions === 3, `workspace diff stats missing: ${JSON.stringify(signal)}`)
  assert(model.realtime.routedSessions === 1, `routed summary missing: ${JSON.stringify(model.realtime)}`)
  assert(model.realtime.failoverSessions === 1, `failover summary missing: ${JSON.stringify(model.realtime)}`)
  assert(model.realtime.budgetedSessions === 1, `budget summary missing: ${JSON.stringify(model.realtime)}`)
  assert(model.realtime.crossValidationValidators === 1, `validator summary missing: ${JSON.stringify(model.realtime)}`)
  assert(model.realtime.isolatedSessions === 1, `isolated summary missing: ${JSON.stringify(model.realtime)}`)
  assert(model.realtime.workspaceChangedFiles === 2, `workspace file summary missing: ${JSON.stringify(model.realtime)}`)
})

check('buildOfficeModel merges live git status into workspace signals', () => {
  const working = session()
  working.meta.isolated = true
  working.meta.branch = 'caogen/checkpoint-branch'
  working.items.push({
    id: 'workspace-checkpoint',
    kind: 'workspace',
    event: 'checkpoint-restore',
    filesChanged: ['checkpoint-only.ts'],
    insertions: 8,
    deletions: 2
  })
  const gitStatus = {
    ok: true,
    cwd: '/tmp/caogen-worktree',
    branch: 'caogen/live-git',
    files: [
      { path: 'src/a.ts', indexStatus: 'M', worktreeStatus: ' ', staged: true, unstaged: false, untracked: false, kind: 'modified' },
      { path: 'src/b.ts', indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, untracked: false, kind: 'modified' },
      { path: 'notes.md', indexStatus: '?', worktreeStatus: '?', staged: false, unstaged: true, untracked: true, kind: 'untracked' }
    ],
    staged: 1,
    unstaged: 1,
    untracked: 1
  }
  const model = officeModel.buildOfficeModel(['working'], { working }, { working: gitStatus })
  const signal = model.sessions.working.signal.workspace
  assert(signal.changedFiles === 3, `live git file count should override checkpoint count: ${JSON.stringify(signal)}`)
  assert(signal.insertions === 8 && signal.deletions === 2, `checkpoint diff stats should be preserved: ${JSON.stringify(signal)}`)
  assert(signal.gitOk === true, `git ok missing: ${JSON.stringify(signal)}`)
  assert(signal.gitBranch === 'caogen/live-git', `git branch missing: ${JSON.stringify(signal)}`)
  assert(signal.gitStaged === 1 && signal.gitUnstaged === 1 && signal.gitUntracked === 1, `git counters missing: ${JSON.stringify(signal)}`)
  assert(model.realtime.gitTrackedSessions === 1, `git tracked summary missing: ${JSON.stringify(model.realtime)}`)
  assert(model.realtime.gitDirtySessions === 1, `git dirty summary missing: ${JSON.stringify(model.realtime)}`)
  assert(model.realtime.gitFiles === 3, `git file summary missing: ${JSON.stringify(model.realtime)}`)
  assert(model.realtime.workspaceChangedFiles === 3, `workspace summary should use live git count: ${JSON.stringify(model.realtime)}`)
})

check('OfficeView exposes machine-readable session status counts', () => {
  const text = source('src/renderer/src/components/office/OfficeView.tsx')
  for (const marker of [
    'data-office-idle-sessions',
    'data-office-running-sessions',
    'data-office-waiting-approval-sessions',
    'data-office-completed-sessions',
    'data-office-failed-sessions',
    'data-office-routed-sessions',
    'data-office-failover-sessions',
    'data-office-budgeted-sessions',
    'data-office-over-budget-sessions',
    'data-office-total-cost-usd',
    'data-office-total-duration-ms',
    'data-office-routing-budget-panels',
    'data-office-isolated-sessions',
    'data-office-removed-worktrees',
    'data-office-workspace-changed-files',
    'data-office-workspace-insertions',
    'data-office-workspace-deletions',
    'data-office-git-tracked-sessions',
    'data-office-git-dirty-sessions',
    'data-office-git-errored-sessions',
    'data-office-git-files',
    'data-office-git-staged',
    'data-office-git-unstaged',
    'data-office-git-untracked'
  ]) {
    assert(text.includes(marker), `missing ${marker}`)
  }
  assert(text.includes('window.agentDesk.gitStatus(id)'), 'OfficeView must refresh live git status for visible sessions')
  assert(text.includes('buildOfficeModel(ids, sessions, officeGitStatusBySession)'), 'OfficeView must pass live git status into office model')
  assert(text.includes('sessionSignal={officeModel.sessions[id]?.signal}'), 'OfficeView must pass real session signals to 3D workstations')
  assert(text.includes("t('officeMetricRouted')"), 'OfficeView command strip must show routed sessions')
  assert(text.includes("t('officeMetricFailover')"), 'OfficeView command strip must show failover sessions')
  assert(text.includes("t('officeMetricCost')"), 'OfficeView command strip must show total cost')
  assert(text.includes("t('officeMetricWorkspace')"), 'OfficeView command strip must show workspace changed files')
  assert(text.includes("t('officeMetricGit')"), 'OfficeView command strip must show live git dirty sessions')
  assert(text.includes("t('officeMetricIsolated')"), 'OfficeView command strip must show isolated sessions')
  assert(text.includes("t('officeWorkspace')"), 'selected agent panel must show workspace state')
  assert(text.includes("t('officeFiles')"), 'selected agent panel must show file change state')
})

check('office visual noise stays removed while packet semantics remain', () => {
  const view = source('src/renderer/src/components/office/OfficeView.tsx')
  const kitIndex = source('src/renderer/src/components/office/kit/index.ts')
  const officeSceneRoot = source('src/renderer/src/components/office/kit/OfficeSceneRoot.tsx')
  const deskAccessories = source('src/renderer/src/components/office/kit/DeskAccessories.tsx')
  const meetingTable = source('src/renderer/src/components/office/kit/MeetingTable.tsx')
  const workstation = source('src/renderer/src/components/office/kit/WorkstationPro.tsx')

  for (const relativePath of [
    'src/renderer/src/components/office/MessagePackets.tsx',
    'src/renderer/src/components/office/kit/DustMotes.tsx'
  ]) {
    assert(
      !existsSync(path.join(repoRoot, relativePath)),
      `removed visual-noise module must stay deleted: ${relativePath}`
    )
  }
  for (const [surface, text] of [
    ['OfficeView', view],
    ['office kit index', kitIndex]
  ]) {
    assert(!text.includes('MessagePackets'), `${surface} must not reference removed MessagePackets`)
    assert(!text.includes('DustMotes'), `${surface} must not reference removed DustMotes`)
  }
  assert(!officeSceneRoot.includes('DustMotes'), 'OfficeSceneRoot must not reference removed DustMotes')
  assert(
    /data-office-packets\s*=\s*\{\s*officeModel\.packets\.length\s*\}/u.test(view),
    'data-office-packets must preserve the semantic packet count from officeModel.packets.length'
  )
  assert(!/<pointsMaterial\b/u.test(deskAccessories), 'DeskAccessories must not render pointsMaterial particles')
  assert(!/<points\b/u.test(deskAccessories), 'DeskAccessories must not render steam point clouds')
  for (const marker of ['STEAM_COUNT', 'steamRef', 'steamPositions', 'steamData']) {
    assert(!deskAccessories.includes(marker), `DeskAccessories must not keep steam particle machinery: ${marker}`)
  }
  assert(!meetingTable.includes('icosahedronGeometry'), 'MeetingTable must not render an icosahedron collaboration orb')
  assert(!workstation.includes('octahedronGeometry'), 'WorkstationPro must not render an octahedron fault orb')
})

check('desk operators use a seated low-noise workstation presentation', () => {
  const animations = source('src/renderer/src/components/office/kit/AvatarAnimations.ts')
  const workstation = source('src/renderer/src/components/office/kit/WorkstationPro.tsx')
  const robotAsset = source('src/renderer/src/components/office/kit/RobotModelAsset.tsx')
  const monitors = source('src/renderer/src/components/office/kit/MonitorSetup.tsx')
  const backplane = source('src/renderer/src/components/office/kit/OperationsBackplane.tsx')
  const windowWall = source('src/renderer/src/components/office/kit/WindowWall.tsx')
  const view = source('src/renderer/src/components/office/OfficeView.tsx')
  const css = source('src/renderer/src/styles.css')

  assert(animations.includes('function applyDeskSeatedLowerBody'), 'desktop animation states must share a seated lower-body pose')
  assert(animations.includes('const DESK_SEATED_ROOT_Y = -0.24'), 'desk operator hip height must stay aligned with the chair')
  for (const state of ['applyMonitoring', 'applyTyping', 'applyTalking', 'applyThinking']) {
    const start = animations.indexOf(`export function ${state}`)
    const end = animations.indexOf('\nexport function ', start + 1)
    const body = animations.slice(start, end < 0 ? animations.length : end)
    assert(body.includes('applyDeskSeatedLowerBody'), `${state} must retain the shared desk seated pose`)
  }
  assert(workstation.includes('<OfficeChair position={[0, 0, 0.65]} scale={0.88} />'), 'chair must sit directly under the operator hips')
  assert(workstation.includes('position={[0, 0, 0.52]}'), 'desk operator must remain centered behind the input surface')
  assert(animations.includes('function applyDeskArmIK'), 'desk arms must use target-driven two-bone IK instead of fixed Euler poses only')
  assert(animations.includes('ikPole.set(0, -0.58, 0)'), 'desk arm IK must keep elbows guided down and close to the torso')
  assert(animations.includes('upperLength + lowerLength - ARM_IK_EPSILON'), 'desk arm IK must clamp unreachable hand targets')
  assert(robotAsset.includes('function createHandEndpointMarker'), 'reference robot must expose real palm-center IK endpoints')
  assert(robotAsset.includes("'left_hand_ik_endpoint'") && robotAsset.includes("'right_hand_ik_endpoint'"), 'both robot hands must expose IK endpoints')
  assert(workstation.includes('const OPERATOR_INPUT_ARRAY_Z = 0.16'), 'operator input array must stay far enough forward for a human-like elbow angle')
  assert(workstation.includes('name="desk-left-hand-ik-target"') && workstation.includes('name="desk-right-hand-ik-target"'), 'workstation must expose two physical hand targets')
  assert(monitors.includes("const SCREEN_SURFACE = '#17232d'"), 'monitor body must use a neutral screen surface')
  assert(monitors.includes('color={SCREEN_SURFACE}') && monitors.includes('emissive={SCREEN_GLOW}'), 'status color must not flood the full monitor panel')
  assert(!backplane.includes('<cylinderGeometry args={[0.08, 0.08, 0.012, 28]} />'), 'floor data nodes must not render circular pucks')
  assert(windowWall.includes('剖切展示模式不渲染孤立亮点'), 'cutaway window wall must suppress isolated city light points')
  assert(view.includes('[0.28, 4.5, 9.55]') && view.includes('const OFFICE_CAMERA_FOV = 44'), 'overview camera must keep the front row inside frame')
  assert(css.includes('top: 50px;') && css.includes('max-height: min(260px'), 'selected agent panel must stay clear of front-row robots')
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
  const cameraRig = source('src/renderer/src/components/office/kit/CameraRig.tsx')
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
  assert(walkers.includes('departureDelay') && walkers.includes('waitingToDepart'), 'facility walkers must stagger departures instead of overlapping at startup')
  assert(walkers.includes('applyStandingTalking'), 'approval walkers must use a standing interaction pose away from the desk')
  assert(walkers.includes('walker-select-hitbox'), 'AgentWalkers must expose a stable pointer hit target')
  assert(cameraRig.includes('minDistance?: number') && view.includes('minDistance={cameraMinDistance}'), 'camera presets must support real close focus instead of a fixed six-unit clamp')
  assert(facilities.includes('cameraPosition: [-6.45, 4.6, 9.15]'), 'restroom camera must use an unobstructed elevated fixture view')
  assert(facilities.includes('cameraPosition: [-2, 4.5, 10.8]'), 'dining camera must use an unobstructed elevated fixture view')
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

check('workstations render real routing/failover/budget signals in 3D', () => {
  const workstation = source('src/renderer/src/components/office/kit/WorkstationPro.tsx')
  const i18n = source('src/renderer/src/i18n.ts')
  const css = source('src/renderer/src/styles.css')
  assert(workstation.includes('function RoutingBudgetStack'), 'WorkstationPro must render a 3D routing/budget signal stack')
  assert(workstation.includes('signal.routing'), 'routing signal must control a real 3D indicator')
  assert(workstation.includes('signal.failover'), 'failover signal must control a real 3D indicator')
  assert(workstation.includes('signal.budget.ratio'), 'budget ratio must control a real 3D indicator')
  assert(workstation.includes('signal.workspace'), 'workspace signal must control a real 3D indicator')
  assert(workstation.includes('<RoutingBudgetStack signal={sessionSignal}'), 'routing/budget stack must be attached to each workstation')
  for (const key of ['officeMetricRouted', 'officeMetricFailover', 'officeMetricCost', 'officeMetricWorkspace', 'officeMetricGit', 'officeMetricIsolated', 'officeRouting', 'officeFailover', 'officeBudget', 'officeDuration', 'officeWorkspace', 'officeFiles']) {
    assert(i18n.includes(key), `missing ${key} i18n`)
  }
  assert(css.includes('.office-signal-list'), 'selection panel must have routing/budget signal styling')
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

check('reference robot assets use the pinned official Unitree rev1 pipeline', () => {
  const wrapper = source('scripts/generate-reference-robot-glb.mjs')
  const blender = source('scripts/generate-reference-robot-blender.py')
  const officialModelMatch = blender.match(
    /OFFICIAL_G1_XML\s*=\s*OFFICIAL_G1_DIR\s*\/\s*"(g1_(?:23|29)dof_rev_1_0\.xml)"/u
  )
  assert(officialModelMatch, 'Blender generator must select an exact Unitree G1 rev1 XML entry point')
  const officialModelPath = `third_party/unitree-g1-rev1/${officialModelMatch[1]}`
  assert(
    existsSync(path.join(repoRoot, officialModelPath)),
    `missing official Unitree rev1 model selected by the generator: ${officialModelPath}`
  )
  const officialXml = source(officialModelPath)
  const officialLicense = source('third_party/unitree-g1-rev1/LICENSE')
  const officialReadme = source('third_party/unitree-g1-rev1/README.md')
  const assetReadme = source('src/renderer/src/assets/robots/README.md')
  const blendPath = path.join(repoRoot, 'src/renderer/src/assets/robots/reference-office-robot.blend')
  const glbPath = 'src/renderer/src/assets/robots/reference-office-robot.glb'

  assert(wrapper.includes("path.join(repoRoot, 'scripts/generate-reference-robot-blender.py')"), 'GLB wrapper must target the Blender generator')
  assert(wrapper.includes("['--background', '--python', blenderScript]"), 'GLB wrapper must run Blender in background Python mode')
  assert(wrapper.includes('process.env.BLENDER_BIN'), 'GLB wrapper must support an explicit Blender binary')
  for (const marker of [
    'import bmesh',
    'import bpy',
    'import xml.etree.ElementTree as ET',
    'ET.parse(OFFICIAL_G1_XML)',
    'bpy.ops.wm.stl_import',
    'body["unitree_body_name"] = original_name',
    'root = build_official_g1_robot(materials)',
    `root["source_commit"] = "${unitreeG1Rev1Commit}"`,
    'root["source_license"] = "BSD-3-Clause"',
    'mesh_name == "logo_link"',
    'nameplate["provider_logo_renderer"] = "ProviderLogoBadge"',
    'bpy.ops.export_scene.gltf',
    'bpy.ops.wm.save_as_mainfile'
  ]) {
    assert(blender.includes(marker), `Blender generator missing ${marker}`)
  }

  assert(
    statSync(path.join(repoRoot, officialModelPath)).size > 15_000,
    `official Unitree rev1 XML is unexpectedly small: ${officialModelPath}`
  )
  assert(
    /<mujoco model="g1_(?:23|29)dof_rev_1_0">/u.test(officialXml) &&
      officialXml.includes('meshdir="meshes"'),
    'official XML must describe a Unitree G1 rev1 mesh model'
  )
  const officialMeshNames = new Set(
    [...officialXml.matchAll(/<mesh\s+name="([^"]+)"/gu)].map((match) => match[1])
  )
  assert(
    officialMeshNames.has('head_link') && officialMeshNames.has('logo_link'),
    'official Unitree rev1 XML must retain head_link and logo_link source mesh names'
  )
  for (const contract of referenceRobotOfficialMeshes) {
    assert(
      contract.sourceMeshNames.some((name) => officialMeshNames.has(name)),
      `official Unitree rev1 XML is missing the ${contract.label} source mesh (${contract.sourceMeshNames.join(' or ')})`
    )
  }
  assert(officialLicense.includes('BSD 3-Clause License'), 'official Unitree assets must retain the BSD 3-Clause license')
  assert(officialReadme.includes(unitreeG1Rev1Commit), 'third-party README must record the pinned Unitree commit')
  assert(officialReadme.includes('BSD-3-Clause'), 'third-party README must identify the retained BSD-3-Clause license')
  assert(assetReadme.includes(unitreeG1Rev1Commit), 'robot asset README must record the pinned Unitree commit')
  assert(assetReadme.includes('ProviderLogoBadge'), 'robot asset README must identify the runtime provider-logo renderer')

  assert(existsSync(blendPath), 'Blender source asset is missing')
  const blendBytes = readFileSync(blendPath)
  const plainBlend = blendBytes.subarray(0, 7).toString('ascii') === 'BLENDER'
  const compressedBlend = blendBytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  assert(blendBytes.length > 1_000_000, `Blender source asset is unexpectedly small: ${blendBytes.length} bytes`)
  assert(plainBlend || compressedBlend, 'Blender source asset has neither a BLENDER nor compressed Blender header')

  const { bytes: glbBytes, json: glb } = loadGlb(glbPath)
  assert(glbBytes.length > 1_000_000, `reference robot GLB is unexpectedly small: ${glbBytes.length} bytes`)
  assert((glb.nodes?.length ?? 0) >= 25 && (glb.meshes?.length ?? 0) >= 20, 'reference robot GLB has unexpectedly little official scene geometry')
  return `source=${officialModelPath}, blend=${(blendBytes.length / 1_048_576).toFixed(1)} MiB, glb=${(glbBytes.length / 1_048_576).toFixed(1)} MiB`
})

check('reference robot GLB preserves official meshes and runtime animation roots', () => {
  const { json: glb } = loadGlb('src/renderer/src/assets/robots/reference-office-robot.glb')
  const nodes = glb.nodes ?? []
  const meshes = glb.meshes ?? []
  const sourceRoots = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.name === 'reference_office_robot_unitree_style')
  assert(sourceRoots.length === 1, `reference robot GLB must have one official source root, found ${sourceRoots.length}`)
  const sourceRoot = sourceRoots[0]
  assert(sourceRoot.node.extras?.source_commit === unitreeG1Rev1Commit, 'GLB source root must retain the pinned Unitree commit')
  assert(sourceRoot.node.extras?.source_license === 'BSD-3-Clause', 'GLB source root must retain the BSD-3-Clause identifier')
  assert(/23[ -]?dof/iu.test(sourceRoot.node.extras?.source_model ?? ''), 'GLB source root must identify the official 23-DOF geometry')

  for (const name of referenceRobotAnimationRoots) {
    const matches = nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.name === name)
    assert(matches.length === 1, `reference robot GLB must have one exact ${name} animation root, found ${matches.length}`)
    assert((matches[0].node.children?.length ?? 0) > 0, `${name} animation root must contain official model descendants`)
    assert(nodeContains(nodes, sourceRoot.index, matches[0].index), `${name} animation root must descend from the official source root`)
  }

  const resolvedBindings = []
  for (const contract of referenceRobotOfficialMeshes) {
    const matches = nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => contract.nodeNames.includes(node.name))
    assert(
      matches.length === 1,
      `${contract.label} must use one accepted exact node name (${contract.nodeNames.join(' or ')}), found ${matches.length}`
    )
    const match = matches[0]
    assert(Number.isInteger(match.node.mesh), `${contract.label} node ${match.node.name} must reference a mesh`)
    const meshName = meshes[match.node.mesh]?.name
    assert(
      contract.meshNames.includes(meshName),
      `${contract.label} node ${match.node.name} must bind ${contract.meshNames.join(' or ')}, found ${meshName}`
    )
    assert(
      contract.sourceMeshNames.includes(match.node.extras?.unitree_mesh_name),
      `${contract.label} node ${match.node.name} must retain its exact Unitree source mesh name`
    )
    assert(nodeContains(nodes, sourceRoot.index, match.index), `${contract.label} must descend from the official source root`)
    if (contract.animationRoot) {
      const animationRootIndex = nodes.findIndex((node) => node.name === contract.animationRoot)
      assert(
        animationRootIndex >= 0 && nodeContains(nodes, animationRootIndex, match.index),
        `${contract.label} must descend from ${contract.animationRoot}`
      )
    }
    resolvedBindings.push(`${match.node.name}->${meshName}`)
  }

  const providerMount = nodes.find((node) => node.name === 'provider_nameplate_mount')
  assert(providerMount?.extras?.provider_logo_renderer === 'ProviderLogoBadge', 'GLB must reserve provider_nameplate_mount for runtime ProviderLogoBadge rendering')
  assert(
    !nodes.some((node) => node.extras?.unitree_mesh_name === 'logo_link'),
    'GLB must not bake the Unitree logo mesh; provider identity is rendered at runtime'
  )
  return `roots=${referenceRobotAnimationRoots.length}, bindings=${resolvedBindings.join(', ')}`
})

check('AvatarRig uses reference robot design language', () => {
  const view = source('src/renderer/src/components/office/OfficeView.tsx')
  const avatar = source('src/renderer/src/components/office/kit/AvatarRig.tsx')
  const robotAsset = source('src/renderer/src/components/office/kit/RobotModelAsset.tsx')
  const providerLogoBadge = source('src/renderer/src/components/office/kit/ProviderLogoBadge.tsx')
  const vendorSkins = source('src/renderer/src/components/office/kit/VendorSkins.ts')
  const workstation = source('src/renderer/src/components/office/kit/WorkstationPro.tsx')
  const deskAccessories = source('src/renderer/src/components/office/kit/DeskAccessories.tsx')
  const coffeeStation = source('src/renderer/src/components/office/kit/CoffeeStation.tsx')
  const walkers = source('src/renderer/src/components/office/kit/AgentWalkers.tsx')
  const wayfinding = source('src/renderer/src/components/office/kit/ServiceWayfinding.tsx')
  const facilities = source('src/renderer/src/components/office/kit/FacilityHotspots.tsx')
  const monitorSetup = source('src/renderer/src/components/office/kit/MonitorSetup.tsx')
  const officeChair = source('src/renderer/src/components/office/kit/OfficeChair.tsx')
  const speechBubble = source('src/renderer/src/components/office/kit/SpeechBubble.tsx')
  const whiteboard = source('src/renderer/src/components/office/kit/Whiteboard.tsx')
  const approvalStation = source('src/renderer/src/components/office/kit/ApprovalStation.tsx')
  const operationsBackplane = source('src/renderer/src/components/office/kit/OperationsBackplane.tsx')
  const meetingTable = source('src/renderer/src/components/office/kit/MeetingTable.tsx')
  const plant = source('src/renderer/src/components/office/kit/Plant.tsx')
  const bookshelf = source('src/renderer/src/components/office/kit/Bookshelf.tsx')
  const serverRack = source('src/renderer/src/components/office/kit/ServerRack.tsx')
  const windowWall = source('src/renderer/src/components/office/kit/WindowWall.tsx')
  const deskLamp = source('src/renderer/src/components/office/kit/DeskLamp.tsx')
  assert(view.includes('data-office-reference-robot-silhouettes'), 'missing reference robot silhouette semantic attribute')
  assert(view.includes('data-office-reference-robot-helmet-visors'), 'missing reference robot helmet visor semantic attribute')
  assert(view.includes('data-office-reference-robot-shell-panels'), 'missing reference robot shell panel semantic attribute')
  assert(view.includes('data-office-reference-robot-articulated-joints'), 'missing reference robot articulated joint semantic attribute')
  assert(view.includes('data-office-reference-robot-back-shells'), 'missing reference robot back shell semantic attribute')
  assert(view.includes('data-office-reference-robot-neutral-shells'), 'missing reference robot neutral shell semantic attribute')
  assert(view.includes('data-office-humanoid-robot-silhouettes'), 'legacy humanoid robot semantic attribute must remain for E2E compatibility')
  assert(!view.includes('globalFault='), 'office must not propagate one failed session as a fault on every workstation')
  assert(avatar.includes('function UnitreeHelmetHead'), 'AvatarRig must include the reference-style helmet head')
  assert(!avatar.includes('<sphereGeometry args={[0.225, 48, 28]} />') && !avatar.includes('<sphereGeometry args={[0.17, 40, 18]} />') && !avatar.includes('<sphereGeometry args={[0.15, 36, 18]} />'), 'AvatarRig fallback helmet must not regress to a stack of black spheres')
  assert(avatar.includes('ReferenceRobotModelAsset') && avatar.includes('preferModelAsset') && avatar.includes('modelUrl'), 'AvatarRig must expose a GLB/reference model asset path with procedural fallback')
  assert(robotAsset.includes("reference-office-robot.glb?url") && robotAsset.includes('REFERENCE_ROBOT_GLB_URL = referenceRobotGlbUrl'), 'RobotModelAsset must load the generated reference GLB by default')
  assert(robotAsset.includes('useLoader') && robotAsset.includes('GLTFLoader') && robotAsset.includes('hasReferenceRobotModelAsset'), 'RobotModelAsset must keep the GLB loading pipeline explicit and guardable')
  assert(!robotAsset.includes('useGLTF'), 'RobotModelAsset must avoid drei useGLTF because it triggers MeshoptDecoder under strict Electron CSP')
  assert(robotAsset.includes('providerLogo?: ProviderLogoSpec'), 'RobotModelAsset must expose typed vendor nameplate input')
  assert(robotAsset.includes('{providerLogo && (') && robotAsset.includes('<ProviderLogoBadge') && robotAsset.includes('logo={providerLogo}'), 'RobotModelAsset must conditionally render the vendor nameplate on GLB assets')
  assert(robotAsset.includes('maxChars={3}') && robotAsset.includes('compact'), 'GLB vendor nameplates must remain compact enough for the chest mount')
  assert(providerLogoBadge.includes("compact ? '#aeb8c4' : '#d7dee5'") && !providerLogoBadge.includes('circleGeometry') && !providerLogoBadge.includes('#f8fbff'), 'provider logos must not sit on white circular backplates')
  assert(providerLogoBadge.includes("color: rowIndex <= 1 ? '#d7dee5' : '#59dcff'") && providerLogoBadge.includes('color="#59dcff" emissive="#59dcff"'), 'provider logo fallback pixels and rails must stay neutral instead of flooding office colors')
  assert(vendorSkins.includes('neutralSkin') && vendorSkins.includes("const NEUTRAL_ACCENT = '#59dcff'"), 'vendor skin mapping must keep provider identity to neutral robot nameplates')
  assert(robotAsset.includes('createAnimationControl') && robotAsset.includes("getObjectByName('helmet_head')"), 'RobotModelAsset must preserve Blender rest transforms behind animation control pivots')
  assert(robotAsset.includes("getObjectByName('left_arm')") && robotAsset.includes("getObjectByName('right_arm')") && robotAsset.includes("getObjectByName('left_leg')") && robotAsset.includes("getObjectByName('right_leg')"), 'RobotModelAsset must bind exact GLB limb nodes instead of ambiguous roll-joint regexes')
  assert(!walkers.includes('<ProviderLogoBadge'), 'walking agents must not render a second vendor badge outside the animated robot root')
  assert(view.includes('position[2] + 0.64'), 'walking agents must depart from the same operator position used at the desk')
  assert(avatar.includes('function HumanoidChestArmor'), 'AvatarRig must include reference robot chest armor')
  assert(avatar.includes('function HumanoidBackArmor'), 'AvatarRig must include a readable rear shell')
  assert(avatar.includes('function HumanoidPelvisArmor'), 'AvatarRig must include a narrow robot pelvis shell')
  assert(avatar.includes('function HumanoidJointBearing'), 'AvatarRig must include visible articulated joint bearings')
  assert(avatar.includes('function HumanoidArm'), 'AvatarRig must use a reusable slim robot arm rig')
  assert(avatar.includes('function HumanoidLeg'), 'AvatarRig must use a reusable slim robot leg rig')
  assert(avatar.includes('function HumanoidHand'), 'AvatarRig must include black mechanical hands')
  assert(avatar.includes('function RobotUpperArmArmor'), 'AvatarRig must include segmented upper-arm armor plates')
  assert(avatar.includes('function RobotForearmArmor'), 'AvatarRig must include segmented forearm armor plates')
  assert(avatar.includes('function RobotThighArmor'), 'AvatarRig must include segmented thigh armor plates')
  assert(avatar.includes('function RobotCalfArmor'), 'AvatarRig must include segmented calf armor plates')
  assert(avatar.includes('function RobotAnklePiston'), 'AvatarRig must include ankle piston details from the reference robot')
  assert(avatar.includes('function RobotReferenceShoe'), 'AvatarRig must include long black reference-style robot shoes')
  assert(avatar.includes('function RobotKnuckleFinger'), 'AvatarRig must include segmented black mechanical fingers')
  assert(avatar.includes('function RobotBlackBearing'), 'AvatarRig must use flat black bearing housings instead of ball-like limb joints')
  assert(avatar.includes('function RobotShoulderShell'), 'AvatarRig must use hard-shell shoulder caps instead of spherical shoulders')
  assert(avatar.includes('ROBOT_CARBON_INSERT') && avatar.includes('MICRO_FASTENER'), 'AvatarRig must include carbon inserts and fastener details')
  assert(avatar.includes('back-scapula-panel') && !avatar.includes('back-scapula-${side}'), 'AvatarRig rear shell must use flat panels instead of ball-like scapula shells')
  for (const geometry of [
    '<sphereGeometry args={[0.068, 28, 18]} />',
    '<sphereGeometry args={[0.12, 32, 18]} />',
    '<sphereGeometry args={[0.106, 28, 14]} />',
    '<sphereGeometry args={[0.044, 20, 12]} />',
    '<sphereGeometry args={[0.034, 18, 10]} />',
    '<sphereGeometry args={[0.06, 24, 16]} />',
    '<sphereGeometry args={[0.118, 28, 14]} />',
    '<sphereGeometry args={[0.052, 20, 12]} />',
    '<sphereGeometry args={[0.112, 28, 14]} />',
    '<sphereGeometry args={[0.04, 18, 10]} />'
  ]) {
    assert(!avatar.includes(geometry), `AvatarRig must not keep old ball-like limb geometry ${geometry}`)
  }
  assert(avatar.includes("const body = '#17202a'") && avatar.includes('const shell = HUMANOID_SILVER'), 'AvatarRig must keep provider color off the main robot body')
  assert(avatar.includes("const HELMET_SHELL = '#05080d'"), 'AvatarRig must use the black helmet shell from the reference robot')
  assert(avatar.includes("const HELMET_CYAN = '#59dcff'"), 'AvatarRig must use the cyan helmet visor light from the reference robot')
  assert(avatar.includes('HUMANOID_SILVER_SHADOW'), 'AvatarRig must keep visible silver contrast in bright themes')
  assert(avatar.includes('HUMANOID_PROPORTION_SCALE: [number, number, number] = [0.78, 1.22, 0.9]'), 'AvatarRig must keep a tall narrow reference robot proportion')
  assert(!avatar.includes('catEars &&'), 'AvatarRig must not render mascot ears on reference robots')
  assert(!avatar.includes('args={[0.36, 0.54, 0.23]}'), 'AvatarRig must not regress to the old block torso')
  assert(!avatar.includes('HUMANOID_FACE'), 'AvatarRig must not keep the scary human face materials')
  assert(!avatar.includes('faceMaskShape'), 'AvatarRig must not keep the human face mask geometry')
  assert(!avatar.includes('SERVICE_WHITE') && !avatar.includes('SERVICE_GLOW'), 'AvatarRig must not keep the old white service ball materials')
  assert(avatar.includes('HELMET_CYAN_CORE'), 'AvatarRig must include a brighter helmet sensor slit')
  assert(avatar.includes('SENSOR_GLASS'), 'AvatarRig must render a black glass sensor band instead of a human face')
  assert(avatar.includes('ROBOT_BLACK_POLYMER'), 'AvatarRig must include black polymer jaw/hand/foot material')
  assert(avatar.includes('<RoundedBox args={[0.158, 0.045, 0.018]}'), 'AvatarRig must include a chest nameplate bay')
  assert(avatar.includes('HUMANOID_SILVER') && avatar.includes('JOINT_BLACK'), 'AvatarRig must use silver hard shell and black joints')
  assert(deskAccessories.includes("const C_MUG = '#aeb8c4'") && deskAccessories.includes("const C_NOTE_PAPER = '#b9c3cf'"), 'desk accessories must use muted gray desk materials instead of white paper/cups')
  assert(!deskAccessories.includes("color=\"#f4f4f4\"") && !deskAccessories.includes("const C_MUG = '#f2f2f2'"), 'desk accessories must not keep white steam/cup highlights')
  assert(!deskAccessories.includes('<sphereGeometry args={[0.028, 16, 16]} />') && !deskAccessories.includes('<sphereGeometry args={[0.006, 8, 8]} />'), 'desk accessories must replace mouse/LED spheres with flatter controls')
  assert(coffeeStation.includes('CUP_SHELL') && coffeeStation.includes('HYDRATION_SIGNAL'), 'coffee station must use muted material constants for cups and hydration signals')
  assert(!coffeeStation.includes('const WHITE') && !coffeeStation.includes('const WATER'), 'coffee station must not keep white cups or bright water-ball constants')
  assert(!coffeeStation.includes('<sphereGeometry args={[0.018, 16, 16]} />') && !coffeeStation.includes('<sphereGeometry args={[0.06, 18, 18]} />'), 'coffee station must replace small glowing/water spheres with slat signals')
  assert(walkers.includes('walker-active-slat') && walkers.includes('marker-slat'), 'walking agents must use slat markers instead of active rings/status orbs')
  assert(!walkers.includes('<sphereGeometry args={[0.032, 14, 10]} />') && !walkers.includes('<sphereGeometry args={[0.052, 16, 12]} />'), 'walking status markers must not render restroom/tea sphere icons')
  assert(!existsSync(path.join(repoRoot, 'src/renderer/src/components/office/kit/VendorMascot.tsx')), 'unused floating VendorMascot module must be removed')
  assert(!wayfinding.includes('sphereGeometry') && !wayfinding.includes('torusGeometry args={[0.09, 0.01, 8, 32]}'), 'service wayfinding must not render restroom head balls or toilet rings')
  assert(!facilities.includes('sphereGeometry') && facilities.includes('facility-active-slat'), 'facility hotspots must use slats/boxes instead of water/person spheres')
  assert(!deskLamp.includes('sphereGeometry'), 'desk lamps must use hard-surface joints instead of ball joints')
  assert(!monitorSetup.includes('sphereGeometry') && monitorSetup.includes("const HIGHLIGHT = '#b7c4ce'"), 'monitor setup must avoid white highlights and ball-like hubs/status lights')
  assert(!officeChair.includes('sphereGeometry'), 'office chairs must not use ball caster wheels')
  assert(!speechBubble.includes('#f4f4f4') && !speechBubble.includes("borderRadius: '50%'"), 'speech bubbles must use dark panels/slats instead of white bubbles or dot chains')
  assert(!whiteboard.includes('#f4f4f4') && !whiteboard.includes('#f8fbff') && whiteboard.includes("const BOARD_SURFACE = '#c7d0da'"), 'whiteboard must use muted gray-blue surface instead of pure white')
  assert(!whiteboard.includes('circleGeometry args={[0.145, 48]}'), 'whiteboard logo backing must be a muted panel, not a white circular chip')
  const structureTrimMatch = workstation.match(/const OFFICE_STRUCTURE_TRIM = '(#[0-9a-f]{6})'/iu)
  const signalAccentMatch = workstation.match(/const OFFICE_SIGNAL_ACCENT = '(#[0-9a-f]{6})'/iu)
  assert(structureTrimMatch, 'workstations must define a shared neutral structure trim')
  assert(signalAccentMatch, 'workstations must define a restrained signal accent')
  const structureTrimChannels = structureTrimMatch[1]
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16)) ?? []
  const signalAccentChannels = signalAccentMatch[1]
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16)) ?? []
  const [trimRed, trimGreen, trimBlue] = structureTrimChannels
  const [accentRed, accentGreen, accentBlue] = signalAccentChannels
  assert(
    structureTrimChannels.length === 3 &&
      Math.max(trimRed, trimGreen, trimBlue) - Math.min(trimRed, trimGreen, trimBlue) <= 35 &&
      Math.max(trimRed, trimGreen, trimBlue) <= 160,
    `workstation structure trim must stay neutral instead of flooding the scene with accent color: ${structureTrimMatch[1]}`
  )
  assert(
    signalAccentChannels.length === 3 &&
      accentGreen - accentRed >= 35 &&
      accentBlue - accentRed >= 45 &&
      Math.abs(accentBlue - accentGreen) <= 50 &&
      accentBlue <= 220,
    `workstation signal accent must stay muted cyan instead of vendor-wide color flooding: ${signalAccentMatch[1]}`
  )
  assert(!workstation.includes('VendorMascot'), 'workstations must not render floating vendor mascots or orb-like props')
  assert(workstation.includes('const stationAccent = OFFICE_STRUCTURE_TRIM'), 'station structure accent must remain neutral per workstation')
  assert(workstation.includes('accent={OFFICE_SIGNAL_ACCENT}'), 'cyan signal accent must stay scoped to compact status indicators')
  assert(workstation.includes("const showFaultStrip = activity === 'error'"), 'workstations must scope the error-only red strip to the failed session')
  assert(workstation.includes("const FAULT_COLOR = '#a94842'") && workstation.includes('<boxGeometry args={[0.24, 0.018, 0.046]} />'), 'fault indicators must stay small and muted instead of large bright red rails')
  assert(workstation.includes("awaiting: '#7f9aac'") && workstation.includes("completed: '#8ba2b0'"), 'non-error work screens must stay in the neutral blue-gray family')
  assert(workstation.includes('operator-position-slat'), 'workstations must mark operator position with slats instead of glowing ball-like discs')
  assert(!workstation.includes('<cylinderGeometry args={[0.72, 0.72, 0.012, 48]} />'), 'workstations must not render large glowing operator discs')
  assert(walkers.includes("const WALKER_ACCENT = '#59dcff'"), 'walking route accent must be neutralized')
  assert(wayfinding.includes("const APPROVAL = '#6f8fa0'") && wayfinding.includes("const DINING = '#5f7f8c'"), 'service wayfinding must use muted blue-gray approval/dining colors')
  assert(facilities.includes("accent: '#5f7f8c'"), 'dining facility hotspot must use muted blue-gray instead of green')
  assert(approvalStation.includes("const ACCENT = '#6f8fa0'"), 'approval station must use muted blue-gray instead of yellow')
  assert(operationsBackplane.includes("const APPROVAL = '#6f8fa0'"), 'operations backplane approval signal must use muted blue-gray instead of yellow')
  for (const [label, text] of [
    ['wayfinding', wayfinding],
    ['facility hotspots', facilities],
    ['agent walkers', walkers],
    ['approval station', approvalStation],
    ['operations backplane', operationsBackplane],
    ['workstation', workstation],
    ['monitor setup', monitorSetup],
    ['meeting table', meetingTable],
    ['office chair', officeChair],
    ['speech bubble', speechBubble],
    ['whiteboard', whiteboard],
    ['desk accessories', deskAccessories],
    ['coffee station', coffeeStation],
    ['plant', plant],
    ['bookshelf', bookshelf],
    ['server rack', serverRack],
    ['window wall', windowWall],
    ['desk lamp', deskLamp]
  ]) {
    for (const color of [
      '#91d18b',
      '#f0ffe8',
      '#e0a33c',
      '#8d7a50',
      '#6f8c82',
      '#ff9b54',
      '#fff2cf',
      '#3fc9c0',
      '#3f8a35',
      '#4fa63f',
      '#57b246',
      '#8a5a3c',
      '#7a4d33',
      '#6b5540',
      '#7a4436',
      '#3d5a52',
      '#c9c2b4',
      '#5affa8',
      '#ffb14a',
      '#ffd98f',
      '#ffd9a0',
      '#ffffff'
    ]) {
      assert(!text.includes(color), `${label} must not keep the old saturated office color ${color}`)
    }
  }
  assert(view.includes("bg: '#10151b'") && view.includes("grid1: '#34404c'"), 'office scene colors must remain muted and low saturation')
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
