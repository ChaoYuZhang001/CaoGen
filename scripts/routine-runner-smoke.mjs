import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-routine-runner-'))
const outDir = path.join(tempRoot, 'compiled')
const storeRoot = path.join(tempRoot, 'routines')
const projectRoot = path.join(tempRoot, 'project')

try {
  mkdirSync(projectRoot, { recursive: true })
  compile(['src/main/routineStore.ts', 'src/main/routines/routine-runner.ts', 'src/main/routines/routine-templates.ts'], outDir)
  const store = await import(pathToFileURL(findCompiled(outDir, 'routineStore.js')).href)
  const runner = await import(pathToFileURL(findCompiled(outDir, 'routine-runner.js')).href)
  const templatesModule = await import(pathToFileURL(findCompiled(outDir, 'routine-templates.js')).href)
  const templates = templatesModule.listRoutineTemplates()
  assert(templates.length >= 5, 'routine templates should include common scheduled workflows')

  const routine = await store.createRoutine(storeRoot, {
    id: 'routine-runner-smoke',
    name: 'Runner Smoke',
    content: 'Summarize smoke state.',
    projectCwd: projectRoot,
    frequency: 'every 1h',
    permissionMode: 'plan',
    notification: { enabled: false, onSuccess: true, onFailure: true },
    nextRunAt: 1000
  })
  assertEqual(routine.prompt, 'Summarize smoke state.')
  assertEqual(routine.schedule, 'every 1h')
  assertEqual(routine.notification.enabled, false)

  const success = await runner.runRoutineWithHistory(
    storeRoot,
    routine,
    async () => ({ sessionId: 'session-success' }),
    2000
  )
  assertEqual(success.status, 'succeeded')
  assertEqual(success.sessionId, 'session-success')

  const afterSuccess = await store.listRoutines(storeRoot)
  assertEqual(afterSuccess[0].lastRunAt, success.startedAt)
  assertEqual(afterSuccess[0].nextRunAt, 2000)
  assertEqual(afterSuccess[0].runState, 'succeeded')

  const failed = await runner.runRoutineWithHistory(
    storeRoot,
    afterSuccess[0],
    async () => {
      throw new Error('planned failure')
    },
    null
  )
  assertEqual(failed.status, 'failed')
  assert(failed.error.includes('planned failure'), 'failed run should persist error')

  const runs = await runner.listRoutineRuns(storeRoot, routine.id)
  assertEqual(runs.length, 2)
  assertEqual(runs[0].status, 'failed')
  const afterFailure = await store.listRoutines(storeRoot)
  assertEqual(afterFailure[0].runState, 'failed')
  assertEqual(afterFailure[0].lastError, 'planned failure')

  console.log('routineRunner smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile(files, outDir) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--rootDir',
      'src',
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
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled ${fileName} not found`)
}

function findCompiledOptional(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
