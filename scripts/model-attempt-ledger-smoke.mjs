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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-model-attempt-ledger-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const paginationData = path.join(tempRoot, 'pagination-data')
const semanticData = path.join(tempRoot, 'semantic-data')
const partialSchemaData = path.join(tempRoot, 'partial-schema-data')
const terminalRunData = path.join(tempRoot, 'terminal-run-data')
const canonicalData = path.join(tempRoot, 'canonical-data')
const deletedTablesData = path.join(tempRoot, 'deleted-tables-data')
const truncatedData = path.join(tempRoot, 'truncated-data')
const missingForeignKeyData = path.join(tempRoot, 'missing-foreign-key-data')
const missingUniqueData = path.join(tempRoot, 'missing-unique-data')
const failoverTimeData = path.join(tempRoot, 'failover-time-data')
for (const root of [
  userData, paginationData, semanticData, partialSchemaData, terminalRunData,
  canonicalData, deletedTablesData, truncatedData, missingForeignKeyData,
  missingUniqueData, failoverTimeData
]) {
  mkdirSync(root, { recursive: true })
}

try {
  compileSources()
  installElectronStub()
  const snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  const api = await import(pathToFileURL(findCompiledModule(outDir, 'model-attempt-api.js')).href)
  const store = await import(pathToFileURL(findCompiledModule(outDir, 'model-attempt-store.js')).href)
  const schema = await import(pathToFileURL(findCompiledModule(outDir, 'model-attempt-schema.js')).href)
  const codec = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-codec.js')).href)
  const attemptTypes = await import(pathToFileURL(path.join(outDir, 'shared', 'model-attempt-types.js')).href)

  const readableRouteReason = '智能调度选择 Zero Choice Local Service/zero-choice-responses；策略=balanced'
  assertEqual(
    attemptTypes.safeReason(readableRouteReason),
    readableRouteReason,
    'human-readable Provider/model route identities must not be treated as credentials'
  )

  await saveRun(snapshotStore, 'run-main', 'session-main', 'project-a', 'task-main', 100)
  await saveRun(snapshotStore, 'run-failover', 'session-failover', 'project-a', 'task-failover', 110)
  await saveRun(snapshotStore, 'run-other', 'session-other', 'project-b', 'task-other', 120)
  await saveRun(snapshotStore, 'run-concurrent', 'session-concurrent', 'project-a', 'task-concurrent', 130)
  await saveRun(
    snapshotStore, 'run-terminal', 'session-terminal', 'project-terminal', 'task-terminal', 140, terminalRunData
  )
  await snapshotStore.mutateTaskSnapshotDatabase(terminalRunData, (db) => {
    db.run("UPDATE workflow_runs SET status = 'completed' WHERE id = 'run-terminal'")
  })
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-terminal', commandId: 'command-terminal', runId: 'run-terminal'
    }), terminalRunData),
    'MODEL_ATTEMPT_INVALID_TRANSITION',
    'terminal canonical Run must reject new Attempts'
  )
  await snapshotStore.mutateTaskSnapshotDatabase(terminalRunData, (db) => {
    db.run("UPDATE workflow_runs SET status = 'completed ' WHERE id = 'run-terminal'")
  })
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-invalid-run-status', commandId: 'command-invalid-run-status', runId: 'run-terminal'
    }), terminalRunData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'unknown canonical Run status must fail closed as corruption'
  )

  const first = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-main-1', commandId: 'command-main-start', runId: 'run-main', startedAt: 200
  }), userData)
  assertEqual(first.ordinal, 1, 'first Attempt ordinal')
  assertEqual(first.projectId, 'project-a', 'Attempt project must derive from Run')
  const duplicate = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-main-1', commandId: 'command-main-start', runId: 'run-main', startedAt: 200
  }), userData)
  assertEqual(duplicate.recordDigest, first.recordDigest, 'same start command must be idempotent')
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-main-conflict', commandId: 'command-main-start', runId: 'run-main', model: 'different-model', startedAt: 200
    }), userData),
    'MODEL_ATTEMPT_COMMAND_CONFLICT',
    'same command with different payload must fail'
  )

  const completed = await api.completePersistedModelAttempt('attempt-main-1', {
    commandId: 'command-main-complete', expectedRevision: 1, status: 'succeeded', completedAt: 260,
    usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 10 }, costUsd: 0.0125
  }, userData)
  assertEqual(completed.revision, 2, 'completion must advance revision')
  assertEqual(completed.latencyMs, 60, 'completion must derive latency')
  const completedDuplicate = await api.completePersistedModelAttempt('attempt-main-1', {
    commandId: 'command-main-complete', expectedRevision: 1, status: 'succeeded', completedAt: 260,
    usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 10 }, costUsd: 0.0125
  }, userData)
  assertEqual(completedDuplicate.recordDigest, completed.recordDigest, 'same completion command must be idempotent')

  const failOne = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-failover-1', commandId: 'command-failover-1-start', runId: 'run-failover',
    providerId: 'anthropic', model: 'claude-fixture', protocol: 'anthropic.messages', startedAt: 300
  }), userData)
  await api.completePersistedModelAttempt(failOne.id, {
    commandId: 'command-failover-1-complete', expectedRevision: 1, status: 'failed', completedAt: 320,
    outcome: 'rate_limited', errorClass: 'provider_rate_limit'
  }, userData)
  const interleaved = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-interleaved', commandId: 'command-interleaved', runId: 'run-failover',
    requestId: 'request-secondary', stepId: 'step-secondary', startedAt: 325
  }), userData)
  assertEqual(interleaved.ordinal, 1, 'interleaved request must own an independent ordinal chain')
  const failTwo = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-failover-2', commandId: 'command-failover-2-start', runId: 'run-failover',
    providerId: 'openai', model: 'gpt-fixture', failoverFromAttemptId: failOne.id, startedAt: 330
  }), userData)
  assertEqual(failTwo.ordinal, 2, 'original request ordinal must ignore interleaved request')
  await api.completePersistedModelAttempt(failTwo.id, {
    commandId: 'command-failover-2-complete', expectedRevision: 1, status: 'failed', completedAt: 350,
    outcome: 'auth_failed', errorClass: 'provider_key_auth'
  }, userData)
  const keyFailover = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-failover-3', commandId: 'command-failover-3-start', runId: 'run-failover',
    providerId: 'openai', model: 'gpt-fixture', keyLabel: `sha256:${'b'.repeat(64)}`,
    failoverFromAttemptId: failTwo.id, startedAt: 360
  }), userData)
  assertEqual(keyFailover.ordinal, 3, 'provider/key failover must preserve ordinal')
  const failoverSelection = await api.queryPersistedModelAttempts({
    runId: 'run-failover', requestId: 'request-fixture'
  }, userData)
  assertEqual(failoverSelection.attempts[0].nextAttemptId, failTwo.id, 'source must derive provider failover successor')
  assertEqual(failoverSelection.attempts[1].nextAttemptId, keyFailover.id, 'source must derive key failover successor')

  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-cross-project', commandId: 'command-cross-project', runId: 'run-other', projectId: 'project-a'
    }), userData),
    'MODEL_ATTEMPT_OWNERSHIP_MISMATCH',
    'cross-project ownership claim must fail'
  )
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-cross-run', commandId: 'command-cross-run', runId: 'run-other',
      failoverFromAttemptId: failTwo.id
    }), userData),
    'MODEL_ATTEMPT_FAILOVER_INVALID',
    'cross-Run failover must fail'
  )
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-secret-key', commandId: 'command-secret-key', runId: 'run-other',
      keyLabel: 'api_key=<redacted-fixture>'
    }), userData),
    'MODEL_ATTEMPT_SECRET_REJECTED',
    'raw credential material must be rejected'
  )
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-wrapped-key', commandId: 'command-wrapped-key', runId: 'run-other',
      keyLabel: 'label:api_key=<redacted-fixture>'
    }), userData),
    'MODEL_ATTEMPT_SECRET_REJECTED',
    'label-wrapped credential material must be rejected'
  )
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-entropy-key', commandId: 'command-entropy-key', runId: 'run-other',
      keyLabel: 'label:A1b2C3d4E5f6G7h8I9j0K1l2'
    }), userData),
    'MODEL_ATTEMPT_SECRET_REJECTED',
    'high-entropy key label must be rejected'
  )
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-secret-reason', commandId: 'command-secret-reason', runId: 'run-other',
      routeReason: 'authorization: Bearer abcdefghijklmnop'
    }), userData),
    'MODEL_ATTEMPT_SECRET_REJECTED',
    'secret-bearing route reason must be rejected'
  )
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-entropy-reason', commandId: 'command-entropy-reason', runId: 'run-other',
      routeReason: 'Selected credential A1b2C3d4E5f6G7h8I9j0K1l2 for routing.'
    }), userData),
    'MODEL_ATTEMPT_SECRET_REJECTED',
    'high-entropy token in route reason must be rejected'
  )

  await saveRun(
    snapshotStore, 'run-failover-time', 'session-failover-time', 'project-time', 'task-time', 380,
    failoverTimeData
  )
  const timeSource = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-time-source', commandId: 'command-time-source-start', requestId: 'request-time',
    runId: 'run-failover-time', startedAt: 400
  }), failoverTimeData)
  await expectCode(
    api.completePersistedModelAttempt(timeSource.id, {
      commandId: 'command-time-secret-complete', expectedRevision: 1, status: 'failed', completedAt: 500,
      outcome: 'error', errorClass: 'opaque_A1b2C3d4E5f6G7h8I9j0K1l2'
    }, failoverTimeData),
    'MODEL_ATTEMPT_SECRET_REJECTED',
    'high-entropy errorClass must be rejected before persistence'
  )
  await api.completePersistedModelAttempt(timeSource.id, {
    commandId: 'command-time-source-complete', expectedRevision: 1, status: 'failed', completedAt: 500,
    outcome: 'error', errorClass: 'provider_error'
  }, failoverTimeData)
  await expectCode(
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-time-successor', commandId: 'command-time-successor', requestId: 'request-time',
      runId: 'run-failover-time', failoverFromAttemptId: timeSource.id, startedAt: 499
    }), failoverTimeData),
    'MODEL_ATTEMPT_FAILOVER_INVALID',
    'failover successor cannot start before its failed source completed'
  )

  const concurrent = await Promise.all([
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-concurrent-a', commandId: 'command-concurrent-a', runId: 'run-concurrent', startedAt: 400
    }), userData),
    api.startPersistedModelAttempt(startInput({
      id: 'attempt-concurrent-b', commandId: 'command-concurrent-b', runId: 'run-concurrent', startedAt: 401
    }), userData)
  ])
  assertDeepEqual(concurrent.map((item) => item.ordinal).sort(), [1, 2], 'concurrent starts must allocate continuous ordinals')

  const casAttempt = concurrent[0]
  const casResults = await Promise.allSettled([
    api.completePersistedModelAttempt(casAttempt.id, {
      commandId: 'command-cas-a', expectedRevision: 1, status: 'succeeded', completedAt: 450
    }, userData),
    api.completePersistedModelAttempt(casAttempt.id, {
      commandId: 'command-cas-b', expectedRevision: 1, status: 'failed', completedAt: 451,
      errorClass: 'fixture_failure'
    }, userData)
  ])
  assertEqual(casResults.filter((result) => result.status === 'fulfilled').length, 1, 'CAS must allow one terminal writer')
  const rejectedCas = casResults.find((result) => result.status === 'rejected')
  assertEqual(rejectedCas?.reason?.code, 'MODEL_ATTEMPT_REVISION_CONFLICT', 'losing CAS writer must report revision conflict')

  const reopened = await api.queryPersistedModelAttempts({ projectId: 'project-a', limit: 100 }, userData)
  assertEqual(reopened.attempts.length, 7, 'restart query must retain all successful project Attempts')
  const verified = await api.verifyPersistedModelAttemptLedger(userData)
  assertEqual(verified.valid, true, 'fresh Attempt ledger must verify')
  assertEqual(verified.events, reopened.events.length, 'project fixture contains every event in this smoke')

  await saveRun(
    snapshotStore, 'run-pagination', 'session-pagination', 'project-pagination', 'task-pagination', 500,
    paginationData
  )
  await snapshotStore.mutateTaskSnapshotDatabase(paginationData, (db) => {
    seedPaginationAttempts(db, schema, codec, 501)
  })
  const cursorProbe = await api.queryPersistedModelAttempts({
    runId: 'run-pagination', requestId: 'request-pagination', limit: 2
  }, paginationData)
  assert(cursorProbe.nextCursor, 'cursor probe must provide a continuation')
  await expectCode(
    api.queryPersistedModelAttempts({
      runId: 'run-pagination', requestId: 'request-wrong', limit: 2, cursor: cursorProbe.nextCursor
    }, paginationData),
    'MODEL_ATTEMPT_INVALID_INPUT',
    'cursor reuse across an explicit request scope must fail'
  )
  await expectCode(
    api.queryPersistedModelAttempts({
      runId: 'run-pagination', requestId: 'request-pagination', providerId: 'openai',
      limit: 2, cursor: cursorProbe.nextCursor
    }, paginationData),
    'MODEL_ATTEMPT_INVALID_INPUT',
    'cursor reuse across provider/status/project filter scope must fail'
  )
  const forgedAnchorCursor = rewriteCursor(cursorProbe.nextCursor, (cursor) => ({
    ...cursor,
    id: 'attempt-page-missing-anchor'
  }))
  await expectCode(
    api.queryPersistedModelAttempts({
      runId: 'run-pagination', requestId: 'request-pagination', limit: 2,
      cursor: forgedAnchorCursor
    }, paginationData),
    'MODEL_ATTEMPT_INVALID_INPUT',
    'cursor anchor must exist in the normalized filter scope'
  )
  const wrongFilterAnchorCursor = rewriteCursor(cursorProbe.nextCursor, (cursor) => ({
    ...cursor,
    scopeDigest: schema.modelAttemptQueryScopeDigest({
      runId: 'run-pagination', requestId: 'request-pagination', providerId: 'anthropic'
    })
  }))
  await expectCode(
    api.queryPersistedModelAttempts({
      runId: 'run-pagination', requestId: 'request-pagination', providerId: 'anthropic',
      limit: 2, cursor: wrongFilterAnchorCursor
    }, paginationData),
    'MODEL_ATTEMPT_INVALID_INPUT',
    'cursor anchor must belong to the normalized filtered set even with a matching scope digest'
  )
  const pagedIds = []
  let cursor
  let pageCount = 0
  do {
    const page = await api.queryPersistedModelAttempts({
      runId: 'run-pagination', requestId: 'request-pagination', limit: 173, cursor
    }, paginationData)
    assertEqual(page.total, 501, 'every cursor page must retain stable total')
    pagedIds.push(...page.attempts.map((attempt) => attempt.id))
    pageCount += 1
    if (page.hasMore) assert(page.nextCursor, 'non-final cursor page must provide nextCursor')
    cursor = page.nextCursor
  } while (cursor)
  assertEqual(pageCount, 3, '501 Attempts must paginate into three stable pages')
  assertEqual(pagedIds.length, 501, 'cursor pagination must return every Attempt')
  assertEqual(new Set(pagedIds).size, 501, 'cursor pagination must not duplicate Attempts')
  assertEqual(pagedIds[0], 'attempt-page-000', 'cursor ordering must start at ordinal 1')
  assertEqual(pagedIds.at(-1), 'attempt-page-500', 'cursor ordering must end at ordinal 501')
  await api.startPersistedModelAttempt(startInput({
    id: 'attempt-page-501', commandId: 'command-page-501', requestId: 'request-pagination',
    runId: 'run-pagination', startedAt: 1_501
  }), paginationData)
  await expectCode(
    api.queryPersistedModelAttempts({
      runId: 'run-pagination', requestId: 'request-pagination', limit: 2,
      cursor: cursorProbe.nextCursor
    }, paginationData),
    'MODEL_ATTEMPT_CURSOR_STALE',
    'cursor must fail closed when the ledger head changes during pagination'
  )

  await saveRun(
    snapshotStore, 'run-semantic', 'session-semantic', 'project-semantic', 'task-semantic', 600,
    semanticData
  )
  const semanticAttempt = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-semantic', commandId: 'command-semantic-start', requestId: 'request-semantic',
    runId: 'run-semantic', startedAt: 610
  }), semanticData)
  const semanticComplete = await api.completePersistedModelAttempt(semanticAttempt.id, {
    commandId: 'command-semantic-complete', expectedRevision: 1, status: 'succeeded', completedAt: 620,
    usage: { inputTokens: 10, outputTokens: 2 }
  }, semanticData)
  await snapshotStore.mutateTaskSnapshotDatabase(semanticData, (db) => {
    const { nextAttemptId: _next, recordDigest: _digest, ...withoutDigest } = semanticComplete
    const corruptedWithoutDigest = {
      ...withoutDigest,
      usage: { ...semanticComplete.usage, inputTokens: -1 }
    }
    const recordDigest = codec.digest(corruptedWithoutDigest)
    const corrupted = { ...corruptedWithoutDigest, recordDigest }
    db.run(
      'UPDATE model_attempts SET input_tokens = ?, record_digest = ?, payload = ? WHERE id = ?',
      [-1, recordDigest, codec.canonicalJson(corrupted), semanticComplete.id]
    )
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(semanticData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'semantically invalid stored usage must map to corruption'
  )

  await saveRun(
    snapshotStore, 'run-canonical', 'session-canonical', 'project-canonical', 'task-canonical', 650,
    canonicalData
  )
  const canonicalAttempt = await api.startPersistedModelAttempt(startInput({
    id: 'attempt-canonical', commandId: 'command-canonical', requestId: 'request-canonical',
    runId: 'run-canonical', startedAt: 660
  }), canonicalData)
  await snapshotStore.mutateTaskSnapshotDatabase(canonicalData, (db) => {
    const { nextAttemptId: _next, recordDigest: _digest, ...withoutDigest } = canonicalAttempt
    const nonCanonicalWithoutDigest = { ...withoutDigest, providerId: ` ${canonicalAttempt.providerId}` }
    const recordDigest = codec.digest(nonCanonicalWithoutDigest)
    const nonCanonical = { ...nonCanonicalWithoutDigest, recordDigest }
    db.run(
      'UPDATE model_attempts SET provider_id = ?, record_digest = ?, payload = ? WHERE id = ?',
      [nonCanonical.providerId, recordDigest, codec.canonicalJson(nonCanonical), canonicalAttempt.id]
    )
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(canonicalData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'stored text must equal its canonical normalized value'
  )
  await snapshotStore.mutateTaskSnapshotDatabase(canonicalData, (db) => {
    db.run(
      'UPDATE model_attempts SET provider_id = ?, record_digest = ?, payload = ? WHERE id = ?',
      [
        canonicalAttempt.providerId,
        canonicalAttempt.recordDigest,
        codec.canonicalJson(canonicalAttempt),
        canonicalAttempt.id
      ]
    )
  })
  await api.verifyPersistedModelAttemptLedger(canonicalData)
  await snapshotStore.mutateTaskSnapshotDatabase(canonicalData, (db) => {
    const { nextAttemptId: _next, recordDigest: _digest, ...withoutDigest } = canonicalAttempt
    const unknownWithoutDigest = { ...withoutDigest, unexpectedSecretField: 'should-not-persist' }
    const recordDigest = codec.digest(unknownWithoutDigest)
    const unknown = { ...unknownWithoutDigest, recordDigest }
    db.run(
      'UPDATE model_attempts SET record_digest = ?, payload = ? WHERE id = ?',
      [recordDigest, codec.canonicalJson(unknown), canonicalAttempt.id]
    )
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(canonicalData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'stored Attempt payload must reject unknown top-level fields'
  )

  await saveRun(
    snapshotStore, 'run-partial', 'session-partial', 'project-partial', 'task-partial', 700,
    partialSchemaData
  )
  await api.startPersistedModelAttempt(startInput({
    id: 'attempt-partial', commandId: 'command-partial', requestId: 'request-partial',
    runId: 'run-partial', startedAt: 710
  }), partialSchemaData)
  await snapshotStore.mutateTaskSnapshotDatabase(partialSchemaData, (db) => {
    store.verifyModelAttemptLedger(db)
    assertEqual(db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0], 1, 'ModelAttempt connection must enable foreign keys')
    db.run('DROP TABLE model_attempt_events')
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(partialSchemaData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'missing event table must map to corruption instead of silent recreation'
  )

  await saveRun(
    snapshotStore, 'run-deleted-tables', 'session-deleted-tables', 'project-deleted',
    'task-deleted', 720, deletedTablesData
  )
  await api.startPersistedModelAttempt(startInput({
    id: 'attempt-deleted-tables', commandId: 'command-deleted-tables',
    requestId: 'request-deleted-tables', runId: 'run-deleted-tables', startedAt: 730
  }), deletedTablesData)
  await snapshotStore.mutateTaskSnapshotDatabase(deletedTablesData, (db) => {
    db.run('DROP TABLE model_attempt_events')
    db.run('DROP TABLE model_attempts')
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(deletedTablesData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'meta marker must detect simultaneous deletion of both primary ledger tables'
  )

  await saveRun(
    snapshotStore, 'run-truncated', 'session-truncated', 'project-truncated',
    'task-truncated', 740, truncatedData
  )
  await api.startPersistedModelAttempt(startInput({
    id: 'attempt-truncated', commandId: 'command-truncated', requestId: 'request-truncated',
    runId: 'run-truncated', startedAt: 750
  }), truncatedData)
  await snapshotStore.mutateTaskSnapshotDatabase(truncatedData, (db) => {
    db.run("DELETE FROM model_attempt_events WHERE attempt_id = 'attempt-truncated'")
    db.run("DELETE FROM model_attempts WHERE id = 'attempt-truncated'")
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(truncatedData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'meta marker must detect a truncated valid ledger suffix'
  )

  await saveRun(
    snapshotStore, 'run-missing-fk', 'session-missing-fk', 'project-schema',
    'task-missing-fk', 760, missingForeignKeyData
  )
  await snapshotStore.mutateTaskSnapshotDatabase(missingForeignKeyData, (db) => {
    installMalformedModelAttemptSchema(db, { includeForeignKeys: false, includeOrdinalUnique: true })
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(missingForeignKeyData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'schema contract must reject tables without declared foreign keys'
  )

  await saveRun(
    snapshotStore, 'run-missing-unique', 'session-missing-unique', 'project-schema',
    'task-missing-unique', 770, missingUniqueData
  )
  await snapshotStore.mutateTaskSnapshotDatabase(missingUniqueData, (db) => {
    installMalformedModelAttemptSchema(db, { includeForeignKeys: true, includeOrdinalUnique: false })
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(missingUniqueData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'schema contract must reject missing UNIQUE constraints'
  )

  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
    db.run("UPDATE model_attempt_events SET payload = '{\"tampered\":true}' WHERE seq = 1")
  })
  await expectCode(
    api.verifyPersistedModelAttemptLedger(userData),
    'MODEL_ATTEMPT_LEDGER_CORRUPTION',
    'tampered chain payload must fail verification'
  )

  console.log(JSON.stringify({
    status: 'pass',
    checks: [
      'start-complete-idempotency', 'restart-persistence', 'concurrent-ordinal', 'completion-cas',
      'request-interleaving', 'cross-run-project-rejection', 'secret-and-entropy-rejection',
      'provider-key-failover-linkage', 'terminal-run-rejection', 'stable-cursor-501',
      'cursor-scope-anchor-head', 'meta-delete-and-truncation', 'canonical-closed-record',
      'run-status-enum', 'low-entropy-error-class', 'failover-time-order',
      'stored-semantic-corruption', 'schema-contract-and-foreign-key-integrity',
      'hash-chain-tamper'
    ],
    attemptsBeforeTamper: verified.attempts,
    eventsBeforeTamper: verified.events
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/model-attempt-api.ts',
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

function installMalformedModelAttemptSchema(db, options) {
  const ordinalUnique = options.includeOrdinalUnique
    ? ', UNIQUE(run_id, request_id, ordinal)'
    : ''
  const attemptForeignKeys = options.includeForeignKeys
    ? `,
       FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE RESTRICT,
       FOREIGN KEY(failover_from_attempt_id) REFERENCES model_attempts(id) ON DELETE RESTRICT`
    : ''
  const eventForeignKeys = options.includeForeignKeys
    ? `,
       FOREIGN KEY(attempt_id) REFERENCES model_attempts(id) ON DELETE RESTRICT,
       FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE RESTRICT`
    : ''
  db.run(`
    CREATE TABLE model_attempts (
      id TEXT PRIMARY KEY,
      start_command_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      step_id TEXT,
      project_id TEXT,
      goal_id TEXT,
      work_item_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      protocol TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      key_label TEXT,
      context_digest TEXT NOT NULL,
      route_reason TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_usd REAL,
      outcome TEXT,
      error_class TEXT,
      failover_from_attempt_id TEXT UNIQUE,
      start_payload_digest TEXT NOT NULL,
      completion_command_id TEXT UNIQUE,
      completion_payload_digest TEXT,
      record_digest TEXT NOT NULL,
      payload TEXT NOT NULL
      ${ordinalUnique}
      ${attemptForeignKeys}
    );
    CREATE TABLE model_attempt_events (
      seq INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      prev_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      payload TEXT NOT NULL
      ${eventForeignKeys}
    );
    CREATE TABLE model_attempt_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      initialized INTEGER NOT NULL CHECK(initialized = 1),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      event_count INTEGER NOT NULL CHECK(event_count >= 0),
      last_seq INTEGER NOT NULL CHECK(last_seq >= 0),
      last_digest TEXT NOT NULL
    );
    INSERT INTO model_attempt_meta(
      id, initialized, attempt_count, event_count, last_seq, last_digest
    ) VALUES (1, 1, 0, 0, 0, '${'0'.repeat(64)}');
  `)
}

function seedPaginationAttempts(db, schema, codec, count) {
  schema.setupModelAttemptSchema(db)
  const meta = schema.readModelAttemptLedgerMeta(db)
  const stmt = db.prepare(
    'SELECT project_id, goal_id, work_item_id FROM workflow_runs WHERE id = ? LIMIT 1'
  )
  let owner
  try {
    stmt.bind(['run-pagination'])
    if (!stmt.step()) throw new Error('pagination fixture Run is missing')
    owner = stmt.getAsObject()
  } finally {
    stmt.free()
  }
  let currentMeta = meta
  let previousDigest = meta.lastDigest
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(3, '0')
    const id = `attempt-page-${suffix}`
    const commandId = `command-page-${suffix}`
    const stepId = index % 2 === 0 ? `step-${suffix}` : undefined
    const startedAt = 1_000 + index
    const normalizedInput = {
      id, commandId, requestId: 'request-pagination', stepId, runId: 'run-pagination',
      providerId: 'openai', model: 'gpt-fixture', protocol: 'openai.responses',
      adapterVersion: 'adapter-v1', contextDigest: `sha256:${'a'.repeat(64)}`,
      routeReason: 'Selected for capability and healthy capacity.', keyLabel: 'label:primary',
      failoverFromAttemptId: undefined, startedAt,
      projectId: undefined, goalId: undefined, workItemId: undefined
    }
    const withoutDigest = {
      schemaVersion: 1,
      id,
      runId: 'run-pagination',
      requestId: 'request-pagination',
      stepId,
      projectId: owner.project_id ?? undefined,
      goalId: owner.goal_id ?? undefined,
      workItemId: owner.work_item_id,
      ordinal: index + 1,
      providerId: normalizedInput.providerId,
      model: normalizedInput.model,
      protocol: normalizedInput.protocol,
      adapterVersion: normalizedInput.adapterVersion,
      contextDigest: normalizedInput.contextDigest,
      routeReason: normalizedInput.routeReason,
      keyLabel: normalizedInput.keyLabel,
      status: 'started',
      revision: 1,
      startedAt,
      startCommandId: commandId,
      startPayloadDigest: codec.digest(normalizedInput)
    }
    const attempt = { ...withoutDigest, recordDigest: codec.digest(withoutDigest) }
    schema.insertModelAttempt(db, attempt)
    const payload = schema.modelAttemptEventPayload(attempt, attempt.startPayloadDigest)
    const eventWithoutDigest = {
      schemaVersion: 1,
      seq: meta.lastSeq + index + 1,
      eventId: `model-attempt:${id}:revision:1`,
      commandId,
      attemptId: id,
      runId: 'run-pagination',
      kind: 'model_attempt.started',
      revision: 1,
      occurredAt: startedAt,
      prevDigest: previousDigest,
      payload
    }
    const eventDigest = codec.digest(eventWithoutDigest)
    db.run(
      `INSERT INTO model_attempt_events(
         seq, event_id, command_id, attempt_id, run_id, kind, revision,
         occurred_at, prev_digest, record_digest, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventWithoutDigest.seq, eventWithoutDigest.eventId, commandId, id, 'run-pagination',
        eventWithoutDigest.kind, 1, startedAt, previousDigest, eventDigest, codec.canonicalJson(payload)
      ]
    )
    const nextMeta = {
      attemptCount: currentMeta.attemptCount + 1,
      eventCount: currentMeta.eventCount + 1,
      lastSeq: eventWithoutDigest.seq,
      lastDigest: eventDigest
    }
    schema.updateModelAttemptLedgerMeta(db, currentMeta, nextMeta)
    currentMeta = { initialized: true, ...nextMeta }
    previousDigest = eventDigest
  }
}

async function saveRun(snapshotStore, runId, sessionId, projectId, taskId, now, root = userData) {
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: buildMeta(sessionId, projectId, taskId),
    transcript: [], lastSeq: 0, eventCount: 0, reason: 'created',
    run: buildRun(runId, sessionId, taskId, now), now
  }), root)
}

function buildMeta(id, projectId, childTaskId) {
  return {
    id, title: id, cwd: userData, projectId, childTaskId,
    model: 'fixture-model', providerId: 'fixture-provider', permissionMode: 'default',
    status: 'running', sdkSessionId: `sdk-${id}`, costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0, createdAt: 1
  }
}

function buildRun(id, sessionId, taskId, now) {
  return {
    schemaVersion: 1, id, sessionId, taskId, status: 'executing', revision: 1,
    attempt: 1, recoveryCount: 0, createdAt: 1, updatedAt: now,
    steps: [], toolExecutions: [], effects: []
  }
}

function startInput(overrides) {
  return {
    id: 'attempt-fixture', commandId: 'command-fixture', requestId: 'request-fixture', runId: 'run-main',
    providerId: 'openai', model: 'gpt-fixture', protocol: 'openai.responses',
    adapterVersion: 'adapter-v1', contextDigest: `sha256:${'a'.repeat(64)}`,
    routeReason: 'Selected for capability and healthy capacity.', keyLabel: 'label:primary',
    startedAt: 1, ...overrides
  }
}

function rewriteCursor(value, rewrite) {
  const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  return Buffer.from(JSON.stringify(rewrite(decoded)), 'utf8').toString('base64url')
}

async function expectCode(promise, code, message) {
  try {
    await promise
  } catch (error) {
    assertEqual(error?.code, code, `${message} code`)
    return
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
