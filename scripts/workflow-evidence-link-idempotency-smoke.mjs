import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-evidence-link-idempotency-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  compileSources()
  installElectronStub()
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({
    locateFile: (file) => file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file
  })
  const ledger = require(findCompiledModule('workflow-ledger-store.js'))
  const evidence = require(findCompiledModule('workflow-evidence-store.js'))
  const db = new SQL.Database()

  try {
    ledger.setupWorkflowLedgerSchema(db)
    evidence.setupWorkflowEvidenceSchema(db)
    ledger.registerWorkflowArtifact(db, {
      id: 'artifact-idempotency',
      projectId: 'project-idempotency',
      kind: 'test_report',
      title: 'Evidence link idempotency report',
      digest: 'sha256:evidence-link-idempotency',
      createdAt: 100,
      updatedAt: 100
    })
    const workflowEvidence = evidence.appendWorkflowEvidence(db, {
      evidenceId: 'evidence-idempotency',
      projectId: 'project-idempotency',
      artifactId: 'artifact-idempotency',
      kind: 'test_result',
      title: 'Evidence link idempotency result',
      verifier: 'workflow-evidence-link-idempotency-smoke',
      observedAt: 110,
      contentDigest: 'a'.repeat(64)
    }, { createdAt: 110 })
    ledger.appendWorkflowEvent(db, {
      eventId: `workflow:evidence-record:${workflowEvidence.evidenceId}`,
      streamId: `project:${workflowEvidence.projectId}`,
      entityType: 'system',
      entityId: workflowEvidence.evidenceId,
      kind: 'workflow.evidence.recorded',
      payload: { ...workflowEvidence },
      occurredAt: workflowEvidence.createdAt,
      correlationId: workflowEvidence.evidenceId
    }, { projectId: workflowEvidence.projectId })

    const input = {
      id: ' link-idempotency ',
      evidenceId: 'evidence-idempotency',
      projectId: 'project-idempotency',
      artifactId: 'artifact-idempotency',
      evidenceOrigin: 'workflow',
      relation: 'supports'
    }
    const originalDateNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      const first = ledger.linkWorkflowEvidence(db, input)
      assertEqual(first.id, 'link-idempotency', 'first link id must be normalized')
      assertEqual(first.createdAt, 1_000, 'first omitted createdAt must be generated once')
      const firstVerification = ledger.verifyWorkflowLedger(db)

      now = 2_000
      const replay = ledger.linkWorkflowEvidence(db, input)
      assertEqual(replay.createdAt, first.createdAt, 'omitted createdAt replay must preserve persisted timestamp')
      const replayVerification = ledger.verifyWorkflowLedger(db)
      assertEqual(replayVerification.evidenceLinks, 1, 'idempotent replay must not duplicate the link')
      assertEqual(replayVerification.events, firstVerification.events, 'idempotent replay must not append an event')
      assertEqual(replayVerification.lastDigest, firstVerification.lastDigest, 'idempotent replay must preserve event chain')

      const explicitReplay = ledger.linkWorkflowEvidence(db, { ...input, createdAt: first.createdAt })
      assertEqual(explicitReplay.createdAt, first.createdAt, 'matching explicit createdAt must remain idempotent')
      expectCorruption(
        () => ledger.linkWorkflowEvidence(db, { ...input, createdAt: 2_000 }),
        'different explicit createdAt must fail closed'
      )
      expectCorruption(
        () => ledger.linkWorkflowEvidence(db, { ...input, relation: 'supersedes' }),
        'different immutable content must fail closed'
      )
    } finally {
      Date.now = originalDateNow
    }
  } finally {
    db.close()
  }

  console.log('workflow evidence link idempotency smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/workflow-ledger-store.ts',
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

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), "exports.app = { getPath: () => '' }\n")
}

function findCompiledModule(name) {
  const entries = require('node:fs').readdirSync(outDir, { recursive: true, withFileTypes: true })
  const entry = entries.find((candidate) => candidate.isFile() && candidate.name === name)
  if (!entry) throw new Error(`compiled ${name} not found under ${outDir}`)
  return path.join(entry.parentPath, entry.name)
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
