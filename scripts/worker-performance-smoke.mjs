#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-worker-performance-'))
const outDir = path.join(tempRoot, 'compiled')
try {
  compile('src/main/digital-worker/worker-performance.ts')
  const api = await import(pathToFileURL(findCompiled(outDir, 'worker-performance.js')).href)
  const worker = { id: 'worker-performance', projectId: 'project-performance' }
  const aggregate = {
    workflow: {
      runs: [
        run('run-1', 'completed', 0, 1000, 'acceptance-1', 'work-1'),
        run('run-2', 'failed', 1000, 3000, 'acceptance-2', 'work-1'),
        run('run-3', 'completed', 3000, 5000, 'acceptance-3', 'work-2')
      ],
      acceptances: [
        { id: 'acceptance-1', status: 'passed', revision: 1 },
        { id: 'acceptance-2', status: 'failed', revision: 1 },
        { id: 'acceptance-3', status: 'passed', revision: 1 }
      ]
    },
    workItems: [
      { id: 'work-1', dueAt: 4000 }, { id: 'work-2', dueAt: 6000 }
    ]
  }
  const profile = api.buildDigitalWorkerPerformanceProfile(worker, aggregate, [
    attempt('attempt-1', 'run-1', 'succeeded', 0.4),
    attempt('attempt-2', 'run-2', 'failed', undefined),
    attempt('attempt-3', 'run-3', 'succeeded', 0.2)
  ], 9000)
  assert.equal(profile.acceptancePassRate, 0.6667)
  assert.equal(profile.reworkRuns, 1)
  assert.equal(profile.costUsd, 0.6)
  assert.equal(profile.costCoverage, 'partial')
  assert.equal(profile.unpricedAttempts, 1)
  assert(!Object.keys(profile).some((key) => /provider|model|engine/i.test(key)))
  console.log('worker performance smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function run(id, status, startedAt, finishedAt, acceptanceId, workItemId) {
  return { id, revision: 1, status, startedAt, finishedAt, acceptanceId, workItemId,
    taskRun: { digitalWorkerBinding: { kind: 'assigned', workerId: 'worker-performance' } } }
}
function attempt(id, runId, status, costUsd) {
  return { id, runId, revision: 1, status, ...(costUsd === undefined ? {} : { costUsd }) }
}
function compile(entry) {
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), entry,
    '--outDir', outDir, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--types', 'node', '--skipLibCheck', '--esModuleInterop'], { cwd: repoRoot, stdio: 'inherit' })
}
function findCompiled(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) { try { return findCompiled(full, name) } catch { /* continue */ } }
    else if (entry.name === name) return full
  }
  throw new Error(`compiled ${name} not found`)
}
