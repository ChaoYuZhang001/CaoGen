import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-command-ingress-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const writerMethods = [
  'createGoal',
  'updateGoal',
  'setGoalAcceptance',
  'transitionGoal',
  'archiveGoal',
  'restoreGoal',
  'createWorkItem',
  'updateWorkItem',
  'setWorkItemAcceptance',
  'transitionWorkItem',
  'acquireWorkItemLease',
  'renewWorkItemLease',
  'releaseWorkItemLease'
]
const assignmentWriteFiles = [
  'src/main/assignment-owner-coordinator/coordinator.ts',
  'src/main/assignment-owner-coordinator/release-operation.ts',
  'src/main/assignment-owner-coordinator/reassign-operation.ts'
]

try {
  assertStaticCommandBoundary()
  compileSources()
  installElectronStub()
  const storeModule = await import(pathToFileURL(findCompiledModule(outDir, 'store.js')).href)
  const commandsModule = await import(pathToFileURL(findCompiledModule(outDir, 'command-service.js')).href)
  const store = new storeModule.ProjectWorkspaceStore(userData)
  await store.open()
  await store.createWorkspace({ id: 'project-command-ingress', name: 'Command ingress', kind: 'software' })
  const commands = commandsModule.createProjectWorkspaceCommandService(store)

  const goal = await commands.createGoal({
    id: 'goal-command-ingress',
    projectId: 'project-command-ingress',
    title: 'Single renderer Goal ingress',
    objective: 'Keep Goal writes behind the command service'
  })
  await assertRejects(
    commands.createGoal({
      id: 'goal-command-ingress-completed',
      projectId: goal.projectId,
      title: 'Forged completed Goal',
      objective: 'Must use the transition gate',
      status: 'completed',
      acceptanceResult: { status: 'passed', evidenceRefs: ['forged-evidence'] }
    }),
    (error) => error?.code === 'invalid_input',
    'command ingress must reject Goal creation directly in completed'
  )
  await assertRejects(
    commands.createGoal({
      id: goal.id,
      projectId: goal.projectId,
      title: 'Duplicate Goal',
      objective: 'Must fail'
    }),
    (error) => error?.code === 'already_exists',
    'duplicate Goal id must fail closed'
  )
  const updatedGoal = await commands.updateGoal(goal.id, { title: 'Updated through commands' }, goal.revision)
  await assertRejects(
    commands.updateGoal(goal.id, { title: 'Stale Goal update' }, goal.revision),
    (error) => error?.code === 'stale_revision',
    'stale Goal revision must fail closed'
  )

  const workItem = await commands.createWorkItem({
    id: 'work-item-command-ingress',
    projectId: goal.projectId,
    goalId: goal.id,
    title: 'Single renderer WorkItem ingress'
  })
  await assertRejects(
    commands.createWorkItem({
      id: workItem.id,
      projectId: workItem.projectId,
      title: 'Duplicate WorkItem'
    }),
    (error) => error?.code === 'already_exists',
    'duplicate WorkItem id must fail closed'
  )
  const updatedWorkItem = await commands.updateWorkItem(
    workItem.id,
    { title: 'Updated through commands' },
    workItem.revision
  )
  await assertRejects(
    commands.updateWorkItem(workItem.id, { title: 'Stale WorkItem update' }, workItem.revision),
    (error) => error?.code === 'stale_revision',
    'stale WorkItem revision must fail closed'
  )
  await assertRejects(
    commands.setWorkItemAcceptance(
      workItem.id,
      { status: 'passed', evidenceRefs: [] },
      updatedWorkItem.revision
    ),
    (error) => error?.code === 'invalid_input',
    'command ingress must reject passed Acceptance without evidence refs'
  )
  const acceptedWorkItem = await commands.setWorkItemAcceptance(
    workItem.id,
    { status: 'passed', evidenceRefs: [' evidence-a ', 'evidence-a', ' evidence-b '] },
    updatedWorkItem.revision
  )
  assert(
    JSON.stringify(acceptedWorkItem.acceptance?.evidenceRefs) === JSON.stringify(['evidence-a', 'evidence-b']),
    'command ingress must trim and deduplicate Acceptance evidence refs'
  )

  let injectedCalls = 0
  const injected = commandsModule.createProjectWorkspaceCommandService({
    createGoal: async (input) => {
      injectedCalls += 1
      return { ...goal, ...input, id: 'injected-goal' }
    }
  })
  const injectedGoal = await injected.createGoal({
    projectId: goal.projectId,
    title: 'Injected repository',
    objective: 'Prove the persistence adapter boundary'
  })
  assert(injectedCalls === 1 && injectedGoal.id === 'injected-goal', 'repository injection must own persistence')

  console.log(JSON.stringify({
    status: 'PASS',
    commandMethods: writerMethods.length,
    goalRevision: updatedGoal.revision,
    workItemRevision: acceptedWorkItem.revision,
    injectedRepositoryCalls: injectedCalls
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertStaticCommandBoundary() {
  const handler = source('src/main/ipc/project-workspace-handlers.ts')
  const service = source('src/main/project-workspace/command-service.ts')
  const projectPreload = source('src/preload/project-workspace.ts')
  assert(
    handler.includes("from '../project-workspace/command-service'"),
    'ProjectWorkspace IPC must import the command service boundary'
  )
  assert(service.includes('export interface ProjectWorkspaceCommandRepository'), 'repository injection contract is required')
  assert(
    service.includes("from './ledger-shadow-write'"),
    'command service must require the durable Ledger shadow boundary before reporting success'
  )
  assert(
    service.includes('reconcileShadowProjection'),
    'command service must expose durable shadow reconciliation'
  )
  for (const method of writerMethods) {
    assert(handler.includes(`commands.${method}(`), `${method} must be routed through the command service`)
    assert(!handler.includes(`store.${method}(`), `${method} must not write directly through the store in IPC`)
  }
  for (const file of assignmentWriteFiles) {
    const assignmentSource = source(file)
    assert(
      !assignmentSource.includes('projectStore.updateWorkItem('),
      `${file} must route WorkItem owner writes through the command service`
    )
  }
  assert(
    assignmentWriteFiles.every((file) => source(file).includes('projectCommands.updateWorkItem(')),
    'Assignment create/release/reassign owner writes must all use the command service'
  )
  assert(projectPreload.includes('createProjectGoal'), 'ProjectWorkspace preload must expose Goal commands')
  assert(projectPreload.includes('createProjectWorkItem'), 'ProjectWorkspace preload must expose WorkItem commands')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/project-workspace/command-service.ts',
    'src/main/project-workspace/store.ts',
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
  writeFileSync(
    path.join(electronDir, 'index.js'),
    `module.exports = { app: { getPath: () => ${JSON.stringify(userData)} } }\n`
  )
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"commonjs"}\n')
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function findCompiledModule(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(entryPath, name)
      if (found) return found
    } else if (entry.name === name) {
      return entryPath
    }
  }
  return undefined
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
