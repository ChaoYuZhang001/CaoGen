import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workflow-evidence-'))
const outDir = path.join(tempRoot, 'compiled')
const dbPath = path.join(tempRoot, 'workflow-evidence.db')

try {
  compileSources()
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({
    locateFile: (file) => file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file
  })
  const store = require(findCompiledModule(outDir, 'workflow-evidence-store.js'))

  const db = new SQL.Database()
  try {
    store.setupWorkflowEvidenceSchema(db)
    assertVerification(store.verifyWorkflowEvidence(db), 0, 0, '0'.repeat(64), 'empty ledger')

    const firstInput = evidenceInput({
      evidenceId: 'evidence-a',
      projectId: 'project-a',
      goalId: 'goal-a',
      workItemId: 'work-a',
      runId: 'run-a',
      artifactId: 'artifact-a',
      kind: 'test_result',
      source: 'human',
      observedAt: 999,
      metadata: { nested: { passed: true }, values: [1, 'two', null] }
    })
    const firstAuthority = {
      source: 'runtime', verifier: 'trusted-main-authority', observedAt: 100, createdAt: 110
    }
    const first = store.appendWorkflowEvidence(db, firstInput, firstAuthority)
    assertEqual(first.seq, 1, 'first sequence')
    assertEqual(first.prevDigest, '0'.repeat(64), 'first previous digest')
    assertEqual(first.id, 'workflow-evidence:evidence-a', 'derived record id')
    assertEqual(first.source, 'runtime', 'main authority must override renderer source')
    assertEqual(first.verifier, 'trusted-main-authority', 'main authority must override renderer verifier')
    assertEqual(first.observedAt, 100, 'main authority must override renderer observedAt')
    assertEqual(first.title, 'Workflow evidence fixture', 'benign evidence title must remain unchanged')
    assertEqual(first.summary, 'Immutable evidence fixture', 'benign evidence summary must remain unchanged')
    assertEqual(first.uri, 'artifact://workflow-evidence/fixture', 'benign evidence URI must remain unchanged')
    assertEqual(first.mediaType, 'application/json', 'benign evidence media type must remain unchanged')

    const duplicate = store.appendWorkflowEvidence(db, firstInput, { ...firstAuthority, createdAt: 999 })
    assertEqual(duplicate.digest, first.digest, 'same evidenceId/content must be idempotent')
    assertEqual(duplicate.createdAt, 110, 'idempotent replay must preserve createdAt')
    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...firstInput, title: 'conflicting title' }, { createdAt: 120 }),
      'same evidenceId with different content must fail closed'
    )

    const second = store.appendWorkflowEvidence(db, evidenceInput({
      evidenceId: 'evidence-b', projectId: 'project-b', goalId: 'goal-b',
      workItemId: 'work-b', runId: 'run-b', artifactId: 'artifact-b', kind: 'approval',
      source: 'human', observedAt: 200
    }), { createdAt: 210 })
    const third = store.appendWorkflowEvidence(db, evidenceInput({
      evidenceId: 'evidence-c', projectId: 'project-a', goalId: 'goal-a',
      workItemId: 'work-c', runId: 'run-c', artifactId: 'artifact-c', kind: 'approval',
      source: 'imported', observedAt: 300
    }), { createdAt: 310 })
    assertEqual(second.prevDigest, first.digest, 'second record must link to first')
    assertEqual(third.prevDigest, second.digest, 'third record must link to second')

    assertCount(store.listWorkflowEvidence(db, { evidenceId: 'evidence-a' }), 1, 'evidenceId scope')
    assertCount(store.listWorkflowEvidence(db, { projectId: 'project-a' }), 2, 'project scope')
    assertCount(store.listWorkflowEvidence(db, { goalId: 'goal-a' }), 2, 'goal scope')
    assertCount(store.listWorkflowEvidence(db, { workItemId: 'work-a' }), 1, 'work item scope')
    assertCount(store.listWorkflowEvidence(db, { runId: 'run-b' }), 1, 'run scope')
    assertCount(store.listWorkflowEvidence(db, { artifactId: 'artifact-c' }), 1, 'artifact scope')
    assertCount(store.listWorkflowEvidence(db, { kind: 'approval' }), 2, 'kind scope')
    assertCount(
      store.listWorkflowEvidence(db, { projectId: 'project-a', goalId: 'goal-a', kind: 'approval' }),
      1,
      'combined scope'
    )

    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...evidenceInput(), unsupported: true }),
      'unknown input fields must fail strict validation'
    )
    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...evidenceInput(), kind: 'not-a-kind' }),
      'unknown evidence kind must fail strict validation'
    )
    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...evidenceInput(), contentDigest: 'not-a-digest' }),
      'content digest must be exactly 64 hexadecimal characters'
    )
    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...evidenceInput(), metadata: { invalid: undefined } }),
      'non-JSON metadata must fail strict validation'
    )
    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...evidenceInput(), metadata: { apiKey: 'x' } }),
      'credential-like metadata must fail the shared secret-free policy'
    )
    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...evidenceInput(), title: 'token fixture' }),
      'credential-like title must fail the shared secret-free policy'
    )
    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...evidenceInput(), summary: 'security_canary' }),
      'credential-like summary must fail the shared secret-free policy'
    )
    expectCorruption(
      () => store.appendWorkflowEvidence(db, { ...evidenceInput(), mediaType: 'application/json; token=x' }),
      'credential-like media type must fail the shared secret-free policy'
    )
    expectCorruption(
      () => store.appendWorkflowEvidence(db, {
        ...evidenceInput(), uri: 'https://example.test/evidence?api_key=x'
      }),
      'credential-like URI must fail the shared secret-free policy'
    )
    expectCorruption(
      () => store.listWorkflowEvidence(db, { projectId: 'project-a', unsupported: true }),
      'unknown scope fields must fail strict validation'
    )
    expectCorruption(
      () => store.selectWorkflowEvidence(db, { projectId: 'project-a', limit: 0 }),
      'non-positive page limit must fail strict validation'
    )
    expectCorruption(
      () => store.selectWorkflowEvidence(db, { projectId: 'project-a', cursor: 'not-a-cursor' }),
      'non-decimal page cursor must fail strict validation'
    )

    const verified = store.verifyWorkflowEvidence(db)
    assertVerification(verified, 3, 3, third.digest, 'fresh ledger')
    writeFileSync(dbPath, db.export())
  } finally {
    db.close()
  }

  const restarted = new SQL.Database(readFileSync(dbPath))
  let restartBytes
  try {
    const verification = store.verifyWorkflowEvidence(restarted)
    assertEqual(verification.count, 3, 'restart must retain all records')
    const replay = store.appendWorkflowEvidence(restarted, evidenceInput({
      evidenceId: 'evidence-a',
      projectId: 'project-a',
      goalId: 'goal-a',
      workItemId: 'work-a',
      runId: 'run-a',
      artifactId: 'artifact-a',
      kind: 'test_result',
      source: 'human',
      observedAt: 999,
      metadata: { nested: { passed: true }, values: [1, 'two', null] }
    }), {
      source: 'runtime', verifier: 'trusted-main-authority', observedAt: 100, createdAt: 9999
    })
    assertEqual(replay.seq, 1, 'idempotency must survive restart')
    const fourth = store.appendWorkflowEvidence(restarted, evidenceInput({
      evidenceId: 'evidence-d', projectId: 'project-d', kind: 'security_scan', observedAt: 400
    }), { createdAt: 410 })
    assertEqual(fourth.seq, 4, 'append after restart must continue sequence')
    assertEqual(fourth.prevDigest, verification.lastDigest, 'append after restart must continue digest chain')
    restartBytes = restarted.export()
  } finally {
    restarted.close()
  }

  const tamperedColumn = new SQL.Database(restartBytes)
  try {
    tamperedColumn.run("UPDATE workflow_evidence SET title = 'tampered' WHERE evidence_id = 'evidence-a'")
    expectCorruption(
      () => store.listWorkflowEvidence(tamperedColumn, { evidenceId: 'evidence-d' }),
      'scoped read must verify the full chain before filtering'
    )
  } finally {
    tamperedColumn.close()
  }

  const tamperedDigest = new SQL.Database(restartBytes)
  try {
    tamperedDigest.run(`UPDATE workflow_evidence SET record_digest = '${'f'.repeat(64)}' WHERE seq = 2`)
    expectCorruption(
      () => store.verifyWorkflowEvidence(tamperedDigest),
      'record digest tampering must fail verification'
    )
  } finally {
    tamperedDigest.close()
  }

  const limitDb = new SQL.Database()
  try {
    store.setupWorkflowEvidenceSchema(limitDb)
    for (let index = 0; index < 501; index += 1) {
      store.appendWorkflowEvidence(limitDb, evidenceInput({
        evidenceId: `limit-${index}`,
        projectId: 'limit-project',
        contentDigest: index.toString(16).padStart(64, '0')
      }), { createdAt: 1000 + index })
    }
    assertEqual(store.verifyWorkflowEvidence(limitDb).count, 501, 'limit fixture chain count')
    assertEqual(
      store.readAllWorkflowEvidenceForIntegrity(limitDb).length,
      501,
      'internal integrity read must not apply the renderer list cap'
    )
    const latestWindow = store.listWorkflowEvidence(limitDb, { projectId: 'limit-project' })
    assertEqual(latestWindow.length, 500, 'legacy list result cap')
    assertEqual(latestWindow[0].seq, 2, 'legacy list must expose the latest bounded window')
    assertEqual(latestWindow.at(-1).seq, 501, 'legacy list latest window must include the ledger head')
    assertEqual(
      store.listWorkflowEvidence(limitDb, { projectId: 'limit-project', limit: 500, cursor: '500' })[0].seq,
      501,
      'legacy list must accept explicit pagination without changing its array result shape'
    )

    const pagedIds = []
    let cursor
    let pages = 0
    do {
      const page = store.selectWorkflowEvidence(limitDb, {
        projectId: 'limit-project', limit: 173, cursor
      })
      assertEqual(page.total, 501, 'every evidence page must report the complete filtered total')
      pagedIds.push(...page.items.map((record) => record.evidenceId))
      pages += 1
      if (page.hasMore) {
        assertEqual(Boolean(page.nextCursor), true, 'non-final evidence page must provide nextCursor')
      }
      cursor = page.nextCursor
    } while (cursor)
    assertEqual(pages, 3, '501 evidence records must paginate into three pages')
    assertEqual(pagedIds.length, 501, 'evidence pagination must return every record')
    assertEqual(new Set(pagedIds).size, 501, 'evidence pagination must not duplicate records')
    assertEqual(pagedIds[0], 'limit-0', 'evidence pagination must start at the first matching record')
    assertEqual(pagedIds.at(-1), 'limit-500', 'evidence pagination must reach the ledger head')
  } finally {
    limitDb.close()
  }

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'sqlite-schema', 'strict-input', 'idempotent-evidence-id', 'conflict-fail-closed',
      'digest-chain', 'full-chain-before-filter', 'all-scope-filters', 'cross-restart',
      'sql-column-tamper', 'record-digest-tamper', 'main-authority-overrides',
      'secret-free-policy', 'benign-text-preservation', 'latest-500-legacy-window',
      'paged-complete-audit', 'uncapped-integrity-read'
    ],
    recordsBeforeTamper: 4
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function evidenceInput(overrides = {}) {
  return {
    evidenceId: 'evidence-default',
    projectId: 'project-default',
    kind: 'observation',
    title: 'Workflow evidence fixture',
    summary: 'Immutable evidence fixture',
    uri: 'artifact://workflow-evidence/fixture',
    mediaType: 'application/json',
    verifier: 'main-process-smoke',
    contentDigest: 'a'.repeat(64),
    metadata: { fixture: true },
    ...overrides
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/workflow-evidence-store.ts',
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
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  return null
}

function expectCorruption(operation, message) {
  try {
    operation()
  } catch (error) {
    if (error?.code === 'WORKFLOW_LEDGER_CORRUPTION') return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assertCount(records, expected, message) {
  assertEqual(records.length, expected, message)
}

function assertVerification(actual, count, lastSeq, lastDigest, message) {
  assertEqual(actual.valid, true, `${message} validity`)
  assertEqual(actual.count, count, `${message} count`)
  assertEqual(actual.lastSeq, lastSeq, `${message} last sequence`)
  assertEqual(actual.lastDigest, lastDigest, `${message} last digest`)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
