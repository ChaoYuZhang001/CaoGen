import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-workspace-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const sourceDir = path.join(tempRoot, 'source-that-must-survive-delete')
const manifestPath = path.join(tempRoot, 'workspace-manifest.json')
mkdirSync(userData, { recursive: true })
mkdirSync(sourceDir, { recursive: true })
writeFileSync(path.join(sourceDir, 'sentinel.txt'), 'source content\n')

try {
  compileSources()
  installElectronStub()
  const api = await import(pathToFileURL(findCompiledModule(outDir, 'index.js')).href)
  const first = new api.ProjectWorkspaceStore(userData)
  await first.open()

  // PROJ-001/002: no-directory workspace and optional resources. The source
  // path is only a resource link and is never owned by the store.
  const emptyWorkspace = await first.createWorkspace({ name: 'Directory-free workspace', kind: 'research' })
  assertEqual(emptyWorkspace.resources.length, 0, 'workspace must allow zero resources')
  const workspace = await first.createWorkspace({
    name: 'Project Workspace',
    kind: 'software',
    resources: [
      { kind: 'directory', path: sourceDir, label: 'source root' },
      { kind: 'repository', path: sourceDir, label: 'source repository' }
    ]
  })
  assert(workspace.id && workspace.revision === 1, 'workspace must have a stable id and first revision')

  // Reopen reads the durable JSON rather than process memory.
  const reopened = new api.ProjectWorkspaceStore(userData)
  await reopened.open()
  assertEqual((await reopened.getWorkspace(workspace.id)).name, workspace.name, 'reopen must recover workspace')
  assertEqual(
    (await reopened.getWorkspace(workspace.id)).resources.find((resource) => resource.label === 'source repository')?.kind,
    'repository',
    'repository resource kind must survive reopen'
  )

  const archived = await reopened.archiveWorkspace(workspace.id, workspace.revision)
  assertEqual(archived.status, 'archived', 'archive must persist')
  const restored = await reopened.restoreWorkspace(workspace.id, archived.revision)
  assertEqual(restored.status, 'active', 'restore must persist')

  const foreign = await reopened.createWorkspace({ name: 'Foreign project', kind: 'personal' })
  const goal = await reopened.createGoal({
    projectId: workspace.id,
    title: 'Ship the project slice',
    objective: 'Make ProjectWorkspace durable',
    background: 'L2 acceptance',
    constraints: ['local only'],
    successCriteria: ['reopen works'],
    forbiddenActions: ['delete source directory'],
    riskLevel: 'medium',
    budget: { amount: 10, currency: 'USD', maxRuns: 4 },
    acceptance: [{ id: 'goal-acceptance', criterion: 'Smoke evidence is present' }]
  })
  assertEqual(goal.contract.objective, goal.objective, 'Goal contract must flatten consistently')
  assertEqual(goal.contract.constraints[0], 'local only', 'Goal constraints must persist')
  await assertRejects(
    reopened.createGoal({
      projectId: workspace.id,
      title: 'Forged completed Goal',
      objective: 'Must not bypass the transition gate',
      status: 'completed',
      acceptanceResult: { status: 'passed', evidenceRefs: ['forged-goal-evidence'] }
    }),
    (error) => error.code === 'invalid_input',
    'Goal creation must not accept completed even when an Acceptance result is supplied'
  )

  const parent = await reopened.createWorkItem({
    projectId: workspace.id,
    goalId: goal.id,
    title: 'Parent item',
    type: 'planning',
    owner: { type: 'digital_worker', id: 'worker-a' }
  })
  assertEqual(parent.inheritedGoalContract.objective, goal.contract.objective, 'WorkItem must inherit Goal Contract')
  const child = await reopened.createWorkItem({
    projectId: workspace.id,
    goalId: goal.id,
    parentId: parent.id,
    dependencyIds: [parent.id],
    title: 'Child item',
    type: 'coding',
    owner: 'worker-b'
  })
  assertEqual(child.parentId, parent.id, 'parent relation must persist')
  assertEqual(child.dependencyIds[0], parent.id, 'dependency relation must persist')

  await assertRejects(
    reopened.createWorkItem({ projectId: workspace.id, title: 'Foreign dependency', dependencyIds: ['missing'] }),
    (error) => error.code === 'not_found',
    'missing dependency must fail closed'
  )
  const foreignItem = await reopened.createWorkItem({ projectId: foreign.id, title: 'Foreign item' })
  await assertRejects(
    reopened.createWorkItem({ projectId: workspace.id, title: 'Cross project', dependencyIds: [foreignItem.id] }),
    (error) => error.code === 'cross_project',
    'cross-project dependency must fail closed'
  )
  await assertRejects(
    reopened.createGoal({ projectId: foreign.id, title: 'Foreign goal', objective: 'foreign' }).then((foreignGoal) =>
      reopened.createWorkItem({ projectId: workspace.id, goalId: foreignGoal.id, title: 'Cross project goal' })),
    (error) => error.code === 'cross_project',
    'cross-project Goal link must fail closed'
  )

  // WORK-001/004: dependency, owner, lease, invalid transition, and
  // acceptance invariants.
  await assertRejects(
    reopened.transitionWorkItem(parent.id, 'running', parent.revision),
    (error) => error.code === 'invalid_transition',
    'backlog must not jump directly to running'
  )
  const readyParent = await reopened.transitionWorkItem(parent.id, 'ready', parent.revision)
  await assertRejects(
    reopened.transitionWorkItem(parent.id, 'running', readyParent.revision),
    (error) => error.code === 'lease_required',
    'running without a lease must fail closed'
  )
  const leasedParent = await reopened.acquireWorkItemLease(parent.id, { expectedRevision: readyParent.revision, ownerId: 'worker-a' })
  await assertRejects(
    reopened.acquireWorkItemLease(parent.id, { expectedRevision: leasedParent.revision, ownerId: 'worker-a' }),
    (error) => error.code === 'lease_conflict',
    'a second active lease must fail closed'
  )
  const runningParent = await reopened.transitionWorkItem(parent.id, 'running', leasedParent.revision)
  const verifyingParent = await reopened.transitionWorkItem(parent.id, 'verifying', runningParent.revision)
  await assertRejects(
    reopened.transitionWorkItem(parent.id, 'done', verifyingParent.revision),
    (error) => error.code === 'acceptance_required',
    'done without Acceptance must fail closed'
  )
  await assertRejects(
    reopened.setWorkItemAcceptance(parent.id, {
      status: 'passed', evidenceRefs: []
    }, verifyingParent.revision),
    (error) => error.code === 'invalid_input',
    'passed Acceptance without evidence references must fail closed'
  )
  await assertRejects(
    reopened.setWorkItemAcceptance(parent.id, {
      status: 'passed', evidenceRefs: ['   ']
    }, verifyingParent.revision),
    (error) => error.code === 'invalid_input',
    'blank Acceptance evidence references must fail closed'
  )
  const acceptedParent = await reopened.setWorkItemAcceptance(parent.id, {
    status: 'passed', evidenceRefs: [' evidence-parent ', 'evidence-parent', ' evidence-parent-2 ']
  }, verifyingParent.revision)
  assertEqual(
    JSON.stringify(acceptedParent.acceptance.evidenceRefs),
    JSON.stringify(['evidence-parent', 'evidence-parent-2']),
    'Acceptance evidence references must be trimmed and deduplicated'
  )
  const doneParent = await reopened.transitionWorkItem(parent.id, 'done', acceptedParent.revision)
  assertEqual(doneParent.status, 'done', 'passed Acceptance must permit done')

  const readyChild = await reopened.transitionWorkItem(child.id, 'ready', child.revision)
  const leasedChild = await reopened.acquireWorkItemLease(child.id, { expectedRevision: readyChild.revision, ownerId: 'worker-b' })
  const runningChild = await reopened.transitionWorkItem(child.id, 'running', leasedChild.revision)
  assertEqual(runningChild.status, 'running', 'satisfied dependencies must permit running')

  await assertRejects(
    reopened.transitionGoal(goal.id, 'completed', goal.revision),
    (error) => error.code === 'invalid_transition',
    'Goal must follow its state machine'
  )
  const plannedGoal = await reopened.transitionGoal(goal.id, 'planned', goal.revision)
  const runningGoal = await reopened.transitionGoal(goal.id, 'running', plannedGoal.revision)
  const verifyingGoal = await reopened.transitionGoal(goal.id, 'verifying', runningGoal.revision)
  await assertRejects(
    reopened.transitionGoal(goal.id, 'completed', verifyingGoal.revision),
    (error) => error.code === 'acceptance_required',
    'Goal completion must require Acceptance')
  await assertRejects(
    reopened.setGoalAcceptance(goal.id, {
      status: 'passed', evidenceRefs: []
    }, verifyingGoal.revision),
    (error) => error.code === 'invalid_input',
    'Goal passed Acceptance without evidence references must fail closed'
  )
  const acceptedGoal = await reopened.setGoalAcceptance(goal.id, {
    status: 'passed', evidenceRefs: [' evidence-goal ', 'evidence-goal']
  }, verifyingGoal.revision)
  assertEqual(acceptedGoal.acceptanceResult.evidenceRefs[0], 'evidence-goal', 'Goal evidence ref must be normalized')
  assertEqual(acceptedGoal.acceptanceResult.evidenceRefs.length, 1, 'Goal evidence refs must be deduplicated')
  const completedGoal = await reopened.transitionGoal(goal.id, 'completed', acceptedGoal.revision)
  const archivedGoal = await reopened.archiveGoal(goal.id, completedGoal.revision)
  assertEqual(archivedGoal.status, 'archived', 'terminal Goal must archive')
  const restoredGoal = await reopened.restoreGoal(goal.id, archivedGoal.revision)
  assertEqual(restoredGoal.status, 'completed', 'Goal restore must return prior terminal state')

  // Export includes the aggregate and a digest, and can be written atomically.
  const manifest = await reopened.exportManifest(workspace.id, manifestPath)
  assertEqual(manifest.projectId, workspace.id, 'manifest must identify its Project')
  assert(manifest.goals.some((item) => item.id === goal.id), 'manifest must include Goal')
  assert(manifest.workItems.some((item) => item.id === child.id), 'manifest must include WorkItems')
  assert(manifest.digest.length === 64, 'manifest must have a SHA-256 digest')
  assert(readFileSync(manifestPath, 'utf8').includes(manifest.digest), 'manifest file must be atomically written')

  // Entity CAS: two independent stores race on one revision; exactly one
  // update may commit. The source directory remains untouched on deletion.
  const left = new api.ProjectWorkspaceStore(userData)
  const right = new api.ProjectWorkspaceStore(userData)
  const current = await left.getWorkspace(workspace.id)
  const race = await Promise.allSettled([
    left.updateWorkspace(workspace.id, { name: 'left' }, current.revision),
    right.updateWorkspace(workspace.id, { name: 'right' }, current.revision)
  ])
  assertEqual(race.filter((result) => result.status === 'fulfilled').length, 1, 'concurrent revision must allow one writer')
  assertEqual(race.filter((result) => result.status === 'rejected' && result.reason?.code === 'stale_revision').length, 1, 'losing writer must receive stale_revision')

  const afterDelete = await reopened.deleteWorkspace(workspace.id)
  assertEqual(afterDelete.status, 'deleted', 'delete must be durable')
  assert(statSync(sourceDir).isDirectory(), 'delete must not remove source directory')
  assertEqual(readFileSync(path.join(sourceDir, 'sentinel.txt'), 'utf8'), 'source content\n', 'source files must survive delete')
  const recovered = await reopened.restoreWorkspace(workspace.id, afterDelete.revision)
  assertEqual(recovered.status, 'active', 'deleted workspace must be recoverable')
  await reopened.purgeWorkspace(workspace.id, recovered.revision)
  assertEqual(await reopened.getWorkspace(workspace.id), undefined, 'permanent delete must remove metadata')
  assert(statSync(sourceDir).isDirectory(), 'permanent delete must still preserve source directory')

  const persisted = JSON.parse(readFileSync(path.join(userData, 'project-workspace.json'), 'utf8'))
  assertEqual(persisted.schemaVersion, 1, 'persisted store must declare schemaVersion')
  assert(Number.isInteger(persisted.revision) && persisted.revision > 0, 'persisted store must declare revision')
  console.log(JSON.stringify({
    status: 'PASS',
    workspaceId: workspace.id,
    goals: manifest.goals.length,
    workItems: manifest.workItems.length,
    manifestDigest: manifest.digest,
    persistedRevision: persisted.revision
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/project-workspace-types.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/index.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
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
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
