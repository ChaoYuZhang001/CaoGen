import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-routine-store-'))
const outDir = path.join(tempRoot, 'compiled')
const storeRoot = path.join(tempRoot, 'store')
const projectRoot = path.join(tempRoot, 'project')
const badRoot = path.join(tempRoot, 'bad-json')
const legacyRoot = path.join(tempRoot, 'legacy-json')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
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
  mkdirSync(projectRoot, { recursive: true })
  const sentinelRunOutput = path.join(projectRoot, 'routine-ran.txt')

  assertEqual(typeof routineStore.createRoutine, 'function')
  assertEqual(typeof routineStore.updateRoutine, 'function')
  assertEqual(typeof routineStore.markRun, 'function')
  assertEqual(typeof routineStore.listRoutines, 'function')
  assertEqual(typeof routineStore.deleteRoutine, 'function')

  const created = await routineStore.createRoutine(storeRoot, {
    id: 'routine-smoke-1',
    name: 'Morning review',
    prompt: `Write ${sentinelRunOutput} if this routine actually runs.`,
    projectCwd: projectRoot,
    schedule: '0 9 * * *',
    providerId: 'provider-a',
    model: 'model-a',
    engine: 'openai',
    permissionMode: 'plan',
    budgetUsd: 1.25,
    createdAt: 1000,
    updatedAt: 1000,
    lastRunAt: null,
    nextRunAt: 1500,
    tags: ['daily'],
    metadata: { owner: 'smoke' }
  })

  assertEqual(created.id, 'routine-smoke-1')
  assertEqual(created.enabled, true)
  assertEqual(created.createdAt, 1000)
  assertEqual(created.updatedAt, 1000)
  assertEqual(created.lastRunAt, null)
  assertEqual(created.nextRunAt, 1500)
  assertEqual(created.engine, 'openai')
  assertEqual(created.tags.length, 1)
  assertEqual(created.metadata.owner, 'smoke')
  assert(!existsSync(sentinelRunOutput), 'createRoutine should persist only; it must not execute the prompt')
  assert(existsSync(path.join(storeRoot, 'routines.json')), 'createRoutine should persist routines.json')
  assertStoreFile(storeRoot, { count: 1 })
  assertNoTempFiles(storeRoot)

  const afterCreateRaw = readFileSync(routineStore.getRoutineStorePath(storeRoot), 'utf8')
  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        id: created.id,
        name: 'Duplicate id',
        prompt: 'x',
        projectCwd: projectRoot,
        schedule: '@daily'
      }),
    'duplicate id should fail validation'
  )
  assertEqual(
    readFileSync(routineStore.getRoutineStorePath(storeRoot), 'utf8'),
    afterCreateRaw,
    'failed duplicate create should not rewrite persisted data'
  )

  const updated = await routineStore.updateRoutine(storeRoot, created.id, {
    name: 'Morning review updated',
    prompt: 'Summarize open work.',
    schedule: '@hourly',
    engine: 'openai',
    permissionMode: 'acceptEdits',
    budgetUsd: 2,
    nextRunAt: null,
    notes: 'unknown update field should persist',
    metadata: { owner: 'updated' }
  })
  assert(updated, 'updateRoutine should find created routine')
  assertEqual(updated.name, 'Morning review updated')
  assertEqual(updated.prompt, 'Summarize open work.')
  assertEqual(updated.projectCwd, projectRoot)
  assertEqual(updated.schedule, '@hourly')
  assertEqual(updated.permissionMode, 'acceptEdits')
  assertEqual(updated.engine, 'openai')
  assertEqual(updated.createdAt, 1000)
  assert(updated.updatedAt >= created.updatedAt, 'updateRoutine should advance updatedAt')
  assert(!hasOwn(updated, 'nextRunAt'), 'nextRunAt: null should clear the persisted schedule boundary')
  assertEqual(updated.metadata.owner, 'updated')
  assertEqual(updated.notes, 'unknown update field should persist')
  assertEqual(updated.tags.length, 1)

  const afterUpdateRaw = readFileSync(routineStore.getRoutineStorePath(storeRoot), 'utf8')
  assertEqual(await routineStore.updateRoutine(storeRoot, 'missing-routine', { name: 'Nope' }), null)
  assertEqual(
    readFileSync(routineStore.getRoutineStorePath(storeRoot), 'utf8'),
    afterUpdateRaw,
    'missing update should not rewrite persisted data'
  )

  const disabled = await routineStore.updateRoutine(storeRoot, created.id, { enabled: false })
  assert(disabled, 'updateRoutine should disable routine')
  assertEqual(disabled.enabled, false)
  assertEqual(disabled.lastRunAt, null)

  await assertRejects(
    () => routineStore.updateRoutine(storeRoot, created.id, { enabled: 'yes' }),
    'invalid enabled should fail validation'
  )
  assertEqual((await routineStore.listRoutines(storeRoot))[0].enabled, false)

  const enabled = await routineStore.updateRoutine(storeRoot, created.id, {
    enabled: true,
    nextRunAt: 1800
  })
  assert(enabled, 'updateRoutine should re-enable routine')
  assertEqual(enabled.enabled, true)
  assertEqual(enabled.nextRunAt, 1800)

  const ran = await routineStore.markRun(storeRoot, created.id, {
    ranAt: 200000,
    nextRunAt: 300000,
    status: 'success',
    runState: 'succeeded',
    outputPath: sentinelRunOutput
  })
  assert(ran, 'markRun should find routine')
  assertEqual(ran.lastRunAt, 200000)
  assertEqual(ran.nextRunAt, 300000)
  assertEqual(ran.enabled, true)
  assert(!hasOwn(ran, 'status'), 'markRun should not persist a fake execution status')
  assert(!hasOwn(ran, 'runState'), 'markRun should not persist a fake UI run state')
  assert(!hasOwn(ran, 'outputPath'), 'markRun should not persist fake run output')
  assert(!existsSync(sentinelRunOutput), 'markRun should not execute the prompt or implement run now')

  const afterMarkRaw = readFileSync(routineStore.getRoutineStorePath(storeRoot), 'utf8')
  assertEqual(await routineStore.markRun(storeRoot, 'missing-routine', { ranAt: 250000 }), null)
  assertEqual(
    readFileSync(routineStore.getRoutineStorePath(storeRoot), 'utf8'),
    afterMarkRaw,
    'missing markRun should not rewrite persisted data'
  )

  const ranWithoutNext = await routineStore.markRun(storeRoot, created.id, {
    ranAt: 210000,
    nextRunAt: null
  })
  assert(ranWithoutNext, 'markRun should allow clearing nextRunAt')
  assertEqual(ranWithoutNext.lastRunAt, 210000)
  assert(!hasOwn(ranWithoutNext, 'nextRunAt'), 'markRun nextRunAt:null should clear nextRunAt')

  const beforeReload = await routineStore.listRoutines(storeRoot)
  assertEqual(beforeReload.length, 1)
  assertEqual(beforeReload[0].id, created.id)
  assertEqual(beforeReload[0].name, 'Morning review updated')
  assertStoreFile(storeRoot, { count: 1 })
  assertDeepEqual(
    JSON.parse(readFileSync(routineStore.getRoutineStorePath(storeRoot), 'utf8')).routines,
    beforeReload,
    'persisted routines should match listRoutines output'
  )

  const routineStoreReloaded = await import(
    `${pathToFileURL(compiledModule).href}?reload=${Date.now()}`
  )
  const afterReload = await routineStoreReloaded.listRoutines(storeRoot)
  assertDeepEqual(afterReload, beforeReload, 'list after module reload should match persisted data')
  assertNoTempFiles(storeRoot)

  const deleted = await routineStore.deleteRoutine(storeRoot, created.id)
  assertEqual(deleted, true)
  assertDeepEqual(await routineStore.listRoutines(storeRoot), [], 'deleteRoutine should remove routine')
  assertEqual(await routineStore.deleteRoutine(storeRoot, created.id), false)
  assertStoreFile(storeRoot, { count: 0 })
  assertNoTempFiles(storeRoot)

  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        name: '',
        prompt: 'x',
        projectCwd: projectRoot,
        schedule: '0 9 * * *'
      }),
    'empty name should fail validation'
  )
  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        name: 'Bad permission',
        prompt: 'x',
        projectCwd: projectRoot,
        schedule: '0 9 * * *',
        permissionMode: 'danger'
      }),
    'invalid permissionMode should fail validation'
  )
  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        name: 'Bad engine',
        prompt: 'x',
        projectCwd: projectRoot,
        schedule: '0 9 * * *',
        engine: 'unknown-engine'
      }),
    'invalid engine should fail validation'
  )
  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        name: 'Bad budget',
        prompt: 'x',
        projectCwd: projectRoot,
        schedule: '0 9 * * *',
        budgetUsd: -1
      }),
    'negative budget should fail validation'
  )
  await assertRejects(
    () =>
      routineStore.createRoutine(storeRoot, {
        name: 'Bad next run',
        prompt: 'x',
        projectCwd: projectRoot,
        schedule: '0 9 * * *',
        nextRunAt: -1
      }),
    'negative nextRunAt should fail validation'
  )
  await assertRejects(() => routineStore.listRoutines(''), 'empty rootDir should fail validation')

  mkdirSync(badRoot, { recursive: true })
  writeFileSync(path.join(badRoot, 'routines.json'), '{ bad json', 'utf8')
  assertDeepEqual(await routineStore.listRoutines(badRoot), [], 'bad JSON should list as empty without throwing')

  const badCreated = await routineStore.createRoutine(badRoot, {
    name: 'Recovered',
    prompt: 'Recover after corrupt file.',
    projectCwd: projectRoot,
    schedule: '@daily'
  })
  assertEqual(badCreated.name, 'Recovered')
  const recoveredRaw = readFileSync(path.join(badRoot, 'routines.json'), 'utf8')
  assert(JSON.parse(recoveredRaw).routines.length === 1, 'createRoutine should overwrite corrupt JSON safely')

  mkdirSync(legacyRoot, { recursive: true })
  writeFileSync(
    path.join(legacyRoot, 'routines.json'),
    `${JSON.stringify(
      {
        version: 999,
        routines: [
          {
            id: 'legacy-ok',
            name: 'Legacy',
            prompt: 'Normalize this persisted record.',
            projectCwd: projectRoot,
            schedule: '@daily',
            providerId: null,
            model: null,
            permissionMode: 'danger',
            budgetUsd: -10,
            enabled: 'yes',
            lastRunAt: null,
            extra: 'kept'
          },
          { id: '', name: 'Invalid', prompt: 'x', projectCwd: projectRoot, schedule: '@daily' },
          null,
          'not a routine'
        ]
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  const legacyList = await routineStore.listRoutines(legacyRoot)
  assertEqual(legacyList.length, 1)
  assertEqual(legacyList[0].id, 'legacy-ok')
  assertEqual(legacyList[0].providerId, '')
  assertEqual(legacyList[0].model, '')
  assertEqual(legacyList[0].permissionMode, 'default')
  assertEqual(legacyList[0].budgetUsd, 0)
  assertEqual(legacyList[0].enabled, true)
  assertEqual(legacyList[0].createdAt, 0)
  assertEqual(legacyList[0].updatedAt, 0)
  assertEqual(legacyList[0].extra, 'kept')

  console.log('routineStore smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertDeepEqual(actual, expected, message = 'values should be deeply equal') {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  assert(actualJson === expectedJson, `${message}: expected ${expectedJson}, got ${actualJson}`)
}

function assertStoreFile(root, { count }) {
  const raw = readFileSync(path.join(root, 'routines.json'), 'utf8')
  const payload = JSON.parse(raw)
  assertEqual(payload.version, 1)
  assert(Array.isArray(payload.routines), 'routines.json should contain a routines array')
  assertEqual(payload.routines.length, count)
  assert(raw.endsWith('\n'), 'routines.json should end with a newline')
}

function assertNoTempFiles(root) {
  const tempFiles = readdirSync(root).filter((entry) => entry.endsWith('.tmp'))
  assertDeepEqual(tempFiles, [], 'routine store should not leave temp files behind')
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
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
