import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-canonical-migration-'))
const outDir = path.join(tempRoot, 'compiled')
let snapshotStore
let snapshotSchema
let migration
let finalization
let workflowCodec
let SQL
let buildCounter = 0

try {
  compileSources()
  installElectronStub()
  snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  snapshotSchema = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot-schema.js')).href)
  migration = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-migration.js')).href)
  finalization = await import(pathToFileURL(findCompiledModule(outDir, 'dag-finalization.js')).href)
  workflowCodec = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-codec.js')).href)
  SQL = await require('sql.js')({
    locateFile: (file) => file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file
  })

  await healthyV8IsReadOnly()
  await singleFlightAndAdditiveRepair()
  await workflowEvidenceTableAdditiveRepair()
  await canonicalSupersetV8UpgradesToV9()
  await committedCanonicalSupersetV8UpgradesToV9()
  await committedTargetIdentityContinuity()
  await futureAndCorruptionFailClosed()
  await fenceReadinessBoundaries()
  await v6TerminalEvidenceAndFinalizerPreservation()
  await v6MultiRunSessionOwnershipPreservation()
  await v2AndLegacySources()
  await emptySourceMigration()
  await maliciousCandidateIsBlocked()
  await faultCheckpointsResume()
  await corruptJournalFailsClosed()
  await rollbackBoundaries()
  console.log('workflow-ledger canonical migration smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function healthyV8IsReadOnly() {
  const fixture = await seedStore('healthy-v8', { projectId: 'project-healthy' })
  const before = readFileSync(fixture.databasePath)
  const backupRoot = path.join(fixture.root, 'backups')
  let builds = 0
  const result = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, async () => {
    builds += 1
    throw new Error('healthy v8 must not invoke candidate builder')
  }, { backupsRoot: backupRoot }))
  assertEqual(result.disposition, 'ready_existing_v8', 'healthy v8 should be directly ready')
  assertEqual(builds, 0, 'healthy v8 builder count')
  assertEqual(Buffer.compare(before, readFileSync(fixture.databasePath)), 0, 'healthy v8 bytes unchanged')
  assert(!existsSync(backupRoot), 'healthy v8 must not create a backup directory')
  const report = await migration.assessWorkflowLedgerCanonicalReadinessFile(fixture.databasePath, { assessedAt: 42 })
  assertEqual(report.status, 'ready', 'healthy readiness status')
  assertEqual(report.counts.dagFinalizations, 0, 'healthy finalizer count')
  console.log('[PASS] healthy v8 direct readiness is read-only')
}

async function singleFlightAndAdditiveRepair() {
  const fixture = await seedStore('single-flight', { projectId: 'project-flight' })
  mutateDb(fixture.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
  let builds = 0
  const builder = async (source) => {
    builds += 1
    await delay(15)
    return buildCandidate(source)
  }
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const results = await Promise.all([
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, builder)),
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, builder))
  ])
  assertEqual(builds, 1, 'single-flight must invoke candidate builder once')
  assertEqual(results[0].disposition, 'migrated', 'additive v8 should migrate')
  assertEqual(results[1].migration.journal.state, 'committed', 'single-flight journal must commit')
  assert(existsSync(fixture.databasePath), 'migrated target must remain')
  console.log('[PASS] v8 additive repair and process single-flight')
}

async function workflowEvidenceTableAdditiveRepair() {
  const fixture = await seedStore('workflow-evidence-additive', {
    projectId: 'project-workflow-evidence-additive'
  })
  mutateDb(fixture.databasePath, (db) => db.run('DROP TABLE workflow_evidence'))
  const before = await migration.assessWorkflowLedgerCanonicalReadinessFile(fixture.databasePath, {
    assessedAt: 40
  })
  assertEqual(before.status, 'repairable', 'missing Workflow evidence table must be repairable')
  assertEqual(before.safeForShadowUse, false, 'missing Workflow evidence table must block shadow readiness')
  assertEqual(before.readyForCanonicalRead, false, 'missing Workflow evidence table must block canonical readiness')
  assert(before.diagnostics.some((item) =>
    item.code === 'additive_projection_table_missing' && item.table === 'workflow_evidence'
  ), 'readiness must name the missing Workflow evidence table')

  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const repaired = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate))
  assertEqual(repaired.disposition, 'migrated', 'missing Workflow evidence table must use additive migration')
  assertEqual(repaired.report.verification?.workflowLedger.workflowEvidence, 0,
    'repaired readiness must verify the empty Workflow evidence chain')
  assert(!repaired.report.diagnostics.some((item) => item.table === 'workflow_evidence'),
    'repaired readiness must clear the Workflow evidence table diagnostic')
  console.log('[PASS] Workflow evidence table participates in canonical readiness and additive repair')
}

async function canonicalSupersetV8UpgradesToV9() {
  const fixture = await seedStore('canonical-superset-v8', { projectId: 'project-canonical-upgrade' })
  mutateDb(fixture.databasePath, (db) => {
    db.run('DELETE FROM task_snapshots')
    db.run('DELETE FROM task_runs')
    db.run('DROP TABLE workflow_store_identity')
  })
  const sourceReport = await migration.assessWorkflowLedgerCanonicalReadinessFile(fixture.databasePath, {
    assessedAt: 41
  })
  assertEqual(sourceReport.safeForShadowUse, false, 'canonical-superset source must not claim shadow parity')
  assertEqual(sourceReport.readyForCanonicalRead, false,
    'old canonical-superset source remains blocked until additive identity repair')
  assert(sourceReport.diagnostics.some((item) => item.code === 'additive_task_support_table_missing' &&
    item.table === 'workflow_store_identity'), 'old canonical-superset source must expose the identity gap')
  const sourceRuns = captureTableRows(readFileSync(fixture.databasePath), 'workflow_runs')
  const sourceRecovery = captureTableRows(readFileSync(fixture.databasePath), 'workflow_recovery_sessions')
  let builds = 0
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, async (source) => {
      builds += 1
      return buildVersionedCandidate(source, 9)
    }, {
      supportedStoreVersion: 9,
      targetStoreVersion: 9,
      readMode: 'canonical',
      faultAt: 'after_migrated_verified'
    })),
    (error) => error?.checkpoint === 'after_migrated_verified',
    'canonical-superset upgrade should persist a resumable candidate'
  )
  const journal = await migration.readWorkflowLedgerCanonicalMigrationJournal(findJournalPath(fixture.root))
  assertEqual(journal.mode, 'canonical', 'canonical-superset journal mode')
  assertEqual(journal.migrationPath, 'canonical_upgrade', 'canonical-superset journal path')

  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const resumed = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, async () => {
    throw new Error('canonical resume must reuse the durable v9 candidate')
  }, {
    supportedStoreVersion: 9,
    targetStoreVersion: 9,
    readMode: 'canonical'
  }))
  assertEqual(resumed.disposition, 'migrated', 'canonical-superset v8 should migrate to v9')
  assertEqual(builds, 1, 'canonical-superset candidate build count')
  assertEqual(readStoreVersion(fixture.databasePath), 9, 'canonical-superset target version')
  assertEqual(JSON.stringify(captureTableRows(readFileSync(fixture.databasePath), 'workflow_runs')),
    JSON.stringify(sourceRuns), 'canonical Workflow Runs must survive v9 upgrade')
  assertEqual(JSON.stringify(captureTableRows(readFileSync(fixture.databasePath), 'workflow_recovery_sessions')),
    JSON.stringify(sourceRecovery), 'canonical recovery rows must survive v9 upgrade')

  const lossy = await seedStore('canonical-superset-lossy', { projectId: 'project-canonical-lossy' })
  mutateDb(lossy.databasePath, (db) => {
    db.run('DELETE FROM task_snapshots')
    db.run('DELETE FROM task_runs')
    db.run('DROP TABLE workflow_store_identity')
  })
  const lossyBefore = readFileSync(lossy.databasePath)
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(lossy, async (source) =>
      buildVersionedCandidate({
        sourceKind: 'empty',
        sourcePath: source.targetPath,
        targetPath: source.targetPath,
        sourceBytes: new Uint8Array(),
        targetExisted: false
      }, 9), {
      supportedStoreVersion: 9,
      targetStoreVersion: 9,
      readMode: 'canonical'
    })),
    (error) => String(error?.code).startsWith('MIGRATION_PRESERVATION_'),
    'canonical-superset candidate must retain canonical source rows'
  )
  assertEqual(Buffer.compare(lossyBefore, readFileSync(lossy.databasePath)), 0,
    'lossy canonical upgrade must leave v8 source bytes unchanged')
  console.log('[PASS] canonical-superset v8->v9 uses canonical gate, durable resume, and preservation')
}

async function committedTargetIdentityContinuity() {
  const fixture = await seedStore('committed-store-identity', { projectId: 'project-store-identity' })
  mutateDb(fixture.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
  const committed = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate))
  assertEqual(committed.migration.journal.state, 'committed', 'identity fixture migration must commit')

  const replacementRoot = path.join(tempRoot, 'replacement-empty-v8')
  mkdirSync(replacementRoot, { recursive: true })
  await snapshotStore.mutateTaskSnapshotDatabase(replacementRoot, () => undefined)
  const replacement = readFileSync(snapshotStore.taskSnapshotsDbFile(replacementRoot))
  writeFileSync(fixture.databasePath, replacement)
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, async () => {
      throw new Error('same-version replacement must fail before candidate build')
    })),
    (error) => error?.code === 'COMMITTED_TARGET_IDENTITY_MISMATCH',
    'same-version valid empty v8 replacement must fail store identity continuity'
  )
  console.log('[PASS] committed target rejects same-version valid empty store replacement')
}

async function committedCanonicalSupersetV8UpgradesToV9() {
  const fixture = await seedStore('committed-canonical-superset-v8', {
    projectId: 'project-committed-canonical-upgrade'
  })
  mutateDb(fixture.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
  const v8 = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate))
  assertEqual(v8.migration.journal.toVersion, 8, 'canonical-superset fixture must retain a committed v8 anchor')

  const canonicalOnly = await makeSnapshot(
    'canonical-only-after-v8-anchor',
    'project-committed-canonical-upgrade',
    undefined,
    2000
  )
  mutateDb(fixture.databasePath, (db) => insertCanonicalRecovery(db, canonicalOnly))
  const sourceReport = await migration.assessWorkflowLedgerCanonicalReadinessFile(fixture.databasePath, {
    assessedAt: 42
  })
  assertEqual(sourceReport.safeForShadowUse, false, 'anchored canonical superset must not claim shadow parity')
  assertEqual(sourceReport.readyForCanonicalRead, true, 'anchored canonical superset must remain canonical-ready')

  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const upgraded = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, (source) =>
    buildVersionedCandidate(source, 9), {
    supportedStoreVersion: 9,
    targetStoreVersion: 9,
    readMode: 'canonical'
  }))
  assertEqual(upgraded.migration.journal.mode, 'canonical', 'anchored v8->v9 journal mode')
  assertEqual(upgraded.migration.journal.fromVersion, 8, 'anchored v8->v9 source version')
  assertEqual(upgraded.migration.journal.toVersion, 9, 'anchored v8->v9 target version')
  assertEqual(readStoreVersion(fixture.databasePath), 9, 'anchored canonical-superset target version')
  assert(captureTableRows(readFileSync(fixture.databasePath), 'workflow_recovery_sessions')
    .some((row) => row[0] === canonicalOnly.id), 'anchored canonical-only recovery row must survive v9 upgrade')
  console.log('[PASS] committed v8 anchor permits identity-bound canonical-superset v9 upgrade')
}

async function futureAndCorruptionFailClosed() {
  const future = await seedStore('future-schema', { projectId: 'project-future' })
  mutateDb(future.databasePath, (db) => db.run('PRAGMA user_version = 99'))
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(future, async () => {
      throw new Error('future schema must not call builder')
    })),
    (error) => error?.code === 'FUTURE_SCHEMA',
    'future schema should fail before migration'
  )
  assert(!findJournalRoot(future.root), 'future schema must not create a journal')

  const corrupt = await seedStore('corrupt-v6', { projectId: 'project-corrupt' })
  mutateDb(corrupt.databasePath, (db) => {
    db.run('PRAGMA user_version = 6')
    db.run("UPDATE task_runs SET updated_at = updated_at + 1 WHERE id = 'run-corrupt-v6'")
  })
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(corrupt, async () => {
      throw new Error('corrupt source must not call builder')
    })),
    (error) => error?.code === 'CANONICAL_READINESS_BLOCKED',
    'corrupt v6 source should fail before builder'
  )
  assert(!findJournalRoot(corrupt.root), 'corrupt source must not create a journal')

  const activeMissing = await seedStore('active-without-snapshot', { projectId: 'project-active' })
  mutateDb(activeMissing.databasePath, (db) => db.run("DELETE FROM task_snapshots WHERE id = 'session-active-without-snapshot'"))
  const report = await migration.assessWorkflowLedgerCanonicalReadinessFile(activeMissing.databasePath, { assessedAt: 43 })
  assert(report.diagnostics.some((item) => item.code === 'active_run_without_snapshot'), 'active Run gap diagnostic')
  assertEqual(report.counts.activeRunsWithoutSnapshot, 1, 'active Run gap count')
  assertEqual(report.status, 'blocked', 'active Run gap must block')

  const snapshotOnly = await seedStore('snapshot-without-run', { projectId: 'project-compat', run: null })
  const compat = await migration.assessWorkflowLedgerCanonicalReadinessFile(snapshotOnly.databasePath, { assessedAt: 44 })
  assert(compat.diagnostics.some((item) => item.code === 'legacy_snapshot_without_run'), 'Snapshot compatibility diagnostic')
  assertEqual(compat.status, 'ready', 'Snapshot compatibility is not corruption')
  assertEqual(compat.readyForCanonicalRead, true, 'v8 recovery projection makes Snapshot compatibility canonical-ready')
  console.log('[PASS] future/corrupt/active gates and compatibility diagnostics')
}

async function fenceReadinessBoundaries() {
  const missing = await seedStore('missing-fence', { projectId: 'project-missing-fence', run: null })
  mutateDb(missing.databasePath, (db) => db.run('DROP TABLE effect_resource_fences'))
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const repaired = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(missing, buildCandidate))
  assertEqual(repaired.disposition, 'migrated', 'missing fence table should use additive migration')

  const protectedMissing = await seedStore('missing-fence-with-lease', { projectId: 'project-missing-fence-lease' })
  mutateDb(protectedMissing.databasePath, (db) => db.run('DROP TABLE effect_resource_fences'))
  const protectedBytes = readFileSync(protectedMissing.databasePath)
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(protectedMissing, buildCandidate)),
    (error) => error?.code === 'CANONICAL_READINESS_BLOCKED' && String(error.message).includes('fence_table_missing_with_leases'),
    'missing fence table with lease state must fail closed'
  )
  assertEqual(Buffer.compare(protectedBytes, readFileSync(protectedMissing.databasePath)), 0, 'missing fence lease state must preserve bytes')

  const invalid = await seedStore('invalid-fence', { projectId: 'project-invalid-fence' })
  mutateDb(invalid.databasePath, (db) => db.run(
    "INSERT INTO effect_resource_fences(resource_key, fencing_token) VALUES ('invalid-fence', -1)"
  ))
  const invalidBytes = readFileSync(invalid.databasePath)
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(invalid, buildCandidate)),
    (error) => error?.code === 'CANONICAL_READINESS_BLOCKED' && String(error.message).includes('fence_row_invalid'),
    'invalid fence row must fail before candidate mutation'
  )
  assertEqual(Buffer.compare(invalidBytes, readFileSync(invalid.databasePath)), 0, 'invalid fence must preserve source bytes')
  console.log('[PASS] fence table readiness and additive repair boundaries')
}

async function v6TerminalEvidenceAndFinalizerPreservation() {
  const fixture = await seedStore('v6-terminal-evidence', {
    projectId: 'project-evidence',
    terminal: true,
    waitingReconciliation: true
  })
  const persisted = (await snapshotStore.listTaskRuns(undefined, fixture.root))[0]
  const terminalRun = {
    ...persisted,
    status: 'failed',
    revision: persisted.revision + 1,
    updatedAt: persisted.updatedAt + 1,
    finishedAt: persisted.updatedAt + 1,
    error: 'reconciliation remains required'
  }
  await snapshotStore.deleteTaskSnapshot(terminalRun.sessionId, fixture.root, terminalRun)
  await insertFinalizer(fixture.root, 'independent-finalizer-parent')
  mutateDb(fixture.databasePath, (db) => {
    db.run(
      'UPDATE task_runs SET updated_at = ?, payload = ? WHERE id = ?',
      [terminalRun.updatedAt, JSON.stringify(terminalRun), terminalRun.id]
    )
    db.run(
      'INSERT OR REPLACE INTO effect_resource_fences(resource_key, fencing_token) VALUES (?, ?)',
      [terminalRun.effects[0].resourceKey, 7]
    )
  })
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const sourceBytes = readFileSync(fixture.databasePath)
  const before = captureStateRows(sourceBytes)
  mutateDb(fixture.databasePath, (db) => {
    db.run('PRAGMA user_version = 6')
    dropWorkflowProjectionTables(db)
  })
  const afterDrop = readFileSync(fixture.databasePath)
  const sourceEvidence = captureTableRows(afterDrop, 'task_evidence')
  const sourceFences = captureTableRows(afterDrop, 'effect_resource_fences')
  assertEqual(sourceFences.length, 1, 'source must contain a real fencing row')
  let builds = 0
  const result = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, async (source) => {
    builds += 1
    return buildCandidate(source)
  }))
  assertEqual(result.disposition, 'migrated', 'v6 terminal source should migrate')
  assertEqual(builds, 1, 'v6 terminal builder count')
  const candidate = readFileSync(fixture.databasePath)
  const after = captureStateRows(candidate)
  assertEqual(JSON.stringify(after.taskRuns), JSON.stringify(before.taskRuns), 'terminal TaskRun payload preserved')
  assertEqual(JSON.stringify(captureTableRows(candidate, 'task_evidence')), JSON.stringify(sourceEvidence), 'evidence rows preserved')
  assertEqual(JSON.stringify(captureTableRows(candidate, 'effect_resource_fences')), JSON.stringify(sourceFences), 'fencing rows preserved')
  assert(after.taskRuns[0].effects[0].generation === 3, 'effect generation preserved')
  assert(after.taskRuns[0].effects[0].status === 'waiting_reconciliation', 'reconciliation state preserved')
  assertEqual(readColumn(candidate, 'workflow_runs', 'project_id'), 'project-evidence',
    'evidence-only terminal Run must retain project ownership')
  const report = await migration.assessWorkflowLedgerCanonicalReadinessFile(fixture.databasePath, { assessedAt: 45 })
  assertEqual(report.counts.terminalRunsWithoutSnapshot, 1, 'terminal compatibility count')
  assert(report.diagnostics.some((item) => item.code === 'terminal_run_without_snapshot'), 'terminal compatibility diagnostic')
  assertEqual(report.counts.dagFinalizations, 1, 'DAG finalizer count')
  assert(report.verification?.taskDagFinalizations.valid, 'DAG finalizer verification')
  console.log('[PASS] v6 terminal/evidence/fencing/finalizer preservation')
}

async function v6MultiRunSessionOwnershipPreservation() {
  const root = path.join(tempRoot, 'v6-multi-run-session-ownership')
  const sessionId = 'session-v6-multi-run'
  const projectId = 'project-v6-multi-run'
  const databasePath = snapshotStore.taskSnapshotsDbFile(root)
  mkdirSync(root, { recursive: true })
  const firstRun = {
    schemaVersion: 1,
    id: 'run-v6-history',
    sessionId,
    taskId: sessionId,
    status: 'completed',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 10,
    updatedAt: 100,
    startedAt: 20,
    finishedAt: 100,
    steps: [],
    toolExecutions: [],
    effects: []
  }
  const currentRun = {
    schemaVersion: 1,
    id: 'run-v6-current',
    sessionId,
    taskId: sessionId,
    status: 'executing',
    revision: 1,
    attempt: 2,
    recoveryCount: 0,
    createdAt: 200,
    updatedAt: 300,
    startedAt: 210,
    steps: [],
    toolExecutions: [],
    effects: []
  }
  await snapshotStore.saveTaskSnapshot(await makeSnapshot(sessionId, projectId, firstRun, 100), root)
  await snapshotStore.saveTaskSnapshot(await makeSnapshot(sessionId, projectId, currentRun, 300), root)
  rmSync(path.join(root, 'backups'), { recursive: true, force: true })
  mutateDb(databasePath, (db) => {
    dropWorkflowProjectionTables(db)
    db.run('PRAGMA user_version = 6')
  })
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  const fixture = {
    root,
    databasePath,
    legacyPath: snapshotStore.taskSnapshotsFile(root)
  }
  const result = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate))
  assertEqual(result.disposition, 'migrated', 'v6 multi-run source should migrate')
  const ownership = readWorkflowRunOwnership(databasePath)
  const historical = ownership.get(firstRun.id)
  const current = ownership.get(currentRun.id)
  assertEqual(historical?.projectId, projectId, 'historical Run must inherit session project ownership')
  assertEqual(current?.projectId, projectId, 'current Run project ownership')
  assertEqual(historical?.workItemId, current?.workItemId,
    'same-session historical/current Runs must remain in one WorkItem')
  console.log('[PASS] v6 no-evidence multi-run session ownership preservation')
}

async function v2AndLegacySources() {
  const v2 = await seedStore('v2-source', { projectId: 'project-v2', run: null })
  mutateDb(v2.databasePath, (db) => {
    db.run('DROP TABLE IF EXISTS task_runs')
    dropWorkflowProjectionTables(db)
    db.run('PRAGMA user_version = 2')
  })
  const v2Before = readFileSync(v2.databasePath)
  const v2Result = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(v2, buildCandidate))
  assertEqual(v2Result.disposition, 'migrated', 'v2 source migration')
  assert(v2Before.length > 0, 'v2 source bytes')

  for (const [label, encoded] of [
    ['legacy-array', JSON.stringify([await makeSnapshot('legacy-array', 'project-legacy')])],
    ['legacy-object', `${JSON.stringify({ version: 1, snapshots: [await makeSnapshot('legacy-object', 'project-legacy')] }, null, 2)}\n`]
  ]) {
    const root = path.join(tempRoot, label)
    mkdirSync(root, { recursive: true })
    const legacyPath = snapshotStore.taskSnapshotsFile(root)
    const databasePath = snapshotStore.taskSnapshotsDbFile(root)
    const bytes = Buffer.from(encoded, 'utf8')
    writeFileSync(legacyPath, bytes)
    const fixture = { root, databasePath, legacyPath }
    const result = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate))
    assertEqual(result.migration.journal.sourceKind, 'legacy_json', `${label} source kind`)
    assertEqual(result.migration.journal.sourcePath, path.resolve(legacyPath), `${label} source path`)
    assertEqual(Buffer.compare(bytes, readFileSync(result.migration.backupPath)), 0, `${label} exact backup bytes`)
    assertEqual(result.migration.journal.source.sizeBytes, bytes.length, `${label} source size`)
  }
  console.log('[PASS] v2 and legacy array/object source discovery with exact JSON backup')
}

async function emptySourceMigration() {
  const root = path.join(tempRoot, 'empty-source')
  mkdirSync(root, { recursive: true })
  const fixture = {
    root,
    databasePath: path.join(root, 'task-snapshots.db'),
    legacyPath: path.join(root, 'task-snapshots.json')
  }
  const result = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate))
  assertEqual(result.migration.journal.sourceKind, 'empty', 'empty source kind')
  assert(existsSync(fixture.databasePath), 'empty migration creates target')
  console.log('[PASS] empty source migration')
}

async function maliciousCandidateIsBlocked() {
  const fixture = await seedStore('malicious-candidate', { projectId: 'project-malicious' })
  mutateDb(fixture.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
  const before = readFileSync(fixture.databasePath)
  let builds = 0
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, async () => {
      builds += 1
      const emptyRoot = path.join(tempRoot, `malicious-empty-${builds}`)
      mkdirSync(emptyRoot, { recursive: true })
      return buildCandidate({ sourceKind: 'empty', sourceBytes: new Uint8Array(), targetPath: fixture.databasePath })
    })),
    (error) => String(error?.code).startsWith('MIGRATION_PRESERVATION_'),
    'candidate dropping legacy rows must be blocked by preservation gate'
  )
  assertEqual(builds, 1, 'malicious builder count')
  assertEqual(Buffer.compare(before, readFileSync(fixture.databasePath)), 0, 'malicious candidate must not rename source')
  console.log('[PASS] source preservation blocks a self-consistent but lossy candidate')
}

async function faultCheckpointsResume() {
  const checkpoints = [
    'after_prepared_journal',
    'after_backup_write',
    'after_backup_verified',
    'after_migrated_verified',
    'before_source_rename',
    'after_source_rename',
    'before_journal_commit',
    'after_journal_commit'
  ]
  for (const checkpoint of checkpoints) {
    const fixture = await seedStore(`fault-${checkpoint}`, { projectId: `project-${checkpoint}` })
    mutateDb(fixture.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
    let builds = 0
    const builder = async (source) => {
      builds += 1
      return buildCandidate(source)
    }
    migration.clearWorkflowLedgerMigrationSingleFlightForTests()
    await assertRejects(
      migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, builder, { faultAt: checkpoint })),
      (error) => error?.checkpoint === checkpoint,
      `${checkpoint} should inject a fault`
    )
    migration.clearWorkflowLedgerMigrationSingleFlightForTests()
    const resumed = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, builder))
    assert(['migrated', 'ready_existing_v8'].includes(resumed.disposition), `${checkpoint} should resume`)
    if (checkpoint === 'after_migrated_verified' || checkpoint === 'before_source_rename' || checkpoint === 'after_source_rename') {
      assertEqual(builds, 1, `${checkpoint} must reuse durable candidate bytes`)
    }
  }
  console.log('[PASS] prepared/backup/verified/rename/commit fault checkpoints resume')
}

async function corruptJournalFailsClosed() {
  const fixture = await seedStore('corrupt-journal', { projectId: 'project-journal' })
  mutateDb(fixture.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate, { faultAt: 'after_prepared_journal' })),
    (error) => error?.checkpoint === 'after_prepared_journal',
    'journal corruption setup fault'
  )
  const journalPath = findJournalPath(fixture.root)
  const original = readFileSync(journalPath, 'utf8')
  writeFileSync(journalPath, `${original.slice(0, -2)}\n`, 'utf8')
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate)),
    (error) => error?.code === 'MIGRATION_JOURNAL_INVALID',
    'corrupt journal must fail closed'
  )
  console.log('[PASS] corrupt migration journal fails closed')
}

async function rollbackBoundaries() {
  const fixture = await seedStore('rollback-sqlite', { projectId: 'project-rollback' })
  mutateDb(fixture.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
  const original = readFileSync(fixture.databasePath)
  const migrated = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(fixture, buildCandidate))
  const journalPath = migrated.migration.journalPath
  const rolled = await migration.rollbackWorkflowLedgerCanonicalMigration(journalPath, {
    expectedTargetPath: fixture.databasePath,
    now: () => 8000
  })
  assertEqual(rolled.state, 'rolled_back', 'rollback state')
  assertEqual(Buffer.compare(original, readFileSync(fixture.databasePath)), 0, 'rollback exact SQLite bytes')

  const mismatch = await seedStore('rollback-target-mismatch', { projectId: 'project-rollback-mismatch' })
  mutateDb(mismatch.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
  const mismatchResult = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(mismatch, buildCandidate))
  await assertRejects(
    migration.rollbackWorkflowLedgerCanonicalMigration(mismatchResult.migration.journalPath, {
      expectedTargetPath: path.join(mismatch.root, 'other.db')
    }),
    (error) => error?.code === 'MIGRATION_TARGET_MISMATCH',
    'rollback target mismatch must reject'
  )

  const pending = await seedStore('rollback-pending', { projectId: 'project-rollback-pending' })
  mutateDb(pending.databasePath, (db) => db.run('DROP TABLE workflow_artifact_locations'))
  const pendingOriginal = readFileSync(pending.databasePath)
  const pendingResult = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(pending, buildCandidate))
  await assertRejects(
    migration.rollbackWorkflowLedgerCanonicalMigration(pendingResult.migration.journalPath, {
      expectedTargetPath: pending.databasePath,
      faultAt: 'after_rollback_source_change'
    }),
    (error) => error?.checkpoint === 'after_rollback_source_change',
    'rollback pending fault'
  )
  await assertRejects(
    migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(pending, buildCandidate)),
    (error) => error?.code === 'MIGRATION_ROLLBACK_COMPLETED',
    'startup must finish pending rollback before releasing store'
  )
  assertEqual(Buffer.compare(pendingOriginal, readFileSync(pending.databasePath)), 0, 'pending rollback restores bytes')

  const legacyRoot = path.join(tempRoot, 'rollback-legacy')
  mkdirSync(legacyRoot, { recursive: true })
  const legacyPath = snapshotStore.taskSnapshotsFile(legacyRoot)
  const legacyBytes = Buffer.from(JSON.stringify({ version: 1, snapshots: [await makeSnapshot('rollback-legacy', 'project-legacy')] }))
  writeFileSync(legacyPath, legacyBytes)
  const legacyFixture = { root: legacyRoot, databasePath: snapshotStore.taskSnapshotsDbFile(legacyRoot), legacyPath }
  const legacyResult = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(legacyFixture, buildCandidate))
  writeFileSync(legacyPath, Buffer.from(`${legacyBytes} changed`))
  await assertRejects(
    migration.rollbackWorkflowLedgerCanonicalMigration(legacyResult.migration.journalPath, {
      expectedTargetPath: legacyFixture.databasePath
    }),
    (error) => error?.code === 'ROLLBACK_SOURCE_DIGEST_MISMATCH',
    'modified legacy JSON must block rollback'
  )

  const missingLegacyRoot = path.join(tempRoot, 'rollback-legacy-missing')
  mkdirSync(missingLegacyRoot, { recursive: true })
  const missingLegacyPath = snapshotStore.taskSnapshotsFile(missingLegacyRoot)
  const missingLegacyBytes = Buffer.from(JSON.stringify({ version: 1, snapshots: [await makeSnapshot('rollback-legacy-missing', 'project-legacy')] }))
  writeFileSync(missingLegacyPath, missingLegacyBytes)
  const missingLegacyFixture = {
    root: missingLegacyRoot,
    databasePath: snapshotStore.taskSnapshotsDbFile(missingLegacyRoot),
    legacyPath: missingLegacyPath
  }
  const missingLegacyResult = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(missingLegacyFixture, buildCandidate))
  rmSync(missingLegacyPath, { force: true })
  const restoredMissing = await migration.rollbackWorkflowLedgerCanonicalMigration(missingLegacyResult.migration.journalPath, {
    expectedTargetPath: missingLegacyFixture.databasePath
  })
  assertEqual(restoredMissing.state, 'rolled_back', 'missing legacy source should be restored from backup')
  assertEqual(Buffer.compare(missingLegacyBytes, readFileSync(missingLegacyPath)), 0, 'missing legacy source bytes must restore exactly')
  assert(!existsSync(missingLegacyFixture.databasePath), 'legacy rollback must remove its migration-created target')

  const collisionRoot = path.join(tempRoot, 'rollback-legacy-candidate-name')
  mkdirSync(collisionRoot, { recursive: true })
  const collisionLegacyPath = path.join(collisionRoot, 'candidate.sqlite')
  const collisionFixture = {
    root: collisionRoot,
    databasePath: snapshotStore.taskSnapshotsDbFile(collisionRoot),
    legacyPath: collisionLegacyPath
  }
  writeFileSync(collisionLegacyPath, JSON.stringify({ version: 1, snapshots: [await makeSnapshot('collision', 'project-collision')] }))
  const collisionResult = await migration.ensureWorkflowLedgerTaskStoreReady(optionsFor(collisionFixture, buildCandidate))
  assertEqual(path.basename(collisionResult.migration.backupPath), 'source-candidate.sqlite', 'backup path must be namespaced away from candidate')
  assert(collisionResult.migration.journal.candidate.path !== collisionResult.migration.backupPath, 'backup and candidate paths must differ')
  console.log('[PASS] rollback exact restore, target/source drift gates, and rollback_pending recovery')
}

function optionsFor(fixture, builder, overrides = {}) {
  return {
    databasePath: fixture.databasePath,
    legacyJsonPath: fixture.legacyPath ?? path.join(fixture.root, 'task-snapshots.json'),
    supportedStoreVersion: 8,
    targetStoreVersion: 8,
    backupsRoot: fixture.backupsRoot ?? path.join(fixture.root, 'backups'),
    buildCandidate: builder,
    now: () => 1000,
    ...overrides
  }
}

async function buildCandidate(source) {
  const root = mkdtempSync(path.join(tempRoot, `candidate-${++buildCounter}-`))
  const databasePath = snapshotStore.taskSnapshotsDbFile(root)
  const legacyPath = snapshotStore.taskSnapshotsFile(root)
  mkdirSync(root, { recursive: true })
  if (source.sourceKind === 'sqlite') writeFileSync(databasePath, Buffer.from(source.sourceBytes))
  if (source.sourceKind === 'legacy_json') writeFileSync(legacyPath, Buffer.from(source.sourceBytes))
  await snapshotStore.listTaskSnapshots(root)
  await snapshotStore.mutateTaskSnapshotDatabase(root, () => undefined)
  return readFileSync(databasePath)
}

async function buildVersionedCandidate(source, version) {
  const db = source.sourceKind === 'sqlite'
    ? new SQL.Database(source.sourceBytes)
    : new SQL.Database()
  try {
    snapshotSchema.setupTaskSnapshotSchema(db, version)
    return db.export()
  } finally {
    db.close()
  }
}

async function seedStore(name, options = {}) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  const projectId = options.projectId ?? 'project-default'
  const sessionId = options.sessionId ?? `session-${name}`
  const run = options.run === null
    ? undefined
    : buildRun(`run-${name}`, sessionId, sessionId, {
        terminal: options.terminal,
        waitingReconciliation: options.waitingReconciliation,
        projectId
      })
  const snapshot = await makeSnapshot(sessionId, projectId, run)
  await snapshotStore.saveTaskSnapshot(snapshot, root)
  if (options.finalizer) await insertFinalizer(root, sessionId)
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  rmSync(path.join(root, 'backups'), { recursive: true, force: true })
  return {
    root,
    databasePath: snapshotStore.taskSnapshotsDbFile(root),
    legacyPath: snapshotStore.taskSnapshotsFile(root),
    snapshot,
    run
  }
}

async function makeSnapshot(id, projectId, run, now) {
  return snapshotStore.buildTaskSnapshot({
    meta: buildMeta(id, projectId),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    ...(now === undefined ? {} : { now })
  })
}

function buildMeta(id, projectId) {
  return {
    id,
    title: `Migration ${id}`,
    cwd: tempRoot,
    sourceCwd: tempRoot,
    repoRoot: tempRoot,
    isolated: false,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: `sdk-${id}`,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1,
    projectId
  }
}

function buildRun(id, sessionId, taskId, options = {}) {
  const updatedAt = options.terminal ? 300 : 100
  const generation = options.waitingReconciliation ? 3 : 1
  const status = options.terminal ? 'failed' : 'executing'
  const effectStatus = options.waitingReconciliation ? 'waiting_reconciliation' : 'confirmed'
  return {
    schemaVersion: 1,
    id,
    sessionId,
    taskId,
    status,
    revision: generation,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt,
    ...(options.terminal ? { finishedAt: updatedAt, error: 'reconciliation required' } : {}),
    effects: [{
      schemaVersion: 1,
      id: `effect-${id}`,
      effectKey: `effect-key-${id}`,
      resourceKey: `resource-key-${id}`,
      sessionId,
      runId: id,
      toolUseId: `tool-${id}`,
      toolName: 'fixture-tool',
      generation,
      revision: generation,
      status: effectStatus,
      reconcilability: 'queryable',
      target: { kind: 'unsupported', toolName: 'fixture-tool' },
      targetDigest: `target-${id}`,
      intentDigest: `intent-${id}`,
      inputDigest: `input-${id}`,
      lease: { id: `lease-${id}`, ownerId: `owner-${id}`, fencingToken: 7, acquiredAt: 10, expiresAt: 10000 },
      evidence: [{
        id: `evidence-${id}`,
        kind: options.waitingReconciliation ? 'reconciliation' : 'execution_result',
        digest: `evidence-digest-${id}`,
        observedAt: 20,
        verifier: 'migration-smoke',
        generation
      }],
      createdAt: 1,
      updatedAt
    }]
  }
}

async function insertFinalizer(root, parentSessionId) {
  const execution = terminalExecution(`finalizer-${parentSessionId}`, parentSessionId)
  const record = finalization.createTaskDagFinalizationRecord({ terminalExecution: execution, now: 1000 })
  mutateDb(snapshotStore.taskSnapshotsDbFile(root), (db) => {
    db.run(
      'INSERT INTO dag_finalizers(execution_id, parent_session_id, revision, updated_at, payload) VALUES (?, ?, ?, ?, ?)',
      [record.executionId, record.parentSessionId, record.revision, record.updatedAt, JSON.stringify(record)]
    )
  })
}

function terminalExecution(id, parentSessionId) {
  const task = { id: 'write-once', title: 'Write once', description: 'Write once', dependencies: [], role: 'backend', prompt: 'write once' }
  return {
    id, parentSessionId,
    dag: { id, title: 'Finalizer fixture', source: 'migration smoke', complexity: 'single', createdAt: 1, tasks: [task] },
    status: 'success', maxRetries: 0, startedAt: 1, completedAt: 2, layers: [['write-once']],
    tasks: [{ task, status: 'success', attempts: 1, sessionIds: ['child'], startedAt: 1, completedAt: 2, resultText: 'done' }],
    summary: '1/1 tasks succeeded'
  }
}

function mutateDb(databasePath, mutator) {
  const db = new SQL.Database(readFileSync(databasePath))
  try {
    mutator(db)
    writeFileSync(databasePath, db.export())
  } finally {
    db.close()
  }
}

function insertCanonicalRecovery(db, snapshot) {
  const payload = workflowCodec.canonicalJson(snapshot)
  db.run(
    `INSERT INTO workflow_recovery_sessions(
       id, session_id, task_id, project_id, run_id, updated_at, payload_digest, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.sessionId,
      snapshot.taskId,
      snapshot.meta.projectId ?? null,
      snapshot.run?.id ?? null,
      snapshot.updatedAt,
      workflowCodec.digest(snapshot),
      payload
    ]
  )
}

function dropWorkflowProjectionTables(db) {
  for (const table of [
    'workflow_evidence', 'workflow_evidence_links', 'workflow_events', 'workflow_artifact_edges', 'workflow_artifact_locations',
    'workflow_recovery_sessions', 'workflow_acceptances', 'workflow_artifacts', 'workflow_runs',
    'workflow_work_items', 'workflow_goals'
  ]) db.run(`DROP TABLE IF EXISTS ${table}`)
}

function captureStateRows(bytes) {
  const db = new SQL.Database(bytes)
  try {
    const result = db.exec('SELECT id, session_id, updated_at, payload FROM task_runs ORDER BY id')
    const taskRuns = result[0]?.values ?? []
    return { taskRuns: taskRuns.map((row) => JSON.parse(row[3])) }
  } finally {
    db.close()
  }
}

function readWorkflowRunOwnership(databasePath) {
  const db = new SQL.Database(readFileSync(databasePath))
  try {
    const rows = db.exec('SELECT id, project_id, work_item_id FROM workflow_runs ORDER BY id')[0]?.values ?? []
    return new Map(rows.map(([id, projectId, workItemId]) => [id, { projectId, workItemId }]))
  } finally {
    db.close()
  }
}

function captureTableRows(bytes, table) {
  const db = new SQL.Database(bytes)
  try { return readRows(db, table) } finally { db.close() }
}

function readColumn(bytes, table, column) {
  const db = new SQL.Database(bytes)
  try {
    const result = db.exec(`SELECT ${column} FROM ${table} LIMIT 1`)
    return result[0]?.values[0]?.[0]
  } finally {
    db.close()
  }
}

function readStoreVersion(databasePath) {
  const db = new SQL.Database(readFileSync(databasePath))
  try { return db.exec('PRAGMA user_version')[0]?.values[0]?.[0] } finally { db.close() }
}

function readRows(db, table) {
  try {
    const result = db.exec(`SELECT * FROM ${table}`)
    if (!result[0]) return []
    return result[0].values.map((values) => values.map((value) => value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value))
  } catch {
    return []
  }
}

function findJournalRoot(root) {
  const backups = path.join(root, 'backups')
  if (!existsSync(backups)) return null
  return readdirSync(backups, { withFileTypes: true }).find((entry) => entry.isDirectory() && !entry.name.startsWith('.creating-'))
    ? backups
    : null
}

function findJournalPath(root) {
  const backups = path.join(root, 'backups')
  for (const entry of readdirSync(backups, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.creating-')) continue
    const candidate = path.join(backups, entry.name, 'journal.json')
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`journal not found under ${backups}`)
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-migration.ts',
    'src/main/agent/dag-finalization.ts',
    '--outDir', outDir, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--types', 'node', '--skipLibCheck', '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(tempRoot)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  const found = findCompiledModuleInTree(root, name)
  if (found) return found
  throw new Error(`compiled ${name} not found under ${root}`)
}

function findCompiledModuleInTree(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleInTree(full, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) return full
  }
  return null
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function assertRejects(promise, predicate, message) {
  try { await promise } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected ${error?.stack ?? error}`)
  }
  throw new Error(`${message}: unexpectedly succeeded`)
}

function assert(condition, message) { if (!condition) throw new Error(message) }
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
