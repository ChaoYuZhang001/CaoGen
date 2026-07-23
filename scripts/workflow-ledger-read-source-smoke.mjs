import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workflow-read-source-'))
const outDir = path.join(tempRoot, 'compiled')
const primaryRoot = path.join(tempRoot, 'primary')
const canonicalOnlyRoot = path.join(tempRoot, 'canonical-only')
const missingLegacyTablesRoot = path.join(tempRoot, 'missing-legacy-tables')
const migrationRoot = path.join(tempRoot, 'v7-migration')

try {
  compileSources()
  installElectronStub()
  const snapshotStore = await import(pathToFileURL(findCompiledModule('task-snapshot.js')).href)
  const migration = await import(pathToFileURL(findCompiledModule('workflow-ledger-migration.js')).href)
  const SQL = await require('sql.js')({
    locateFile: (file) => file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file
  })

  assertEqual(
    migration.workflowLedgerReadinessSupportsMode(
      { safeForShadowUse: true, readyForCanonicalRead: false },
      'canonical'
    ),
    false,
    'canonical mode must not fall through a shadow-ready but canonical-unready report'
  )
  assertEqual(
    migration.workflowLedgerReadinessSupportsMode(
      { safeForShadowUse: false, readyForCanonicalRead: true },
      'canonical'
    ),
    true,
    'existing canonical mode may ignore legacy-only drift'
  )
  assertEqual(
    migration.workflowLedgerReadinessSupportsMode(
      { safeForShadowUse: false, readyForCanonicalRead: true },
      'canonical',
      true
    ),
    false,
    'canonical migration candidates must retain dual-write parity'
  )

  mkdirSync(primaryRoot, { recursive: true })
  const firstRun = buildRun('run-1', 'completed', 1, 100)
  const firstSnapshot = buildSnapshot(snapshotStore, firstRun, 1, 100)
  await snapshotStore.saveTaskSnapshot(firstSnapshot, primaryRoot)

  const secondRun = buildRun('run-2', 'executing', 1, 200)
  const secondSnapshot = buildSnapshot(snapshotStore, secondRun, 2, 200)
  await snapshotStore.saveTaskSnapshot(secondSnapshot, primaryRoot)
  const primaryDb = snapshotStore.taskSnapshotsDbFile(primaryRoot)

  assertEqual(readUserVersion(SQL, primaryDb), 8, 'task store must migrate to v8')
  assertEqual(rowCount(SQL, primaryDb, 'workflow_recovery_sessions'), 1, 'one current recovery session')
  assertEqual(rowCount(SQL, primaryDb, 'workflow_runs'), 2, 'multi-run history must remain canonical')
  assertEqual(readRecoveryRunId(SQL, primaryDb), 'run-2', 'only current session recovery is projected')

  await snapshotStore.configureWorkflowLedgerReadMode('compare', primaryRoot)
  assertEqual(snapshotStore.getWorkflowLedgerReadMode(primaryRoot), 'compare', 'runtime mode flip to compare')
  assertEqual((await snapshotStore.listTaskRuns('session-cutover', primaryRoot)).length, 2, 'compare run history')
  assertEqual((await snapshotStore.listTaskSnapshots(primaryRoot))[0].run.id, 'run-2', 'compare recovery source')

  const healthyBytes = readFileSync(primaryDb)
  mutateDb(SQL, primaryDb, (db) => {
    db.run(
      `UPDATE task_snapshots SET updated_at = ?, payload = ? WHERE id = ?`,
      [firstSnapshot.updatedAt, JSON.stringify(firstSnapshot), firstSnapshot.id]
    )
  })
  const driftedBytes = readFileSync(primaryDb)
  await assertRejects(
    () => snapshotStore.listTaskSnapshots(primaryRoot),
    'differs between legacy and canonical read sources',
    'compare read must fail closed on parity drift'
  )
  await assertRejects(
    () => snapshotStore.saveTaskSnapshot(
      buildSnapshot(snapshotStore, { ...secondRun, revision: 2, updatedAt: 250 }, 3, 250),
      primaryRoot
    ),
    'differs between legacy and canonical read sources',
    'compare prior-state read must block writes on parity drift'
  )
  await assertRejects(
    () => snapshotStore.configureWorkflowLedgerReadMode('canonical', primaryRoot),
    'workflow_recovery_digest_mismatch',
    'stale canonical projection must block a runtime canonical flip'
  )
  assertEqual(snapshotStore.getWorkflowLedgerReadMode(primaryRoot), 'compare',
    'blocked canonical flip must preserve compare mode')
  assertEqual(
    Buffer.compare(driftedBytes, readFileSync(primaryDb)),
    0,
    'blocked compare write must preserve database bytes'
  )
  writeFileSync(primaryDb, healthyBytes)

  await snapshotStore.configureWorkflowLedgerReadMode('canonical', primaryRoot)
  const updatedRun = { ...secondRun, revision: 2, updatedAt: 300 }
  const updatedSnapshot = buildSnapshot(snapshotStore, updatedRun, 3, 300)
  await snapshotStore.saveTaskSnapshot(updatedSnapshot, primaryRoot)
  assertEqual((await snapshotStore.getTaskSnapshot('session-cutover', primaryRoot)).run.revision, 2,
    'canonical prior-state write must advance current Run')
  await snapshotStore.configureWorkflowLedgerReadMode('compare', primaryRoot)
  assertEqual((await snapshotStore.listTaskRuns('session-cutover', primaryRoot)).length, 2,
    'canonical write must keep legacy and canonical history in parity')

  await assertRejects(
    () => snapshotStore.configureWorkflowLedgerReadMode('fallback', primaryRoot),
    'must be legacy, compare, or canonical',
    'invalid runtime mode must fail closed'
  )
  assertEqual(snapshotStore.getWorkflowLedgerReadMode(primaryRoot), 'compare',
    'invalid flip must preserve active mode')

  mkdirSync(canonicalOnlyRoot, { recursive: true })
  const canonicalOnlyDb = snapshotStore.taskSnapshotsDbFile(canonicalOnlyRoot)
  writeFileSync(canonicalOnlyDb, readFileSync(primaryDb))
  mutateDb(SQL, canonicalOnlyDb, (db) => {
    db.run('DELETE FROM task_snapshots')
    db.run('DELETE FROM task_runs')
  })
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  await snapshotStore.configureWorkflowLedgerReadMode('canonical', canonicalOnlyRoot)
  assertEqual((await snapshotStore.listTaskSnapshots(canonicalOnlyRoot))[0].run.id, 'run-2',
    'canonical recovery read must not depend on legacy Snapshot rows')
  assertEqual((await snapshotStore.listTaskRuns('session-cutover', canonicalOnlyRoot)).length, 2,
    'canonical Run history must not depend on legacy TaskRun rows')
  const canonicalOnlyUpdatedRun = { ...secondRun, revision: 3, updatedAt: 350 }
  await snapshotStore.saveTaskSnapshot(
    buildSnapshot(snapshotStore, canonicalOnlyUpdatedRun, 4, 350),
    canonicalOnlyRoot
  )
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  assertEqual((await snapshotStore.listTaskRuns('session-cutover', canonicalOnlyRoot)).length, 2,
    'canonical-only history must remain readable after a dual-write and process restart')
  assertEqual(snapshotStore.getWorkflowLedgerReadMode(primaryRoot), 'compare',
    'primary root mode must remain isolated')
  assertEqual(snapshotStore.getWorkflowLedgerReadMode(canonicalOnlyRoot), 'canonical',
    'canonical-only root mode must remain isolated')

  mkdirSync(missingLegacyTablesRoot, { recursive: true })
  const missingLegacyTablesDb = snapshotStore.taskSnapshotsDbFile(missingLegacyTablesRoot)
  writeFileSync(missingLegacyTablesDb, readFileSync(primaryDb))
  mutateDb(SQL, missingLegacyTablesDb, (db) => {
    db.run('DROP TABLE task_snapshots')
    db.run('DROP TABLE task_runs')
  })
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  await assertRejects(
    () => snapshotStore.configureWorkflowLedgerReadMode('canonical', missingLegacyTablesRoot),
    'legacy_snapshot_table_missing',
    'canonical mode must reject missing dual-write tables'
  )

  mkdirSync(migrationRoot, { recursive: true })
  const migrationDb = snapshotStore.taskSnapshotsDbFile(migrationRoot)
  writeFileSync(migrationDb, readFileSync(primaryDb))
  mutateDb(SQL, migrationDb, (db) => {
    db.run('DROP TABLE workflow_recovery_sessions')
    db.run('PRAGMA user_version = 7')
  })
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  await Promise.all([
    snapshotStore.listTaskSnapshots(migrationRoot),
    snapshotStore.configureWorkflowLedgerReadMode('canonical', migrationRoot)
  ])
  assertEqual(readUserVersion(SQL, migrationDb), 8, 'v7 source must migrate to v8')
  assertEqual(rowCount(SQL, migrationDb, 'workflow_runs'), 2, 'v7 migration must preserve multi-run history')
  assertEqual(rowCount(SQL, migrationDb, 'workflow_recovery_sessions'), 1,
    'v7 migration must project only the current recovery session')
  assertEqual(readRecoveryRunId(SQL, migrationDb), 'run-2', 'v7 migration current recovery binding')
  assertEqual(countCommittedMigrationJournals(migrationRoot), 1,
    'cross-mode first open must publish exactly one committed migration journal')

  writeFileSync(migrationDb, Buffer.alloc(0))
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  await assertRejects(
    () => snapshotStore.listTaskSnapshots(migrationRoot),
    'Committed migration target version regressed',
    'committed migration journal must prevent truncated target recreation'
  )
  assertEqual(readFileSync(migrationDb).byteLength, 0, 'truncated committed target must stay untouched')

  rmSync(migrationDb)
  migration.clearWorkflowLedgerMigrationSingleFlightForTests()
  await assertRejects(
    () => snapshotStore.listTaskSnapshots(migrationRoot),
    'Committed migration target is missing',
    'committed migration journal must prevent silent empty-store recreation'
  )
  assertEqual(require('node:fs').existsSync(migrationDb), false, 'missing committed target must stay absent')

  console.log('workflow-ledger read-source smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function buildSnapshot(snapshotStore, run, lastSeq, now) {
  return snapshotStore.buildTaskSnapshot({
    meta: {
      id: 'session-cutover',
      title: 'Canonical cutover',
      cwd: tempRoot,
      sourceCwd: tempRoot,
      repoRoot: tempRoot,
      isolated: false,
      model: 'fixture-model',
      providerId: 'fixture-provider',
      permissionMode: 'default',
      status: run.status === 'completed' ? 'idle' : 'running',
      sdkSessionId: 'sdk-cutover',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: 1,
      projectId: 'project-cutover'
    },
    transcript: [],
    lastSeq,
    eventCount: lastSeq,
    reason: 'important-event',
    run,
    now
  })
}

function buildRun(id, status, revision, updatedAt) {
  return {
    schemaVersion: 1,
    id,
    sessionId: 'session-cutover',
    taskId: 'session-cutover',
    status,
    revision,
    attempt: id === 'run-1' ? 1 : 2,
    recoveryCount: 0,
    createdAt: id === 'run-1' ? 10 : 150,
    updatedAt,
    ...(status === 'completed' ? { startedAt: 20, finishedAt: updatedAt } : { startedAt: 160 }),
    steps: []
  }
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
  writeFileSync(
    path.join(electronDir, 'index.js'),
    `export const app = { getPath: () => ${JSON.stringify(primaryRoot)} }\n`
  )
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(fileName) {
  const matches = []
  walk(outDir, matches, fileName)
  if (matches.length !== 1) throw new Error(`expected one compiled ${fileName}, found ${matches.length}`)
  return matches[0]
}

function walk(dir, matches, fileName) {
  for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, matches, fileName)
    else if (entry.name === fileName) matches.push(full)
  }
}

function mutateDb(SQL, databasePath, mutator) {
  const db = new SQL.Database(readFileSync(databasePath))
  try {
    mutator(db)
    writeFileSync(databasePath, db.export())
  } finally {
    db.close()
  }
}

function readUserVersion(SQL, databasePath) {
  return readScalar(SQL, databasePath, 'PRAGMA user_version')
}

function rowCount(SQL, databasePath, table) {
  return readScalar(SQL, databasePath, `SELECT COUNT(*) FROM ${table}`)
}

function readRecoveryRunId(SQL, databasePath) {
  return readScalar(SQL, databasePath, 'SELECT run_id FROM workflow_recovery_sessions LIMIT 1')
}

function countCommittedMigrationJournals(root) {
  const backups = path.join(root, 'backups', 'workflow-ledger')
  if (!require('node:fs').existsSync(backups)) return 0
  return readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.creating-'))
    .map((entry) => JSON.parse(readFileSync(path.join(backups, entry.name, 'journal.json'), 'utf8')))
    .filter((journal) => journal.state === 'committed').length
}

function readScalar(SQL, databasePath, sql) {
  const db = new SQL.Database(readFileSync(databasePath))
  try {
    return db.exec(sql)[0]?.values[0]?.[0]
  } finally {
    db.close()
  }
}

async function assertRejects(action, expected, message) {
  try {
    await action()
  } catch (error) {
    if (String(error).includes(expected)) return
    throw new Error(`${message}: unexpected error ${String(error)}`)
  }
  throw new Error(`${message}: expected rejection containing ${expected}`)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
