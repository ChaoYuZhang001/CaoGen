import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-session-query-'))
const outDir = path.join(tempRoot, 'compiled')
const transcriptsDir = path.join(tempRoot, 'transcripts')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/session-query.ts',
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
  const compiledPath = [
    path.join(outDir, 'session-query.js'),
    path.join(outDir, 'main', 'session-query.js'),
    path.join(outDir, 'src', 'main', 'session-query.js')
  ].find((candidate) => existsSync(candidate))
  assert(compiledPath, 'compiled session-query.js should exist')
  const { normalizeSessionQueryInput, querySessionDirectory } = await import(pathToFileURL(compiledPath).href)

  mkdirSync(transcriptsDir, { recursive: true })
  writeFileSync(path.join(transcriptsDir, 'sdk-root.jsonl'), [
    JSON.stringify({ seq: 1, event: { kind: 'user-message', text: 'the durable transcript contains needle text' } }),
    JSON.stringify({ seq: 2, event: { kind: 'tool-result', content: 'needle must not leak from tools' } })
  ].join('\n') + '\n')

  const root = sessionMeta('root', {
    sdkSessionId: 'sdk-root',
    title: 'Architecture review',
    workspaceId: 'workspace-a',
    goalId: 'goal-a',
    workItemId: 'work-root',
    createdAt: 100
  })
  const child = sessionMeta('child', {
    sdkSessionId: 'sdk-child',
    title: 'Implementation child',
    workspaceId: 'workspace-a',
    goalId: 'goal-a',
    workItemId: 'work-child',
    parentSessionId: 'root',
    orchestrationId: 'orch-a',
    childTaskId: 'task-child',
    childRole: 'implementation',
    status: 'running',
    createdAt: 200
  })
  const archived = historyEntry(sessionMeta('archived', {
    sdkSessionId: 'sdk-archived',
    title: 'Archived work',
    workspaceId: 'workspace-b',
    createdAt: 150
  }), 250, { archived: true })
  const recoveryMeta = sessionMeta('recovery', {
    sdkSessionId: 'sdk-recovery',
    title: 'Recoverable failure',
    workspaceId: 'workspace-a',
    status: 'error',
    createdAt: 180
  })
  const sources = {
    activeSessions: [child],
    history: [
      historyEntry(root, 300),
      historyEntry({ ...child, id: 'child-history' }, 350),
      archived
    ],
    snapshots: [
      snapshot('snapshot-child', child, 400, 'important-event', 'executing'),
      snapshot('snapshot-recovery', recoveryMeta, 500, 'recovered', 'failed')
    ],
    transcriptsDir
  }

  const page = await querySessionDirectory(sources)
  equal(page.schemaVersion, 1)
  deepEqual(page.items.map((item) => item.id), ['recovery', 'child', 'root'])
  equal(page.totalMatched, 3, 'archived Sessions are hidden by default')
  deepEqual(page.items.find((item) => item.id === 'child').presence, ['active', 'recovery', 'history'])
  equal(page.items.find((item) => item.id === 'child').updatedAt, 400)
  equal(page.items.find((item) => item.id === 'child').lineage.rootSessionId, 'root')
  deepEqual(page.items.find((item) => item.id === 'child').lineage.ancestorSessionIds, ['root'])
  deepEqual(page.items.find((item) => item.id === 'root').lineage.childSessionIds, ['child'])
  equal(page.items.find((item) => item.id === 'recovery').recovery.runStatus, 'failed')

  const activeOnly = await querySessionDirectory(sources, { presence: ['active'] })
  deepEqual(activeOnly.items.map((item) => item.id), ['child'])
  const failures = await querySessionDirectory(sources, { statuses: ['error'] })
  deepEqual(failures.items.map((item) => item.id), ['recovery'])
  const project = await querySessionDirectory(sources, { workspaceId: 'workspace-a' })
  deepEqual(project.items.map((item) => item.id), ['recovery', 'child', 'root'])
  const children = await querySessionDirectory(sources, { parentSessionId: 'root' })
  deepEqual(children.items.map((item) => item.id), ['child'])
  const roots = await querySessionDirectory(sources, { rootsOnly: true })
  deepEqual(roots.items.map((item) => item.id), ['recovery', 'root'])
  const withArchived = await querySessionDirectory(sources, { includeArchived: true })
  deepEqual(withArchived.items.map((item) => item.id), ['recovery', 'child', 'root', 'archived'])

  const transcript = await querySessionDirectory(sources, { query: 'needle' })
  deepEqual(transcript.items.map((item) => item.id), ['root'])
  equal(transcript.items[0].transcriptHits.length, 1)
  equal(transcript.items[0].transcriptHits[0].role, 'user')

  const first = await querySessionDirectory(sources, { limit: 2 })
  deepEqual(first.items.map((item) => item.id), ['recovery', 'child'])
  assert(first.nextCursor, 'first page should expose a cursor')
  const second = await querySessionDirectory(sources, { limit: 2, cursor: first.nextCursor })
  deepEqual(second.items.map((item) => item.id), ['root'])
  equal(second.nextCursor, undefined)
  await assertRejects(
    () => querySessionDirectory(sources, { limit: 2, workspaceId: 'workspace-a', cursor: first.nextCursor }),
    /different query/,
    'cursor must be bound to the normalized query'
  )

  const restartedSources = JSON.parse(JSON.stringify(sources))
  restartedSources.transcriptsDir = transcriptsDir
  deepEqual(
    await querySessionDirectory(restartedSources, { workspaceId: 'workspace-a', limit: 3 }),
    await querySessionDirectory(sources, { workspaceId: 'workspace-a', limit: 3 }),
    'reconstructed read sources must produce the same page'
  )

  const cycleA = sessionMeta('cycle-a', { parentSessionId: 'cycle-b', createdAt: 10 })
  const cycleB = sessionMeta('cycle-b', { parentSessionId: 'cycle-a', createdAt: 20 })
  const cyclePage = await querySessionDirectory({ activeSessions: [cycleA, cycleB], history: [], snapshots: [] })
  assert(cyclePage.items.every((item) => item.lineage.cycleDetected), 'lineage cycles must be reported without looping')

  assertThrows(() => normalizeSessionQueryInput({ unknown: true }), /Unknown Session query field/)
  assertThrows(() => normalizeSessionQueryInput({ statuses: ['not-a-status'] }), /statuses is invalid/)
  assertThrows(() => normalizeSessionQueryInput({ limit: 201 }), /between 1 and 200/)
  assertThrows(() => normalizeSessionQueryInput({ rootsOnly: true, parentSessionId: 'root' }), /mutually exclusive/)
  assertThrows(() => normalizeSessionQueryInput({ updatedAfter: 20, updatedBefore: 10 }), /must not exceed/)

  const ipcSource = readFileSync(path.join(repoRoot, 'src/main/ipc/session-query-handlers.ts'), 'utf8')
  const handlerStart = ipcSource.indexOf('handleSessionQueryIpc')
  const handlerBlock = ipcSource.slice(handlerStart, handlerStart + 700)
  assert(handlerStart >= 0, 'Session query app-feature handler should exist')
  assert(
    handlerBlock.indexOf('assertTrustedWorkflowLedgerSender(event)') >= 0 &&
      handlerBlock.indexOf('assertTrustedWorkflowLedgerSender(event)') < handlerBlock.indexOf('querySessionDirectory'),
    'Session query must reject an untrusted renderer before reading stores'
  )
  const appFeatureSource = readFileSync(path.join(repoRoot, 'src/main/ipc/app-feature-handlers.ts'), 'utf8')
  assert(appFeatureSource.includes("feature === 'session-query'"), 'Session query should use appFeatures:invoke')
  const preloadSource = readFileSync(path.join(repoRoot, 'src/preload/session-query.ts'), 'utf8')
  assert(preloadSource.includes("invokeAppFeature('session-query', 'query', input)"), 'preload should expose Session query')
  const inventory = readFileSync(path.join(repoRoot, 'scripts/effect-entry-registry.mjs'), 'utf8')
  assert(inventory.includes("'session-query/query'"), 'Session query must be classified as a read-only app feature')

  console.log('session query smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function sessionMeta(id, overrides = {}) {
  return {
    id,
    title: `Session ${id}`,
    cwd: `/workspace/${id}`,
    model: 'test-model',
    providerId: 'test-provider',
    taskStrategy: 'execute',
    permissionMode: 'default',
    status: 'closed',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1,
    ...overrides
  }
}

function historyEntry(meta, updatedAt, overrides = {}) {
  return { ...meta, sdkSessionId: meta.sdkSessionId ?? `sdk-${meta.id}`, updatedAt, ...overrides }
}

function snapshot(id, meta, updatedAt, reason, runStatus) {
  return {
    id,
    taskId: `task-${id}`,
    sessionId: meta.id,
    title: meta.title,
    projectPath: meta.cwd,
    model: meta.model,
    providerId: meta.providerId,
    createdAt: meta.createdAt,
    updatedAt,
    eventCount: 0,
    reason,
    meta,
    execution: { status: meta.status, lastSeq: 0, lastEventAt: updatedAt },
    run: { status: runStatus },
    transcript: [],
    subtasks: [],
    dagExecutions: []
  }
}

async function assertRejects(callback, pattern, message) {
  try {
    await callback()
  } catch (error) {
    assert(pattern.test(String(error)), `${message}: ${String(error)}`)
    return
  }
  throw new Error(message)
}

function assertThrows(callback, pattern) {
  try {
    callback()
  } catch (error) {
    assert(pattern.test(String(error)), `unexpected error: ${String(error)}`)
    return
  }
  throw new Error(`expected error matching ${pattern}`)
}

function equal(actual, expected, message = 'values should match') {
  assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function deepEqual(actual, expected, message = 'values should deeply match') {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
