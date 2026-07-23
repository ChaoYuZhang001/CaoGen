import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-canonical-project-read-cutover-'))
const outDir = path.join(tempRoot, 'compiled')
const primaryRoot = path.join(tempRoot, 'primary')
const READ_MODE_ENV = 'CAOGEN_PROJECT_WORKSPACE_READ_MODE'
process.env.CAOGEN_PROJECT_WORKSPACE_READ_TEST_RENDERER_URL = pathToFileURL(
  path.join(outDir, 'renderer', 'index.html')
).href
process.env.ELECTRON_RENDERER_URL = process.env.CAOGEN_PROJECT_WORKSPACE_READ_TEST_RENDERER_URL

let storeModule
let commandsModule
let readModule
let snapshots
let workflow
let workflowQuery
let forgedSequence = 0

try {
  assertStaticProductionCutover()
  compileSources()
  installElectronShim()
  storeModule = require(path.join(outDir, 'main', 'project-workspace', 'store.js'))
  commandsModule = require(path.join(outDir, 'main', 'project-workspace', 'command-service.js'))
  readModule = require(path.join(outDir, 'main', 'project-workspace', 'canonical-read-service.js'))
  snapshots = require(path.join(outDir, 'main', 'task', 'task-snapshot.js'))
  workflow = require(path.join(outDir, 'main', 'task', 'workflow-ledger-store.js'))
  workflowQuery = require(path.join(outDir, 'main', 'task', 'workflow-ledger-query.js'))

  await productionIpcReadsCanonicalByDefault()
  await canonicalListsPreserveDomainInsertionOrder()
  await purgedWorkspaceIdsCannotBeReused()
  await scopedReadsIgnoreUnrelatedInvalidWorkspace()
  await canonicalIntegrityTamperingFailsClosed()
  await committedSourceLossFailsClosed()
  console.log(JSON.stringify({
    status: 'PASS',
    defaultReadMode: 'canonical',
    rollbackModes: ['compare', 'legacy'],
    productionActions: ['goals:list', 'goals:get', 'workItems:list', 'workItems:get'],
    writeSource: 'workflow-ledger',
    jsonRole: 'workspace-registry-and-recoverable-projection'
  }, null, 2))
} finally {
  delete process.env[READ_MODE_ENV]
  delete process.env.CAOGEN_PROJECT_WORKSPACE_READ_TEST_USER_DATA
  delete process.env.CAOGEN_PROJECT_WORKSPACE_READ_TEST_RENDERER_URL
  delete process.env.ELECTRON_RENDERER_URL
  rmSync(tempRoot, { recursive: true, force: true })
}

async function canonicalListsPreserveDomainInsertionOrder() {
  const root = path.join(tempRoot, 'insertion-order')
  const store = new storeModule.ProjectWorkspaceStore(root)
  await store.open()
  const workspace = await store.createWorkspace({
    id: 'project-order',
    name: 'Insertion order',
    kind: 'software'
  })
  const commands = commandsModule.createProjectWorkspaceCommandService(store, { rootDir: root })
  const goalZ = await commands.createGoal({
    id: 'goal-z-first',
    projectId: workspace.id,
    title: 'Created first',
    objective: 'Preserve first position'
  })
  const goalA = await commands.createGoal({
    id: 'goal-a-second',
    projectId: workspace.id,
    title: 'Created second',
    objective: 'Preserve second position'
  })
  const itemZ = await commands.createWorkItem({
    id: 'work-item-z-first',
    projectId: workspace.id,
    goalId: goalZ.id,
    title: 'Created first'
  })
  const itemA = await commands.createWorkItem({
    id: 'work-item-a-second',
    projectId: workspace.id,
    goalId: goalA.id,
    title: 'Created second'
  })

  for (const mode of ['canonical', 'compare']) {
    const service = readModule.createProjectWorkspaceReadService(root, mode)
    assertDeepEqual(
      await service.listGoals(workspace.id),
      [goalZ, goalA],
      `${mode} Goal list must preserve JSON/domain insertion order`
    )
    assertDeepEqual(
      await service.listWorkItems(workspace.id),
      [itemZ, itemA],
      `${mode} WorkItem list must preserve JSON/domain insertion order`
    )
    assertDeepEqual(
      (await service.listGoals()).map((goal) => goal.id),
      [goalZ.id, goalA.id],
      `${mode} global Goal list must preserve JSON/domain insertion order`
    )
  }
  console.log('[PASS] canonical and compare lists preserve reverse-lexicographic insertion order')
}

async function purgedWorkspaceIdsCannotBeReused() {
  const root = path.join(tempRoot, 'purged-id')
  const seeded = await seedWorkspace(root, 'purged')
  const canonical = readModule.createProjectWorkspaceReadService(root, 'canonical')
  assertDeepEqual(await canonical.getGoal(seeded.goal.id), seeded.goal, 'purge fixture must commit canonical history')

  const store = new storeModule.ProjectWorkspaceStore(root)
  await store.open()
  await store.purgeWorkspace(seeded.workspace.id, { expectedRevision: seeded.workspace.revision })
  const state = await store.getState()
  assert(
    state.events.some((event) =>
      event.projectId === seeded.workspace.id && event.entityId === seeded.workspace.id &&
      event.kind === 'workspace.purged'
    ),
    'purge must retain a durable Workspace identity tombstone'
  )

  const reopened = new storeModule.ProjectWorkspaceStore(root)
  await reopened.open()
  await assertRejects(
    reopened.createWorkspace({ id: seeded.workspace.id, name: 'Forbidden reuse', kind: 'software' }),
    (error) => error?.code === 'purged_id_reuse_forbidden',
    'purged Workspace identity reuse must fail closed after reopen'
  )

  const other = await reopened.createWorkspace({ id: 'project-after-purge', name: 'Fresh identity', kind: 'software' })
  const commands = commandsModule.createProjectWorkspaceCommandService(reopened, { rootDir: root })
  const goal = await commands.createGoal({
    id: 'goal-after-purge',
    projectId: other.id,
    title: 'Fresh identity remains usable',
    objective: 'Verify fresh identity'
  })
  assertDeepEqual(
    await canonical.listGoals(other.id),
    [goal],
    'a different Workspace identity must remain readable after purge'
  )
  console.log('[PASS] purge tombstone blocks same-ID reuse across reopen without blocking fresh IDs')
}

async function scopedReadsIgnoreUnrelatedInvalidWorkspace() {
  const root = path.join(tempRoot, 'scoped-isolation')
  const good = await seedWorkspace(root, 'scope-good')
  const bad = await seedWorkspace(root, 'scope-bad')
  const canonical = readModule.createProjectWorkspaceReadService(root, 'canonical')
  assertDeepEqual(await canonical.getGoal(good.goal.id), good.goal, 'good fixture must begin readable')
  assertDeepEqual(await canonical.getGoal(bad.goal.id), bad.goal, 'bad fixture must begin readable before corruption')

  const jsonPath = path.join(root, 'project-workspace.json')
  const state = JSON.parse(readFileSync(jsonPath, 'utf8'))
  state.goals.find((goal) => goal.id === bad.goal.id).projectId = 'missing-unrelated-workspace'
  writeJson(jsonPath, state)

  const compare = readModule.createProjectWorkspaceReadService(root, 'compare')
  assertDeepEqual(await canonical.listGoals(good.workspace.id), [good.goal], 'scoped Goal list must isolate unrelated corruption')
  assertDeepEqual(await compare.getGoal(good.goal.id), good.goal, 'scoped Goal get must isolate unrelated corruption')
  assertDeepEqual(await canonical.listWorkItems(good.workspace.id), [good.item], 'scoped WorkItem list must isolate unrelated corruption')
  assertDeepEqual(await compare.getWorkItem(good.item.id), good.item, 'scoped WorkItem get must isolate unrelated corruption')
  await assertRejects(
    canonical.listGoals(),
    (error) => error?.code === 'REFERENCE_MISSING',
    'global Goal list must remain fail-closed on an invalid unrelated Workspace'
  )
  console.log('[PASS] project-scoped list/get isolate unrelated corruption while global list stays fail-closed')
}

async function productionIpcReadsCanonicalByDefault() {
  process.env.CAOGEN_PROJECT_WORKSPACE_READ_TEST_USER_DATA = primaryRoot
  delete process.env[READ_MODE_ENV]
  const electron = require(path.join(outDir, 'node_modules', 'electron', 'index.js'))
  require(path.join(outDir, 'main', 'ipc', 'project-workspace-handlers.js')).registerProjectWorkspaceIpc()
  const gateway = electron.__handlers.get('projectWorkspace:invoke')
  assert(gateway, 'ProjectWorkspace IPC gateway must register')
  const event = { sender: electron.__trustedSender, senderFrame: electron.__trustedSender.mainFrame }
  const invoke = (action, ...args) => gateway(event, action, ...args)

  await invoke('create', { id: 'project-cutover', name: 'Canonical cutover', kind: 'software' })
  const goal = await invoke('goals:create', {
    id: 'goal-cutover',
    projectId: 'project-cutover',
    title: 'Read canonical Goal',
    objective: 'Use the verified rich view in production IPC',
    background: 'canonical background',
    constraints: ['fail closed'],
    successCriteria: ['list/get use canonical data']
  })
  const item = await invoke('workItems:create', {
    id: 'work-item-cutover',
    projectId: goal.projectId,
    goalId: goal.id,
    title: 'Read canonical WorkItem',
    description: 'Production IPC read fixture',
    priority: 7,
    owner: { type: 'human', id: 'owner-cutover' }
  })

  const [goals, workItems] = await Promise.all([
    invoke('goals:list', goal.projectId),
    invoke('workItems:list', goal.projectId)
  ])
  assertDeepEqual(goals, [goal], 'production Goal list must return the verified rich entity')
  assertDeepEqual(workItems, [item], 'production WorkItem list must return the verified rich entity')
  const [readGoal, readWorkItem] = await Promise.all([
    invoke('goals:get', goal.id),
    invoke('workItems:get', item.id)
  ])
  assertDeepEqual(readGoal, goal, 'production Goal get must return canonical data')
  assertDeepEqual(readWorkItem, item, 'production WorkItem get must return canonical data')

  process.env[READ_MODE_ENV] = 'compare'
  assertDeepEqual(await invoke('goals:list', goal.projectId), [goal], 'compare mode must pass matching Goal sources')
  assertDeepEqual(await invoke('workItems:list', goal.projectId), [item], 'compare mode must pass matching WorkItem sources')

  const jsonPath = path.join(primaryRoot, 'project-workspace.json')
  const original = readFileSync(jsonPath)
  const drifted = JSON.parse(original.toString('utf8'))
  drifted.goals.find((candidate) => candidate.id === goal.id).background = 'unversioned JSON drift'
  writeJson(jsonPath, drifted)

  process.env[READ_MODE_ENV] = 'canonical'
  await assertRejects(
    invoke('goals:list', goal.projectId),
    (error) => error?.code === 'SOURCE_REVISION_DRIFT',
    'canonical IPC must fail closed on unversioned JSON source drift'
  )

  process.env[READ_MODE_ENV] = 'legacy'
  const legacy = await invoke('goals:get', goal.id)
  assertEqual(legacy.background, 'unversioned JSON drift', 'legacy rollback must be explicit and read JSON')

  process.env[READ_MODE_ENV] = 'invalid-fallback'
  await assertRejects(
    invoke('goals:get', goal.id),
    (error) => error?.code === 'invalid_read_mode',
    'invalid read mode must not silently fall back'
  )

  writeFileSync(jsonPath, original, { mode: 0o600 })
  process.env[READ_MODE_ENV] = 'canonical'
  assertDeepEqual(await invoke('goals:get', goal.id), goal, 'canonical reads must recover after source bytes are restored')
  console.log('[PASS] production IPC defaults to canonical and keeps compare/legacy explicit')
}

async function canonicalIntegrityTamperingFailsClosed() {
  const root = path.join(tempRoot, 'tamper')
  const seeded = await seedWorkspace(root, 'tamper')
  const service = readModule.createProjectWorkspaceReadService(root, 'canonical')
  assertDeepEqual(await service.getGoal(seeded.goal.id), seeded.goal, 'tamper fixture must begin readable')

  await snapshots.mutateTaskSnapshotDatabase(root, (db) => {
    const original = workflowQuery.readAndVerifyEvents(db).filter((event) =>
      event.kind === 'workflow.project-workspace.migrated' && event.entityId === seeded.workspace.id
    ).at(-1)
    assert(original, 'tamper fixture must have a committed migration event')
    const payload = structuredClone(original.payload)
    payload.goals[0].source.title = 'forged canonical payload'
    forgedSequence += 1
    workflow.appendWorkflowEvent(db, {
      eventId: `workflow:test:canonical-read-tamper:${forgedSequence}`,
      streamId: original.streamId,
      entityType: 'system',
      entityId: seeded.workspace.id,
      kind: original.kind,
      payload,
      occurredAt: original.occurredAt + forgedSequence,
      correlationId: `canonical-read-tamper-${forgedSequence}`
    }, { projectId: seeded.workspace.id })
  })

  await assertRejects(
    service.getGoal(seeded.goal.id),
    (error) => error?.code === 'SOURCE_DIGEST_MISMATCH',
    'forged rich migration payload must fail closed'
  )
  console.log('[PASS] hash-chain-valid payload tampering still fails rich-view digest verification')
}

async function committedSourceLossFailsClosed() {
  const root = path.join(tempRoot, 'missing-source')
  const seeded = await seedWorkspace(root, 'missing')
  const service = readModule.createProjectWorkspaceReadService(root, 'canonical')
  assertDeepEqual(await service.getWorkItem(seeded.item.id), seeded.item, 'missing-source fixture must begin readable')
  rmSync(path.join(root, 'project-workspace.json'))
  await assertRejects(
    service.listWorkItems(seeded.workspace.id),
    (error) => error?.code === 'canonical_read_source_missing',
    'committed canonical history must block silent JSON registry recreation'
  )
  assert(!exists(path.join(root, 'project-workspace.json')), 'failed canonical read must not recreate the missing JSON source')
  console.log('[PASS] committed JSON source loss is fail-closed')
}

async function seedWorkspace(root, suffix) {
  const store = new storeModule.ProjectWorkspaceStore(root)
  await store.open()
  const workspace = await store.createWorkspace({
    id: `project-${suffix}`,
    name: `Project ${suffix}`,
    kind: 'software'
  })
  const commands = commandsModule.createProjectWorkspaceCommandService(store, { rootDir: root })
  const goal = await commands.createGoal({
    id: `goal-${suffix}`,
    projectId: workspace.id,
    title: `Goal ${suffix}`,
    objective: `Verify ${suffix}`,
    background: `Background ${suffix}`
  })
  const item = await commands.createWorkItem({
    id: `work-item-${suffix}`,
    projectId: workspace.id,
    goalId: goal.id,
    title: `WorkItem ${suffix}`
  })
  return { workspace, goal, item }
}

function assertStaticProductionCutover() {
  const handler = source('src/main/ipc/project-workspace-handlers.ts')
  const service = source('src/main/project-workspace/canonical-read-service.ts')
  assert(
    handler.includes("from '../project-workspace/canonical-read-service'"),
    'ProjectWorkspace IPC must import the canonical read service'
  )
  for (const [action, method] of [
    ['goals:list', 'listGoals'],
    ['goals:get', 'getGoal'],
    ['workItems:list', 'listWorkItems'],
    ['workItems:get', 'getWorkItem']
  ]) {
    assert(handler.includes(`'${action}'`) && handler.includes(`reads.${method}(`), `${action} must use canonical reads`)
    assert(!handler.includes(`store.${method}(`), `${action} must not read Goal/WorkItem payloads from JSON`)
  }
  assert(service.includes("? 'canonical'"), 'canonical must be the default production read mode')
  assert(service.includes("this.mode === 'legacy'"), 'legacy rollback must be explicit')
  assert(service.includes("this.mode === 'compare'"), 'compare compatibility mode must fail closed on drift')
  assert(service.includes('withConsistentProjectionRead'), 'canonical reads must share the durable shadow lock')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/assignment-owner-coordinator/index.ts',
    'src/main/digital-worker/index.ts',
    'src/main/project-workspace/index.ts',
    'src/main/project-workspace/canonical-read-service.ts',
    'src/main/ipc/project-workspace-handlers.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronShim() {
  const shimDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(path.join(shimDir, 'index.js'), `
const handlers = new Map()
const mainFrame = { url: process.env.CAOGEN_PROJECT_WORKSPACE_READ_TEST_RENDERER_URL }
const trustedSender = {
  mainFrame,
  isDestroyed: () => false,
  getURL: () => mainFrame.url
}
module.exports = {
  __handlers: handlers,
  __trustedSender: trustedSender,
  app: {
    getPath(name) {
      if (name !== 'userData') throw new Error('unexpected app path request: ' + name)
      return process.env.CAOGEN_PROJECT_WORKSPACE_READ_TEST_USER_DATA
    }
  },
  BrowserWindow: { getAllWindows: () => [{ webContents: trustedSender }] },
  ipcMain: {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('duplicate IPC handler: ' + channel)
      handlers.set(channel, handler)
    }
  }
}
`)
  writeFileSync(path.join(shimDir, 'package.json'), '{"type":"commonjs"}\n')
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function exists(filePath) {
  try {
    readFileSync(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertDeepEqual(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
