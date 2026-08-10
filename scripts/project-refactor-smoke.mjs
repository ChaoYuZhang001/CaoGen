#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
mkdirSync(path.join(repoRoot, 'tmp'), { recursive: true })
const tempRoot = mkdtempSync(path.join(repoRoot, 'tmp', 'project-refactor-smoke-'))
const projectDir = path.join(tempRoot, 'project')
const checks = []
let runtime

const modelPath = path.join(projectDir, 'src', 'model.ts')
const consumerPath = path.join(projectDir, 'src', 'consumer.ts')
const originalModel = [
  'export function calculateTotal(value: number): number {',
  '  return value * 2',
  '}',
  ''
].join('\n')
const originalConsumer = [
  "import { calculateTotal } from './model'",
  'export const result = calculateTotal(21)',
  ''
].join('\n')

try {
  mkdirSync(path.dirname(modelPath), { recursive: true })
  writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['src/**/*.ts']
  }, null, 2))
  writeFileSync(modelPath, originalModel)
  writeFileSync(consumerPath, originalConsumer)

  const bundlePath = path.join(tempRoot, 'project-refactor.mjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src', 'main', 'projectRefactor.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['typescript', 'typescript-language-server']
  })
  runtime = await import(pathToFileURL(bundlePath).href)
  runtime.configureProjectRefactorRecovery(path.join(tempRoot, 'userData'))

  await assert.rejects(
    runtime.previewTypeScriptRename(projectDir, 'invalid-name', request(originalModel, 'not-valid!')),
    /input is invalid/,
    'invalid TypeScript identifiers are rejected before LSP execution'
  )
  await assert.rejects(
    runtime.previewTypeScriptRename(projectDir, 'escape', { ...request(originalModel, 'computeTotal'), path: '../outside.ts' }),
    /escapes|project-relative/,
    'source paths cannot escape the Session workspace'
  )
  await assert.rejects(
    runtime.previewTypeScriptRename(projectDir, 'unsaved', request(`${originalModel}// draft\n`, 'computeTotal')),
    /Save the active file/,
    'unsaved editor content cannot overwrite a different disk snapshot'
  )

  const preview = await runtime.previewTypeScriptRename(projectDir, 'rename-session', request(originalModel, 'computeTotal'))
  equal(preview.kind, 'typescript-rename', 'preview identifies the refactor kind')
  equal(preview.files.length, 2, 'cross-file TypeScript references are included')
  check('preview covers the declaration, import, and call', preview.totalEdits >= 3)
  check('preview contains only project-relative paths', preview.files.every((file) => !path.isAbsolute(file.path)))
  check('preview exposes bounded changed lines and digests, not full file snapshots', preview.files.every((file) =>
    file.lines.length > 0 && /^[a-f0-9]{64}$/.test(file.beforeDigest) && !('before' in file) && !('after' in file)))
  check('line preview shows old and new symbol names', preview.files.flatMap((file) => file.lines)
    .some((line) => line.kind === 'removed' && line.text.includes('calculateTotal')) && preview.files.flatMap((file) => file.lines)
    .some((line) => line.kind === 'added' && line.text.includes('computeTotal')))

  writeFileSync(consumerPath, `${originalConsumer}// external drift\n`)
  await assert.rejects(
    runtime.applyProjectRefactor(projectDir, 'rename-session', preview.previewId),
    /stale/,
    'apply refuses files changed after preview'
  )
  writeFileSync(consumerPath, originalConsumer)

  const fresh = await runtime.previewTypeScriptRename(projectDir, 'rename-session', request(originalModel, 'computeTotal'))
  const concurrentApply = await Promise.allSettled([
    runtime.applyProjectRefactor(projectDir, 'rename-session', fresh.previewId),
    runtime.applyProjectRefactor(projectDir, 'rename-session', fresh.previewId)
  ])
  check('a preview is one-shot under concurrent apply attempts',
    concurrentApply.filter((result) => result.status === 'fulfilled').length === 1 && concurrentApply.filter((result) => result.status === 'rejected').length === 1)
  const applied = concurrentApply.find((result) => result.status === 'fulfilled').value
  equal(applied.ok, true, 'verified preview applies successfully')
  equal(applied.files.length, 2, 'apply reports every changed project-relative file')
  check('declaration is renamed on disk', readFileSync(modelPath, 'utf8').includes('function computeTotal'))
  check('import and call are renamed on disk', !readFileSync(consumerPath, 'utf8').includes('calculateTotal') && readFileSync(consumerPath, 'utf8').includes('computeTotal'))
  await assert.rejects(
    runtime.applyProjectRefactor(projectDir, 'other-session', fresh.previewId),
    /not found/,
    'consumed or cross-Session previews cannot be replayed'
  )

  const renamedConsumer = readFileSync(consumerPath, 'utf8')
  writeFileSync(consumerPath, `${renamedConsumer}// post-apply drift\n`)
  await assert.rejects(
    runtime.rollbackProjectRefactor(projectDir, 'rename-session', applied.operationId),
    /rollback was refused/,
    'rollback refuses files changed after apply'
  )
  writeFileSync(consumerPath, renamedConsumer)
  const rolledBack = await runtime.rollbackProjectRefactor(projectDir, 'rename-session', applied.operationId)
  equal(rolledBack.ok, true, 'verified refactor rolls back successfully')
  equal(readFileSync(modelPath, 'utf8'), originalModel, 'rollback restores declaration bytes exactly')
  equal(readFileSync(consumerPath, 'utf8'), originalConsumer, 'rollback restores reference bytes exactly')

  const restartPreview = await runtime.previewTypeScriptRename(projectDir, 'restart-session', request(originalModel, 'computeTotal'))
  const restartApplied = await runtime.applyProjectRefactor(projectDir, 'restart-session', restartPreview.previewId)
  const restarted = await import(`${pathToFileURL(bundlePath).href}?restart=1`)
  restarted.configureProjectRefactorRecovery(path.join(tempRoot, 'userData'))
  const restartRecovery = await restarted.getProjectRefactorRecovery(projectDir, 'restart-session')
  equal(restartRecovery.status, 'rollback_available', 'completed refactor remains rollback-capable after main-process restart')
  equal(restartRecovery.operationId, restartApplied.operationId, 'restart recovery preserves the opaque operation identity')
  await restarted.rollbackProjectRefactor(projectDir, 'restart-session', restartApplied.operationId)
  equal(readFileSync(modelPath, 'utf8'), originalModel, 'restart rollback restores the declaration')
  equal(readFileSync(consumerPath, 'utf8'), originalConsumer, 'restart rollback restores the consumer')

  const interruptedPreview = await restarted.previewTypeScriptRename(projectDir, 'interrupted-session', request(originalModel, 'computeTotal'))
  const interrupted = await restarted.applyProjectRefactor(projectDir, 'interrupted-session', interruptedPreview.previewId)
  writeFileSync(modelPath, originalModel)
  rewriteJournalStage(path.join(tempRoot, 'userData'), interrupted.operationId, 'applying')
  const afterCrash = await import(`${pathToFileURL(bundlePath).href}?restart=2`)
  afterCrash.configureProjectRefactorRecovery(path.join(tempRoot, 'userData'))
  const interruptedRecovery = await afterCrash.getProjectRefactorRecovery(projectDir, 'interrupted-session')
  equal(interruptedRecovery.status, 'auto_rolled_back', 'mixed before/after files are compensated after an interrupted apply')
  equal(readFileSync(modelPath, 'utf8'), originalModel, 'interrupted recovery retains the original declaration')
  equal(readFileSync(consumerPath, 'utf8'), originalConsumer, 'interrupted recovery restores the partially changed consumer')
  await afterCrash.dismissProjectRefactorRecovery(projectDir, 'interrupted-session', interrupted.operationId)
  equal((await afterCrash.getProjectRefactorRecovery(projectDir, 'interrupted-session')).status, 'none', 'completed recovery notice can be acknowledged')

  const blockedPreview = await afterCrash.previewTypeScriptRename(projectDir, 'blocked-session', request(originalModel, 'computeTotal'))
  const blocked = await afterCrash.applyProjectRefactor(projectDir, 'blocked-session', blockedPreview.previewId)
  const externallyChanged = `${readFileSync(consumerPath, 'utf8')}// external change after crash\n`
  writeFileSync(consumerPath, externallyChanged)
  rewriteJournalStage(path.join(tempRoot, 'userData'), blocked.operationId, 'applying')
  const blockedRestart = await import(`${pathToFileURL(bundlePath).href}?restart=3`)
  blockedRestart.configureProjectRefactorRecovery(path.join(tempRoot, 'userData'))
  const blockedRecovery = await blockedRestart.getProjectRefactorRecovery(projectDir, 'blocked-session')
  equal(blockedRecovery.status, 'blocked', 'unexpected post-crash file drift blocks automatic recovery')
  equal(readFileSync(consumerPath, 'utf8'), externallyChanged, 'blocked recovery never overwrites external file changes')
  check('blocked recovery message does not expose the workspace path', !blockedRecovery.message.includes(projectDir))

  writeFileSync(consumerPath, renamedConsumer)
  const retriedRecovery = await blockedRestart.getProjectRefactorRecovery(projectDir, 'blocked-session')
  equal(retriedRecovery.status, 'auto_rolled_back', 'blocked recovery retries after the external drift is resolved')
  equal(readFileSync(modelPath, 'utf8'), originalModel, 'retried recovery restores the declaration')
  equal(readFileSync(consumerPath, 'utf8'), originalConsumer, 'retried recovery restores the consumer')
  await blockedRestart.dismissProjectRefactorRecovery(projectDir, 'blocked-session', blocked.operationId)

  const completedPreview = await blockedRestart.previewTypeScriptRename(projectDir, 'completed-session', request(originalModel, 'calculateGrandTotal'))
  await blockedRestart.applyProjectRefactor(projectDir, 'completed-session', completedPreview.previewId)
  writeFileSync(consumerPath, `${readFileSync(consumerPath, 'utf8')}// ordinary edit after completed refactor\n`)
  const completedRestart = await import(`${pathToFileURL(bundlePath).href}?restart=4`)
  completedRestart.configureProjectRefactorRecovery(path.join(tempRoot, 'userData'))
  equal(
    (await completedRestart.getProjectRefactorRecovery(projectDir, 'completed-session')).status,
    'none',
    'ordinary edits after a completed refactor expire rollback without blocking the workspace'
  )
  writeFileSync(modelPath, originalModel)
  writeFileSync(consumerPath, originalConsumer)

  const journalDir = path.join(tempRoot, 'userData', 'project-refactor-journal')
  writeFileSync(path.join(journalDir, 'invalid-record.json'), '{broken', 'utf8')
  const corruptSummary = await completedRestart.reconcileProjectRefactorsAtStartup()
  equal(corruptSummary.corrupt, 1, 'a corrupt private record is counted without aborting startup reconciliation')
  const corruptRecovery = await completedRestart.getProjectRefactorRecovery(projectDir, 'completed-session')
  equal(corruptRecovery.status, 'blocked', 'a corrupt private record fails closed for new refactors')
  check('corrupt recovery response exposes neither workspace path nor source',
    !JSON.stringify(corruptRecovery).includes(projectDir) && !JSON.stringify(corruptRecovery).includes('calculateTotal'))
  rmSync(path.join(journalDir, 'invalid-record.json'), { force: true })

  const journalBundlePath = path.join(tempRoot, 'project-refactor-journal.mjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src', 'main', 'projectRefactorJournal.ts')],
    outfile: journalBundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22'
  })
  const journalRuntime = await import(pathToFileURL(journalBundlePath).href)
  journalRuntime.configureProjectRefactorJournal(path.join(tempRoot, 'capacity-userData'))
  const capacityIds = []
  for (let index = 0; index < 51; index += 1) {
    const operationId = randomUUID()
    capacityIds.push(operationId)
    const timestamp = new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString()
    await journalRuntime.writeProjectRefactorJournal(journalRuntime.createProjectRefactorJournalRecord({
      operationId,
      sessionId: `capacity-${index}`,
      root: projectDir,
      kind: 'typescript-rename',
      stage: 'applied',
      snapshots: [{
        path: 'src/model.ts',
        before: originalModel,
        after: originalModel.replaceAll('calculateTotal', `capacityName${index}`),
        beforeDigest: sha256(originalModel),
        afterDigest: sha256(originalModel.replaceAll('calculateTotal', `capacityName${index}`))
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
      appliedAt: timestamp
    }))
  }
  const capacityScan = await journalRuntime.scanProjectRefactorJournals()
  equal(capacityScan.records.length, 50, 'journal capacity remains bounded after 51 completed refactors')
  equal(capacityScan.corruptCount, 0, 'bounded capacity pruning does not create corrupt records')
  check('capacity pruning removes the oldest completed rollback record',
    !capacityScan.records.some((record) => record.operationId === capacityIds[0]))
  const staleTemporary = path.join(
    tempRoot,
    'capacity-userData',
    'project-refactor-journal',
    `.${randomUUID()}.1234.${randomUUID()}.tmp`
  )
  writeFileSync(staleTemporary, 'stale private source snapshot', 'utf8')
  const staleTime = new Date(Date.now() - 25 * 60 * 60_000)
  utimesSync(staleTemporary, staleTime, staleTime)
  await journalRuntime.scanProjectRefactorJournals()
  check('startup scanning removes a stale private temporary journal', !existsSync(staleTemporary))

  console.log(`project refactor smoke ok: ${checks.length}/${checks.length}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function request(content, newName) {
  return { path: 'src/model.ts', content, line: 1, column: 17, newName }
}

function check(message, condition) {
  assert(condition, message)
  checks.push(message)
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  checks.push(message)
}

function rewriteJournalStage(userDataRoot, operationId, stage) {
  const journalPath = path.join(userDataRoot, 'project-refactor-journal', `${operationId}.json`)
  const record = JSON.parse(readFileSync(journalPath, 'utf8'))
  delete record.integrity
  record.stage = stage
  record.updatedAt = new Date().toISOString()
  record.integrity = createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex')
  writeFileSync(journalPath, `${JSON.stringify(record)}\n`, 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
