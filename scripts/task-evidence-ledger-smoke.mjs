import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-task-evidence-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const snapshotStore = await import(pathToFileURL(compiledTaskModule('task-snapshot.js')).href)
  const evidenceApi = await import(pathToFileURL(compiledTaskModule('task-evidence-api.js')).href)
  const evidenceProjection = await import(
    pathToFileURL(compiledTaskModule('workflow-ledger-evidence-projection.js')).href
  )
  const workflowStore = await import(pathToFileURL(compiledTaskModule('workflow-ledger-store.js')).href)

  const firstEvidence = evidence('evidence-1', 'prepared', 100)
  const secondEvidence = evidence('evidence-2', 'execution_result', 200)
  const run = buildRun([firstEvidence])
  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: buildMeta(),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run
  })

  await snapshotStore.saveTaskSnapshot(snapshot, userData)
  const savedSnapshots = await snapshotStore.listTaskSnapshots(userData)
  assertEqual(savedSnapshots.length, 1, `snapshot must be readable after save: ${JSON.stringify(savedSnapshots)}`)
  assertEqual((await evidenceApi.listPersistedTaskEvidence({}, userData)).length, 1, 'first evidence must append')
  const verification = await evidenceApi.verifyPersistedTaskEvidence(userData)
  assertEqual(verification.valid, true, 'fresh evidence chain must verify')
  assertEqual(verification.lastSeq, 1, 'fresh evidence chain sequence')

  await snapshotStore.saveTaskRunBarrier(run, userData)
  assertEqual((await evidenceApi.listPersistedTaskEvidence({}, userData)).length, 1, 'same evidence must be idempotent')

  const extendedRun = {
    ...run,
    revision: 2,
    updatedAt: 300,
    effects: [{ ...run.effects[0], revision: 2, evidence: [...run.effects[0].evidence, secondEvidence] }]
  }
  await snapshotStore.saveTaskRunBarrier(extendedRun, userData)
  const allEvidence = await evidenceApi.listPersistedTaskEvidence({}, userData)
  assertEqual(allEvidence.length, 2, 'new evidence must append exactly once')
  assertEqual((await evidenceApi.listPersistedTaskEvidence({ effectId: 'effect-1' }, userData)).length, 2, 'effect scope filter')
  assertEqual(
    (await evidenceApi.listPersistedTaskEvidence({ projectId: 'project-1', operationId: 'operation-1' }, userData)).length,
    2,
    'project and operation scope filter'
  )

  const ordinaryRun = {
    ...extendedRun,
    id: 'run-ordinary',
    sessionId: 'session-ordinary',
    taskId: 'task-ordinary',
    projectId: 'project-ordinary',
    operation: undefined,
    effects: [{
      ...extendedRun.effects[0],
      id: 'effect-ordinary',
      effectKey: 'effect-key-ordinary',
      sessionId: 'session-ordinary',
      runId: 'run-ordinary',
      evidence: [evidence('evidence-ordinary', 'prepared', 400)]
    }]
  }
  await snapshotStore.saveTaskSnapshot(
    snapshotStore.buildTaskSnapshot({
      meta: {
        ...buildMeta(),
        id: 'session-ordinary',
        title: 'Ordinary evidence smoke',
        projectId: 'project-ordinary',
        childTaskId: 'task-ordinary'
      },
      transcript: [],
      lastSeq: 0,
      eventCount: 0,
      reason: 'created'
    }),
    userData
  )
  await snapshotStore.saveTaskRunBarrier(ordinaryRun, userData)
  assertEqual(
    (await evidenceApi.listPersistedTaskEvidence({ projectId: 'project-ordinary' }, userData)).length,
    1,
    'ordinary TaskRun project scope must be retained without operation metadata'
  )

  const dbPath = snapshotStore.taskSnapshotsDbFile(userData)
  await withDatabase(dbPath, (db) => {
    const before = workflowStore.verifyWorkflowLedger(db)
    const changed = evidenceProjection.projectTaskEvidenceIntoWorkflow(db, { runId: run.id })
    const after = workflowStore.verifyWorkflowLedger(db)
    assertEqual(changed, false, 'steady-state evidence projection must be idempotent')
    assertEqual(after.events, before.events, 'steady-state projection must preserve event count')
    assertEqual(after.lastDigest, before.lastDigest, 'steady-state projection must preserve last digest')
  })

  await withDatabase(dbPath, (db) => {
    const before = workflowStore.verifyWorkflowLedger(db)
    const missingEventId = 'workflow:evidence:evidence-ordinary'
    assertEqual(eventSeq(db, missingEventId), before.lastSeq, 'missing-event fixture must remove the chain tail')
    db.run('DELETE FROM workflow_events WHERE event_id = ?', [missingEventId])
    const changed = evidenceProjection.projectTaskEvidenceIntoWorkflow(db, { runId: ordinaryRun.id })
    const repaired = workflowStore.verifyWorkflowLedger(db)
    assertEqual(changed, true, 'missing evidence event must be projected')
    assertEqual(repaired.events, before.events, 'missing evidence event repair must restore event count')
    assertEqual(repaired.lastDigest, before.lastDigest, 'missing evidence event repair must restore last digest')
  })

  await withDatabase(dbPath, (db) => {
    const conflictingEventId = 'workflow:evidence:evidence-ordinary'
    db.run('DELETE FROM workflow_events WHERE event_id = ?', [conflictingEventId])
    workflowStore.appendWorkflowEvent(db, {
      eventId: conflictingEventId,
      streamId: 'system:evidence-id-collision',
      entityType: 'system',
      entityId: 'evidence-id-collision',
      kind: 'workflow.evidence-id-collision',
      payload: {},
      occurredAt: 401
    })
    assertThrows(
      () => evidenceProjection.projectTaskEvidenceIntoWorkflow(db, { runId: ordinaryRun.id }),
      (error) => error?.code === 'WORKFLOW_LEDGER_CORRUPTION',
      'non-evidence event must not satisfy Task evidence projection by event ID alone'
    )
  })

  await withDatabase(dbPath, (db) => {
    db.run("UPDATE workflow_events SET record_digest = 'tampered-workflow' WHERE event_id = 'workflow:evidence:evidence-ordinary'")
    assertThrows(
      () => evidenceProjection.projectTaskEvidenceIntoWorkflow(db, { runId: run.id }),
      (error) => error?.code === 'WORKFLOW_LEDGER_CORRUPTION',
      'scoped projection must fail closed on a corrupt event outside its run'
    )
  })

  await withDatabase(dbPath, (db) => {
    tamperEvidencePayloadInDatabase(db, 'evidence-ordinary')
    assertThrows(
      () => evidenceProjection.projectTaskEvidenceIntoWorkflow(db, { runId: run.id }),
      (error) => error?.code === 'TASK_EVIDENCE_CORRUPTION',
      'scoped projection must fail closed on a corrupt evidence payload outside its run'
    )
  })

  const invalidRun = {
    ...run,
    id: 'run-invalid',
    sessionId: 'session-invalid',
    taskId: 'task-invalid',
    operation: undefined,
    effects: [{
      ...run.effects[0],
      sessionId: 'session-invalid',
      runId: 'run-invalid',
      evidence: [evidence('', 'prepared', 500)]
    }]
  }
  const invalidDbBytes = readFileSync(snapshotStore.taskSnapshotsDbFile(userData))
  await assertRejects(
    snapshotStore.saveTaskSnapshot(
      snapshotStore.buildTaskSnapshot({
        meta: {
          ...buildMeta(), id: 'session-invalid', title: 'Invalid evidence smoke', childTaskId: 'task-invalid'
        },
        transcript: [],
        lastSeq: 0,
        eventCount: 0,
        reason: 'created',
        run: invalidRun
      }),
      userData
    ),
    (error) => error?.code === 'TASK_EVIDENCE_CORRUPTION',
    'invalid evidence input must fail before persistence'
  )
  assertEqual(
    Buffer.compare(invalidDbBytes, readFileSync(snapshotStore.taskSnapshotsDbFile(userData))),
    0,
    'invalid evidence input must not rewrite the database'
  )
  const wrongOwnerRun = {
    ...invalidRun,
    id: 'run-wrong-owner',
    sessionId: 'session-wrong-owner',
    taskId: 'task-wrong-owner',
    effects: [{
      ...run.effects[0],
      id: 'effect-wrong-owner',
      sessionId: 'session-wrong-owner',
      runId: 'different-run',
      evidence: [evidence('evidence-wrong-owner', 'prepared', 600)]
    }]
  }
  await assertRejects(
    snapshotStore.saveTaskSnapshot(
      snapshotStore.buildTaskSnapshot({
        meta: {
          ...buildMeta(),
          id: 'session-wrong-owner',
          title: 'Wrong owner evidence smoke',
          childTaskId: 'task-wrong-owner'
        },
        transcript: [],
        lastSeq: 0,
        eventCount: 0,
        reason: 'created',
        run: wrongOwnerRun
      }),
      userData
    ),
    (error) => error?.code === 'TASK_EVIDENCE_CORRUPTION',
    'cross-run evidence ownership must fail before persistence'
  )
  assertEqual(
    Buffer.compare(invalidDbBytes, readFileSync(snapshotStore.taskSnapshotsDbFile(userData))),
    0,
    'cross-run evidence ownership must not rewrite the database'
  )

  const beforeCorruption = readFileSync(dbPath)
  await tamperEvidenceDigest(dbPath)
  const tamperedBytes = readFileSync(dbPath)
  await assertRejects(
    evidenceApi.listPersistedTaskEvidence({}, userData),
    (error) => error?.code === 'TASK_EVIDENCE_CORRUPTION',
    'tampered evidence must fail closed'
  )
  await assertRejects(
    evidenceApi.verifyPersistedTaskEvidence(userData),
    (error) => error?.code === 'TASK_EVIDENCE_CORRUPTION',
    'tampered evidence verification must fail closed'
  )
  assertEqual(
    Buffer.compare(tamperedBytes, readFileSync(dbPath)),
    0,
    'failed evidence verification must not rewrite the database'
  )

  // Restore the fixture, then prove snapshot deletion cannot erase the append-only ledger.
  writeFileSync(dbPath, beforeCorruption)
  await tamperTaskRunPayload(dbPath)
  const tamperedRunBytes = readFileSync(dbPath)
  await assertRejects(
    evidenceApi.listPersistedTaskEvidence({}, userData),
    (error) => error?.code === 'TASK_EVIDENCE_CORRUPTION',
    'corrupt TaskRun migration must fail closed'
  )
  assertEqual(
    Buffer.compare(tamperedRunBytes, readFileSync(dbPath)),
    0,
    'failed TaskRun migration must not rewrite the database'
  )
  writeFileSync(dbPath, beforeCorruption)
  await snapshotStore.deleteTaskSnapshot('session-1', userData)
  const retained = await evidenceApi.listPersistedTaskEvidence({}, userData)
  assertEqual(retained.length, 3, 'deleting a snapshot must retain evidence history')
  assertEqual((await evidenceApi.verifyPersistedTaskEvidence(userData)).lastSeq, 3, 'retained chain remains verifiable')
  await snapshotStore.deleteTaskSnapshot('session-ordinary', userData)
  assertEqual(
    (await evidenceApi.listPersistedTaskEvidence({ projectId: 'project-ordinary' }, userData)).length,
    1,
    'project binding must survive ordinary snapshot deletion'
  )

  console.log('task evidence ledger smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/task-snapshot.ts',
      'src/main/task/task-evidence-api.ts',
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
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(
    path.join(electronDir, 'index.js'),
    `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`
  )
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function compiledTaskModule(name) {
  const modulePath = path.join(outDir, 'main', 'task', name)
  if (!existsSync(modulePath)) throw new Error(`compiled ${name} not found at ${modulePath}`)
  return modulePath
}

function buildMeta() {
  return {
    id: 'session-1',
    title: 'Evidence smoke',
    cwd: userData,
    projectId: 'project-1',
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: 'sdk-session-1',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1
  }
}

function buildRun(evidenceItems) {
  return {
    schemaVersion: 1,
    id: 'run-1',
    sessionId: 'session-1',
    taskId: 'operation-1',
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt: 100,
    operation: {
      schemaVersion: 1,
      operationId: 'operation-1',
      source: 'renderer',
      kind: 'file_write',
      sourceSessionId: 'session-1',
      projectId: 'project-1',
      title: 'Evidence fixture'
    },
    steps: [],
    toolExecutions: [],
    effects: [{
      schemaVersion: 1,
      id: 'effect-1',
      effectKey: 'effect-key-1',
      resourceKey: 'resource-key-1',
      sessionId: 'session-1',
      runId: 'run-1',
      toolUseId: 'tool-1',
      toolName: 'write_file',
      generation: 1,
      revision: 1,
      status: 'confirmed',
      reconcilability: 'queryable',
      target: { kind: 'unsupported', toolName: 'write_file' },
      targetDigest: 'target-digest-1',
      intentDigest: 'intent-digest-1',
      inputDigest: 'input-digest-1',
      createdAt: 1,
      updatedAt: 100,
      evidence: evidenceItems
    }]
  }
}

function evidence(id, kind, observedAt) {
  return {
    id,
    kind,
    digest: `${id}-digest`,
    observedAt,
    verifier: 'task-evidence-ledger-smoke',
    generation: 1
  }
}

async function tamperEvidenceDigest(dbPath) {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({ locateFile: (file) => (file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file) })
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    db.run("UPDATE task_evidence SET record_digest = 'tampered' WHERE seq = 1")
    writeFileSync(dbPath, db.export())
  } finally {
    db.close()
  }
}

async function tamperTaskRunPayload(dbPath) {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({ locateFile: (file) => (file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file) })
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    db.run("UPDATE task_runs SET payload = '{' WHERE id = 'run-ordinary'")
    writeFileSync(dbPath, db.export())
  } finally {
    db.close()
  }
}

async function withDatabase(dbPath, callback) {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({ locateFile: (file) => (file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file) })
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    return callback(db)
  } finally {
    db.close()
  }
}

function eventSeq(db, eventId) {
  const stmt = db.prepare('SELECT seq FROM workflow_events WHERE event_id = ? LIMIT 1')
  try {
    stmt.bind([eventId])
    if (!stmt.step()) return undefined
    return stmt.getAsObject().seq
  } finally {
    stmt.free()
  }
}

function tamperEvidencePayloadInDatabase(db, evidenceId) {
  const stmt = db.prepare('SELECT payload FROM task_evidence WHERE evidence_id = ? LIMIT 1')
  let payload
  try {
    stmt.bind([evidenceId])
    if (!stmt.step()) throw new Error(`missing evidence fixture ${evidenceId}`)
    payload = stmt.getAsObject().payload
  } finally {
    stmt.free()
  }
  const parsed = JSON.parse(payload)
  parsed.verifier = 'tampered-evidence-payload'
  db.run('UPDATE task_evidence SET payload = ? WHERE evidence_id = ?', [JSON.stringify(parsed), evidenceId])
}

function assertThrows(callback, predicate, message) {
  try {
    callback()
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
