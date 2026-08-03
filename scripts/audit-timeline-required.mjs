#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runStamp = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'audit-timeline-required')
const reportDir = path.join(reportRoot, runStamp)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-audit-timeline-'))
const outDir = path.join(tempRoot, 'compiled')
const checks = []
let failure

try {
  compile()
  const audit = await import(pathToFileURL(path.join(outDir, 'main', 'studio-result', 'studio-audit-timeline.js')).href)
  const aggregate = fixtureAggregate()
  const session = fixtureSession()
  const attempts = fixtureAttempts()
  const costs = [
    { id: 'session-primary', costUsd: 0.42 },
    { id: 'session-secondary', costUsd: 0.03 },
    { id: 'session-sibling', costUsd: 99 }
  ]

  const complete = check('canonical actor, routing, tool, Effect, Evidence, Approval and Acceptance projection', () =>
    audit.buildStudioAuditTimelinePage({ session, aggregate, attempts, sessionCosts: costs, query: { limit: 100 } }))
  const categories = new Set(complete.items.map((item) => item.category))
  for (const category of ['run', 'model_attempt', 'tool', 'effect', 'evidence', 'approval', 'acceptance', 'integrity']) {
    assert(categories.has(category), `missing ${category} audit category`)
  }
  const routed = complete.items.find((item) => item.entityId === 'attempt-primary')
  assert(routed, 'primary ModelAttempt row missing')
  assert.deepEqual({
    actor: routed.actor.label,
    role: routed.actor.role,
    providerId: routed.providerId,
    model: routed.model,
    protocol: routed.protocol,
    keyLabel: routed.keyLabel,
    reason: routed.reason,
    costUsd: routed.costUsd
  }, {
    actor: 'Release reviewer',
    role: 'role-reviewer',
    providerId: 'provider-primary',
    model: 'model-primary',
    protocol: 'responses',
    keyLabel: 'label:primary',
    reason: 'fixed Provider profile selected for acceptance review',
    costUsd: 0.0123
  })
  assert(complete.items.some((item) => item.category === 'run' && item.runId === 'run-primary' && item.costUsd === 0.42), 'Run cost missing')
  assert(complete.items.some((item) => item.category === 'tool' && item.toolName === 'write_file'), 'Tool result missing')
  assert(complete.items.some((item) => item.category === 'effect' && item.targetKind === 'unsupported'), 'Effect target kind missing')
  assert(complete.items.some((item) => item.category === 'approval' && item.evidenceId === 'approval-primary'), 'Approval Evidence missing')
  assert(complete.items.some((item) => item.category === 'acceptance' && item.acceptanceId === 'acceptance-primary'), 'Acceptance missing')

  check('WorkItem scope excludes sibling and broader Goal or Project audit material', () => {
    const rendered = JSON.stringify(complete)
    for (const forbidden of ['work-sibling', 'run-sibling', 'attempt-sibling', 'SIBLING_DOMAIN_CANARY', 'SIBLING_EVIDENCE_CANARY']) {
      assert(!rendered.includes(forbidden), `scope leaked ${forbidden}`)
    }
  })

  check('Run filter excludes other Run rows while retaining only scope-level rows without a Run', () => {
    const filtered = audit.buildStudioAuditTimelinePage({
      session,
      aggregate,
      attempts,
      sessionCosts: costs,
      query: { runId: 'run-secondary', limit: 100 }
    })
    assert(filtered.items.some((item) => item.runId === 'run-secondary'), 'selected Run is absent')
    assert(filtered.items.every((item) => !item.runId || item.runId === 'run-secondary'), 'Run filter leaked another Run')
    assert(!JSON.stringify(filtered).includes('attempt-primary'), 'Run filter leaked primary attempt')
    assert.throws(() => audit.buildStudioAuditTimelinePage({
      session,
      aggregate,
      attempts,
      query: { runId: 'run-sibling' }
    }), /outside the Session scope/)
  })

  check('opaque pagination is complete and has no duplicate rows', () => {
    const ids = []
    let cursor
    let total
    do {
      const page = audit.buildStudioAuditTimelinePage({
        session,
        aggregate,
        attempts,
        sessionCosts: costs,
        query: { limit: 3, ...(cursor ? { cursor } : {}) }
      })
      total ??= page.total
      ids.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(ids.length, total)
    assert.equal(new Set(ids).size, ids.length)
  })

  check('stale cursor fails closed after source changes', () => {
    const first = audit.buildStudioAuditTimelinePage({ session, aggregate, attempts, query: { limit: 2 } })
    assert(first.nextCursor, 'fixture did not produce a pagination cursor')
    const changed = structuredClone(aggregate)
    changed.aggregateDigest = hex('9')
    assert.throws(() => audit.buildStudioAuditTimelinePage({
      session,
      aggregate: changed,
      attempts,
      query: { limit: 2, cursor: first.nextCursor }
    }), /stale or invalid/)
  })

  check('missing Acceptance Evidence and Tool Effect references become integrity rows', () => {
    const missing = complete.items.filter((item) => item.integrity === 'missing_reference')
    assert.equal(complete.integrity.missingReferences, 2)
    assert(missing.some((item) => item.entityType === 'acceptance_evidence' && item.entityId === 'evidence-missing'))
    assert(missing.some((item) => item.entityType === 'tool_effect' && item.entityId === 'effect-missing'))
  })

  check('raw target and credential canaries never enter a Renderer page', () => {
    const rendered = JSON.stringify(complete)
    for (const forbidden of ['TARGET_SECRET_CANARY', 'TOOL_INPUT_CANARY', 'TOOL_OUTPUT_CANARY']) {
      assert(!rendered.includes(forbidden), `Renderer page leaked ${forbidden}`)
    }
    const unsafeAttempts = fixtureAttempts()
    unsafeAttempts[0].routeReason = 'Bearer synthetic-audit-credential-canary'
    const error = captureError(() => audit.buildStudioAuditTimelinePage({ session, aggregate, attempts: unsafeAttempts }))
    assert.match(error.message, /credential material/)
    assert(!error.message.includes('synthetic-audit-credential-canary'), 'credential error echoed the canary')
  })

  check('typed unbound and integrity-error pages expose no raw failure text', () => {
    const unbound = audit.buildUnboundStudioAuditTimeline({ ...session, workspaceId: undefined, goalId: undefined, workItemId: undefined })
    assert.equal(unbound.state, 'unbound')
    assert.equal(unbound.items.length, 0)
    const failed = audit.buildFailedStudioAuditTimeline(session, 'MODEL_ATTEMPT_INTEGRITY')
    assert.equal(failed.state, 'integrity_error')
    assert.equal(failed.errorCode, 'MODEL_ATTEMPT_INTEGRITY')
    assert.equal('error' in failed, false)
  })

  check('production IPC, preload, API and Timeline UI wiring is present', verifyProductionWiring)
} catch (error) {
  failure = serializeError(error)
  process.exitCode = 1
} finally {
  const report = {
    schemaVersion: 1,
    gate: 'test:audit-timeline:required',
    status: failure ? 'failed' : 'passed',
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    acceptance: {
      NFR_AUD_001: 'partial: canonical Project-scoped audit timeline foundation covered',
      NFR_AUD_002: 'partial: actor, routing, tool, Effect, Evidence, Approval, Acceptance and integrity projection covered'
    },
    error: failure
  }
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
  if (failure) console.error(`audit timeline required: FAIL: ${failure.message}`)
  else {
    console.log(`audit timeline required: PASS (${checks.length} checks)`)
    console.log(`report: ${reportPath}`)
  }
}

function check(name, run) {
  try {
    const value = run()
    checks.push({ name, status: 'passed' })
    return value
  } catch (error) {
    checks.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

function fixtureSession() {
  return {
    id: 'session-primary', title: 'Primary', cwd: '/fixture', workspaceId: 'project-1', goalId: 'goal-1', workItemId: 'work-primary',
    model: 'model-primary', providerId: 'provider-primary', taskStrategy: 'execute', permissionMode: 'default', status: 'idle',
    costUsd: 0.42, usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, contextTokens: 2, createdAt: 1
  }
}

function fixtureAggregate() {
  const primaryEffect = {
    schemaVersion: 1,
    id: 'effect-primary',
    effectKey: 'effect-key-primary',
    resourceKey: 'resource-primary',
    sessionId: 'session-primary',
    runId: 'run-primary',
    toolExecutionId: 'tool-primary',
    toolUseId: 'tool-use-primary',
    toolName: 'write_file',
    generation: 1,
    revision: 2,
    status: 'confirmed',
    reconcilability: 'queryable',
    target: { kind: 'unsupported', toolName: 'write_file', rawSecret: 'TARGET_SECRET_CANARY' },
    targetDigest: hex('5'),
    intentDigest: hex('6'),
    inputDigest: 'TOOL_INPUT_CANARY',
    evidence: [{ id: 'effect-evidence-primary', kind: 'execution_result', digest: hex('7'), observedAt: 65, verifier: 'effect-verifier', generation: 1 }],
    createdAt: 50,
    updatedAt: 65,
    terminalAt: 65
  }
  const taskRun = (id, sessionId, binding, toolExecutions = [], effects = []) => ({
    schemaVersion: 1,
    id,
    sessionId,
    taskId: `task-${id}`,
    digitalWorkerBinding: binding,
    status: 'completed',
    revision: 2,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 10,
    updatedAt: 70,
    startedAt: 20,
    finishedAt: 70,
    steps: [],
    toolExecutions,
    effects
  })
  const workflowRun = (id, sessionId, workItemId, taskRunValue) => ({
    schemaVersion: 1,
    id,
    projectId: 'project-1',
    goalId: 'goal-1',
    workItemId,
    sessionId,
    taskId: `task-${id}`,
    status: 'completed',
    revision: 2,
    attempt: 1,
    createdAt: 10,
    updatedAt: 70,
    startedAt: 20,
    finishedAt: 70,
    taskRun: taskRunValue
  })
  const primaryTools = [
    {
      id: 'tool-primary', runId: 'run-primary', sessionId: 'session-primary', toolUseId: 'tool-use-primary', toolName: 'write_file',
      status: 'succeeded', permissionDecision: 'allow', inputDigest: 'TOOL_INPUT_CANARY', outputDigest: hex('8'), effectId: 'effect-primary',
      createdAt: 40, updatedAt: 65, finishedAt: 65, error: 'TOOL_OUTPUT_CANARY'
    },
    {
      id: 'tool-missing-effect', runId: 'run-primary', sessionId: 'session-primary', toolUseId: 'tool-use-missing', toolName: 'git_push',
      status: 'succeeded', effectId: 'effect-missing', createdAt: 42, updatedAt: 66, finishedAt: 66
    }
  ]
  const runPrimary = workflowRun('run-primary', 'session-primary', 'work-primary', taskRun(
    'run-primary',
    'session-primary',
    { kind: 'assigned', workerId: 'worker-reviewer', assignmentId: 'assignment-reviewer' },
    primaryTools,
    [primaryEffect]
  ))
  const runSecondary = workflowRun('run-secondary', 'session-secondary', 'work-primary', taskRun(
    'run-secondary', 'session-secondary', { kind: 'unscoped' }
  ))
  const runSibling = workflowRun('run-sibling', 'session-sibling', 'work-sibling', taskRun(
    'run-sibling', 'session-sibling', { kind: 'unscoped' }
  ))
  const workItem = (id, runRefs, artifactRefs) => ({
    schemaVersion: 1, id, projectId: 'project-1', goalId: 'goal-1', type: 'testing', title: id,
    dependencyIds: [], priority: 1, status: id === 'work-primary' ? 'done' : 'ready', acceptanceSpec: [], artifactRefs, runRefs,
    createdAt: 1, updatedAt: 80, revision: 2
  })
  const artifact = (id, workItemId, runId) => ({
    schemaVersion: 1, id, projectId: 'project-1', goalId: 'goal-1', workItemId, runId, kind: 'test_report', title: id,
    version: 1, digest: `sha256:${hex(id === 'artifact-primary' ? 'a' : 'b')}`, provenance: 'explicit', createdAt: 60, updatedAt: 70
  })
  return {
    schemaVersion: 1,
    format: 'caogen.project-aggregate.v1',
    projectId: 'project-1',
    identityDigest: hex('1'),
    projectRevision: 5,
    workspace: { schemaVersion: 1, id: 'project-1', name: 'Audit project', kind: 'software', status: 'active', resources: [], createdAt: 1, updatedAt: 80, revision: 5 },
    resources: [],
    goals: [{
      schemaVersion: 1, id: 'goal-1', projectId: 'project-1', title: 'Audit every Agent action', objective: 'Produce a canonical audit timeline',
      constraints: [], successCriteria: ['Every action is attributable'], riskLevel: 'medium', forbiddenActions: [], acceptance: [],
      contract: { objective: 'Produce a canonical audit timeline', constraints: [], successCriteria: ['Every action is attributable'], forbiddenActions: [], acceptance: [], riskLevel: 'medium' },
      status: 'verifying', createdAt: 1, updatedAt: 80, revision: 2
    }],
    workItems: [
      workItem('work-primary', ['run-primary', 'run-secondary'], ['artifact-primary']),
      workItem('work-sibling', ['run-sibling'], ['artifact-sibling'])
    ],
    squads: [], comments: [],
    digitalWorkers: [{
      schemaVersion: 1, id: 'worker-reviewer', projectId: 'project-1', roleTemplateId: 'role-reviewer', roleTemplateVersion: 1,
      displayName: 'Release reviewer', avatarProfile: {}, status: 'active', responsibilityScope: ['work-primary'], capabilityOverrides: {},
      toolPolicy: {}, dataScope: {}, memoryNamespace: 'worker-reviewer', budgetPolicy: {}, concurrencyLimit: 1, acceptancePolicy: {},
      schedulePolicy: {}, escalationPolicy: {}, performanceProfile: {}, createdAt: 1, updatedAt: 80, revision: 1
    }],
    assignments: [{
      schemaVersion: 1, id: 'assignment-reviewer', projectId: 'project-1', workItemId: 'work-primary', assigneeKind: 'digital_worker',
      assigneeId: 'worker-reviewer', scope: {}, assignedBy: 'local-user', assignedAt: 5, reason: 'Review release evidence', status: 'active', revision: 1
    }],
    leases: [],
    workflow: {
      runs: [runPrimary, runSecondary, runSibling],
      artifacts: [artifact('artifact-primary', 'work-primary', 'run-primary'), artifact('artifact-sibling', 'work-sibling', 'run-sibling')],
      artifactEdges: [], artifactLocations: [],
      acceptances: [
        { schemaVersion: 1, id: 'acceptance-primary', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-primary', criteria: ['Audit complete'], status: 'pending', evidenceRefs: ['evidence-primary', 'evidence-missing'], criterionEvidence: [], verifier: 'release-owner', revision: 2, createdAt: 60, updatedAt: 75 },
        { schemaVersion: 1, id: 'acceptance-sibling', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-sibling', criteria: ['Sibling'], status: 'pending', evidenceRefs: ['evidence-sibling'], criterionEvidence: [], revision: 1, createdAt: 60, updatedAt: 75 }
      ],
      evidenceLinks: [
        { schemaVersion: 1, id: 'link-primary', evidenceId: 'evidence-primary', evidenceOrigin: 'workflow', projectId: 'project-1', runId: 'run-primary', artifactId: 'artifact-primary', acceptanceId: 'acceptance-primary', relation: 'verifies', createdAt: 70 },
        { schemaVersion: 1, id: 'link-sibling', evidenceId: 'evidence-sibling', evidenceOrigin: 'workflow', projectId: 'project-1', runId: 'run-sibling', artifactId: 'artifact-sibling', acceptanceId: 'acceptance-sibling', relation: 'verifies', createdAt: 70 }
      ],
      taskEvidence: [],
      workflowEvidence: [
        { schemaVersion: 1, seq: 1, id: 'workflow-evidence-primary', evidenceId: 'evidence-primary', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-primary', runId: 'run-primary', artifactId: 'artifact-primary', kind: 'test_result', source: 'runtime', title: 'Primary test evidence', verifier: 'test-runner', observedAt: 70, contentDigest: hex('c'), createdAt: 70, prevDigest: hex('0'), digest: hex('d') },
        { schemaVersion: 1, seq: 2, id: 'workflow-approval-primary', evidenceId: 'approval-primary', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-primary', runId: 'run-primary', kind: 'approval', source: 'human', title: 'Approved by release owner', verifier: 'release-owner', observedAt: 72, contentDigest: hex('e'), createdAt: 72, prevDigest: hex('d'), digest: hex('f') },
        { schemaVersion: 1, seq: 3, id: 'workflow-evidence-sibling', evidenceId: 'evidence-sibling', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-sibling', runId: 'run-sibling', artifactId: 'artifact-sibling', kind: 'observation', source: 'runtime', title: 'SIBLING_EVIDENCE_CANARY', verifier: 'sibling', observedAt: 73, contentDigest: hex('2'), createdAt: 73, prevDigest: hex('f'), digest: hex('3') }
      ]
    },
    memory: [], budgets: [], policies: [],
    audit: [
      { id: 'audit-run-primary', projectId: 'project-1', source: 'workflow_ledger', occurredAt: 70, value: { kind: 'run.completed', entityType: 'run', entityId: 'run-primary', runId: 'run-primary' } },
      { id: 'audit-run-secondary', projectId: 'project-1', source: 'workflow_ledger', occurredAt: 71, value: { kind: 'run.completed', entityType: 'run', entityId: 'run-secondary', runId: 'run-secondary' } },
      { id: 'audit-sibling', projectId: 'project-1', source: 'workflow_ledger', occurredAt: 72, value: { kind: 'run.completed', entityType: 'run', entityId: 'run-sibling', runId: 'run-sibling', reason: 'SIBLING_DOMAIN_CANARY' } },
      { id: 'audit-goal-wide', projectId: 'project-1', source: 'project_workspace', occurredAt: 73, value: { kind: 'goal.updated', entityType: 'goal', entityId: 'goal-1', reason: 'SIBLING_DOMAIN_CANARY' } },
      { id: 'audit-project-wide', projectId: 'project-1', source: 'project_workspace', occurredAt: 74, value: { kind: 'project.updated', entityType: 'project', entityId: 'project-1', reason: 'SIBLING_DOMAIN_CANARY' } }
    ],
    objectCounts: {}, objectDigests: {}, aggregateDigest: hex('4'), sanitized: true
  }
}

function fixtureAttempts() {
  const attempt = (id, runId, workItemId, providerId, ordinal) => ({
    schemaVersion: 1, id, runId, requestId: `request-${id}`, ordinal, providerId, model: providerId === 'provider-sibling' ? 'model-sibling' : 'model-primary',
    protocol: 'responses', adapterVersion: '1', contextDigest: `sha256:${hex('a')}`, routeReason: 'fixed Provider profile selected for acceptance review',
    keyLabel: 'label:primary', status: 'succeeded', revision: 2, startedAt: 45 + ordinal, completedAt: 55 + ordinal, latencyMs: 10,
    usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0123, outcome: 'success', startCommandId: `start-${id}`,
    startPayloadDigest: `sha256:${hex('b')}`, completionCommandId: `complete-${id}`, completionPayloadDigest: `sha256:${hex('c')}`,
    recordDigest: hex(String((ordinal % 8) + 1)), projectId: 'project-1', goalId: 'goal-1', workItemId
  })
  return [
    attempt('attempt-primary', 'run-primary', 'work-primary', 'provider-primary', 1),
    attempt('attempt-secondary', 'run-secondary', 'work-primary', 'provider-primary', 2),
    attempt('attempt-sibling', 'run-sibling', 'work-sibling', 'provider-sibling', 3)
  ]
}

function verifyProductionWiring() {
  const types = source('src/shared/studio-result-types.ts')
  const ipc = source('src/main/ipc/studio-result-handlers.ts')
  const appFeatures = source('src/main/ipc/app-feature-handlers.ts')
  const preload = source('src/preload/studio-result.ts')
  const panel = source('src/renderer/src/components/workbench/StudioResultPanel.tsx')
  const packageJson = JSON.parse(source('package.json'))
  assert.match(types, /caogen\.studio-audit-timeline\.v1/)
  assert.match(types, /queryStudioAuditTimeline/)
  assert.match(ipc, /verifyLiveProject\(session\.workspaceId\)/)
  assert.match(ipc, /queryPersistedModelAttempts/)
  assert.match(appFeatures, /handleStudioResultIpc\(event, action, args\[0\], args\[1\]\)/)
  assert.match(preload, /queryStudioAuditTimeline/)
  assert.match(panel, /data-studio-audit-run-filter/)
  assert.match(panel, /data-studio-audit-load-more/)
  assert.match(panel, /data-studio-audit-integrity/)
  assert.equal(packageJson.scripts['test:audit-timeline'], 'node scripts/audit-timeline-required.mjs')
  assert(packageJson.scripts['test:audit-timeline:required']?.includes('test:audit-timeline'))
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/studio-result/studio-audit-timeline.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function hex(character) {
  return character.repeat(64)
}

function captureError(run) {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) return error
    return new Error(String(error))
  }
  throw new Error('expected operation to fail')
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  }
}
