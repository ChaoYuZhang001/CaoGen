import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workflow-shadow-consistency-'))
const outDir = path.join(tempRoot, 'compiled')
const supersedeRoot = path.join(tempRoot, 'supersede')
const unownedRoot = path.join(tempRoot, 'unowned')
const olderNowRoot = path.join(tempRoot, 'older-now')
const v6ProjectRoot = path.join(tempRoot, 'v6-project')
const v6ConflictRoot = path.join(tempRoot, 'v6-conflict')
const operationConflictRoot = path.join(tempRoot, 'operation-conflict')

try {
  compileSources()
  installElectronStub()
  const snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  const migration = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-migration.js')).href)
  const workflowStore = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-store.js')).href)
  const workflowCodec = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-codec.js')).href)
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({
    locateFile: (file) => file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file
  })

  const sessionId = 'session-shadow-supersede'
  const projectId = 'project-shadow'
  const orchestrationId = 'orchestration-shadow'
  const taskId = 'task-shadow-child'
  const expectedWorkItemId = `work-item:dag:${orchestrationId}:${taskId}`
  const run = buildRunWithEvidence('run-shadow-supersede', sessionId, 1, 100, taskId)
  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: {
      ...buildMeta(sessionId, projectId),
      orchestrationId,
      childTaskId: taskId,
      childRole: 'execution'
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: 100
  })
  await snapshotStore.saveTaskSnapshot(snapshot, supersedeRoot)
  const initial = readRawState(
    SQL,
    snapshotStore.taskSnapshotsDbFile(supersedeRoot),
    run.id,
    workflowStore
  )
  assertWorkflowOwnership(initial.workflowRun, projectId, expectedWorkItemId, 'initial projection')
  assertEqual(
    await snapshotStore.deleteTaskSnapshot(sessionId, supersedeRoot),
    true,
    'fixture Snapshot must be deleted while its TaskRun and WorkflowRun remain'
  )

  assertEqual(
    await snapshotStore.supersedeToolExecution(
      run.toolExecutions[0].id,
      'run-shadow-retry:tool:confirmed',
      200,
      supersedeRoot
    ),
    true,
    'supersede must update a TaskRun that no longer has a Snapshot'
  )
  const superseded = readRawState(
    SQL,
    snapshotStore.taskSnapshotsDbFile(supersedeRoot),
    run.id,
    workflowStore
  )
  assertEqual(superseded.snapshotCount, 0, 'supersede fixture must not recreate a Snapshot')
  assertWorkflowOwnership(superseded.workflowRun, projectId, expectedWorkItemId, 'supersede')
  assertEqual(superseded.taskRun.revision, run.revision + 1, 'supersede must increment the Run exactly once')
  assertEqual(superseded.runProjectionEventCount, 2, 'supersede must append exactly one Run projection event')
  assertEqual(superseded.taskRun.toolExecutions[0].status, 'superseded', 'legacy TaskRun must update immediately')
  assertEqual(
    superseded.workflowRun.taskRun.toolExecutions[0].status,
    'superseded',
    'WorkflowRun must update in the same mutation without reopen backfill'
  )
  assertDigestParity(workflowCodec, superseded, 'supersede')

  const finalRun = {
    ...superseded.taskRun,
    revision: superseded.taskRun.revision + 1,
    updatedAt: 300,
    finishedAt: 300,
    error: 'finalized after Snapshot removal',
    effects: [appendEffectEvidence(superseded.taskRun.effects[0], 'final', 300)]
  }
  assertEqual(
    await snapshotStore.deleteTaskSnapshot('missing-snapshot-id', supersedeRoot, finalRun),
    false,
    'final Run update without a Snapshot must report that no Snapshot was deleted'
  )
  const finalized = readRawState(
    SQL,
    snapshotStore.taskSnapshotsDbFile(supersedeRoot),
    run.id,
    workflowStore
  )
  assertWorkflowOwnership(
    finalized.workflowRun,
    projectId,
    expectedWorkItemId,
    'deleteTaskSnapshot(missing, finalRun)'
  )
  assertEqual(finalized.runProjectionEventCount, 3, 'final Run persistence must append exactly one Run projection event')
  assertEqual(finalized.taskRun.revision, finalRun.revision, 'legacy final Run revision must persist immediately')
  assertEqual(finalized.workflowRun.revision, finalRun.revision, 'Workflow final Run revision must persist immediately')
  assertEqual(
    JSON.stringify(finalized.taskEvidenceProjects),
    JSON.stringify([projectId, projectId]),
    'new Evidence without a Snapshot must inherit prior Workflow project ownership'
  )
  assertEqual(
    finalized.workflowRun.taskRun.error,
    finalRun.error,
    'WorkflowRun must carry the exact final TaskRun payload without reopen'
  )
  assertDigestParity(workflowCodec, finalized, 'deleteTaskSnapshot(finalRun)')

  const unowned = buildRun('run-shadow-unowned', 'session-shadow-unowned', 1, 400)
  await assertRejects(
    snapshotStore.deleteTaskSnapshot(unowned.sessionId, unownedRoot, unowned),
    (error) => String(error).includes('ownership cannot be proven'),
    'a Run without Snapshot or prior WorkflowRun ownership must fail closed'
  )
  assertEmptyCanonicalStore(
    SQL,
    snapshotStore.taskSnapshotsDbFile(unownedRoot),
    'failed ownership proof'
  )

  const operationId = 'operation-conflict'
  const operationConflictRun = buildRun(
    'run-operation-conflict',
    `operation:${operationId}`,
    1,
    450,
    operationId
  )
  const operationConflictSnapshot = snapshotStore.buildTaskSnapshot({
    meta: buildMeta(operationConflictRun.sessionId, 'project-snapshot-owner'),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: {
      ...operationConflictRun,
      operation: buildOperation(operationConflictRun, 'project-operation-owner')
    },
    now: 450
  })
  await assertRejects(
    snapshotStore.saveTaskSnapshot(operationConflictSnapshot, operationConflictRoot),
    (error) => String(error).includes('operation project ownership differs'),
    'Snapshot and operation project ownership conflict must fail closed'
  )
  assertEmptyCanonicalStore(
    SQL,
    snapshotStore.taskSnapshotsDbFile(operationConflictRoot),
    'operation ownership conflict'
  )

  const priorOperationRun = {
    ...operationConflictRun,
    operation: buildOperation(operationConflictRun, 'project-prior-owner')
  }
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: buildMeta(operationConflictRun.sessionId, 'project-prior-owner'),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: priorOperationRun,
    now: 450
  }), operationConflictRoot)
  await snapshotStore.deleteTaskSnapshot(operationConflictRun.sessionId, operationConflictRoot)
  const operationConflictDb = snapshotStore.taskSnapshotsDbFile(operationConflictRoot)
  const operationConflictDigest = fileDigest(operationConflictDb)
  await assertRejects(
    snapshotStore.deleteTaskSnapshot('missing-operation-snapshot', operationConflictRoot, {
      ...priorOperationRun,
      revision: 2,
      updatedAt: 460,
      operation: buildOperation(operationConflictRun, 'project-operation-owner')
    }),
    (error) => String(error).includes('TaskRun operation 元数据发生不可变字段冲突'),
    'persisted TaskRun operation ownership must remain immutable'
  )
  assertEqual(
    fileDigest(operationConflictDb),
    operationConflictDigest,
    'failed operation ownership mutation must leave database bytes unchanged'
  )

  const olderSessionId = 'session-shadow-older-now'
  const olderRun = buildRun('run-shadow-older-now', olderSessionId, 1, 100)
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: buildMeta(olderSessionId, 'project-older-now'),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: olderRun,
    now: 100
  }), olderNowRoot)
  const newerPersistedRun = { ...olderRun, revision: 2, updatedAt: 1_000 }
  mutateDatabaseFile(SQL, snapshotStore.taskSnapshotsDbFile(olderNowRoot), (db) => {
    db.run('UPDATE task_runs SET updated_at = ?, payload = ? WHERE id = ?', [
      newerPersistedRun.updatedAt,
      JSON.stringify(newerPersistedRun),
      newerPersistedRun.id
    ])
  })
  assertEqual(
    await snapshotStore.supersedeToolExecution(
      olderRun.toolExecutions[0].id,
      'run-shadow-older-now:tool:confirmed',
      200,
      olderNowRoot
    ),
    true,
    'supersede must accept a timestamp older than the persisted Run'
  )
  const olderNowState = readRawState(
    SQL,
    snapshotStore.taskSnapshotsDbFile(olderNowRoot),
    olderRun.id,
    workflowStore
  )
  assertEqual(olderNowState.taskRun.updatedAt, 1_000, 'older now must not regress the persisted Run timestamp')
  assertEqual(olderNowState.snapshot.updatedAt, 1_000, 'Snapshot timestamp must cover the merged Run timestamp')
  assertEqual(olderNowState.snapshot.run.updatedAt, 1_000, 'Snapshot must embed the merged Run timestamp')

  const v6ProjectId = 'project-v6-evidence'
  const v6Run = buildRunWithEvidence('run-v6-evidence', 'session-v6-evidence', 1, 500)
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: buildMeta(v6Run.sessionId, v6ProjectId),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: v6Run,
    now: 500
  }), v6ProjectRoot)
  const v6ProjectDb = snapshotStore.taskSnapshotsDbFile(v6ProjectRoot)
  rmSync(path.join(v6ProjectRoot, 'backups'), { recursive: true, force: true })
  downgradeToV6WithoutWorkflow(SQL, v6ProjectDb)
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const v6Digest = fileDigest(v6ProjectDb)
  await snapshotStore.listTaskRuns(undefined, v6ProjectRoot)
  const v6State = readRawState(SQL, v6ProjectDb, v6Run.id, workflowStore)
  assertEqual(v6State.snapshotCount, 0, 'v6 fixture must recover without a Snapshot')
  assertWorkflowOwnership(
    v6State.workflowRun,
    v6ProjectId,
    workflowStore.deriveWorkItemId(v6Run, { projectId: v6ProjectId }),
    'v6 Task Evidence backfill'
  )
  assertEqual(v6State.taskEvidenceProjects[0], v6ProjectId, 'v6 Task Evidence must retain its project scope')
  const upgradedDigest = fileDigest(v6ProjectDb)
  assert(upgradedDigest !== v6Digest, 'first v6 reopen must durably write the Workflow projection')
  await snapshotStore.listTaskRuns(undefined, v6ProjectRoot)
  const reopenedV6State = readRawState(SQL, v6ProjectDb, v6Run.id, workflowStore)
  assertEqual(fileDigest(v6ProjectDb), upgradedDigest, 'repeated reopen must leave upgraded database bytes unchanged')
  assertEqual(
    reopenedV6State.workflowEventCount,
    v6State.workflowEventCount,
    'repeated reopen must not duplicate Workflow events'
  )

  const conflictingRun = buildRunWithEvidence(
    'run-v6-conflicting-evidence', 'session-v6-conflicting-evidence', 1, 600, undefined, 2
  )
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: buildMeta(conflictingRun.sessionId, 'project-v6-original'),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: conflictingRun,
    now: 600
  }), v6ConflictRoot)
  const v6ConflictDb = snapshotStore.taskSnapshotsDbFile(v6ConflictRoot)
  rmSync(path.join(v6ConflictRoot, 'backups'), { recursive: true, force: true })
  downgradeToV6WithoutWorkflow(SQL, v6ConflictDb)
  rewriteLastEvidenceProject(SQL, v6ConflictDb, 'project-v6-conflict', workflowCodec)
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const conflictDigest = fileDigest(v6ConflictDb)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assertRejects(
      snapshotStore.listTaskRuns(undefined, v6ConflictRoot),
      (error) => String(error).includes('task_evidence_project_conflict'),
      'conflicting v6 Task Evidence ownership must fail closed'
    )
    assertEqual(
      fileDigest(v6ConflictDb),
      conflictDigest,
      'failed v6 ownership backfill must leave original database bytes unchanged'
    )
  }

  console.log('workflow shadow consistency smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/task-snapshot.ts',
      '--outDir', outDir,
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(tempRoot)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  const found = findCompiledModuleInTree(root, name)
  if (!found) throw new Error(`compiled ${name} not found under ${root}`)
  return found
}

function findCompiledModuleInTree(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleInTree(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  return null
}

function readRawState(SQL, dbPath, runId, workflowStore) {
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    const taskRun = readPayload(db, 'task_runs', runId)
    const workflowRun = readPayload(db, 'workflow_runs', runId)
    const snapshot = readOptionalPayload(db, 'task_snapshots', 'session_id', taskRun.sessionId)
    const snapshotCount = scalar(db, 'SELECT COUNT(*) FROM task_snapshots')
    const workflowEventCount = scalar(db, 'SELECT COUNT(*) FROM workflow_events')
    const runProjectionEventCount = scalar(
      db,
      `SELECT COUNT(*) FROM workflow_events
       WHERE run_id = ? AND kind IN ('run.projected', 'run.recovered')`,
      [runId]
    )
    const taskEvidenceProjects = columnValues(
      db,
      'SELECT project_id FROM task_evidence WHERE run_id = ? ORDER BY seq',
      [runId]
    )
    assertEqual(workflowStore.verifyWorkflowLedger(db).valid, true, 'raw Workflow Ledger must verify')
    return {
      taskRun,
      workflowRun,
      snapshot,
      snapshotCount,
      workflowEventCount,
      runProjectionEventCount,
      taskEvidenceProjects
    }
  } finally {
    db.close()
  }
}

function assertEmptyCanonicalStore(SQL, dbPath, label) {
  assert(existsSync(dbPath), `${label} must leave the verified empty canonical store available`)
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    for (const table of ['task_snapshots', 'task_runs', 'task_evidence', 'workflow_runs', 'workflow_events']) {
      const count = db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0]
      assertEqual(count, 0, `${label} must not persist business rows in ${table}`)
    }
  } finally {
    db.close()
  }
}

function readPayload(db, table, id) {
  const stmt = db.prepare(`SELECT payload FROM ${table} WHERE id = ? LIMIT 1`)
  try {
    stmt.bind([id])
    assert(stmt.step(), `${table} must contain ${id}`)
    const payload = stmt.getAsObject().payload
    assert(typeof payload === 'string', `${table} payload must be text`)
    return JSON.parse(payload)
  } finally {
    stmt.free()
  }
}

function readOptionalPayload(db, table, column, id) {
  const stmt = db.prepare(`SELECT payload FROM ${table} WHERE ${column} = ? LIMIT 1`)
  try {
    stmt.bind([id])
    if (!stmt.step()) return null
    const payload = stmt.getAsObject().payload
    assert(typeof payload === 'string', `${table} payload must be text`)
    return JSON.parse(payload)
  } finally {
    stmt.free()
  }
}

function columnValues(db, sql, params = []) {
  const stmt = db.prepare(sql)
  const values = []
  try {
    stmt.bind(params)
    while (stmt.step()) values.push(stmt.get()[0])
    return values
  } finally {
    stmt.free()
  }
}

function scalar(db, sql, params = []) {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params)
    assert(stmt.step(), `scalar query must return a row: ${sql}`)
    return stmt.get()[0]
  } finally {
    stmt.free()
  }
}

function assertDigestParity(codec, state, label) {
  assertEqual(
    codec.digest(state.taskRun),
    codec.digest(state.workflowRun.taskRun),
    `${label} legacy/Workflow TaskRun digests must match immediately`
  )
}

function assertWorkflowOwnership(workflowRun, projectId, workItemId, label) {
  assertEqual(workflowRun.projectId, projectId, `${label} must preserve Workflow project ownership`)
  assertEqual(workflowRun.workItemId, workItemId, `${label} must preserve Workflow work item ownership`)
}

function buildMeta(id, projectId) {
  return {
    id,
    title: `Shadow consistency ${id}`,
    cwd: tempRoot,
    projectId,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'error',
    sdkSessionId: `sdk-${id}`,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1
  }
}

function buildRun(id, sessionId, revision, updatedAt, taskId = sessionId) {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    taskId,
    status: 'failed',
    revision,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt,
    finishedAt: updatedAt,
    error: 'unknown external result',
    steps: [],
    toolExecutions: [{
      id: `${id}:tool:unknown`,
      runId: id,
      sessionId,
      toolUseId: 'unknown',
      toolName: 'write_file',
      status: 'unknown_outcome',
      createdAt: 2,
      updatedAt,
      finishedAt: updatedAt,
      error: 'unknown'
    }],
    effects: []
  }
}

function buildRunWithEvidence(id, sessionId, revision, updatedAt, taskId = sessionId, effectCount = 1) {
  const run = buildRun(id, sessionId, revision, updatedAt, taskId)
  return {
    ...run,
    effects: Array.from(
      { length: effectCount },
      (_, index) => buildConfirmedEffect(run, `effect-${index + 1}`, updatedAt)
    )
  }
}

function buildOperation(run, projectId) {
  return {
    schemaVersion: 1,
    operationId: run.taskId,
    source: 'renderer',
    kind: 'file_write',
    sourceSessionId: run.sessionId,
    projectId,
    title: `Operation ${run.id}`
  }
}

function buildConfirmedEffect(run, suffix, updatedAt) {
  const effect = {
    schemaVersion: 1,
    id: `${run.id}:${suffix}`,
    effectKey: `${run.id}:${suffix}:key`,
    resourceKey: `${run.id}:${suffix}:resource`,
    sessionId: run.sessionId,
    runId: run.id,
    toolUseId: `${run.id}:${suffix}:tool`,
    toolName: 'fixture_tool',
    generation: 1,
    revision: 1,
    status: 'confirmed',
    reconcilability: 'queryable',
    target: { kind: 'unsupported', toolName: 'fixture_tool' },
    targetDigest: `${run.id}:${suffix}:target`,
    intentDigest: `${run.id}:${suffix}:intent`,
    inputDigest: `${run.id}:${suffix}:input`,
    evidence: [],
    createdAt: updatedAt,
    updatedAt,
    terminalAt: updatedAt
  }
  return appendEffectEvidence(effect, 'initial', updatedAt)
}

function appendEffectEvidence(effect, suffix, observedAt) {
  return {
    ...effect,
    revision: effect.revision + (effect.evidence.length > 0 ? 1 : 0),
    updatedAt: Math.max(effect.updatedAt, observedAt),
    evidence: [...effect.evidence, {
      id: `${effect.id}:evidence:${suffix}`,
      kind: 'execution_result',
      digest: `${effect.id}:digest:${suffix}`,
      observedAt,
      verifier: 'workflow-shadow-consistency-smoke',
      generation: effect.generation
    }]
  }
}

function mutateDatabaseFile(SQL, dbPath, mutator) {
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    mutator(db)
    writeFileSync(dbPath, Buffer.from(db.export()))
  } finally {
    db.close()
  }
}

function downgradeToV6WithoutWorkflow(SQL, dbPath) {
  mutateDatabaseFile(SQL, dbPath, (db) => {
    db.run('DELETE FROM task_snapshots')
    for (const table of [
      'workflow_events',
      'workflow_evidence_links',
      'workflow_acceptances',
      'workflow_artifacts',
      'workflow_recovery_sessions',
      'workflow_runs',
      'workflow_work_items',
      'workflow_goals'
    ]) {
      db.run(`DROP TABLE IF EXISTS ${table}`)
    }
    db.run('PRAGMA user_version = 6')
  })
}

function rewriteLastEvidenceProject(SQL, dbPath, projectId, workflowCodec) {
  mutateDatabaseFile(SQL, dbPath, (db) => {
    const result = db.exec('SELECT seq, payload FROM task_evidence ORDER BY seq DESC LIMIT 1')
    const [seq, payload] = result[0]?.values[0] ?? []
    assert(typeof seq === 'number' && typeof payload === 'string', 'conflict fixture needs Task Evidence')
    const rewritten = { ...JSON.parse(payload), projectId }
    db.run(
      'UPDATE task_evidence SET project_id = ?, record_digest = ?, payload = ? WHERE seq = ?',
      [projectId, workflowCodec.digest(rewritten), JSON.stringify(rewritten), seq]
    )
  })
}

function fileDigest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${String(error)}`)
  }
  throw new Error(`${message}: expected rejection`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
