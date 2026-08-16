#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-task-plan-contract-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')

try {
  compile(outDir)
  const { TaskPlanContractStore } = await import(
    pathToFileURL(path.join(outDir, 'main', 'task', 'task-plan-contract-store.js')).href
  )
  const store = new TaskPlanContractStore(() => userData)
  const binding = { sessionId: 'session-1', workspaceId: 'workspace-1', goalId: 'goal-1', workItemId: 'work-1' }

  const first = store.createVersion(binding, draft('Ship the first version'), 'local-user')
  assert.equal(first.currentVersion?.version, 1)
  assert.match(first.currentVersion?.digest ?? '', /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.approvalStatus, 'pending')
  assert.throws(() => store.approve(binding.sessionId, {
    version: 1,
    digest: `sha256:${'0'.repeat(64)}`
  }), /目标已变化/)

  const approved = store.approve(binding.sessionId, {
    version: 1,
    digest: first.currentVersion.digest,
    reason: 'Reviewed locally'
  })
  assert.equal(approved.approvalStatus, 'approved')
  assert.equal(store.assertExecutionAuthorized(binding.sessionId, true).approved, true)
  approved.currentVersion.objective = 'mutated returned view'
  assert.equal(store.get(binding.sessionId).currentVersion.objective, 'Ship the first version')

  const restarted = new TaskPlanContractStore(() => userData)
  assert.equal(restarted.get(binding.sessionId).approvalStatus, 'approved')
  const second = restarted.createVersion(
    binding,
    { ...draft('Ship the reviewed second version'), changeReason: 'Acceptance changed' },
    'local-user'
  )
  assert.equal(second.currentVersion.version, 2)
  assert.equal(second.approvalStatus, 'pending')
  assert.equal(second.approvalEvents.at(-1)?.kind, 'superseded')
  assert.throws(() => restarted.assertExecutionAuthorized(binding.sessionId, false), /尚未批准|取代/)
  assert.throws(() => restarted.createVersion(
    { ...binding, workItemId: 'work-2' },
    { ...draft('Binding change'), changeReason: 'Move ownership' },
    'local-user'
  ), /不能改变/)
  assert.throws(() => restarted.createVersion(
    binding,
    { ...draft('Cycle'), steps: [
      { id: 'one', title: 'One', dependsOn: ['two'] },
      { id: 'two', title: 'Two', dependsOn: ['one'] }
    ], changeReason: 'Cycle check' },
    'local-user'
  ), /形成循环/)

  const directory = path.join(userData, 'task-plans')
  const file = path.join(directory, 'task-plan-contracts.json')
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o077, 0)
    assert.equal(statSync(file).mode & 0o077, 0)
  }

  const validText = readFileSync(file, 'utf8')
  const tamperedDigest = JSON.parse(validText)
  tamperedDigest.sessions[binding.sessionId].versions[1].objective = 'tampered objective'
  writePrivate(file, tamperedDigest)
  assert.throws(() => new TaskPlanContractStore(() => userData).get(binding.sessionId), /存储损坏|摘要校验失败/)

  writeFileSync(file, validText, { mode: 0o600 })
  chmodSync(file, 0o600)
  const tamperedApproval = JSON.parse(validText)
  tamperedApproval.sessions[binding.sessionId].approvalEvents[0].actor = 'system'
  writePrivate(file, tamperedApproval)
  assert.throws(() => new TaskPlanContractStore(() => userData).get(binding.sessionId), /存储损坏|审批历史/)

  writeFileSync(file, validText, { mode: 0o600 })
  chmodSync(file, 0o600)
  if (process.platform !== 'win32') {
    chmodSync(file, 0o644)
    assert.throws(() => new TaskPlanContractStore(() => userData).get(binding.sessionId), /存储损坏|权限/)
  }

  verifyProductionWiring()
  console.log('task plan contract smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function draft(objective) {
  return {
    objective,
    steps: [{ id: 'inspect', title: 'Inspect', description: 'Read current state' }],
    expectedArtifacts: ['Verified change'],
    dataEgress: ['Configured Provider: request and required context'],
    estimatedCostUsd: 0.25,
    riskLevel: 'medium',
    acceptanceCriteria: ['Regression suite passes']
  }
}

function writePrivate(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

function compile(outDirPath) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/task-plan-contract-store.ts',
    '--outDir', outDirPath,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function verifyProductionWiring() {
  const manager = source('src/main/sessionManager.ts')
  const coordinator = source('src/main/task/task-plan-session-coordinator.ts')
  const tools = source('src/main/openaiTools.ts')
  const genesis = source('src/main/task/genesis-plan-contract.ts')
  const interactiveIpc = source('src/main/ipc/interactive-mutation-handlers.ts')
  const terminalIpc = source('src/main/ipc/terminal-mutation-ipc.ts')
  const rootIpc = source('src/main/ipc.ts')
  const taskPlanIpc = source('src/main/ipc/task-plan-handlers.ts')
  const preload = source('src/preload/task-plan.ts')
  const workbench = source('src/renderer/src/components/experience/TaskPlanWorkbench.tsx')
  const editor = source('src/renderer/src/components/experience/TaskPlanEditor.tsx')
  assert.match(coordinator, /assertExecutionAuthorized\(id, session\.meta\.taskStrategy === 'plan'\)/)
  assert.match(coordinator, /session\.meta\.lastError = error instanceof Error \? error\.message : String\(error\)/)
  assert.match(manager, /createAgentTaskPlanVersion/)
  assert.match(tools, /buildGenesisPlanContract/)
  assert.match(genesis, /planContract:[\s\S]*digest: plan\.currentVersion\?\.digest/)
  assert.match(terminalIpc, /assertExecutionAuthorized\(session\.id, '启动终端'\)/)
  assert.match(terminalIpc, /authorizeExistingTerminalMutation\(dependencies, id, '向终端写入输入'\)/)
  assert.match(terminalIpc, /authorizeExistingTerminalMutation\(dependencies, id, '调整终端尺寸'\)/)
  assert.match(terminalIpc, /authorizeExistingTerminalMutation\(dependencies, id, '关闭终端'\)/)
  assert.match(rootIpc, /assertExecutionAuthorized: \(id, action\) => sessionManager\.assertInteractiveExecutionAuthorized\(id, action\)/)
  assert.match(interactiveIpc, /authorize\(id, '保存项目文件'\)/)
  assert.match(taskPlanIpc, /handleTaskPlanIpc/)
  assert.match(preload, /invokeAppFeature\('task-plan', action, sessionId, payload\)/)
  assert.match(taskPlanIpc, /action === 'create-version'/)
  assert.match(preload, /invoke\('create-version', sessionId, draft\)/)
  assert.match(editor, /data-task-plan-approve-execute/)
  assert.match(workbench, /version: current\.version, digest: current\.digest/)
  assert.match(manager, /dispatchTaskDag\(id, \{ dag, isolated: this\.sessions\.get\(id\)\?\.meta\.isolated === true \}\)/)
  assert.match(coordinator, /executionAuthoritySessionId\(session\.meta\)/)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}
