import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-desk-memory-store-'))
const outDir = path.join(tempRoot, 'compiled')
const memoryRoot = path.join(tempRoot, 'memory')
const projectA = path.join(tempRoot, 'project-a')
const projectB = path.join(tempRoot, 'project-b')

try {
  mkdirSync(projectA, { recursive: true })
  mkdirSync(projectB, { recursive: true })

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/memoryStore.ts',
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
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const memoryStore = await import(pathToFileURL(path.join(outDir, 'memoryStore.js')).href)

  const hashA = memoryStore.projectHash(projectA)
  const hashARepeat = memoryStore.projectHash(projectA)
  const hashB = memoryStore.projectHash(projectB)
  assertEqual(hashA, hashARepeat)
  assert(hashA !== hashB, 'different project roots should produce isolated hashes')

  const emptyRead = await memoryStore.readProjectMemory(projectA, memoryRoot)
  assertEqual(emptyRead.projectHash, hashA)
  assertEqual(emptyRead.markdown, '')
  assertEqual(emptyRead.entries.length, 0)
  assertEqual(emptyRead.drafts.length, 0)

  const draft = await memoryStore.proposeMemoryDraft(projectA, memoryRoot, {
    kind: 'decision',
    title: 'Use per-entry memory files',
    body: 'Store confirmed memories and drafts separately so independent updates stay low-conflict.',
    source: 'scripts/memory-store-smoke.mjs',
    reason: 'smoke-test draft path'
  })
  assertEqual(draft.status, 'draft')
  assertEqual(draft.source, 'scripts/memory-store-smoke.mjs')
  assertEqual(draft.reason, 'smoke-test draft path')
  assert(existsSync(path.join(memoryRoot, 'projects', hashA, 'drafts', `${draft.id}.json`)))
  assert(existsSync(path.join(memoryRoot, 'projects', hashA, 'drafts', `${draft.id}.md`)))

  const readWithDraft = await memoryStore.readProjectMemory(projectA, memoryRoot)
  assertEqual(readWithDraft.entries.length, 0)
  assertEqual(readWithDraft.drafts.length, 1)
  assert(!readWithDraft.markdown.includes(draft.title), 'drafts should not enter prompt markdown')

  const confirmed = await memoryStore.acceptMemoryDraft(projectA, memoryRoot, draft.id)
  assertEqual(confirmed.id, draft.id)
  assertEqual(confirmed.title, draft.title)
  assert(!('status' in confirmed), 'accepted entries should not retain draft status')
  assert(!existsSync(path.join(memoryRoot, 'projects', hashA, 'drafts', `${draft.id}.json`)))
  assert(!existsSync(path.join(memoryRoot, 'projects', hashA, 'drafts', `${draft.id}.md`)))
  assert(existsSync(path.join(memoryRoot, 'projects', hashA, 'confirmed', `${confirmed.id}.json`)))
  assert(existsSync(path.join(memoryRoot, 'projects', hashA, 'confirmed', `${confirmed.id}.md`)))

  const readConfirmed = await memoryStore.readProjectMemory(projectA, memoryRoot)
  assertEqual(readConfirmed.entries.length, 1)
  assertEqual(readConfirmed.drafts.length, 0)
  assert(readConfirmed.markdown.includes('## Project Memory'))
  assert(readConfirmed.markdown.includes(confirmed.title))
  assert(readConfirmed.markdown.includes(confirmed.body))
  assert(readConfirmed.markdown.includes(confirmed.source))
  assert(readConfirmed.markdown.includes(confirmed.reason))

  const deleted = await memoryStore.deleteMemoryEntry(projectA, memoryRoot, confirmed.id)
  assert(deleted.deleted, 'confirmed entry should be deleted')
  assertEqual(deleted.deletedFrom.join(','), 'confirmed')
  const readAfterDelete = await memoryStore.readProjectMemory(projectA, memoryRoot)
  assertEqual(readAfterDelete.entries.length, 0)
  assertEqual(readAfterDelete.markdown, '')

  const isolatedDraft = await memoryStore.proposeMemoryDraft(projectB, memoryRoot, {
    kind: 'fact',
    title: 'Project B only',
    body: 'This memory must not appear under Project A.',
    source: 'scripts/memory-store-smoke.mjs',
    reason: 'smoke-test hash isolation'
  })
  await memoryStore.acceptMemoryDraft(projectB, memoryRoot, isolatedDraft.id)

  const finalA = await memoryStore.readProjectMemory(projectA, memoryRoot)
  const finalB = await memoryStore.readProjectMemory(projectB, memoryRoot)
  assertEqual(finalA.entries.length, 0)
  assert(!finalA.markdown.includes('Project B only'), 'Project A should not see Project B memory')
  assertEqual(finalB.entries.length, 1)
  assert(finalB.markdown.includes('Project B only'))
  assert(readFileSync(path.join(memoryRoot, 'projects', hashB, 'confirmed', `${isolatedDraft.id}.json`), 'utf8').includes('"source"'))

  console.log('memoryStore smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}
