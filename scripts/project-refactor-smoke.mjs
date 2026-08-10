#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    runtime.applyProjectRefactor('rename-session', preview.previewId),
    /stale/,
    'apply refuses files changed after preview'
  )
  writeFileSync(consumerPath, originalConsumer)

  const fresh = await runtime.previewTypeScriptRename(projectDir, 'rename-session', request(originalModel, 'computeTotal'))
  const concurrentApply = await Promise.allSettled([
    runtime.applyProjectRefactor('rename-session', fresh.previewId),
    runtime.applyProjectRefactor('rename-session', fresh.previewId)
  ])
  check('a preview is one-shot under concurrent apply attempts',
    concurrentApply.filter((result) => result.status === 'fulfilled').length === 1 && concurrentApply.filter((result) => result.status === 'rejected').length === 1)
  const applied = concurrentApply.find((result) => result.status === 'fulfilled').value
  equal(applied.ok, true, 'verified preview applies successfully')
  equal(applied.files.length, 2, 'apply reports every changed project-relative file')
  check('declaration is renamed on disk', readFileSync(modelPath, 'utf8').includes('function computeTotal'))
  check('import and call are renamed on disk', !readFileSync(consumerPath, 'utf8').includes('calculateTotal') && readFileSync(consumerPath, 'utf8').includes('computeTotal'))
  await assert.rejects(
    runtime.applyProjectRefactor('other-session', fresh.previewId),
    /not found/,
    'consumed or cross-Session previews cannot be replayed'
  )

  const renamedConsumer = readFileSync(consumerPath, 'utf8')
  writeFileSync(consumerPath, `${renamedConsumer}// post-apply drift\n`)
  await assert.rejects(
    runtime.rollbackProjectRefactor('rename-session', applied.operationId),
    /rollback was refused/,
    'rollback refuses files changed after apply'
  )
  writeFileSync(consumerPath, renamedConsumer)
  const rolledBack = await runtime.rollbackProjectRefactor('rename-session', applied.operationId)
  equal(rolledBack.ok, true, 'verified refactor rolls back successfully')
  equal(readFileSync(modelPath, 'utf8'), originalModel, 'rollback restores declaration bytes exactly')
  equal(readFileSync(consumerPath, 'utf8'), originalConsumer, 'rollback restores reference bytes exactly')

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
