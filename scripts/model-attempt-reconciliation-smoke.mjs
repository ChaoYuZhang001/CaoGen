import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-model-attempt-reconciliation-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  const api = await import(pathToFileURL(findCompiledModule(outDir, 'model-attempt-api.js')).href)

  for (const fixture of [
    ['run-retry', 'session-retry', 'project-retry', 'task-retry', 100],
    ['run-cancel', 'session-cancel', 'project-cancel', 'task-cancel', 110],
    ['run-ambiguous', 'session-ambiguous', 'project-ambiguous', 'task-ambiguous', 120],
    ['run-multi', 'session-multi', 'project-multi', 'task-multi', 130],
    ['run-normal', 'session-normal', 'project-normal', 'task-normal', 140],
    ['run-invalid', 'session-invalid', 'project-invalid', 'task-invalid', 150]
  ]) await saveRun(snapshotStore, ...fixture)

  const retry = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-retry', commandId: 'command-retry-start', runId: 'run-retry',
    requestId: 'request-retry', stepId: 'step-retry', startedAt: 200
  }), userData)
  const columnsBefore = await modelAttemptColumns(snapshotStore)
  const versionBefore = await databaseUserVersion(snapshotStore)
  const pendingBySession = await api.listPersistedModelAttemptReconciliations({
    sessionId: 'session-retry', stepId: 'step-retry'
  }, userData)
  assert.equal(pendingBySession.length, 1)
  assert.equal(pendingBySession[0].attempt.id, retry.id)
  assert.equal(pendingBySession[0].runId, 'run-retry')
  assert.equal(pendingBySession[0].sessionId, 'session-retry')
  assert.equal(await api.hasPersistedModelAttemptReconciliation({ runId: 'run-retry' }, userData), true)

  await setRunStatus(snapshotStore, 'run-retry', 'waiting_reconciliation')
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-retry-bypass', commandId: 'command-retry-bypass', runId: 'run-retry',
      requestId: 'request-unrelated', stepId: 'step-unrelated', startedAt: 201
    }), userData),
    'MODEL_ATTEMPT_RECONCILIATION_REQUIRED',
    'waiting Run must reject unrelated Attempt starts'
  )
  const authorized = await api.resolvePersistedModelAttemptReconciliation(
    retry.id, retry.revision, 'retry_authorized', userData
  )
  assert.equal(authorized.attempt.status, 'failed')
  assert.equal(authorized.attempt.outcome, 'unknown')
  assert.equal(authorized.attempt.errorClass, 'runtime_result_unknown')
  assert.equal(authorized.sessionId, 'session-retry')
  const authorizedAgain = await api.resolvePersistedModelAttemptReconciliation(
    retry.id, retry.revision, 'retry_authorized', userData
  )
  assert.equal(authorizedAgain.attempt.recordDigest, authorized.attempt.recordDigest, 'resolution must be idempotent')
  assert.equal((await api.listPersistedModelAttemptReconciliations({ runId: 'run-retry' }, userData)).length, 0)
  assert.equal((await api.listPersistedModelAttemptRetryAuthorizations({ runId: 'run-retry' }, userData)).length, 1)
  const retryAuthorization = await api.getPersistedModelAttemptRetryAuthorization({
    runId: 'run-retry', stepId: 'step-retry'
  }, userData)
  assert.equal(retryAuthorization?.attempt.id, retry.id)

  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-retry-no-link', commandId: 'command-retry-no-link', runId: 'run-retry',
      requestId: 'request-retry', stepId: 'step-retry', startedAt: Date.now()
    }), userData),
    'MODEL_ATTEMPT_RECONCILIATION_REQUIRED',
    'authorized retry must be linked explicitly'
  )
  const successor = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-retry-successor', commandId: 'command-retry-successor', runId: 'run-retry',
    requestId: 'request-retry', stepId: 'step-retry', failoverFromAttemptId: retry.id, startedAt: Date.now()
  }), userData)
  assert.equal(successor.failoverFromAttemptId, retry.id)
  assert.equal(await api.hasPersistedModelAttemptRetryAuthorization({ runId: 'run-retry' }, userData), false)
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-retry-second-successor', commandId: 'command-retry-second-successor', runId: 'run-retry',
      requestId: 'request-retry', stepId: 'step-retry', failoverFromAttemptId: retry.id, startedAt: Date.now()
    }), userData),
    'MODEL_ATTEMPT_RECONCILIATION_REQUIRED',
    'retry authorization must be consumed once'
  )

  const normal = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-normal', commandId: 'command-normal', runId: 'run-normal',
    requestId: 'request-normal', stepId: 'step-normal', startedAt: 230
  }), userData)
  assert.equal(normal.status, 'started', 'a different active Run must remain available')

  const cancelledSource = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-cancel', commandId: 'command-cancel-start', runId: 'run-cancel',
    requestId: 'request-cancel', stepId: 'step-cancel', startedAt: 240
  }), userData)
  await setRunStatus(snapshotStore, 'run-cancel', 'waiting_reconciliation')
  const cancelled = await api.resolvePersistedModelAttemptReconciliation(
    cancelledSource.id, cancelledSource.revision, 'cancelled_by_user', userData
  )
  assert.equal(cancelled.attempt.status, 'cancelled')
  assert.equal(cancelled.attempt.outcome, 'cancelled')
  assert.equal(cancelled.attempt.errorClass, undefined)
  assert.equal((await api.listPersistedModelAttemptRetryAuthorizations({ runId: 'run-cancel' }, userData)).length, 0)
  await expectCode(
    api.resolvePersistedModelAttemptReconciliation(cancelledSource.id, 1, 'confirmed_success', userData),
    'MODEL_ATTEMPT_INVALID_INPUT',
    'success confirmation must not be a reconciliation option'
  )

  const ambiguousFirst = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-ambiguous-first', commandId: 'command-ambiguous-first', runId: 'run-ambiguous',
    requestId: 'request-ambiguous', stepId: 'step-ambiguous', startedAt: 250
  }), userData)
  const ambiguousLast = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-ambiguous-last', commandId: 'command-ambiguous-last', runId: 'run-ambiguous',
    requestId: 'request-ambiguous', stepId: 'step-ambiguous', startedAt: 251
  }), userData)
  await setRunStatus(snapshotStore, 'run-ambiguous', 'waiting_reconciliation')
  await expectCode(
    api.resolvePersistedModelAttemptReconciliation(ambiguousFirst.id, 1, 'retry_authorized', userData),
    'MODEL_ATTEMPT_RECONCILIATION_AMBIGUOUS',
    'non-latest Attempt retry must fail closed'
  )
  await api.resolvePersistedModelAttemptReconciliation(ambiguousLast.id, 1, 'retry_authorized', userData)
  await api.resolvePersistedModelAttemptReconciliation(ambiguousFirst.id, 1, 'cancelled_by_user', userData)
  const ambiguousSuccessor = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-ambiguous-successor', commandId: 'command-ambiguous-successor', runId: 'run-ambiguous',
    requestId: 'request-ambiguous', stepId: 'step-ambiguous',
    failoverFromAttemptId: ambiguousLast.id, startedAt: Date.now()
  }), userData)
  assert.equal(ambiguousSuccessor.ordinal, 3)

  const multiOne = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-multi-one', commandId: 'command-multi-one', runId: 'run-multi',
    requestId: 'request-multi-one', stepId: 'step-multi-one', startedAt: 270
  }), userData)
  const multiTwo = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-multi-two', commandId: 'command-multi-two', runId: 'run-multi',
    requestId: 'request-multi-two', stepId: 'step-multi-two', startedAt: 271
  }), userData)
  await setRunStatus(snapshotStore, 'run-multi', 'waiting_reconciliation')
  await api.resolvePersistedModelAttemptReconciliation(multiOne.id, 1, 'retry_authorized', userData)
  await api.resolvePersistedModelAttemptReconciliation(multiTwo.id, 1, 'retry_authorized', userData)
  assert.equal((await api.listPersistedModelAttemptRetryAuthorizations({ runId: 'run-multi' }, userData)).length, 2)
  await expectCode(
    api.getPersistedModelAttemptRetryAuthorization({ runId: 'run-multi' }, userData),
    'MODEL_ATTEMPT_RECONCILIATION_AMBIGUOUS',
    'Run-only retry lookup must reject multiple request candidates'
  )
  assert.equal((await api.getPersistedModelAttemptRetryAuthorization({
    runId: 'run-multi', stepId: 'step-multi-two'
  }, userData))?.attempt.id, multiTwo.id)

  const invalid = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-invalid', commandId: 'command-invalid-start', runId: 'run-invalid',
    requestId: 'request-invalid', stepId: 'step-invalid', startedAt: 280
  }), userData)
  await expectCode(
    api.completePersistedModelAttempt(invalid.id, {
      commandId: 'command-invalid-complete', expectedRevision: 1, status: 'failed',
      outcome: 'unknown', errorClass: 'provider_error', completedAt: 281
    }, userData),
    'MODEL_ATTEMPT_INVALID_INPUT',
    'unknown outcome must require the reconciliation error marker'
  )
  await expectCode(
    api.completePersistedModelAttempt(invalid.id, {
      commandId: 'command-forged-reconciliation', expectedRevision: 1, status: 'failed',
      outcome: 'unknown', errorClass: 'runtime_result_unknown', completedAt: 281
    }, userData),
    'MODEL_ATTEMPT_INVALID_INPUT',
    'generic completion must not forge retry authorization'
  )

  assert.deepEqual(await modelAttemptColumns(snapshotStore), columnsBefore, 'reconciliation must not alter DB columns')
  assert.equal(await databaseUserVersion(snapshotStore), versionBefore, 'reconciliation must not alter DB version')
  const verified = await api.verifyPersistedModelAttemptLedger(userData)
  assert.equal(verified.valid, true)
  console.log(JSON.stringify({
    status: 'pass',
    checks: [
      'started-candidate-query', 'session-run-step-filter', 'waiting-run-hard-gate',
      'retry-resolution-idempotency', 'retry-marker-query', 'explicit-single-consumption',
      'cancelled-by-user', 'no-success-confirmation', 'non-latest-ambiguity',
      'multi-request-step-disambiguation', 'unknown-outcome-capability', 'schema-version-unchanged'
    ],
    attempts: verified.attempts,
    events: verified.events
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/model-attempt-api.ts',
    'src/main/task/model-attempt-reconciliation.ts',
    'src/main/task/model-attempt-store.ts',
    'src/main/task/task-snapshot.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  const found = findCompiledModuleInTree(root, name)
  if (!found) throw new Error(`compiled ${name} not found under ${root}`)
  return found
}

function findCompiledModuleInTree(root, name) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleInTree(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) return fullPath
  }
  return null
}

async function saveRun(snapshotStore, runId, sessionId, projectId, taskId, now) {
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: {
      id: sessionId, title: sessionId, cwd: userData, projectId, childTaskId: taskId,
      model: 'fixture-model', providerId: 'fixture-provider', permissionMode: 'default',
      status: 'running', sdkSessionId: `sdk-${sessionId}`, costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0, createdAt: 1
    },
    transcript: [], lastSeq: 0, eventCount: 0, reason: 'created',
    run: {
      schemaVersion: 1, id: runId, sessionId, taskId, status: 'executing', revision: 1,
      attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: now,
      steps: [], toolExecutions: [], effects: []
    },
    now
  }), userData)
}

function startInput(overrides) {
  return {
    id: 'attempt-fixture', commandId: 'command-fixture', requestId: 'request-fixture', runId: 'run-retry',
    providerId: 'openai', model: 'gpt-fixture', protocol: 'openai.responses',
    adapterVersion: 'adapter-v1', contextDigest: `sha256:${'a'.repeat(64)}`,
    routeReason: 'Selected for capability and healthy capacity.', keyLabel: 'label:primary',
    startedAt: 1, ...overrides
  }
}

async function setRunStatus(snapshotStore, runId, status) {
  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
    db.run('UPDATE workflow_runs SET status = ? WHERE id = ?', [status, runId])
  })
}

async function modelAttemptColumns(snapshotStore) {
  return snapshotStore.readTaskSnapshotDatabase(userData, (db) =>
    db.exec('PRAGMA table_info(model_attempts)')[0].values.map((row) => row[1]))
}

async function databaseUserVersion(snapshotStore) {
  return snapshotStore.readTaskSnapshotDatabase(userData, (db) => db.exec('PRAGMA user_version')[0].values[0][0])
}

async function expectCode(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${message} code`)
    return true
  }, message)
}
