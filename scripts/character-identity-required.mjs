#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/gu, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'character-identity')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-character-identity-'))
const require = createRequire(import.meta.url)
const sourceFiles = [
  'src/shared/watercolor-character.ts',
  'src/shared/workflow-repair.ts',
  'src/renderer/src/components/office/model.ts'
]
let report
let failure

try {
  const watercolor = loadModule('watercolor-character', sourceFiles[0])
  const workflowRepair = loadModule('workflow-repair', sourceFiles[1])
  const officeModel = loadOfficeModel(workflowRepair)
  const checks = [
    ...verifyRoleIdentity(watercolor),
    ...verifyCharacterStates(officeModel, workflowRepair),
    ...verifyAssetIdentity(watercolor)
  ]
  report = buildReport('passed', checks)
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  failure = serializeError(error)
  report = buildReport('failed', [], failure)
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport(report)
}

function verifyRoleIdentity(module) {
  const roles = module.WATERCOLOR_CHARACTER_ROLES
  assert.deepEqual(roles, [
    'researcher', 'planner', 'writer', 'designer', 'developer', 'review-test', 'operations'
  ])
  const explicit = module.resolveWatercolorRole(worker('explicit', { watercolorRole: 'qa' }), {
    name: 'Developer',
    purpose: 'Write code'
  })
  assert.deepEqual(explicit, { role: 'review-test', source: 'avatar-profile' })
  const semanticFixtures = [
    ['Research analyst', 'Find sources', 'researcher'],
    ['Product planner', 'Plan milestones', 'planner'],
    ['Content editor', 'Write documentation', 'writer'],
    ['UX designer', 'Design interfaces', 'designer'],
    ['Software engineer', 'Develop software', 'developer'],
    ['Quality reviewer', 'Review and test', 'review-test'],
    ['Operations lead', 'Operate production', 'operations']
  ]
  for (const [name, purpose, expected] of semanticFixtures) {
    assert.deepEqual(
      module.resolveWatercolorRole(worker(`semantic-${expected}`), { name, purpose }),
      { role: expected, source: 'role-template' }
    )
  }
  const first = module.resolveWatercolorRole(worker('stable-worker'))
  const second = module.resolveWatercolorRole({
    ...worker('stable-worker'),
    providerId: 'ignored-provider',
    model: 'ignored-model'
  })
  assert.deepEqual(first, second)
  assert.equal(first.source, 'stable-fallback')
  assert.ok(roles.includes(first.role))
  return [
    'seven-canonical-roles',
    'avatar-profile-precedes-role-template',
    'role-template-semantics-cover-seven-roles',
    'stable-fallback-is-provider-and-model-neutral'
  ]
}

function verifyCharacterStates(module, workflowRepair) {
  const stateOf = module.officeWatercolorStateOf
  assert.equal(stateOf(session()), 'idle')
  assert.equal(stateOf(session({ status: 'running' })), 'thinking')
  assert.equal(stateOf(session({ status: 'running', runningTools: { tool: true } })), 'tool-running')
  assert.equal(stateOf(session({ pendingPermissions: [{ id: 'approval', toolUseId: 'tool' }] })), 'awaiting-approval')
  assert.equal(stateOf(session({ status: 'error' })), 'blocked')
  assert.equal(stateOf(session({ items: [{ kind: 'turn-result', isError: false }] })), 'delivering')
  assert.equal(stateOf(session({ items: [{ kind: 'turn-result', isError: true }] })), 'blocked')
  const repairId = `${workflowRepair.WORKFLOW_ACCEPTANCE_REPAIR_WORK_ITEM_PREFIX}${'a'.repeat(64)}`
  assert.equal(stateOf(session({ status: 'running', workItemId: repairId })), 'repairing')
  assert.equal(stateOf(session({ status: 'running', workItemId: 'workflow-repair:not-a-digest' })), 'thinking')
  assert.equal(stateOf(session({ status: 'error', workItemId: repairId })), 'blocked')
  assert.equal(
    stateOf(session({
      status: 'running',
      workItemId: repairId,
      pendingPermissions: [{ id: 'approval', toolUseId: 'tool' }]
    })),
    'awaiting-approval'
  )
  return [
    'real-session-signals-map-to-seven-states',
    'repairing-requires-canonical-work-item-identity',
    'approval-and-failure-override-repairing',
    'turn-result-controls-delivery-and-blocked-state'
  ]
}

function verifyAssetIdentity(module) {
  const files = module.WATERCOLOR_CHARACTER_ROLES.flatMap((role) =>
    module.WATERCOLOR_CHARACTER_STATES.map((state) => module.watercolorCharacterAssetFilename(role, state))
  )
  assert.equal(files.length, 49)
  assert.equal(new Set(files).size, 49)
  assert.ok(files.every((file) => /^role-.+-state-.+-v01\.png$/u.test(file)))
  return ['forty-nine-unique-role-state-asset-identities']
}

function loadOfficeModel(workflowRepair) {
  const source = transpile(sourceFiles[2])
  const target = path.join(tempRoot, 'office-model.cjs')
  writeFileSync(target, source, 'utf8')
  const Module = require('node:module')
  const originalLoad = Module._load
  Module._load = function loadOfficeDependencies(request, parent, isMain) {
    if (request === '../../../../shared/workflow-repair') return workflowRepair
    if (request === './providerModelFailover') {
      return {
        hasOfficeFailoverSignal: (signal) => Boolean(signal.failover || signal.keyFailover || signal.modelFailover),
        latestProviderModelFailoverSignal: () => undefined
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(target)
  } finally {
    Module._load = originalLoad
  }
}

function loadModule(name, sourceFile) {
  const target = path.join(tempRoot, `${name}.cjs`)
  writeFileSync(target, transpile(sourceFile), 'utf8')
  return require(target)
}

function transpile(relativePath) {
  return ts.transpileModule(readFileSync(path.join(repoRoot, relativePath), 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true
    },
    fileName: relativePath,
    reportDiagnostics: true
  }).outputText
}

function worker(id, avatarProfile = {}) {
  return { id, avatarProfile }
}

function session(overrides = {}) {
  const { status = 'idle', workItemId, ...rest } = overrides
  return {
    meta: { id: 'session', status, ...(workItemId ? { workItemId } : {}) },
    items: [],
    streamText: '',
    streamThinking: '',
    toolResults: {},
    runningTools: {},
    pendingPermissions: [],
    childResults: {},
    lastSeq: 0,
    ...rest
  }
}

function buildReport(status, checks, error = null) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const gitStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  return {
    schemaVersion: 1,
    status,
    gate: 'test:character-identity:required',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    git: { commit, worktreeClean: gitStatus.length === 0 },
    sourceDigests: Object.fromEntries(sourceFiles.map((file) => [file, digest(file)])),
    checks,
    error
  }
}

function digest(relativePath) {
  return createHash('sha256').update(readFileSync(path.join(repoRoot, relativePath))).digest('hex')
}

function writeReport(value) {
  mkdirSync(path.join(reportRoot, runId), { recursive: true })
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path.join(reportRoot, runId, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  }
}
