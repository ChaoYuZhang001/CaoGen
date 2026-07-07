#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-memory-loop-'))
const outDir = path.join(tempRoot, 'compiled')
const memoryRoot = path.join(tempRoot, 'memory')
const projectRoot = path.join(tempRoot, 'project')

try {
  mkdirSync(projectRoot, { recursive: true })
  compile(
    [
      'src/main/memory/memory-loop.ts',
      'src/main/memory/memory-manager.ts',
      'src/main/memory/memory-writer.ts',
      'src/main/memoryStore.ts'
    ],
    outDir
  )

  const loop = await import(pathToFileURL(findCompiled(outDir, 'memory-loop.js')).href)
  const store = await import(pathToFileURL(findCompiled(outDir, 'memoryStore.js')).href)
  const manager = await import(pathToFileURL(findCompiled(outDir, 'memory-manager.js')).href)

  const review = loop.buildMemoryLoopReview({
    projectRoot,
    title: 'Browser annotation screenshot',
    outcome: 'failure',
    summary: 'Browser annotation flow reached capture but screenshot evidence was blank, so the task is not complete.',
    failures: 'Error: captured screenshot PNG is blank when BrowserView is hidden.',
    rootCause: 'The BrowserView bounds were not visible before capture.',
    nextAction: 'Set visible bounds and verify non-empty PNG pixels before reporting completion.',
    verification: ['node scripts/browser-annotations-smoke.mjs failed with blank screenshot evidence'],
    preferences: ['记住: A6 复盘必须先写待确认草稿,不能把未验证能力写成已完成。']
  })

  assert(review.projectDrafts.some((draft) => draft.kind === 'task-retrospective'), 'task retrospective draft missing')
  assert(review.projectDrafts.some((draft) => draft.kind === 'failure-retrospective'), 'failure draft missing')
  assert(review.projectDrafts.some((draft) => draft.kind === 'preference'), 'preference draft missing')
  assert(review.suggestions.some((suggestion) => suggestion.kind === 'failure-review'), 'failure review suggestion missing')
  assert(
    review.projectDrafts.some((draft) => draft.body.includes('结果: 失败')),
    'failure outcome should be recorded truthfully'
  )

  const persisted = await loop.persistMemoryLoopReview({
    memoryRoot,
    projectRoot,
    review: {
      projectRoot,
      title: 'Browser annotation screenshot',
      outcome: 'failure',
      summary: 'Capture reached BrowserView but the evidence is still blank.',
      failures: 'Error: blank screenshot evidence.',
      rootCause: 'BrowserView was not visible.',
      nextAction: 'Verify non-empty PNG pixels before completion.',
      verification: ['node scripts/browser-annotations-smoke.mjs'],
      preferences: ['记住: 失败复盘必须保留第一个可观察失败。']
    }
  })

  assert(persisted.drafts.length >= 3, `expected at least 3 project drafts, got ${persisted.drafts.length}`)
  assert(persisted.layered.length >= 3, `expected layered memories, got ${persisted.layered.length}`)

  const projectMemory = await store.readProjectMemory(projectRoot, memoryRoot)
  assert(projectMemory.entries.length === 0, 'memory loop should not auto-confirm project memories')
  assert(projectMemory.drafts.some((draft) => draft.kind === 'failure-retrospective'), 'failure draft not persisted')

  const hits = await manager.searchMemories(memoryRoot, {
    query: 'blank screenshot BrowserView visible bounds',
    projectRoot,
    layers: ['working', 'project'],
    limit: 10
  })
  assert(hits.some((hit) => hit.entry.title.includes('失败复盘')), 'failure memory should be searchable')

  console.log('memoryLoop smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile(files, outDir) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  const found = findCompiledMaybe(root, fileName)
  if (!found) throw new Error(`compiled ${fileName} not found`)
  return found
}

function findCompiledMaybe(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledMaybe(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
