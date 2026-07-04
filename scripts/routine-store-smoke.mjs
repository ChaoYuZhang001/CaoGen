import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-routine-store-'))
const outDir = path.join(tempRoot, 'compiled')
const storeRoot = path.join(tempRoot, 'store')
const badRoot = path.join(tempRoot, 'bad-json')

try {
  execFileSync(
    'npx',
    [
      'tsc',
      'src/main/routineStore.ts',
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

  const compiledModule = findCompiledModule(outDir)
  const routineStore = await import(pathToFileURL(compiledModule).href)

  const created = await routineStore.createRoutine(storeRoot, {
    name: 'Morning review',
    prompt: 'Summarize open work.',
    projectCwd: repoRoot,
    schedule: '0 9 * * *',
    providerId: 'provider-a',
    model: 'model-a',
    permissionMode: 'plan',
    budgetUsd: 1.25,
    metadata: { owner: 'smoke' }
  })

  assert(created.id, 'createRoutine should assign an id')
  assertEqual(created.enabled, true)
  assertEqual(created.lastRunAt, null)
  assertEqual(created.metadata.owner, 'smoke')
  assert(existsSync(path.join(storeRoot, 'routines.json')), 'createRoutine should persist routines.json')

  const updated = await routineStore.updateRoutine(storeRoot, created.id, {
    name: 'Morning review updated',
    budgetUsd: 2,
    nextRunAt: 123456,
    metadata: { owner: 'updated' }
  })
  assert(updated, 'updateRoutine should find created routine')
  assertEqual(updated.name, 'Morning review updated')
  assertEqual(updated.prompt, 'Summarize open work.')
  assertEqual(updated.nextRunAt, 123456)
  assertEqual(updated.metadata.owner, 'updated')
  assertEqual(updated.permissionMode, 'plan')

  const disabled = await routineStore.updateRoutine(storeRoot, created.id, { enabled: false })
  assert(disabled, 'updateRoutine should disable routine')
  assertEqual(disabled.enabled, false)

  const ran = await routineStore.markRun(storeRoot, created.id, { ranAt: 200000, nextRunAt: 300000 })
  assert(ran, 'markRun should find routine')
  assertEqual(ran.lastRunAt, 200000)
  assertEqual(ran.nextRunAt, 300000)
  assertEqual(ran.enabled, false)

  const beforeReload = await routineStore.listRoutines(storeRoot)
  assertEqual(beforeReload.length, 1)
  assertEqual(beforeReload[0].id, created.id)
  assertEqual(beforeReload[0].name, 'Morning review updated')

  const routineStoreReloaded = await import(
    `${pathToFileURL(compiledModule).href}?reload=${Date.now()}`
  )
  const afterReload = await routineStoreReloaded.listRoutines(storeRoot)
  assertDeepEqual(afterReload, beforeReload, 'list after module reload should match persisted data')

  const deleted = await routineStore.deleteRoutine(storeRoot, created.id)
  assertEqual(deleted, true)
  assertDeepEqual(await routineStore.listRoutines(storeRoot), [], 'deleteRoutine should remove routine')
  assertEqual(await routineStore.deleteRoutine(storeRoot, created.id), false)

  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        name: '',
        prompt: 'x',
        projectCwd: repoRoot,
        schedule: '0 9 * * *'
      }),
    'empty name should fail validation'
  )
  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        name: 'Bad permission',
        prompt: 'x',
        projectCwd: repoRoot,
        schedule: '0 9 * * *',
        permissionMode: 'danger'
      }),
    'invalid permissionMode should fail validation'
  )
  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        name: 'Bad budget',
        prompt: 'x',
        projectCwd: repoRoot,
        schedule: '0 9 * * *',
        budgetUsd: -1
      }),
    'negative budget should fail validation'
  )

  mkdirSync(badRoot, { recursive: true })
  writeFileSync(path.join(badRoot, 'routines.json'), '{ bad json', 'utf8')
  assertDeepEqual(await routineStore.listRoutines(badRoot), [], 'bad JSON should list as empty without throwing')

  const badCreated = await routineStore.createRoutine(badRoot, {
    name: 'Recovered',
    prompt: 'Recover after corrupt file.',
    projectCwd: repoRoot,
    schedule: '@daily'
  })
  assertEqual(badCreated.name, 'Recovered')
  const recoveredRaw = readFileSync(path.join(badRoot, 'routines.json'), 'utf8')
  assert(JSON.parse(recoveredRaw).routines.length === 1, 'createRoutine should overwrite corrupt JSON safely')

  console.log('routineStore smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertDeepEqual(actual, expected, message = 'values should be deeply equal') {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  assert(actualJson === expectedJson, `${message}: expected ${expectedJson}, got ${actualJson}`)
}

function findCompiledModule(root) {
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath)
      if (found) return found
    } else if (entry.isFile() && entry.name === 'routineStore.js') {
      return fullPath
    }
  }
  throw new Error(`compiled routineStore.js not found under ${root}`)
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function assertRejects(fn, message) {
  let rejected = false
  try {
    await fn()
  } catch {
    rejected = true
  }
  assert(rejected, message)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}
