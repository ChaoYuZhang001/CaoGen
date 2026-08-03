#!/usr/bin/env node
import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

const mode = process.argv[2]
if (mode === '--crash-worker' || mode === '--restart-probe') {
  const payload = decodePayload(process.argv[3])
  configureWorkerEnvironment(payload)
  if (mode === '--crash-worker') await runCrashWorker(payload)
  else await runRestartProbe(payload)
  process.exit(0)
}

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-external-effect-recovery-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const workspace = path.join(tempRoot, 'workspace')
const fixtureBin = path.join(tempRoot, 'bin')
const ghState = path.join(tempRoot, 'gh-state.json')
const ghAudit = path.join(tempRoot, 'gh-audit.jsonl')
const mcpState = path.join(tempRoot, 'mcp-state.json')
const mcpServer = path.join(tempRoot, 'mcp-server.mjs')
const reportRoot = path.join(repoRoot, 'test-results', 'external-effect-recovery')
const reportDir = path.join(reportRoot, runId)

const report = {
  schemaVersion: 1,
  runId,
  status: 'failed',
  sourceRevision: gitOutput(repoRoot, ['rev-parse', 'HEAD']),
  worktreeStatusCount: gitOutput(repoRoot, ['status', '--porcelain']).split('\n').filter(Boolean).length,
  checks: [],
  summary: {},
  failures: []
}

try {
  mkdirSync(userData, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(fixtureBin, { recursive: true })
  compileSources(outDir)
  installElectronStub(outDir)
  installFakeGitHubCli(fixtureBin)
  installMcpServer(mcpServer)
  initializeGitHubState(ghState)
  initializeMcpState(mcpState)
  initializeRepository(workspace)
  configureWorkerEnvironment({ userData, fixtureBin, ghState, ghAudit })

  const api = await loadApi(outDir)
  await runIssueNegativeCases(api, { userData, workspace, ghState })
  const directMcpMutations = await runMcpCases(api, { userData, workspace, mcpServer, mcpState })

  clearIssueRecords(ghState)
  normalizeMcpCapabilities(mcpState)
  const issueInput = {
    title: 'Crash recovery issue',
    body: 'Created only by the isolated required gate.',
    labels: ['recovery', 'trust-003']
  }
  const mcpInput = mcpToolInput(mcpServer, mcpState, 'crash-recovery', 'confirmed-after-restart')
  const crash = await runHardKill({
    repoRoot,
    outDir,
    userData,
    workspace,
    fixtureBin,
    ghState,
    ghAudit,
    mcpState,
    mcpServer,
    issueInput,
    mcpInput
  })
  assertEqual(crash.issueStatus, 'executing', 'Issue status before hard kill')
  assertEqual(crash.mcpStatus, 'executing', 'MCP status before hard kill')
  assertEqual(crash.issueCreateCalls, 1, 'Issue create count before hard kill')
  assertEqual(crash.mcpMutateCalls, directMcpMutations + 1, 'MCP mutate count before hard kill')
  check('SIGKILL occurs after both external mutations and before Effect completion', 'negative')

  const restart = runRestartChild({
    repoRoot,
    outDir,
    userData,
    workspace,
    fixtureBin,
    ghState,
    ghAudit,
    mcpState,
    issueEffectId: crash.issueEffectId,
    mcpEffectId: crash.mcpEffectId,
    sessionId: crash.sessionId,
    issueInput,
    mcpInput
  })
  assertEqual(restart.issueStatus, 'confirmed', 'Issue status after restart reconciliation')
  assertEqual(restart.mcpStatus, 'confirmed', 'MCP status after restart reconciliation')
  assertEqual(restart.issueCreateCalls, crash.issueCreateCalls, 'Issue create count after restart')
  assertEqual(restart.mcpMutateCalls, crash.mcpMutateCalls, 'MCP mutate count after restart')
  assertEqual(restart.firstRunRevision, restart.secondRunRevision, 'idempotent restart run revision')
  assertEqual(restart.issueDuplicateDecision, 'ask', 'confirmed Issue duplicate decision')
  assertEqual(restart.mcpDuplicateDecision, 'ask', 'confirmed MCP duplicate decision')
  assertEqual(countGitHubCommands(ghAudit, ['issue', 'create']), 1, 'total fake GitHub create commands')
  assertEqual(restart.unexpectedGitHubCommands.length, 0, 'unexpected fake GitHub commands')
  check('independent restart confirms the unique Issue marker using queries only')
  check('independent restart confirms MCP state using the read-only discovery contract')
  check('restart reconciliation is idempotent and performs zero automatic replays', 'negative')

  report.summary = {
    hardKill: true,
    issueEffectsConfirmedAfterRestart: 1,
    mcpEffectsConfirmedAfterRestart: 1,
    issueCreateCalls: restart.issueCreateCalls,
    mcpMutateCalls: restart.mcpMutateCalls,
    automaticIssueReplays: restart.issueCreateCalls - crash.issueCreateCalls,
    automaticMcpReplays: restart.mcpMutateCalls - crash.mcpMutateCalls,
    githubCommands: readAudit(ghAudit).length,
    negativePaths: report.checks.filter((item) => item.kind === 'negative').length
  }
  report.status = 'passed'
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log(JSON.stringify({
  status: report.status,
  runId,
  checks: report.checks.length,
  summary: report.summary,
  failures: report.failures,
  reportDir
}, null, 2))

async function runIssueNegativeCases(api, paths) {
  const initialCreates = readJson(paths.ghState).createCalls
  const baseInput = {
    title: 'Frozen issue intent',
    body: 'The body is part of the approved Effect intent.',
    labels: ['effect', 'recovery']
  }

  clearIssueRecords(paths.ghState)
  const intentCase = await prepareCase(api, paths, {
    sessionId: 'issue-intent-drift',
    toolUseId: 'issue-intent-drift-tool',
    toolName: 'git_create_issue',
    toolInput: baseInput
  })
  assertEqual(intentCase.handle.target.kind, 'issue_create', 'Issue target kind')
  assert(intentCase.handle.target.marker.includes(intentCase.handle.target.markerToken), 'Issue marker token must be frozen')
  const intentError = await rejectionMessage(() => api.effectRuntime.markEffectExecutionStarted(
    intentCase.handle,
    { ...intentCase.execution, toolInput: { ...baseInput, title: 'Changed after approval' } }
  ))
  assert(intentError.includes('执行前目标或输入已变化'), 'Issue intent drift must invalidate approval')
  assertEqual(await persistedEffectStatus(api, paths.userData, intentCase), 'abandoned', 'Issue intent drift status')
  check('Issue title/body/labels intent drift is rejected before create', 'negative')

  clearIssueRecords(paths.ghState)
  const remoteCase = await prepareCase(api, paths, {
    sessionId: 'issue-remote-drift',
    toolUseId: 'issue-remote-drift-tool',
    toolName: 'git_create_issue',
    toolInput: baseInput
  })
  gitOutput(paths.workspace, ['remote', 'set-url', 'origin', 'https://github.com/acme/drifted-fixture.git'])
  let remoteError
  try {
    remoteError = await rejectionMessage(() => api.effectRuntime.markEffectExecutionStarted(
      remoteCase.handle,
      remoteCase.execution
    ))
  } finally {
    gitOutput(paths.workspace, ['remote', 'set-url', 'origin', 'https://github.com/acme/caogen-effect-fixture.git'])
  }
  assert(remoteError.includes('执行前目标或输入已变化'), 'Issue remote drift must invalidate approval')
  assertEqual(await persistedEffectStatus(api, paths.userData, remoteCase), 'abandoned', 'Issue remote drift status')
  check('Issue repository remote drift is rejected before create', 'negative')

  clearIssueRecords(paths.ghState)
  const absentCase = await prepareCase(api, paths, {
    sessionId: 'issue-query-absent',
    toolUseId: 'issue-query-absent-tool',
    toolName: 'git_create_issue',
    toolInput: baseInput
  })
  await api.effectRuntime.markEffectExecutionStarted(absentCase.handle, absentCase.execution)
  const absent = await api.effectRuntime.completeEffectExecution(absentCase.handle, {
    ok: false,
    output: 'synthetic lost acknowledgement without an observed Issue'
  })
  assertEqual(absent?.status, 'waiting_reconciliation', 'absent Issue reconciliation status')
  assert(absent?.error?.includes('未观察到 Issue'), 'absent Issue must not be treated as not-applied')
  check('no Issue result remains unresolved and cannot authorize replay', 'negative')

  clearIssueRecords(paths.ghState)
  const ambiguousCase = await prepareCase(api, paths, {
    sessionId: 'issue-query-ambiguous',
    toolUseId: 'issue-query-ambiguous-tool',
    toolName: 'git_create_issue',
    toolInput: { ...baseInput, title: 'Ambiguous issue marker' }
  })
  await api.effectRuntime.markEffectExecutionStarted(ambiguousCase.handle, ambiguousCase.execution)
  const target = ambiguousCase.handle.target
  writeIssueRecords(paths.ghState, [issueRecord(target, 41), issueRecord(target, 42)])
  const ambiguous = await api.effectRuntime.completeEffectExecution(ambiguousCase.handle, {
    ok: false,
    output: 'synthetic ambiguous result'
  })
  assertEqual(ambiguous?.status, 'waiting_reconciliation', 'ambiguous Issue reconciliation status')
  assert(ambiguous?.error?.includes('多个 Issue'), 'ambiguous Issue marker must remain unresolved')
  assertEqual(readJson(paths.ghState).createCalls, initialCreates, 'Issue negative-path create count')
  clearIssueRecords(paths.ghState)
  check('multiple exact Issue markers remain unresolved with zero create calls', 'negative')
}

async function runMcpCases(api, paths) {
  initializeMcpState(paths.mcpState)
  const config = mcpConfig(paths.mcpServer, paths.mcpState)
  const discovery = await api.mcpClient.discoverMcpServer(config, 5_000)
  api.mcpEffect.recordApprovedMcpDiscovery(config, discovery)
  assertEqual(discovery.tools.find((item) => item.name === 'read_state')?.annotations?.readOnlyHint, true)
  check('MCP discovery approves a distinct readOnlyHint reconciliation tool')

  const normalInput = mcpToolInput(paths.mcpServer, paths.mcpState, 'normal-confirmed', 'ready')
  const normalCase = await prepareCase(api, paths, {
    sessionId: 'mcp-normal-confirmed',
    toolUseId: 'mcp-normal-confirmed-tool',
    toolName: 'mcp_call_tool',
    toolInput: normalInput
  })
  assertEqual(normalCase.handle.target.kind, 'mcp_tool_call', 'MCP target kind')
  await api.effectRuntime.markEffectExecutionStarted(normalCase.handle, normalCase.execution)
  const beforeNormal = readJson(paths.mcpState).mutateCalls
  const normalResult = await api.mcpEffect.executeMcpEffectTarget(normalCase.handle.target, normalInput, 5_000)
  assertEqual(normalResult.ok, true, 'normal MCP mutation result')
  const normalEffect = await api.effectRuntime.completeEffectExecution(normalCase.handle, {
    ok: normalResult.ok,
    output: JSON.stringify(normalResult)
  })
  assertEqual(normalEffect?.status, 'confirmed', 'normal MCP Effect status')
  assertEqual(readJson(paths.mcpState).mutateCalls, beforeNormal + 1, 'normal MCP mutate count')
  const duplicate = await api.mcpEffect.executeMcpEffectTarget(normalCase.handle.target, normalInput, 5_000)
  assertEqual(duplicate.ok, true, 'MCP duplicate pre-query result')
  assertEqual(duplicate.existing, true, 'MCP duplicate must resolve as existing')
  assertEqual(readJson(paths.mcpState).mutateCalls, beforeNormal + 1, 'MCP duplicate mutate count')
  const normalDecision = api.registry.taskRuntimeRegistry.evaluateTool({
    sessionId: normalCase.execution.sessionId,
    cwd: paths.workspace,
    toolName: 'mcp_call_tool',
    toolInput: normalInput,
    toolUseId: 'mcp-normal-confirmed-duplicate'
  })
  assertEqual(normalDecision.kind, 'ask', 'confirmed MCP duplicate policy')
  check('queryable MCP mutation confirms through its frozen read-only postcondition')
  check('confirmed MCP duplicate returns existing without a second mutation', 'negative')

  const argsInput = mcpToolInput(paths.mcpServer, paths.mcpState, 'arguments-drift', 'approved')
  const argsCase = await prepareCase(api, paths, {
    sessionId: 'mcp-arguments-drift',
    toolUseId: 'mcp-arguments-drift-tool',
    toolName: 'mcp_call_tool',
    toolInput: argsInput
  })
  await api.effectRuntime.markEffectExecutionStarted(argsCase.handle, argsCase.execution)
  const beforeArgsDrift = readJson(paths.mcpState).mutateCalls
  const argsDrift = await api.mcpEffect.executeMcpEffectTarget(argsCase.handle.target, {
    ...argsInput,
    arguments: { id: 'arguments-drift', value: 'changed' }
  }, 5_000)
  assertEqual(argsDrift.ok, false, 'MCP arguments drift result')
  assert(argsDrift.error?.includes('arguments 已偏离'), 'MCP arguments drift error')
  assertEqual(readJson(paths.mcpState).mutateCalls, beforeArgsDrift, 'MCP arguments drift mutate count')
  check('MCP mutation arguments drift is rejected before execution', 'negative')

  const contractInput = mcpToolInput(paths.mcpServer, paths.mcpState, 'contract-drift', 'approved')
  const contractCase = await prepareCase(api, paths, {
    sessionId: 'mcp-contract-drift',
    toolUseId: 'mcp-contract-drift-tool',
    toolName: 'mcp_call_tool',
    toolInput: contractInput
  })
  await api.effectRuntime.markEffectExecutionStarted(contractCase.handle, contractCase.execution)
  const beforeContractDrift = readJson(paths.mcpState).mutateCalls
  const contractDrift = await api.mcpEffect.executeMcpEffectTarget(contractCase.handle.target, {
    ...contractInput,
    reconciliation: { ...contractInput.reconciliation, expectedValue: 'changed' }
  }, 5_000)
  assertEqual(contractDrift.ok, false, 'MCP reconciliation drift result')
  assert(contractDrift.error?.includes('reconciliation contract 已偏离'), 'MCP reconciliation drift error')
  assertEqual(readJson(paths.mcpState).mutateCalls, beforeContractDrift, 'MCP reconciliation drift mutate count')
  check('MCP reconciliation contract drift is rejected before execution', 'negative')

  const unmatchedInput = mcpToolInput(paths.mcpServer, paths.mcpState, 'unmatched', 'expected')
  const unmatchedCase = await prepareCase(api, paths, {
    sessionId: 'mcp-unmatched',
    toolUseId: 'mcp-unmatched-tool',
    toolName: 'mcp_call_tool',
    toolInput: unmatchedInput
  })
  await api.effectRuntime.markEffectExecutionStarted(unmatchedCase.handle, unmatchedCase.execution)
  const beforeUnmatched = readJson(paths.mcpState).mutateCalls
  const unmatched = await api.effectRuntime.completeEffectExecution(unmatchedCase.handle, {
    ok: false,
    output: 'synthetic uncertain MCP result'
  })
  assertEqual(unmatched?.status, 'waiting_reconciliation', 'unmatched MCP reconciliation status')
  assert(unmatched?.error?.includes('未返回预期后置条件'), 'unmatched MCP reconciliation reason')
  assertEqual(readJson(paths.mcpState).mutateCalls, beforeUnmatched, 'unmatched MCP mutate count')
  check('unmatched MCP postcondition remains unresolved with zero automatic mutation', 'negative')

  const capabilityInput = mcpToolInput(paths.mcpServer, paths.mcpState, 'capability-drift', 'expected')
  const capabilityCase = await prepareCase(api, paths, {
    sessionId: 'mcp-capability-drift',
    toolUseId: 'mcp-capability-drift-tool',
    toolName: 'mcp_call_tool',
    toolInput: capabilityInput
  })
  await api.effectRuntime.markEffectExecutionStarted(capabilityCase.handle, capabilityCase.execution)
  const beforeCapabilityDrift = readJson(paths.mcpState).mutateCalls
  const driftedState = readJson(paths.mcpState)
  writeJson(paths.mcpState, { ...driftedState, capabilityVersion: 'v2' })
  const capability = await api.effectRuntime.completeEffectExecution(capabilityCase.handle, {
    ok: false,
    output: 'synthetic MCP capability drift'
  })
  assertEqual(capability?.status, 'waiting_reconciliation', 'MCP capability drift status')
  assert(capability?.error?.includes('capability snapshot 已变化'), 'MCP capability drift reason')
  assertEqual(readJson(paths.mcpState).mutateCalls, beforeCapabilityDrift, 'MCP capability drift mutate count')
  normalizeMcpCapabilities(paths.mcpState)
  check('MCP capability snapshot drift blocks the old query contract', 'negative')

  return readJson(paths.mcpState).mutateCalls
}

async function runCrashWorker(payload) {
  const api = await loadApi(payload.outDir)
  const config = mcpConfig(payload.mcpServer, payload.mcpState)
  const discovery = await api.mcpClient.discoverMcpServer(config, 5_000)
  api.mcpEffect.recordApprovedMcpDiscovery(config, discovery)
  const sessionId = 'external-effects-hard-kill'
  const issueToolUseId = 'hard-kill-issue-tool'
  const mcpToolUseId = 'hard-kill-mcp-tool'
  await seedRun(api, {
    userData: payload.userData,
    cwd: payload.workspace,
    sessionId,
    executions: [
      { toolUseId: issueToolUseId, toolName: 'git_create_issue', toolInput: payload.issueInput },
      { toolUseId: mcpToolUseId, toolName: 'mcp_call_tool', toolInput: payload.mcpInput }
    ]
  })

  const issueExecution = execution(sessionId, payload.workspace, issueToolUseId, 'git_create_issue', payload.issueInput)
  const issueHandle = await api.effectRuntime.prepareEffectExecution(issueExecution)
  assert(issueHandle?.target.kind === 'issue_create', 'hard-kill Issue target')
  await api.effectRuntime.markEffectExecutionStarted(issueHandle, issueExecution)
  const issueResult = await api.pullRequest.executeIssueEffectTarget({
    target: issueHandle.target,
    title: payload.issueInput.title,
    body: payload.issueInput.body,
    labels: payload.issueInput.labels
  })
  assertEqual(issueResult.ok, true, 'hard-kill Issue execution')

  const mcpExecution = execution(sessionId, payload.workspace, mcpToolUseId, 'mcp_call_tool', payload.mcpInput)
  const mcpHandle = await api.effectRuntime.prepareEffectExecution(mcpExecution)
  assert(mcpHandle?.target.kind === 'mcp_tool_call', 'hard-kill MCP target')
  await api.effectRuntime.markEffectExecutionStarted(mcpHandle, mcpExecution)
  const mcpResult = await api.mcpEffect.executeMcpEffectTarget(mcpHandle.target, payload.mcpInput, 5_000)
  assertEqual(mcpResult.ok, true, 'hard-kill MCP execution')

  const stored = await api.snapshot.getTaskSnapshot(sessionId, payload.userData)
  const issueEffect = requireEffect(stored, issueHandle.effectId)
  const mcpEffect = requireEffect(stored, mcpHandle.effectId)
  assertEqual(issueEffect.status, 'executing', 'persisted hard-kill Issue status')
  assertEqual(mcpEffect.status, 'executing', 'persisted hard-kill MCP status')
  process.send?.({
    type: 'external-mutations-complete',
    sessionId,
    issueEffectId: issueHandle.effectId,
    mcpEffectId: mcpHandle.effectId,
    issueStatus: issueEffect.status,
    mcpStatus: mcpEffect.status,
    issueCreateCalls: readJson(payload.ghState).createCalls,
    mcpMutateCalls: readJson(payload.mcpState).mutateCalls
  })
  setInterval(() => undefined, 60_000)
}

async function runRestartProbe(payload) {
  const api = await loadApi(payload.outDir)
  const stored = await api.snapshot.getTaskSnapshot(payload.sessionId, payload.userData)
  assert(stored?.run, 'restart probe requires the persisted crash Run')
  const first = await api.effectRuntime.reconcilePersistedTaskSnapshot(stored)
  const firstIssue = requireEffect(first, payload.issueEffectId)
  const firstMcp = requireEffect(first, payload.mcpEffectId)
  const second = await api.effectRuntime.reconcilePersistedTaskSnapshot(first)
  const secondIssue = requireEffect(second, payload.issueEffectId)
  const secondMcp = requireEffect(second, payload.mcpEffectId)
  const issueDecision = api.registry.taskRuntimeRegistry.evaluateTool({
    sessionId: payload.sessionId,
    cwd: payload.workspace,
    toolName: 'git_create_issue',
    toolInput: payload.issueInput,
    toolUseId: 'hard-kill-issue-duplicate'
  })
  const mcpDecision = api.registry.taskRuntimeRegistry.evaluateTool({
    sessionId: payload.sessionId,
    cwd: payload.workspace,
    toolName: 'mcp_call_tool',
    toolInput: payload.mcpInput,
    toolUseId: 'hard-kill-mcp-duplicate'
  })
  const audit = readAudit(payload.ghAudit)
  process.stdout.write(`EXTERNAL_EFFECT_RESTART:${JSON.stringify({
    issueStatus: secondIssue.status,
    mcpStatus: secondMcp.status,
    issueCreateCalls: readJson(payload.ghState).createCalls,
    mcpMutateCalls: readJson(payload.mcpState).mutateCalls,
    firstRunRevision: first.run?.revision,
    secondRunRevision: second.run?.revision,
    firstIssueRevision: firstIssue.revision,
    secondIssueRevision: secondIssue.revision,
    firstMcpRevision: firstMcp.revision,
    secondMcpRevision: secondMcp.revision,
    issueDuplicateDecision: issueDecision.kind,
    mcpDuplicateDecision: mcpDecision.kind,
    unexpectedGitHubCommands: audit
      .map((item) => item.args)
      .filter((args) => !isAllowedGitHubCommand(args))
  })}\n`)
}

async function runHardKill(payload) {
  const encoded = encodePayload(payload)
  return new Promise((resolvePromise, rejectPromise) => {
    let ready = null
    let stderr = ''
    const child = fork(scriptPath, ['--crash-worker', encoded], {
      cwd: repoRoot,
      silent: true,
      env: workerEnv(payload)
    })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`external Effect crash worker timed out:${stderr}`))
    }, 30_000)
    child.on('message', (message) => {
      if (!message || message.type !== 'external-mutations-complete' || ready) return
      ready = message
      child.kill('SIGKILL')
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (!ready) {
        rejectPromise(new Error(`external Effect crash worker exited before barrier (code=${code}, signal=${signal}):${stderr}`))
        return
      }
      if (code === 0 && signal === null) {
        rejectPromise(new Error('external Effect crash worker was not forcibly terminated'))
        return
      }
      resolvePromise(ready)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
  })
}

function runRestartChild(payload) {
  const stdout = execFileSync(process.execPath, [scriptPath, '--restart-probe', encodePayload(payload)], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: workerEnv(payload),
    timeout: 30_000
  })
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('EXTERNAL_EFFECT_RESTART:'))
  if (!line) throw new Error(`restart probe did not emit its result marker:${stdout}`)
  return JSON.parse(line.slice('EXTERNAL_EFFECT_RESTART:'.length))
}

async function prepareCase(api, paths, spec) {
  await seedRun(api, {
    userData: paths.userData,
    cwd: paths.workspace,
    sessionId: spec.sessionId,
    executions: [spec]
  })
  const input = execution(spec.sessionId, paths.workspace, spec.toolUseId, spec.toolName, spec.toolInput)
  const handle = await api.effectRuntime.prepareEffectExecution(input)
  assert(handle, `${spec.toolName} must produce an Effect handle`)
  return { handle, execution: input }
}

async function seedRun(api, input) {
  const now = Date.now()
  const runId = `run-${input.sessionId}`
  const run = {
    schemaVersion: 1,
    id: runId,
    sessionId: input.sessionId,
    taskId: `task-${input.sessionId}`,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: now,
    updatedAt: now,
    steps: [],
    toolExecutions: input.executions.map((item, index) => ({
      id: `execution-${input.sessionId}-${index + 1}`,
      runId,
      sessionId: input.sessionId,
      toolUseId: item.toolUseId,
      toolName: item.toolName,
      status: 'requested',
      inputDigest: api.idempotency.stableValueDigest(item.toolInput),
      idempotencyKey: api.idempotency.buildToolIdempotencyKey({
        scopeId: input.sessionId,
        cwd: input.cwd,
        toolName: item.toolName,
        toolInput: item.toolInput
      }),
      createdAt: now + index,
      updatedAt: now + index
    })),
    effects: []
  }
  const snapshot = api.snapshot.buildTaskSnapshot({
    meta: {
      id: input.sessionId,
      title: `External Effect fixture ${input.sessionId}`,
      cwd: input.cwd,
      childTaskId: run.taskId,
      model: 'synthetic-external-effect-model',
      providerId: 'synthetic-external-effect-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: `sdk-${input.sessionId}`,
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: now
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now
  })
  const persisted = await api.snapshot.saveTaskSnapshot(snapshot, input.userData)
  api.registry.taskRuntimeRegistry.set(input.sessionId, persisted.run ?? run)
}

function execution(sessionId, cwd, toolUseId, toolName, toolInput) {
  return { sessionId, cwd, toolUseId, toolName, toolInput }
}

async function persistedEffectStatus(api, userDataPath, prepared) {
  const stored = await api.snapshot.getTaskSnapshot(prepared.execution.sessionId, userDataPath)
  return requireEffect(stored, prepared.handle.effectId).status
}

function requireEffect(snapshot, effectId) {
  const effect = snapshot?.run?.effects?.find((item) => item.id === effectId)
  if (!effect) throw new Error(`missing persisted Effect:${effectId}`)
  return effect
}

function mcpConfig(serverPath, statePath) {
  return { command: process.execPath, args: [serverPath, statePath], transport: 'stdio' }
}

function mcpToolInput(serverPath, statePath, id, value) {
  return {
    ...mcpConfig(serverPath, statePath),
    toolName: 'mutate',
    arguments: { id, value },
    reconciliation: {
      toolName: 'read_state',
      arguments: { id },
      jsonPointer: '/structuredContent/value',
      expectedValue: value
    },
    timeoutMs: 5_000
  }
}

function issueRecord(target, number) {
  return {
    number,
    url: `https://github.com/acme/caogen-effect-fixture/issues/${number}`,
    state: 'OPEN',
    title: 'Frozen issue intent',
    body: `The body is part of the approved Effect intent.\n\n${target.marker}`,
    labels: target.labels.map((name) => ({ name }))
  }
}

function clearIssueRecords(statePath) {
  const state = readJson(statePath)
  writeJson(statePath, { ...state, records: [] })
}

function writeIssueRecords(statePath, records) {
  const state = readJson(statePath)
  writeJson(statePath, { ...state, records })
}

function normalizeMcpCapabilities(statePath) {
  const state = readJson(statePath)
  writeJson(statePath, { ...state, capabilityVersion: 'v1', readOnly: true })
}

function initializeGitHubState(statePath) {
  writeJson(statePath, { createCalls: 0, records: [] })
  writeFileSync(ghAudit, '', 'utf8')
}

function initializeMcpState(statePath) {
  writeJson(statePath, {
    capabilityVersion: 'v1',
    readOnly: true,
    mutateCalls: 0,
    readCalls: 0,
    values: {}
  })
}

function initializeRepository(cwd) {
  gitOutput(cwd, ['init'])
  gitOutput(cwd, ['config', 'user.name', 'CaoGen Effect Gate'])
  gitOutput(cwd, ['config', 'user.email', 'effect-gate@example.invalid'])
  writeFileSync(path.join(cwd, 'README.md'), '# isolated external effect fixture\n', 'utf8')
  gitOutput(cwd, ['add', 'README.md'])
  gitOutput(cwd, ['commit', '-m', 'fixture'])
  gitOutput(cwd, ['remote', 'add', 'origin', 'https://github.com/acme/caogen-effect-fixture.git'])
}

function installFakeGitHubCli(binDir) {
  const file = path.join(binDir, 'gh')
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const statePath = process.env.CAOGEN_EXTERNAL_GH_STATE
const auditPath = process.env.CAOGEN_EXTERNAL_GH_AUDIT
if (!statePath || !auditPath) throw new Error('fake gh state is not configured')
const args = process.argv.slice(2)
appendFileSync(auditPath, JSON.stringify({ args }) + '\\n', 'utf8')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(state.records || []) + '\\n')
} else if (args[0] === 'issue' && args[1] === 'create') {
  state.createCalls = (state.createCalls || 0) + 1
  const number = 100 + state.createCalls
  const labels = String(option('--label') || '').split(',').filter(Boolean).map((name) => ({ name }))
  const record = {
    number,
    url: 'https://github.com/acme/caogen-effect-fixture/issues/' + number,
    state: 'OPEN',
    title: option('--title') || '',
    body: option('--body') || '',
    labels
  }
  state.records = [record]
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n', 'utf8')
  process.stdout.write(record.url + '\\n')
} else {
  process.stderr.write('unexpected fake gh command:' + JSON.stringify(args) + '\\n')
  process.exitCode = 64
}
`, 'utf8')
  chmodSync(file, 0o755)
}

function installMcpServer(serverPath) {
  writeFileSync(serverPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const statePath = process.argv[2]
if (!statePath) throw new Error('MCP state path is required')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n', 'utf8')
const response = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  if (!line.trim()) continue
  const request = JSON.parse(line)
  const state = readState()
  if (request.method === 'initialize') {
    response(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'caogen-effect-fixture', version: state.capabilityVersion }
    })
  } else if (request.method === 'tools/list') {
    const readSchema = state.capabilityVersion === 'v1'
      ? { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
      : { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'number' } }, required: ['id'] }
    response(request.id, { tools: [
      {
        name: 'mutate',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, value: {} },
          required: ['id', 'value']
        },
        annotations: { destructiveHint: true }
      },
      {
        name: 'read_state',
        inputSchema: readSchema,
        annotations: { readOnlyHint: state.readOnly === true }
      }
    ] })
  } else if (request.method === 'resources/list') {
    response(request.id, { resources: [] })
  } else if (request.method === 'prompts/list') {
    response(request.id, { prompts: [] })
  } else if (request.method === 'tools/call') {
    const name = request.params && request.params.name
    const args = request.params && request.params.arguments || {}
    if (name === 'mutate') {
      state.mutateCalls += 1
      state.values[args.id] = args.value
      writeState(state)
      response(request.id, {
        content: [{ type: 'text', text: JSON.stringify({ applied: true }) }],
        structuredContent: { applied: true }
      })
    } else if (name === 'read_state') {
      state.readCalls += 1
      writeState(state)
      const value = Object.hasOwn(state.values, args.id) ? state.values[args.id] : null
      response(request.id, {
        content: [{ type: 'text', text: JSON.stringify({ value }) }],
        structuredContent: { value }
      })
    } else {
      response(request.id, { content: [{ type: 'text', text: 'unknown tool' }], isError: true })
    }
  } else {
    response(request.id, {})
  }
}
`, 'utf8')
  chmodSync(serverPath, 0o755)
}

function compileSources(compiledRoot) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/effect-runtime.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/task-runtime-registry.ts',
    'src/main/git/pull-request-effect.ts',
    'src/main/mcp/mcp-effect.ts',
    '--outDir', compiledRoot,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub(compiledRoot) {
  const electronDir = path.join(compiledRoot, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `
function transform(value) {
  const input = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8')
  const output = Buffer.alloc(input.length)
  for (let index = 0; index < input.length; index += 1) output[index] = input[input.length - index - 1] ^ 0xa5
  return output
}
export const app = { getPath: () => process.env.CAOGEN_EXTERNAL_EFFECT_USER_DATA }
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => transform(value),
  decryptString: (value) => transform(value).toString('utf8')
}
`, 'utf8')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n', 'utf8')
}

async function loadApi(compiledRoot) {
  const [effectRuntime, snapshot, registry, idempotency, pullRequest, mcpEffect, mcpClient] = await Promise.all([
    importCompiled(compiledRoot, 'main/task/effect-runtime.js'),
    importCompiled(compiledRoot, 'main/task/task-snapshot.js'),
    importCompiled(compiledRoot, 'main/task/task-runtime-registry.js'),
    importCompiled(compiledRoot, 'main/task/tool-idempotency.js'),
    importCompiled(compiledRoot, 'main/git/pull-request-effect.js'),
    importCompiled(compiledRoot, 'main/mcp/mcp-effect.js'),
    importCompiled(compiledRoot, 'main/mcp/mcp-client.js')
  ])
  return { effectRuntime, snapshot, registry, idempotency, pullRequest, mcpEffect, mcpClient }
}

async function importCompiled(root, suffix) {
  const file = findCompiled(root, suffix)
  if (!file) throw new Error(`compiled module not found:${suffix}`)
  return import(pathToFileURL(file).href)
}

function findCompiled(root, suffix) {
  const target = suffix.split('/').join(path.sep)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && full.endsWith(target)) return full
    }
  }
  return undefined
}

function configureWorkerEnvironment(payload) {
  if (payload.userData) process.env.CAOGEN_EXTERNAL_EFFECT_USER_DATA = payload.userData
  if (payload.ghState) process.env.CAOGEN_EXTERNAL_GH_STATE = payload.ghState
  if (payload.ghAudit) process.env.CAOGEN_EXTERNAL_GH_AUDIT = payload.ghAudit
  if (payload.fixtureBin) process.env.PATH = `${payload.fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`
}

function workerEnv(payload) {
  return {
    ...process.env,
    CAOGEN_EXTERNAL_EFFECT_USER_DATA: payload.userData,
    CAOGEN_EXTERNAL_GH_STATE: payload.ghState,
    CAOGEN_EXTERNAL_GH_AUDIT: payload.ghAudit,
    PATH: `${payload.fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`
  }
}

function readAudit(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function countGitHubCommands(file, prefix) {
  return readAudit(file).filter((item) => prefix.every((value, index) => item.args[index] === value)).length
}

function isAllowedGitHubCommand(args) {
  return Array.isArray(args) && args[0] === 'issue' && (args[1] === 'list' || args[1] === 'create')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function gitOutput(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function rejectionMessage(task) {
  try {
    await task()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected operation to reject')
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodePayload(value) {
  if (!value) throw new Error('worker payload is required')
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function check(name, kind = 'positive') {
  report.checks.push({ name, kind })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label = 'value') {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
