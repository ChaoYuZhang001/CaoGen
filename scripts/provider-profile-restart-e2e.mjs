#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
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
import { runProviderProfileRestartServiceWorker } from './lib/provider-profile-restart-service-worker.mjs'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const workerAction = process.env.CAOGEN_PROVIDER_PROFILE_RESTART_ACTION

if (workerAction) {
  await runWorker(workerAction)
  process.exit(0)
}

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-profile-restart', runId)
const reportPath = path.join(reportDir, 'report.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-profile-restart-'))
const compiledRoot = path.join(tempRoot, 'compiled')
const report = {
  schemaVersion: 1,
  gate: 'test:provider-profile:restart',
  status: 'failed',
  generatedAt: new Date().toISOString(),
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitOutput([
    'status', '--porcelain=v1', '--untracked-files=all'
  ]).split('\n').filter(Boolean).length,
  scenarios: [],
  failures: []
}

try {
  mkdirSync(reportDir, { recursive: true })
  compileSources(compiledRoot)
  installElectronStub(compiledRoot)

  report.scenarios.push(await runLiveOwnerContentionScenario())
  report.scenarios.push(await runGracefulReleaseContentionScenario())
  for (const operation of ['import', 'rollback']) {
    for (const checkpoint of ['after_prepare', 'after_store_commit']) {
      report.scenarios.push(runStrongKillScenario(operation, checkpoint))
    }
  }
  report.scenarios.push(runUnknownStoreDigestScenario())
  report.scenarios.push(runSameProcessConflictConvergenceScenario())
  report.scenarios.push(runPendingWriterMatrixScenario())
  report.scenarios.push(runInflightBackupBindingScenario('after_prepare'))
  report.scenarios.push(runInflightBackupBindingScenario('after_store_commit'))
  report.scenarios.push(runBackupBindingConflictScenario())
  report.scenarios.push(runRollbackSourceBindingConflictScenario())

  report.status = 'passed'
} catch (error) {
  report.failures.push(serializeError(error))
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
}

async function runGracefulReleaseContentionScenario() {
  const scenarioName = 'graceful-release-contention'
  const scenarioRoot = path.join(tempRoot, scenarioName)
  const userDataDir = path.join(scenarioRoot, 'userData')
  const holderReadyPath = path.join(scenarioRoot, 'holder-ready')
  const contenderBlockedPath = path.join(scenarioRoot, 'contender-blocked')
  const releasePath = path.join(scenarioRoot, 'release-holder')
  mkdirSync(userDataDir, { recursive: true })

  let holderStderr = ''
  const holder = spawn(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: workerEnvironment('hold_lock_until_release', {
      userDataDir,
      readyPath: holderReadyPath,
      releasePath
    }),
    stdio: ['ignore', 'ignore', 'pipe']
  })
  holder.stderr.setEncoding('utf8')
  holder.stderr.on('data', (chunk) => { holderStderr += chunk })

  let contender
  try {
    await waitForHolderReady(holder, holderReadyPath, () => holderStderr)
    let contenderStdout = ''
    let contenderStderr = ''
    contender = spawn(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: workerEnvironment('contend_writer_until_created', {
        userDataDir,
        readyPath: contenderBlockedPath
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    contender.stdout.setEncoding('utf8')
    contender.stderr.setEncoding('utf8')
    contender.stdout.on('data', (chunk) => { contenderStdout += chunk })
    contender.stderr.on('data', (chunk) => { contenderStderr += chunk })
    await waitForHolderReady(contender, contenderBlockedPath, () => contenderStderr)

    writeFileSync(releasePath, 'release\n', 'utf8')
    await Promise.all([waitForChildExit(holder), waitForChildExit(contender)])
    assert.equal(holder.exitCode, 0, `${scenarioName} holder must release normally: ${holderStderr}`)
    assert.equal(contender.exitCode, 0, `${scenarioName} contender must acquire after release: ${contenderStderr}`)
    const result = JSON.parse(contenderStdout)
    assert.equal(result.acquired, true, `${scenarioName} contender acquisition`)
    assert.ok(result.attempts >= 2, `${scenarioName} must observe contention before acquisition`)
    assert.deepEqual(result.observedCodes, ['LOCK_HELD'], `${scenarioName} contention error codes`)
    const storedProviders = JSON.parse(readFileSync(path.join(userDataDir, 'providers.json'), 'utf8'))
    assert.equal(storedProviders.some((provider) => provider.name === 'Contended Provider writer'), true,
      `${scenarioName} real Provider writer must commit after release`)
    assert.deepEqual(lockArtifactSnapshot(userDataDir), [], `${scenarioName} must leave no lock artifacts`)

    return {
      name: scenarioName,
      status: 'passed',
      observedLockHeld: true,
      eventualAcquire: true,
      attempts: result.attempts,
      unexpectedErrorCodes: [],
      realProviderWriterCommitted: true,
      lockArtifacts: 0
    }
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
    if (contender && contender.exitCode === null && contender.signalCode === null) contender.kill('SIGKILL')
    await waitForChildExit(holder)
    if (contender) await waitForChildExit(contender)
  }
}

console.log(JSON.stringify({
  status: report.status,
  scenarios: report.scenarios.length,
  failures: report.failures,
  reportPath: path.relative(repoRoot, reportPath)
}, null, 2))

async function runLiveOwnerContentionScenario() {
  const scenarioName = 'live-owner-contention'
  const scenarioRoot = path.join(tempRoot, scenarioName)
  const userDataDir = path.join(scenarioRoot, 'userData')
  const readyPath = path.join(scenarioRoot, 'holder-ready')
  mkdirSync(userDataDir, { recursive: true })

  let holderStderr = ''
  const holder = spawn(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: workerEnvironment('hold_lock', { userDataDir, readyPath }),
    stdio: ['ignore', 'ignore', 'pipe']
  })
  holder.stderr.setEncoding('utf8')
  holder.stderr.on('data', (chunk) => { holderStderr += chunk })

  try {
    await waitForHolderReady(holder, readyPath, () => holderStderr)
    const activeLockPath = path.join(userDataDir, '.provider-store-mutation.lock')
    assert.equal(existsSync(activeLockPath), true, `${scenarioName} holder must own the active lock`)

    const contention = invokeWorker('attempt_lock', { userDataDir })
    assert.equal(contention.blocked, true, `${scenarioName} contender must be blocked`)
    assert.equal(contention.code, 'LOCK_HELD', `${scenarioName} contender error code`)
    assert.deepEqual(lockArtifactSnapshot(userDataDir), [],
      `${scenarioName} failed contender must remove its candidate lock`)
    const writerContention = invokeWorker('attempt_mutation', { userDataDir })
    assert.equal(writerContention.blocked, true, `${scenarioName} real Provider writer must be blocked`)
    assert.equal(writerContention.name, 'ProviderStoreMutationLockError', `${scenarioName} writer error type`)
    assert.equal(writerContention.code, 'LOCK_HELD', `${scenarioName} writer error code`)

    holder.kill('SIGKILL')
    await waitForChildExit(holder)
    assert.equal(holder.signalCode, 'SIGKILL', `${scenarioName} holder must receive SIGKILL`)

    const recovery = invokeWorker('attempt_lock', { userDataDir })
    assert.equal(recovery.blocked, false, `${scenarioName} dead owner lock must be recoverable`)
    assert.equal(recovery.reentrant, true, `${scenarioName} recovered lock must remain process-reentrant`)
    assert.equal(existsSync(activeLockPath), false, `${scenarioName} recovery must release the active lock`)
    const recoveryArtifacts = lockArtifactSnapshot(userDataDir)
    assert.equal(recoveryArtifacts.filter((name) => name.includes('.candidate-')).length, 0,
      `${scenarioName} recovery must not leave candidate locks`)
    assert.equal(recoveryArtifacts.filter((name) => name.includes('.released-')).length, 0,
      `${scenarioName} recovery must not leave released locks`)
    assert.equal(recoveryArtifacts.filter((name) => name.includes('.recovered-')).length, 1,
      `${scenarioName} recovery must retain one bounded dead-owner tombstone`)

    return {
      name: scenarioName,
      status: 'passed',
      liveOwnerBlocked: true,
      contenderErrorCode: contention.code,
      realProviderWriterBlocked: true,
      deadWriterLockRecovered: true,
      processReentrant: true,
      candidateArtifacts: 0,
      releasedArtifacts: 0,
      recoveredTombstones: 1
    }
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
    await waitForChildExit(holder)
  }
}

function runStrongKillScenario(operation, checkpoint) {
  const scenarioName = `${operation}-${checkpoint}`
  const scenarioRoot = path.join(tempRoot, scenarioName)
  const userDataDir = path.join(scenarioRoot, 'userData')
  const importPath = path.join(scenarioRoot, 'profile.json')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'providers.json'), `${JSON.stringify([seedProvider()], null, 2)}\n`, {
    mode: 0o600
  })
  writeFileSync(importPath, `${JSON.stringify(importProfile(), null, 2)}\n`, { mode: 0o600 })

  let rollbackBackupId = ''
  if (operation === 'rollback') {
    const primed = invokeWorker('prime_rollback', {
      userDataDir,
      importPath
    })
    rollbackBackupId = primed.backupId
    assert.equal(typeof rollbackBackupId, 'string')
    assert.ok(rollbackBackupId.length > 0)
  }

  const storePath = path.join(userDataDir, 'providers.json')
  const journalPath = path.join(userDataDir, 'provider-profile-operations', 'journal.json')
  const backupRoot = path.join(userDataDir, 'provider-profile-backups')
  const activeLockPath = path.join(userDataDir, '.provider-store-mutation.lock')
  const beforeCrashStore = readFileSync(storePath, 'utf8')
  const backupsBeforeCrash = backupSnapshot(backupRoot)
  const crash = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: workerEnvironment('crash', {
      userDataDir,
      importPath,
      operation,
      checkpoint,
      rollbackBackupId
    }),
    encoding: 'utf8'
  })
  assert.equal(crash.signal, 'SIGKILL', `${scenarioName} worker must receive SIGKILL`)
  assert.equal(existsSync(activeLockPath), true, `${scenarioName} must strand the killed writer lock`)

  const afterKillStore = readFileSync(storePath, 'utf8')
  const afterKillProviders = JSON.parse(afterKillStore)
  const expectedModel = checkpoint === 'after_prepare'
    ? operation === 'rollback' ? 'changed-model' : 'base-model'
    : operation === 'rollback' ? 'base-model' : 'changed-model'
  assert.equal(afterKillProviders[0]?.models?.[0], expectedModel, `${scenarioName} Store boundary`)

  const pendingJournal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const pendingEntry = [...pendingJournal.entries].reverse().find((entry) => entry.phase === 'prepared')
  assert.ok(pendingEntry, `${scenarioName} must leave a prepared operation`)
  assert.equal(pendingEntry.operation, operation, `${scenarioName} operation kind`)
  assertBackupBindings(pendingEntry, backupRoot)

  const backupsAfterKill = backupSnapshot(backupRoot)
  assert.equal(
    backupsAfterKill.length,
    backupsBeforeCrash.length + 1,
    `${scenarioName} must create exactly one safety backup`
  )

  const beforeBlockedMutationJournal = readFileSync(journalPath, 'utf8')
  const blocked = invokeWorker('attempt_mutation', { userDataDir })
  assertMutationBlocked(blocked, 'OPERATION_CONFLICT', scenarioName)
  assert.equal(readFileSync(storePath, 'utf8'), afterKillStore,
    `${scenarioName} blocked mutation must preserve Store bytes`)
  assert.equal(readFileSync(journalPath, 'utf8'), beforeBlockedMutationJournal,
    `${scenarioName} blocked mutation must preserve journal bytes`)
  assert.deepEqual(backupSnapshot(backupRoot), backupsAfterKill,
    `${scenarioName} blocked mutation must preserve backups`)

  const firstRecovery = invokeWorker('reconcile', { userDataDir })
  const firstStore = readFileSync(storePath, 'utf8')
  const firstJournal = readFileSync(journalPath, 'utf8')
  const firstBackups = backupSnapshot(backupRoot)
  const firstLockArtifacts = lockArtifactSnapshot(userDataDir)
  const expectedPhase = checkpoint === 'after_prepare' ? 'aborted' : 'committed'
  assert.equal(firstRecovery.reconciliations.length, 1, `${scenarioName} first recovery count`)
  assert.equal(firstRecovery.reconciliations[0].operationId, pendingEntry.operationId)
  assert.equal(firstRecovery.reconciliations[0].phase, expectedPhase, `${scenarioName} recovery phase`)
  assert.equal(firstStore, afterKillStore, `${scenarioName} recovery must not replay Store mutation`)
  assert.deepEqual(firstBackups, backupsAfterKill, `${scenarioName} recovery must not create a backup`)
  assert.equal(existsSync(activeLockPath), false, `${scenarioName} recovery must release the active lock`)

  const secondRecovery = invokeWorker('reconcile', { userDataDir })
  const secondStore = readFileSync(storePath, 'utf8')
  const secondJournal = readFileSync(journalPath, 'utf8')
  const secondBackups = backupSnapshot(backupRoot)
  const secondLockArtifacts = lockArtifactSnapshot(userDataDir)
  assert.deepEqual(secondRecovery.reconciliations, [], `${scenarioName} second recovery must be a no-op`)
  assert.equal(secondStore, firstStore, `${scenarioName} repeated recovery Store bytes`)
  assert.equal(secondJournal, firstJournal, `${scenarioName} repeated recovery journal bytes`)
  assert.deepEqual(secondBackups, firstBackups, `${scenarioName} repeated recovery backup set`)
  assert.deepEqual(secondLockArtifacts, firstLockArtifacts,
    `${scenarioName} repeated recovery lock artifacts`)

  const finalEntry = JSON.parse(secondJournal).entries.find(
    (entry) => entry.operationId === pendingEntry.operationId
  )
  assert.equal(finalEntry?.phase, expectedPhase, `${scenarioName} final journal phase`)

  return {
    name: scenarioName,
    status: 'passed',
    operationId: pendingEntry.operationId,
    phase: expectedPhase,
    storeChangedBeforeKill: afterKillStore !== beforeCrashStore,
    automaticReplayCount: 0,
    deadWriterLockRecovered: true,
    pendingMutationBlocked: true,
    repeatedRecoveryByteStable: true,
    backupCount: secondBackups.length
  }
}

function runUnknownStoreDigestScenario() {
  const scenarioName = 'import-unknown-store-digest'
  const before = runUnknownStoreDigestConvergence(`${scenarioName}-before`, 'after_prepare', 'aborted')
  const desired = runUnknownStoreDigestConvergence(`${scenarioName}-desired`, 'after_store_commit', 'committed')
  return {
    name: scenarioName,
    status: 'passed',
    phase: 'reconciled',
    automaticReplayCount: 0,
    ordinaryMutationBlocked: true,
    ordinaryMutationResumed: true,
    repeatedRecoveryByteStable: true,
    convergences: [before, desired]
  }
}

function runSameProcessConflictConvergenceScenario() {
  const scenarioName = 'same-process-conflict-convergence'
  const scenarioRoot = path.join(tempRoot, scenarioName)
  const userDataDir = path.join(scenarioRoot, 'userData')
  const importPath = path.join(scenarioRoot, 'profile.json')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'providers.json'), `${JSON.stringify([seedProvider()], null, 2)}\n`, {
    mode: 0o600
  })
  writeFileSync(importPath, `${JSON.stringify(importProfile(), null, 2)}\n`, { mode: 0o600 })

  const result = invokeWorker('same_process_convergence', { userDataDir, importPath })
  assert.equal(result.initialModel, 'base-model', `${scenarioName} initial cache fixture`)
  assert.equal(result.operationBlocked, true, `${scenarioName} third digest must block terminal commit`)
  assert.equal(result.waitingPhase, 'waiting_reconciliation', `${scenarioName} durable conflict phase`)
  assert.equal(result.pendingMutationCode, 'RECONCILIATION_CONFLICT', `${scenarioName} pending write code`)
  assert.equal(result.reconciliations.length, 1, `${scenarioName} convergence count`)
  assert.equal(result.reconciliations[0].phase, 'aborted', `${scenarioName} convergence phase`)
  assert.equal(result.created, true, `${scenarioName} ordinary write must resume without restart`)
  assert.deepEqual(result.finalModels, ['base-model'], `${scenarioName} cache must reload the repaired Store`)

  return {
    name: scenarioName,
    status: 'passed',
    persistentConflict: true,
    convergencePhase: 'aborted',
    cacheReloaded: true,
    ordinaryMutationResumedWithoutRestart: true
  }
}

function runPendingWriterMatrixScenario() {
  const scenarioName = 'prepared-pending-writer-matrix'
  const scenarioRoot = path.join(tempRoot, scenarioName)
  const userDataDir = path.join(scenarioRoot, 'userData')
  const importPath = path.join(scenarioRoot, 'profile.json')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'providers.json'), `${JSON.stringify([seedProvider()], null, 2)}\n`, {
    mode: 0o600
  })
  writeFileSync(importPath, `${JSON.stringify(importProfile(), null, 2)}\n`, { mode: 0o600 })

  const result = invokeWorker('pending_writer_matrix', { userDataDir, importPath })
  for (const writer of ['create', 'update', 'delete', 'directCommit', 'forgedOperationWithoutDigest']) {
    assert.equal(result.writerResults[writer]?.blocked, true, `${scenarioName} ${writer} blocked`)
    assert.equal(result.writerResults[writer]?.name, 'ProviderProfileOperationJournalError',
      `${scenarioName} ${writer} error type`)
    assert.equal(result.writerResults[writer]?.code, 'OPERATION_CONFLICT',
      `${scenarioName} ${writer} error code`)
  }
  assert.equal(result.writerResults.forgedOperationWrongResult?.blocked, true,
    `${scenarioName} forged result blocked`)
  assert.equal(result.writerResults.forgedOperationWrongResult?.name, 'ProviderStoreMutationBlockedError',
    `${scenarioName} forged result error type`)
  assert.equal(result.storeByteStable, true, `${scenarioName} Store bytes`)
  assert.equal(result.finalPhase, 'aborted', `${scenarioName} cleanup phase`)

  return {
    name: scenarioName,
    status: 'passed',
    blockedWriterCount: Object.keys(result.writerResults).length,
    exactJournalConflictCodes: true,
    forgedOperationIdCannotWriteThirdDigest: true,
    storeByteStable: true,
    finalPhase: 'aborted'
  }
}

function runInflightBackupBindingScenario(checkpoint) {
  const scenarioName = `import-inflight-backup-binding-${checkpoint}`
  const scenarioRoot = path.join(tempRoot, scenarioName)
  const userDataDir = path.join(scenarioRoot, 'userData')
  const importPath = path.join(scenarioRoot, 'profile.json')
  const originalBackupPath = path.join(scenarioRoot, 'frozen-backup.json')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'providers.json'), `${JSON.stringify([seedProvider()], null, 2)}\n`, {
    mode: 0o600
  })
  writeFileSync(importPath, `${JSON.stringify(importProfile(), null, 2)}\n`, { mode: 0o600 })
  const storePath = path.join(userDataDir, 'providers.json')
  const storeBefore = readFileSync(storePath, 'utf8')

  const result = invokeWorker('tamper_during_operation', {
    userDataDir,
    importPath,
    originalBackupPath,
    tamperCheckpoint: checkpoint
  })
  assert.equal(result.blocked, true, `${scenarioName} must fail before journal terminal state`)
  assert.equal(result.phase, 'waiting_reconciliation', `${scenarioName} persistent conflict phase`)
  const storeChangedBeforeBlock = readFileSync(storePath, 'utf8') !== storeBefore
  assert.equal(storeChangedBeforeBlock, checkpoint === 'after_store_commit', `${scenarioName} Store boundary`)
  assertMutationBlocked(invokeWorker('attempt_mutation', { userDataDir }),
    'RECONCILIATION_CONFLICT', scenarioName)

  const backupPath = path.join(userDataDir, 'provider-profile-backups', `${result.safetyBackupId}.json`)
  writeFileSync(backupPath, readFileSync(originalBackupPath), { mode: 0o600 })
  const convergence = invokeWorker('reconcile', { userDataDir })
  const convergencePhase = checkpoint === 'after_prepare' ? 'aborted' : 'committed'
  assert.equal(convergence.reconciliations[0]?.phase, convergencePhase, `${scenarioName} convergence phase`)
  assertMutationAllowed(invokeWorker('attempt_mutation', { userDataDir }), scenarioName)

  return {
    name: scenarioName,
    status: 'passed',
    backupDigestMismatchBlockedBeforeTerminal: true,
    checkpoint,
    storeChangedBeforeBlock,
    persistentConflict: true,
    convergencePhase,
    ordinaryMutationResumed: true
  }
}

function runUnknownStoreDigestConvergence(scenarioName, checkpoint, expectedPhase) {
  const scenario = prepareKilledImportScenario(scenarioName, checkpoint)
  const expectedStore = readFileSync(scenario.storePath, 'utf8')
  const thirdStore = `${JSON.stringify([{ ...seedProvider(), models: ['third-digest-model'] }], null, 2)}\n`
  writeFileSync(scenario.storePath, thirdStore, { mode: 0o600 })
  const backupsBefore = backupSnapshot(scenario.backupRoot)

  const firstFailure = invokeWorkerExpectFailure('reconcile', { userDataDir: scenario.userDataDir })
  assert.match(firstFailure, /reconcil|对账|snapshot/i, `${scenarioName} first recovery error`)
  const waitingJournal = readFileSync(scenario.journalPath, 'utf8')
  const waitingEntry = JSON.parse(waitingJournal).entries.find(
    (entry) => entry.operationId === scenario.pendingEntry.operationId
  )
  assert.equal(waitingEntry?.phase, 'waiting_reconciliation', `${scenarioName} blocked phase`)
  assert.equal(readFileSync(scenario.storePath, 'utf8'), thirdStore, `${scenarioName} must not overwrite Store`)
  assert.deepEqual(backupSnapshot(scenario.backupRoot), backupsBefore,
    `${scenarioName} must not create recovery backups`)

  const blocked = invokeWorker('attempt_mutation', { userDataDir: scenario.userDataDir })
  assertMutationBlocked(blocked, 'RECONCILIATION_CONFLICT', scenarioName)
  assert.equal(readFileSync(scenario.storePath, 'utf8'), thirdStore,
    `${scenarioName} blocked mutation must preserve Store`)
  assert.equal(readFileSync(scenario.journalPath, 'utf8'), waitingJournal,
    `${scenarioName} blocked mutation must preserve journal`)

  const secondFailure = invokeWorkerExpectFailure('reconcile', { userDataDir: scenario.userDataDir })
  assert.match(secondFailure, /reconcil|对账|snapshot/i, `${scenarioName} repeated recovery error`)
  assert.equal(readFileSync(scenario.storePath, 'utf8'), thirdStore,
    `${scenarioName} repeated recovery must preserve Store`)
  assert.equal(readFileSync(scenario.journalPath, 'utf8'), waitingJournal,
    `${scenarioName} repeated recovery must preserve journal bytes`)
  assert.deepEqual(backupSnapshot(scenario.backupRoot), backupsBefore,
    `${scenarioName} repeated recovery must preserve backups`)

  writeFileSync(scenario.storePath, expectedStore, { mode: 0o600 })
  const convergence = invokeWorker('reconcile', { userDataDir: scenario.userDataDir })
  assert.equal(convergence.reconciliations.length, 1, `${scenarioName} convergence count`)
  assert.equal(convergence.reconciliations[0].operationId, scenario.pendingEntry.operationId)
  assert.equal(convergence.reconciliations[0].phase, expectedPhase, `${scenarioName} convergence phase`)
  const convergedEntry = JSON.parse(readFileSync(scenario.journalPath, 'utf8')).entries.find(
    (entry) => entry.operationId === scenario.pendingEntry.operationId
  )
  assert.equal(convergedEntry?.phase, expectedPhase, `${scenarioName} persisted convergence phase`)
  assertMutationAllowed(invokeWorker('attempt_mutation', { userDataDir: scenario.userDataDir }), scenarioName)

  return {
    target: checkpoint === 'after_prepare' ? 'before' : 'desired',
    operationId: scenario.pendingEntry.operationId,
    phase: expectedPhase
  }
}

function runBackupBindingConflictScenario() {
  const scenarioName = 'import-safety-backup-binding-conflict'
  const scenario = prepareKilledImportScenario(scenarioName)
  const backupPath = path.join(scenario.backupRoot, `${scenario.pendingEntry.safetyBackupId}.json`)
  const originalBackup = readFileSync(backupPath, 'utf8')
  const document = JSON.parse(readFileSync(backupPath, 'utf8'))
  document.providers[0].models = ['valid-but-substituted-backup']
  const { payloadDigest: _previousDigest, ...payload } = document
  document.payloadDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  writeFileSync(backupPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  assert.notEqual(document.payloadDigest, scenario.pendingEntry.safetyBackupDigest,
    `${scenarioName} fixture must change the frozen backup digest`)
  const storeBefore = readFileSync(scenario.storePath, 'utf8')
  const backupsBefore = backupSnapshot(scenario.backupRoot)

  const firstFailure = invokeWorkerExpectFailure('reconcile', { userDataDir: scenario.userDataDir })
  assert.match(firstFailure, /backup digest|备份|对账/i, `${scenarioName} recovery error`)
  const waitingJournal = readFileSync(scenario.journalPath, 'utf8')
  const waitingEntry = JSON.parse(waitingJournal).entries.find(
    (entry) => entry.operationId === scenario.pendingEntry.operationId
  )
  assert.equal(waitingEntry?.phase, 'waiting_reconciliation', `${scenarioName} blocked phase`)
  assert.equal(readFileSync(scenario.storePath, 'utf8'), storeBefore,
    `${scenarioName} must not mutate Store`)
  assert.deepEqual(backupSnapshot(scenario.backupRoot), backupsBefore,
    `${scenarioName} must not rewrite the substituted backup`)
  assertMutationBlocked(
    invokeWorker('attempt_mutation', { userDataDir: scenario.userDataDir }),
    'RECONCILIATION_CONFLICT',
    scenarioName
  )

  const secondFailure = invokeWorkerExpectFailure('reconcile', { userDataDir: scenario.userDataDir })
  assert.match(secondFailure, /backup digest|备份|对账/i, `${scenarioName} repeated recovery error`)
  assert.equal(readFileSync(scenario.journalPath, 'utf8'), waitingJournal,
    `${scenarioName} repeated recovery must preserve journal bytes`)
  assert.equal(readFileSync(scenario.storePath, 'utf8'), storeBefore,
    `${scenarioName} repeated recovery must preserve Store bytes`)

  writeFileSync(backupPath, originalBackup, { mode: 0o600 })
  const convergence = invokeWorker('reconcile', { userDataDir: scenario.userDataDir })
  assert.equal(convergence.reconciliations[0]?.phase, 'aborted', `${scenarioName} convergence phase`)
  assertMutationAllowed(invokeWorker('attempt_mutation', { userDataDir: scenario.userDataDir }), scenarioName)

  return {
    name: scenarioName,
    status: 'passed',
    operationId: scenario.pendingEntry.operationId,
    phase: 'aborted',
    backupDigestMismatchBlocked: true,
    automaticReplayCount: 0,
    repeatedRecoveryByteStable: true,
    ordinaryMutationResumed: true
  }
}

function runRollbackSourceBindingConflictScenario() {
  const scenarioName = 'rollback-source-backup-binding-conflict'
  const scenario = prepareKilledRollbackScenario(scenarioName)
  const sourcePath = path.join(scenario.backupRoot, `${scenario.pendingEntry.sourceBackupId}.json`)
  const originalSource = readFileSync(sourcePath, 'utf8')
  const document = JSON.parse(readFileSync(sourcePath, 'utf8'))
  document.providers[0].models = ['valid-but-substituted-rollback-source']
  const { payloadDigest: _previousDigest, ...payload } = document
  document.payloadDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  writeFileSync(sourcePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  assert.notEqual(document.payloadDigest, scenario.pendingEntry.sourceBackupDigest,
    `${scenarioName} fixture must change the frozen source backup digest`)
  const storeBefore = readFileSync(scenario.storePath, 'utf8')
  const backupsBefore = backupSnapshot(scenario.backupRoot)

  const firstFailure = invokeWorkerExpectFailure('reconcile', { userDataDir: scenario.userDataDir })
  assert.match(firstFailure, /backup digest|备份|对账/i, `${scenarioName} recovery error`)
  const waitingJournal = readFileSync(scenario.journalPath, 'utf8')
  const waitingEntry = JSON.parse(waitingJournal).entries.find(
    (entry) => entry.operationId === scenario.pendingEntry.operationId
  )
  assert.equal(waitingEntry?.phase, 'waiting_reconciliation', `${scenarioName} blocked phase`)
  assert.equal(readFileSync(scenario.storePath, 'utf8'), storeBefore, `${scenarioName} must not mutate Store`)
  assert.deepEqual(backupSnapshot(scenario.backupRoot), backupsBefore,
    `${scenarioName} must not rewrite the substituted source backup`)
  assertMutationBlocked(
    invokeWorker('attempt_mutation', { userDataDir: scenario.userDataDir }),
    'RECONCILIATION_CONFLICT',
    scenarioName
  )

  const secondFailure = invokeWorkerExpectFailure('reconcile', { userDataDir: scenario.userDataDir })
  assert.match(secondFailure, /backup digest|备份|对账/i, `${scenarioName} repeated recovery error`)
  assert.equal(readFileSync(scenario.journalPath, 'utf8'), waitingJournal,
    `${scenarioName} repeated recovery must preserve journal bytes`)
  assert.equal(readFileSync(scenario.storePath, 'utf8'), storeBefore,
    `${scenarioName} repeated recovery must preserve Store bytes`)

  writeFileSync(sourcePath, originalSource, { mode: 0o600 })
  const convergence = invokeWorker('reconcile', { userDataDir: scenario.userDataDir })
  assert.equal(convergence.reconciliations[0]?.phase, 'aborted', `${scenarioName} convergence phase`)
  assertMutationAllowed(invokeWorker('attempt_mutation', { userDataDir: scenario.userDataDir }), scenarioName)

  return {
    name: scenarioName,
    status: 'passed',
    operationId: scenario.pendingEntry.operationId,
    phase: 'aborted',
    sourceBackupDigestMismatchBlocked: true,
    automaticReplayCount: 0,
    repeatedRecoveryByteStable: true,
    ordinaryMutationResumed: true
  }
}

function prepareKilledImportScenario(scenarioName, checkpoint = 'after_prepare') {
  const scenarioRoot = path.join(tempRoot, scenarioName)
  const userDataDir = path.join(scenarioRoot, 'userData')
  const importPath = path.join(scenarioRoot, 'profile.json')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'providers.json'), `${JSON.stringify([seedProvider()], null, 2)}\n`, {
    mode: 0o600
  })
  writeFileSync(importPath, `${JSON.stringify(importProfile(), null, 2)}\n`, { mode: 0o600 })
  const crash = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: workerEnvironment('crash', {
      userDataDir,
      importPath,
      operation: 'import',
      checkpoint
    }),
    encoding: 'utf8'
  })
  assert.equal(crash.signal, 'SIGKILL', `${scenarioName} worker must receive SIGKILL`)
  const storePath = path.join(userDataDir, 'providers.json')
  const journalPath = path.join(userDataDir, 'provider-profile-operations', 'journal.json')
  const backupRoot = path.join(userDataDir, 'provider-profile-backups')
  const pendingEntry = JSON.parse(readFileSync(journalPath, 'utf8')).entries.find(
    (entry) => entry.phase === 'prepared'
  )
  assert.ok(pendingEntry, `${scenarioName} must leave a prepared operation`)
  assertBackupBindings(pendingEntry, backupRoot)
  return { userDataDir, importPath, storePath, journalPath, backupRoot, pendingEntry }
}

function prepareKilledRollbackScenario(scenarioName) {
  const scenarioRoot = path.join(tempRoot, scenarioName)
  const userDataDir = path.join(scenarioRoot, 'userData')
  const importPath = path.join(scenarioRoot, 'profile.json')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'providers.json'), `${JSON.stringify([seedProvider()], null, 2)}\n`, {
    mode: 0o600
  })
  writeFileSync(importPath, `${JSON.stringify(importProfile(), null, 2)}\n`, { mode: 0o600 })
  const primed = invokeWorker('prime_rollback', { userDataDir, importPath })
  const crash = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: workerEnvironment('crash', {
      userDataDir,
      importPath,
      operation: 'rollback',
      checkpoint: 'after_prepare',
      rollbackBackupId: primed.backupId
    }),
    encoding: 'utf8'
  })
  assert.equal(crash.signal, 'SIGKILL', `${scenarioName} worker must receive SIGKILL`)
  const storePath = path.join(userDataDir, 'providers.json')
  const journalPath = path.join(userDataDir, 'provider-profile-operations', 'journal.json')
  const backupRoot = path.join(userDataDir, 'provider-profile-backups')
  const pendingEntry = JSON.parse(readFileSync(journalPath, 'utf8')).entries.find(
    (entry) => entry.phase === 'prepared' && entry.operation === 'rollback'
  )
  assert.ok(pendingEntry, `${scenarioName} must leave a prepared rollback operation`)
  assertBackupBindings(pendingEntry, backupRoot)
  return { userDataDir, importPath, storePath, journalPath, backupRoot, pendingEntry }
}

async function runWorker(action) {
  const userDataDir = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_USER_DATA')

  if (action === 'hold_lock'
    || action === 'hold_lock_until_release'
    || action === 'attempt_lock'
    || action === 'contend_until_acquired') {
    await runLockWorker(action, userDataDir)
    return
  }
  await runProviderProfileRestartServiceWorker(action, {
    userDataDir,
    requiredEnvironment,
    seedProvider,
    markLockContentionObserved
  })
}

function assertMutationBlocked(result, expectedCode, scenarioName) {
  assert.equal(result.blocked, true, `${scenarioName} must block ordinary Provider mutation`)
  assert.equal(result.name, 'ProviderProfileOperationJournalError', `${scenarioName} mutation error type`)
  assert.equal(result.code, expectedCode, `${scenarioName} mutation error code`)
}

function assertMutationAllowed(result, scenarioName) {
  assert.equal(result.blocked, false, `${scenarioName} must allow ordinary mutation after reconciliation`)
}

async function runLockWorker(action, userDataDir) {
  const lock = await import(pathToFileURL(
    requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_LOCK')
  ).href)
  if (action === 'hold_lock' || action === 'hold_lock_until_release') {
    holdProviderStoreLock(lock, userDataDir, action)
    return
  }
  if (action === 'contend_until_acquired') {
    contendForProviderStoreLock(lock, userDataDir)
    return
  }
  attemptProviderStoreLock(lock, userDataDir)
}

function holdProviderStoreLock(lock, userDataDir, action) {
  lock.withProviderStoreMutationLock(userDataDir, () => {
    writeFileSync(requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_READY'), 'ready\n', 'utf8')
    if (action === 'hold_lock') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
      return
    }
    const releasePath = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_RELEASE')
    const deadline = Date.now() + 10_000
    while (!existsSync(releasePath)) {
      if (Date.now() >= deadline) throw new Error('Graceful Provider Store lock release timed out')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  })
}

function contendForProviderStoreLock(lock, userDataDir) {
  const deadline = Date.now() + 10_000
  const observedCodes = new Set()
  for (let attempts = 1; Date.now() < deadline; attempts += 1) {
    try {
      lock.withProviderStoreMutationLock(userDataDir, () => undefined)
      process.stdout.write(JSON.stringify({ acquired: true, attempts, observedCodes: [...observedCodes] }))
      return
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'LOCK_HELD') throw error
      observedCodes.add(code)
      markLockContentionObserved()
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
    }
  }
  throw new Error('Graceful Provider Store lock contender timed out')
}

function markLockContentionObserved() {
  const readyPath = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_READY')
  if (!existsSync(readyPath)) writeFileSync(readyPath, 'blocked\n', 'utf8')
}

function attemptProviderStoreLock(lock, userDataDir) {
  try {
    const result = lock.withProviderStoreMutationLock(userDataDir, () =>
      lock.withProviderStoreMutationLock(userDataDir, () => 'reentrant'))
    process.stdout.write(JSON.stringify({ blocked: false, reentrant: result === 'reentrant' }))
  } catch (error) {
    process.stdout.write(JSON.stringify({
      blocked: true,
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
      name: error instanceof Error ? error.name : 'Error'
    }))
  }
}

function invokeWorker(action, input) {
  const output = execFileSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: workerEnvironment(action, input),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return JSON.parse(output)
}

function invokeWorkerExpectFailure(action, input) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: workerEnvironment(action, input),
    encoding: 'utf8'
  })
  assert.notEqual(result.status, 0, `${action} worker must fail closed`)
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function workerEnvironment(action, input) {
  return {
    ...process.env,
    CAOGEN_PROVIDER_PROFILE_RESTART_ACTION: action,
    CAOGEN_PROVIDER_PROFILE_RESTART_SERVICE: findCompiled(compiledRoot, 'providerProfileService.js'),
    CAOGEN_PROVIDER_PROFILE_RESTART_PROVIDERS: findCompiled(compiledRoot, 'providers.js'),
    CAOGEN_PROVIDER_PROFILE_RESTART_LOCK: findCompiled(compiledRoot, 'providerStoreMutationLock.js'),
    CAOGEN_PROVIDER_PROFILE_RESTART_USER_DATA: input.userDataDir,
    CAOGEN_PROVIDER_PROFILE_RESTART_READY: input.readyPath ?? '',
    CAOGEN_PROVIDER_PROFILE_RESTART_RELEASE: input.releasePath ?? '',
    CAOGEN_PROVIDER_PROFILE_RESTART_IMPORT: input.importPath ?? '',
    CAOGEN_PROVIDER_PROFILE_RESTART_OPERATION: input.operation ?? '',
    CAOGEN_PROVIDER_PROFILE_RESTART_CHECKPOINT: input.checkpoint ?? '',
    CAOGEN_PROVIDER_PROFILE_RESTART_BACKUP_ID: input.rollbackBackupId ?? '',
    CAOGEN_PROVIDER_PROFILE_RESTART_ORIGINAL_BACKUP: input.originalBackupPath ?? '',
    CAOGEN_PROVIDER_PROFILE_RESTART_TAMPER_CHECKPOINT: input.tamperCheckpoint ?? ''
  }
}

async function waitForHolderReady(child, readyPath, stderr) {
  const deadline = Date.now() + 10_000
  while (!existsSync(readyPath)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Provider Store lock holder exited before readiness: ${stderr().trim()}`)
    }
    if (Date.now() >= deadline) throw new Error('Provider Store lock holder readiness timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve())
    child.once('error', reject)
  })
}

function seedProvider() {
  return {
    id: 'provider-restart',
    name: 'Restart local runtime',
    baseUrl: 'http://127.0.0.1:11434/v1',
    encryptedToken: '',
    apiKeys: [],
    models: ['base-model'],
    authMode: 'none',
    engine: 'openai',
    openaiProtocol: 'chat',
    budgetUsd: 0,
    createdAt: 1
  }
}

function importProfile() {
  return {
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [{
      name: 'Restart local runtime',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['changed-model'],
      authMode: 'none',
      engine: 'openai',
      openaiProtocol: 'chat'
    }]
  }
}

function backupSnapshot(directoryPath) {
  if (!existsSync(directoryPath)) return []
  return readdirSync(directoryPath)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name,
      digest: createHash('sha256').update(readFileSync(path.join(directoryPath, name))).digest('hex')
    }))
}

function assertBackupBindings(entry, backupRoot) {
  const safety = JSON.parse(readFileSync(path.join(backupRoot, `${entry.safetyBackupId}.json`), 'utf8'))
  assert.equal(safety.payloadDigest, entry.safetyBackupDigest,
    `${entry.operationId} safety backup digest binding`)
  if (entry.operation !== 'rollback') return
  const source = JSON.parse(readFileSync(path.join(backupRoot, `${entry.sourceBackupId}.json`), 'utf8'))
  assert.equal(source.payloadDigest, entry.sourceBackupDigest,
    `${entry.operationId} rollback source backup digest binding`)
}

function lockArtifactSnapshot(userDataDir) {
  return readdirSync(userDataDir)
    .filter((name) => name.startsWith('.provider-store-mutation.lock.'))
    .sort()
}

function compileSources(outDir) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/providerProfileService.ts',
    '--outDir', outDir,
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
  const electronRoot = path.join(compiledRoot, 'node_modules', 'electron')
  mkdirSync(electronRoot, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({
    name: 'electron',
    version: '0.0.0-provider-profile-restart',
    main: 'index.js'
  }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = {\n  app: {\n    getPath(name) {\n      if (name !== 'userData') throw new Error('unsupported Electron path: ' + name)\n      const value = process.env.CAOGEN_PROVIDER_PROFILE_RESTART_USER_DATA\n      if (!value) throw new Error('missing Provider Profile restart userData')\n      return value\n    }\n  },\n  safeStorage: {\n    isEncryptionAvailable() { return false },\n    encryptString() { throw new Error('encryption unavailable in Provider Profile restart E2E') },\n    decryptString() { throw new Error('encryption unavailable in Provider Profile restart E2E') },\n    getSelectedStorageBackend() { return 'basic_text' }\n  }\n}\n`)
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(fullPath, fileName) } catch { /* keep looking */ }
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`Compiled ${fileName} not found`)
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  }
}
