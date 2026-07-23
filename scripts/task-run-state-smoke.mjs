import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-task-run-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/task-run.ts',
      'src/main/task/task-runtime-registry.ts',
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const taskRun = await import(pathToFileURL(findCompiledModule(outDir, 'task-run.js')).href)
  const taskExecution = await import(pathToFileURL(findCompiledModule(outDir, 'task-execution.js')).href)
  const toolIdempotency = await import(pathToFileURL(findCompiledModule(outDir, 'tool-idempotency.js')).href)
  const runtimeRegistry = await import(pathToFileURL(findCompiledModule(outDir, 'task-runtime-registry.js')).href)
  let run = taskRun.createTaskRun({ id: 'run-a', sessionId: 'session-a', taskId: 'task-a', now: 1000 })
  assertEqual(run.status, 'queued')
  assertEqual(run.revision, 1)

  run = taskRun.reduceTaskRunEvent(
    run,
    { kind: 'user-message', messageId: 'message-a', text: '执行任务' },
    1100
  )
  assertEqual(run.status, 'planning')
  assertEqual(run.messageId, 'message-a')

  run = taskRun.reduceTaskRunEvent(run, { kind: 'status', status: 'running' }, 1200)
  assertEqual(run.status, 'executing')
  assertEqual(run.startedAt, 1100)

  run = taskRun.reduceTaskRunEvent(
    run,
    {
      kind: 'permission-request',
      request: { requestId: 'permission-a', toolName: 'Bash', input: {}, createdAt: 1300 }
    },
    1300
  )
  assertEqual(run.status, 'waiting_approval')
  assertEqual(run.pendingPermissionRequestId, 'permission-a')

  run = taskRun.reduceTaskRunEvent(
    run,
    { kind: 'permission-resolved', requestId: 'permission-a', behavior: 'allow' },
    1400
  )
  assertEqual(run.status, 'executing')
  assertEqual(run.pendingPermissionRequestId, undefined)

  run = taskRun.reduceTaskRunEvent(
    run,
    { kind: 'turn-result', subtype: 'success', isError: false, resultText: 'done' },
    1500
  )
  assertEqual(run.status, 'completed')
  assertEqual(run.finishedAt, 1500)
  assert(taskRun.isTaskRunTerminal(run.status), 'completed run should be terminal')
  assertThrows(() => taskRun.transitionTaskRun(run, 'executing'), 'terminal run must not restart')

  let failed = taskRun.createTaskRun({ id: 'run-b', sessionId: 'session-b', taskId: 'task-b', now: 2000 })
  failed = taskRun.reduceTaskRunEvent(failed, { kind: 'status', status: 'error', error: 'network failed' }, 2100)
  assertEqual(failed.status, 'failed')
  assertEqual(failed.error, 'network failed')
  failed = taskRun.transitionTaskRun(failed, 'recovering', { now: 2200 })
  assertEqual(failed.status, 'recovering')
  assertEqual(failed.attempt, 2)
  assertEqual(failed.recoveryCount, 1)
  assertEqual(failed.finishedAt, undefined)

  let unresolvedError = taskRun.transitionTaskRun(
    taskRun.createTaskRun({ id: 'run-unresolved-error', sessionId: 'session-unresolved-error', taskId: 'task-unresolved-error', now: 2201 }),
    'executing',
    { now: 2202 }
  )
  unresolvedError = {
    ...unresolvedError,
    effects: [{ status: 'executing' }]
  }
  unresolvedError = taskRun.reduceTaskRunEvent(
    unresolvedError,
    { kind: 'status', status: 'error', error: 'stream crashed after external execution started' },
    2203
  )
  assertEqual(unresolvedError.status, 'waiting_reconciliation')
  assertEqual(unresolvedError.finishedAt, undefined)

  let approvalRecovery = taskRun.createTaskRun({ id: 'run-d', sessionId: 'session-d', taskId: 'task-d', now: 2300 })
  approvalRecovery = taskRun.reduceTaskRunEvent(
    taskRun.transitionTaskRun(approvalRecovery, 'executing', { now: 2350 }),
    {
      kind: 'permission-request',
      request: { requestId: 'stale-permission', toolName: 'Write', input: {}, createdAt: 2400 }
    },
    2400
  )
  approvalRecovery = taskRun.transitionTaskRun(approvalRecovery, 'recovering', { now: 2500 })
  assertEqual(approvalRecovery.pendingPermissionRequestId, undefined)
  assertEqual(approvalRecovery.status, 'recovering')

  let cancelled = taskRun.createTaskRun({ id: 'run-c', sessionId: 'session-c', taskId: 'task-c', now: 3000 })
  cancelled = taskRun.reduceTaskRunEvent(
    cancelled,
    { kind: 'turn-result', subtype: 'interrupted', isError: true, resultText: 'stopped' },
    3100
  )
  assertEqual(cancelled.status, 'cancelled')
  assert(taskRun.isTaskRunRecord(cancelled), 'valid TaskRun should pass runtime validation')
  assert(!taskRun.isTaskRunRecord({ ...cancelled, revision: 'bad' }), 'invalid TaskRun must be rejected')

  const operationSources = [
    ['renderer', 'file_write'],
    ['dag', 'worktree_patch_apply'],
    ['session_lifecycle', 'managed_worktree_create']
  ]
  for (const [source, kind] of operationSources) {
    const operationRun = taskRun.createTaskRun({
      id: `operation-${source}`,
      sessionId: `operation-${source}`,
      taskId: `operation-${source}`,
      operation: {
        schemaVersion: 1,
        operationId: `operation-${source}`,
        source,
        kind,
        sourceSessionId: `source-${source}`,
        title: `${source} operation`
      }
    })
    assert(taskRun.isTaskRunRecord(operationRun), `${source} operation metadata must survive validation`)
    assert(
      !taskRun.isTaskRunRecord({
        ...operationRun,
        operation: { ...operationRun.operation, source: 'unknown-source' }
      }),
      'unknown operation source must fail runtime validation'
    )
  }

  let cursorRun = taskRun.createTaskRun({
    id: 'run-cursor',
    sessionId: 'session-cursor',
    taskId: 'task-cursor',
    now: 3200
  })
  const cursorEvent = { kind: 'user-message', messageId: 'cursor-message', text: '只应用一次' }
  const cursorIdentity = identity(1, 'event-cursor-user', 3210)
  cursorRun = applyLedgerEvent(taskRun, taskExecution, cursorRun, cursorEvent, tempRoot, 3210, cursorIdentity)
  const cursorRevision = cursorRun.revision
  const cursorStepCount = cursorRun.steps.length
  const duplicateCursorRun = applyLedgerEvent(
    taskRun,
    taskExecution,
    cursorRun,
    cursorEvent,
    tempRoot,
    3220,
    cursorIdentity
  )
  assertEqual(duplicateCursorRun.revision, cursorRevision)
  assertEqual(duplicateCursorRun.steps.length, cursorStepCount)
  const staleDifferentEvent = identity(1, 'event-cursor-stale-different-id', 3230)
  assert(taskRun.hasTaskRunAppliedEvent(cursorRun, staleDifferentEvent), 'older cursor must be rejected even with another id')
  assertEqual(cursorRun.lastAppliedEventId, cursorIdentity.eventId)
  assertEqual(cursorRun.lastAppliedEventSeq, cursorIdentity.seq)

  const keyA = toolIdempotency.buildToolIdempotencyKey({
    scopeId: 'session-tools',
    cwd: tempRoot,
    toolName: 'Bash',
    toolInput: { command: 'npm test', env: { B: '2', A: '1' } }
  })
  const keyB = toolIdempotency.buildToolIdempotencyKey({
    scopeId: 'session-tools',
    cwd: tempRoot,
    toolName: 'bash',
    toolInput: { env: { A: '1', B: '2' }, command: 'npm test' }
  })
  assertEqual(keyA, keyB)
  assert(
    keyA !== toolIdempotency.buildToolIdempotencyKey({
      scopeId: 'session-tools-other',
      cwd: tempRoot,
      toolName: 'bash',
      toolInput: { env: { A: '1', B: '2' }, command: 'npm test' }
    }),
    'idempotency keys must not cross sessions'
  )
  assert(
    keyA !== toolIdempotency.buildToolIdempotencyKey({
      scopeId: 'session-tools',
      cwd: path.join(tempRoot, 'other-project'),
      toolName: 'bash',
      toolInput: { env: { A: '1', B: '2' }, command: 'npm test' }
    }),
    'idempotency keys must not cross project paths'
  )
  assertEqual(
    toolIdempotency.buildToolIdempotencyKey({
      scopeId: 'session-tools',
      cwd: tempRoot,
      toolName: 'Write',
      toolInput: { file_path: 'a.txt', content: 'same' }
    }),
    toolIdempotency.buildToolIdempotencyKey({
      scopeId: 'session-tools',
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: { path: 'a.txt', file_path: 'a.txt', content: 'same' }
    })
  )
  assertEqual(
    toolIdempotency.buildToolIdempotencyKey({
      scopeId: 'session-tools',
      cwd: tempRoot,
      toolName: 'read_file',
      toolInput: { path: 'README.md' }
    }),
    undefined
  )

  let executionRun = taskRun.createTaskRun({ id: 'run-tools', sessionId: 'session-tools', taskId: 'task-tools', now: 4000 })
  executionRun = taskExecution.reduceTaskExecutionEvent(
    executionRun,
    { kind: 'user-message', messageId: 'message-tools', text: '运行测试' },
    tempRoot,
    4010,
    identity(1, 'event-tools-user', 4010)
  )
  executionRun = taskExecution.reduceTaskExecutionEvent(
    executionRun,
    { kind: 'tool-start', toolUseId: 'tool-1', name: 'Bash' },
    tempRoot,
    4020,
    identity(2, 'event-tools-start', 4020)
  )
  executionRun = taskExecution.reduceTaskExecutionEvent(
    executionRun,
    {
      kind: 'assistant-message',
      blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }]
    },
    tempRoot,
    4030,
    identity(3, 'event-tools-requested', 4030)
  )
  executionRun = taskExecution.reduceTaskExecutionEvent(
    executionRun,
    {
      kind: 'permission-request',
      request: { requestId: 'permission-tools', toolName: 'bash', toolUseId: 'tool-1', input: { command: 'npm test' } }
    },
    tempRoot,
    4040,
    identity(4, 'event-tools-approval-requested', 4040)
  )
  assertEqual(executionRun.steps[0].status, 'waiting_approval')
  assertEqual(executionRun.toolExecutions[0].status, 'waiting_approval')
  assert(executionRun.toolExecutions[0].idempotencyKey?.startsWith('tool-v1:'), 'side-effecting tool needs idempotency key')
  assertEqual(executionRun.steps[0].createdEventId, 'event-tools-user')
  assertEqual(executionRun.toolExecutions[0].toolStartEventId, 'event-tools-start')
  assertEqual(executionRun.toolExecutions[0].requestedEventId, 'event-tools-requested')
  assertEqual(executionRun.toolExecutions[0].approvalRequestedEventId, 'event-tools-approval-requested')

  executionRun = taskExecution.reduceTaskExecutionEvent(
    executionRun,
    { kind: 'permission-resolved', requestId: 'permission-tools', behavior: 'allow' },
    tempRoot,
    4050,
    identity(5, 'event-tools-approval-resolved', 4050)
  )
  executionRun = taskExecution.reduceTaskExecutionEvent(
    executionRun,
    { kind: 'tool-result', toolUseId: 'tool-1', content: 'ok', isError: false },
    tempRoot,
    4060,
    identity(6, 'event-tools-result', 4060)
  )
  assertEqual(executionRun.toolExecutions[0].status, 'succeeded')
  assert(executionRun.toolExecutions[0].outputDigest, 'tool result should persist only a digest')
  assertEqual(executionRun.toolExecutions[0].approvalResolvedEventId, 'event-tools-approval-resolved')
  assertEqual(executionRun.toolExecutions[0].resultEventId, 'event-tools-result')

  let reconciliationRun = taskRun.createTaskRun({
    id: 'run-live-reconciliation',
    sessionId: 'session-live-reconciliation',
    taskId: 'task-live-reconciliation',
    now: 4061
  })
  reconciliationRun = taskExecution.reduceTaskExecutionEvent(
    reconciliationRun,
    {
      kind: 'assistant-message',
      blocks: [{ type: 'tool_use', id: 'tool-live-reconciliation', name: 'bash', input: { command: 'publish' } }]
    },
    tempRoot,
    4062
  )
  reconciliationRun = taskExecution.reduceTaskExecutionEvent(
    reconciliationRun,
    {
      kind: 'tool-result',
      toolUseId: 'tool-live-reconciliation',
      content: 'result unknown',
      isError: true,
      effectStatus: 'waiting_reconciliation'
    },
    tempRoot,
    4063
  )
  assertEqual(reconciliationRun.toolExecutions[0].status, 'unknown_outcome')
  assertEqual(reconciliationRun.toolExecutions[0].effectStatus, 'waiting_reconciliation')

  executionRun = taskExecution.reduceTaskExecutionEvent(
    executionRun,
    { kind: 'tool-start', toolUseId: 'tool-2', name: 'bash' },
    tempRoot,
    4070
  )
  executionRun = taskExecution.reduceTaskExecutionEvent(
    executionRun,
    {
      kind: 'assistant-message',
      blocks: [{ type: 'tool_use', id: 'tool-2', name: 'bash', input: { command: 'npm test' } }]
    },
    tempRoot,
    4080
  )
  assertEqual(executionRun.toolExecutions[1].duplicateOfExecutionId, executionRun.toolExecutions[0].id)

  const recoveredExecution = taskExecution.recoverTaskExecutionState(executionRun, 4090)
  assertEqual(recoveredExecution.steps[0].status, 'recovering')
  assertEqual(recoveredExecution.toolExecutions[1].status, 'unknown_outcome')
  const oldUnknown = { ...recoveredExecution.toolExecutions[1], id: 'unknown-old', toolUseId: 'unknown-old' }
  const confirmedRetry = {
    ...recoveredExecution.toolExecutions[1],
    id: 'confirmed-retry',
    toolUseId: 'confirmed-retry',
    status: 'approved',
    duplicateOfExecutionId: oldUnknown.id,
    updatedAt: 4100,
    finishedAt: undefined,
    error: undefined
  }
  const supersededRun = taskExecution.reduceTaskExecutionEvent(
    { ...recoveredExecution, toolExecutions: [oldUnknown, confirmedRetry] },
    { kind: 'tool-result', toolUseId: confirmedRetry.toolUseId, content: 'retry ok', isError: false },
    tempRoot,
    4110
  )
  assertEqual(supersededRun.toolExecutions[0].status, 'superseded')
  assertEqual(supersededRun.toolExecutions[0].supersededByExecutionId, confirmedRetry.id)
  assertEqual(supersededRun.toolExecutions[1].status, 'succeeded')

  let queuedSteps = taskRun.createTaskRun({ id: 'run-queue', sessionId: 'session-queue', taskId: 'task-queue', now: 5000 })
  queuedSteps = taskExecution.reduceTaskExecutionEvent(
    queuedSteps,
    { kind: 'user-message', messageId: 'queue-1', text: 'first' },
    tempRoot,
    5010
  )
  queuedSteps = taskExecution.reduceTaskExecutionEvent(
    queuedSteps,
    { kind: 'user-message', messageId: 'queue-2', text: 'second' },
    tempRoot,
    5020
  )
  queuedSteps = taskExecution.reduceTaskExecutionEvent(
    queuedSteps,
    { kind: 'turn-result', subtype: 'success', isError: false, resultText: 'first done' },
    tempRoot,
    5030
  )
  assertEqual(queuedSteps.steps[0].status, 'completed')
  assertEqual(queuedSteps.steps[1].status, 'executing')
  assert(taskExecution.hasPendingTaskSteps(queuedSteps), 'second queued step should keep the run recoverable')
  assert(taskRun.isTaskRunRecord(queuedSteps), 'TaskRun with valid steps should pass runtime validation')
  assert(
    !taskRun.isTaskRunRecord({ ...queuedSteps, steps: [{ ...queuedSteps.steps[0], sequence: 0 }] }),
    'TaskRun validator must reject malformed nested steps'
  )

  let parallelApprovals = taskRun.createTaskRun({
    id: 'run-parallel-approvals',
    sessionId: 'session-parallel-approvals',
    taskId: 'task-parallel-approvals',
    now: 5100
  })
  const applyParallelEvent = (event, now) => {
    parallelApprovals = taskExecution.reduceTaskExecutionEvent(parallelApprovals, event, tempRoot, now)
    parallelApprovals = taskRun.reduceTaskRunEvent(parallelApprovals, event, now)
  }
  applyParallelEvent(
    { kind: 'user-message', messageId: 'parallel-message', text: '执行两个需审批的工具' },
    5110
  )
  applyParallelEvent(
    {
      kind: 'permission-request',
      request: {
        requestId: 'parallel-permission-a',
        toolName: 'bash',
        toolUseId: 'parallel-tool-a',
        input: { command: 'echo a' }
      }
    },
    5120
  )
  applyParallelEvent(
    {
      kind: 'permission-request',
      request: {
        requestId: 'parallel-permission-b',
        toolName: 'bash',
        toolUseId: 'parallel-tool-b',
        input: { command: 'echo b' }
      }
    },
    5130
  )
  applyParallelEvent(
    { kind: 'permission-resolved', requestId: 'parallel-permission-a', behavior: 'allow' },
    5140
  )
  assertEqual(parallelApprovals.status, 'waiting_approval')
  assertEqual(parallelApprovals.pendingPermissionRequestId, 'parallel-permission-b')
  assertEqual(parallelApprovals.steps[0].status, 'waiting_approval')
  assertEqual(parallelApprovals.steps[0].pendingPermissionRequestId, 'parallel-permission-b')
  applyParallelEvent(
    { kind: 'permission-resolved', requestId: 'parallel-permission-b', behavior: 'allow' },
    5150
  )
  assertEqual(parallelApprovals.status, 'executing')
  assertEqual(parallelApprovals.steps[0].status, 'executing')

  const registry = runtimeRegistry.taskRuntimeRegistry
  registry.clear()
  const serializationRun = {
    ...taskRun.createTaskRun({
      id: 'run-effect-event-serialization',
      sessionId: 'session-effect-event-serialization',
      taskId: 'task-effect-event-serialization',
      now: 5900
    }),
    status: 'executing',
    revision: 4,
    updatedAt: 5940,
    lastAppliedEventId: 'event-4',
    lastAppliedEventSeq: 4,
    recentEventIds: ['event-4']
  }
  const serializationEffect = effectRecord(serializationRun, 'serialized-write', 5940)
  const serializationTool = {
    ...toolRecord(serializationRun, 'serialized-write', 'write_file', 'running', 'serialized-key', 5940),
    effectId: serializationEffect.id,
    effectKey: serializationEffect.effectKey,
    effectStatus: 'executing',
    lastEventId: 'event-4',
    lastEventSeq: 4
  }
  const eventBranch = {
    ...serializationRun,
    revision: 5,
    updatedAt: 5960,
    lastAppliedEventId: 'event-5',
    lastAppliedEventSeq: 5,
    recentEventIds: ['event-4', 'event-5'],
    toolExecutions: [{
      ...serializationTool,
      outputDigest: 'event-output-digest',
      resultEventId: 'event-5',
      lastEventId: 'event-5',
      lastEventSeq: 5,
      updatedAt: 5960
    }],
    effects: [serializationEffect]
  }
  const confirmedEffect = {
    ...serializationEffect,
    revision: serializationEffect.revision + 1,
    status: 'confirmed',
    lease: { ...serializationEffect.lease, releasedAt: 5950 },
    evidence: [
      ...serializationEffect.evidence,
      {
        id: 'serialized-confirmed-evidence',
        kind: 'execution_result',
        digest: 'serialized-confirmed-digest',
        observedAt: 5950,
        verifier: 'task-run-state-smoke',
        generation: 1
      }
    ],
    updatedAt: 5950,
    terminalAt: 5950
  }
  const effectBranch = {
    ...serializationRun,
    revision: 5,
    updatedAt: 5950,
    toolExecutions: [{
      ...serializationTool,
      status: 'succeeded',
      effectStatus: 'confirmed',
      updatedAt: 5950,
      finishedAt: 5950
    }],
    effects: [confirmedEffect]
  }
  registry.set(serializationRun.sessionId, eventBranch)
  registry.set(serializationRun.sessionId, effectBranch)
  const serialized = registry.get(serializationRun.sessionId)
  assertEqual(serialized.lastAppliedEventSeq, 5)
  assertEqual(serialized.effects[0].status, 'confirmed')
  assertEqual(serialized.toolExecutions[0].status, 'succeeded')
  assertEqual(serialized.toolExecutions[0].effectStatus, 'confirmed')
  assertEqual(serialized.toolExecutions[0].outputDigest, 'event-output-digest')
  registry.clear()

  const completedEventBranch = {
    ...eventBranch,
    status: 'completed',
    revision: 6,
    updatedAt: 5970,
    lastAppliedEventId: 'event-6',
    lastAppliedEventSeq: 6,
    recentEventIds: ['event-4', 'event-5', 'event-6'],
    finishedAt: 5970,
    effects: []
  }
  const unresolvedEffectBranch = {
    ...serializationRun,
    revision: 5,
    updatedAt: 5950,
    toolExecutions: [serializationTool],
    effects: [serializationEffect]
  }
  for (const merged of [
    taskRun.mergeTaskRunRecords(completedEventBranch, unresolvedEffectBranch),
    taskRun.mergeTaskRunRecords(unresolvedEffectBranch, completedEventBranch)
  ]) {
    assertEqual(merged.status, 'waiting_reconciliation')
    assertEqual(merged.finishedAt, undefined)
    assertEqual(merged.effects[0].status, 'executing')
  }

  const policyRun = taskRun.createTaskRun({ id: 'run-policy', sessionId: 'session-policy', taskId: 'task-policy', now: 6000 })
  const writeInput = { path: 'result.txt', content: 'done' }
  const writeKey = toolIdempotency.buildToolIdempotencyKey({
    scopeId: policyRun.sessionId,
    cwd: tempRoot,
    toolName: 'write_file',
    toolInput: writeInput
  })
  registry.set(policyRun.sessionId, {
    ...policyRun,
    toolExecutions: [toolRecord(policyRun, 'old-write', 'write_file', 'unknown_outcome', writeKey, 6010)]
  })
  const isolatedPolicyRun = taskRun.createTaskRun({
    id: 'run-policy-isolated',
    sessionId: 'session-policy-isolated',
    taskId: 'task-policy-isolated',
    now: 6011
  })
  registry.set(isolatedPolicyRun.sessionId, isolatedPolicyRun)
  assertEqual(
    registry.evaluateTool({
      sessionId: isolatedPolicyRun.sessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: writeInput,
      toolUseId: 'isolated-write'
    }).kind,
    'neutral'
  )
  assertEqual(
    registry.evaluateTool({
      sessionId: policyRun.sessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: writeInput,
      toolUseId: 'retry-write'
    }).kind,
    'ask'
  )
  const nextPolicyRun = taskRun.createTaskRun({
    id: 'run-policy-next',
    sessionId: policyRun.sessionId,
    taskId: 'task-policy-next',
    now: 6015
  })
  registry.set(policyRun.sessionId, nextPolicyRun)
  const crossRunDecision = registry.evaluateTool({
    sessionId: policyRun.sessionId,
    cwd: tempRoot,
    toolName: 'write_file',
    toolInput: writeInput,
    toolUseId: 'cross-run-retry-write'
  })
  assertEqual(crossRunDecision.kind, 'ask')
  let confirmedCrossRun = taskExecution.reduceTaskExecutionEvent(
    nextPolicyRun,
    { kind: 'user-message', messageId: 'cross-run-message', text: '确认后重试写入' },
    tempRoot,
    6016
  )
  confirmedCrossRun = taskExecution.reduceTaskExecutionEvent(
    confirmedCrossRun,
    {
      kind: 'permission-request',
      request: {
        requestId: 'cross-run-permission',
        toolName: 'write_file',
        toolUseId: 'cross-run-retry-write',
        input: writeInput,
        duplicateExecutionId: crossRunDecision.duplicateExecutionId
      }
    },
    tempRoot,
    6017
  )
  confirmedCrossRun = taskExecution.reduceTaskExecutionEvent(
    confirmedCrossRun,
    { kind: 'permission-resolved', requestId: 'cross-run-permission', behavior: 'allow' },
    tempRoot,
    6018
  )
  confirmedCrossRun = taskExecution.reduceTaskExecutionEvent(
    confirmedCrossRun,
    { kind: 'tool-result', toolUseId: 'cross-run-retry-write', content: 'retry ok', isError: false },
    tempRoot,
    6019
  )
  const crossRunRetry = confirmedCrossRun.toolExecutions[0]
  assertEqual(crossRunRetry.duplicateOfExecutionId, crossRunDecision.duplicateExecutionId)
  assert(
    registry.supersedeArchivedExecution(
      policyRun.sessionId,
      crossRunDecision.duplicateExecutionId,
      crossRunRetry.id,
      6019
    ),
    'cross-run success should supersede the archived unknown execution'
  )
  registry.set(policyRun.sessionId, confirmedCrossRun)
  assertEqual(
    registry.evaluateTool({
      sessionId: policyRun.sessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: writeInput,
      toolUseId: 'post-success-write'
    }).kind,
    'neutral'
  )
  registry.clear()
  registry.hydrateHistory([
    {
      ...policyRun,
      id: 'history-unknown-run',
      toolExecutions: [toolRecord({ ...policyRun, id: 'history-unknown-run' }, 'history-unknown', 'write_file', 'unknown_outcome', writeKey, 10)]
    },
    {
      ...policyRun,
      id: 'history-success-run',
      toolExecutions: [toolRecord({ ...policyRun, id: 'history-success-run' }, 'history-success', 'write_file', 'succeeded', writeKey, 20)]
    }
  ])
  registry.set(policyRun.sessionId, nextPolicyRun)
  assertEqual(
    registry.evaluateTool({
      sessionId: policyRun.sessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: writeInput,
      toolUseId: 'post-restart-safe-write'
    }).kind,
    'neutral'
  )

  registry.clear()
  registry.set(policyRun.sessionId, {
    ...policyRun,
    toolExecutions: [toolRecord(policyRun, 'done-write', 'write_file', 'succeeded', writeKey, 6020)]
  })
  assertEqual(
    registry.evaluateTool({
      sessionId: policyRun.sessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: writeInput,
      toolUseId: 'repeat-safe-write'
    }).kind,
    'neutral'
  )

  const pushInput = { branch: 'main' }
  const pushKey = toolIdempotency.buildToolIdempotencyKey({
    scopeId: policyRun.sessionId,
    cwd: tempRoot,
    toolName: 'git_push',
    toolInput: pushInput
  })
  registry.set(policyRun.sessionId, {
    ...policyRun,
    toolExecutions: [toolRecord(policyRun, 'done-push', 'git_push', 'succeeded', pushKey, 6030)]
  })
  assertEqual(
    registry.evaluateTool({
      sessionId: policyRun.sessionId,
      cwd: tempRoot,
      toolName: 'git_push',
      toolInput: pushInput,
      toolUseId: 'repeat-push'
    }).kind,
    'ask'
  )

  const bashInput = { command: 'npm test' }
  const bashKey = toolIdempotency.buildToolIdempotencyKey({
    scopeId: policyRun.sessionId,
    cwd: tempRoot,
    toolName: 'bash',
    toolInput: bashInput
  })
  registry.set(policyRun.sessionId, {
    ...policyRun,
    toolExecutions: [toolRecord(policyRun, 'active-bash', 'bash', 'requested', bashKey, 6040)]
  })
  assertEqual(
    registry.evaluateTool({
      sessionId: policyRun.sessionId,
      cwd: tempRoot,
      toolName: 'bash',
      toolInput: bashInput,
      toolUseId: 'other-bash'
    }).kind,
    'deny'
  )
  assertEqual(
    registry.evaluateTool({
      sessionId: policyRun.sessionId,
      cwd: tempRoot,
      toolName: 'bash',
      toolInput: bashInput,
      toolUseId: 'active-bash'
    }).kind,
    'neutral'
  )

  registry.clear()
  const retainedSessionId = 'session-retained-history'
  const retainedRuns = Array.from({ length: 100 }, (_, index) => {
    const historyRun = taskRun.createTaskRun({
      id: `retained-run-${index}`,
      sessionId: retainedSessionId,
      taskId: `retained-task-${index}`,
      now: 7000 + index
    })
    const input = { path: `retained-${index}.txt`, content: String(index) }
    const key = toolIdempotency.buildToolIdempotencyKey({
      scopeId: retainedSessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: input
    })
    return {
      ...historyRun,
      toolExecutions: [toolRecord(historyRun, `retained-tool-${index}`, 'write_file', 'unknown_outcome', key, 7000 + index)]
    }
  })
  registry.hydrateHistory(retainedRuns)
  registry.set(retainedSessionId, retainedRuns[99])
  registry.set(
    retainedSessionId,
    taskRun.createTaskRun({ id: 'retained-current', sessionId: retainedSessionId, taskId: 'retained-current', now: 7200 })
  )
  assertEqual(
    registry.evaluateTool({
      sessionId: retainedSessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: { path: 'retained-0.txt', content: '0' },
      toolUseId: 'retained-retry-0'
    }).kind,
    'ask'
  )

  registry.clear()
  const boundedSessionId = 'session-bounded-history'
  const boundedRuns = Array.from({ length: 101 }, (_, index) => {
    const historyRun = taskRun.createTaskRun({
      id: `bounded-run-${index}`,
      sessionId: boundedSessionId,
      taskId: `bounded-task-${index}`,
      now: 8000 + index
    })
    const input = { path: `bounded-${index}.txt`, content: String(index) }
    const key = toolIdempotency.buildToolIdempotencyKey({
      scopeId: boundedSessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: input
    })
    return {
      ...historyRun,
      toolExecutions: [toolRecord(historyRun, `bounded-tool-${index}`, 'write_file', 'unknown_outcome', key, 8000 + index)]
    }
  })
  registry.hydrateHistory(boundedRuns)
  registry.set(
    boundedSessionId,
    taskRun.createTaskRun({ id: 'bounded-current', sessionId: boundedSessionId, taskId: 'bounded-current', now: 8200 })
  )
  assertEqual(
    registry.evaluateTool({
      sessionId: boundedSessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: { path: 'bounded-0.txt', content: '0' },
      toolUseId: 'bounded-retry-0'
    }).kind,
    'neutral'
  )
  assertEqual(
    registry.evaluateTool({
      sessionId: boundedSessionId,
      cwd: tempRoot,
      toolName: 'write_file',
      toolInput: { path: 'bounded-100.txt', content: '100' },
      toolUseId: 'bounded-retry-100'
    }).kind,
    'ask'
  )
  registry.clear()

  console.log('taskRun state smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function identity(seq, eventId, occurredAt) {
  return {
    schemaVersion: 1,
    streamId: 'stream-task-run-smoke',
    eventId,
    seq,
    occurredAt
  }
}

function applyLedgerEvent(taskRun, taskExecution, run, event, cwd, now, eventIdentity) {
  if (taskRun.hasTaskRunAppliedEvent(run, eventIdentity)) return run
  let next = taskExecution.reduceTaskExecutionEvent(run, event, cwd, now, eventIdentity)
  next = taskRun.reduceTaskRunEvent(next, event, now)
  return taskRun.recordTaskRunEvent(next, eventIdentity, next === run)
}

function findCompiledModule(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return undefined
}

function assertThrows(fn, message) {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  assert(threw, message)
}

function toolRecord(run, toolUseId, toolName, status, idempotencyKey, now) {
  return {
    id: `${run.id}:tool:${toolUseId}`,
    runId: run.id,
    sessionId: run.sessionId,
    toolUseId,
    toolName,
    status,
    idempotencyKey,
    createdAt: now,
    updatedAt: now
  }
}

function effectRecord(run, toolUseId, now) {
  return {
    schemaVersion: 1,
    id: `${run.id}:effect:${toolUseId}`,
    effectKey: `effect-v1:${toolUseId}`,
    resourceKey: `resource-v1:${toolUseId}`,
    sessionId: run.sessionId,
    runId: run.id,
    toolUseId,
    toolName: 'write_file',
    generation: 1,
    revision: 2,
    status: 'executing',
    reconcilability: 'queryable',
    target: {
      kind: 'file_content',
      rootPath: tempRoot,
      relativePath: 'serialized.txt',
      preState: 'absent',
      expectedSha256: 'serialized-sha',
      expectedBytes: 10
    },
    targetDigest: 'serialized-target-digest',
    intentDigest: 'serialized-intent-digest',
    inputDigest: 'serialized-input-digest',
    lease: {
      id: 'serialized-lease',
      ownerId: 'serialized-owner',
      fencingToken: 1,
      acquiredAt: now - 10,
      expiresAt: now + 60_000
    },
    evidence: [{
      id: 'serialized-executing-evidence',
      kind: 'executing',
      digest: 'serialized-executing-digest',
      observedAt: now,
      verifier: 'task-run-state-smoke',
      generation: 1
    }],
    createdAt: now - 10,
    updatedAt: now
  }
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
