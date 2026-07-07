import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-personal-os-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')

try {
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path.join(projectDir, 'package.json'), '{"name":"personal-os-smoke"}\n', 'utf8')
  compile(['src/main/routines/personal-os.ts', 'src/main/startSuggestions.ts'], outDir)

  const personalOs = await import(pathToFileURL(findCompiled(outDir, 'personal-os.js')).href)
  const startSuggestions = await import(pathToFileURL(findCompiled(outDir, 'startSuggestions.js')).href)
  const now = 1_000_000

  const routines = [
    routine({ id: 'due', name: 'Due Routine', nextRunAt: now - 5_000 }),
    routine({ id: 'running', name: 'Running Routine', nextRunAt: now + 60_000 }),
    routine({ id: 'failed', name: 'Failed Routine', nextRunAt: now + 120_000, lastError: 'planned failure' }),
    routine({ id: 'paused', name: 'Paused Routine', enabled: false, nextRunAt: now + 180_000 })
  ]
  const runs = [
    run({ id: 'run-running', routineId: 'running', status: 'running', startedAt: now - 1_000 }),
    run({ id: 'run-failed', routineId: 'failed', status: 'failed', startedAt: now - 10_000, error: 'planned failure' })
  ]
  const snapshot = personalOs.buildPersonalOsSnapshot({
    routines,
    routineRuns: runs,
    suggestions: [{ id: 's1', title: 'Suggestion', body: 'body', source: 'routine', priority: 'low', prompt: 'prompt' }],
    settings: { notificationsEnabled: true, preventDisplaySleep: true },
    now
  })

  assertEqual(snapshot.status, 'active')
  assertEqual(snapshot.totals.routines, 4)
  assertEqual(snapshot.totals.enabled, 3)
  assertEqual(snapshot.totals.due, 1)
  assertEqual(snapshot.totals.running, 1)
  assertEqual(snapshot.totals.failed, 1)
  assertEqual(snapshot.notificationPlan.routineFailures, 1)
  assertEqual(snapshot.notificationPlan.overdueRoutines, 1)
  assertEqual(snapshot.powerPlan.active, true)
  assertEqual(snapshot.routines.find((item) => item.id === 'paused')?.state, 'paused')

  const successNotification = personalOs.buildRoutineRunNotification(
    routines[0],
    run({ id: 'notify-success', routineId: 'due', status: 'succeeded', startedAt: now, sessionId: 'session-1' }),
    { notificationsEnabled: true }
  )
  assert(successNotification, 'succeeded routine should build a notification when enabled')
  assertEqual(successNotification.sessionId, 'session-1')
  assert(successNotification.title.includes('Routine 已完成'), 'success notification title should be explicit')

  const failureNotification = personalOs.buildRoutineRunNotification(
    routines[0],
    run({ id: 'notify-failure', routineId: 'due', status: 'failed', startedAt: now, error: 'planned failure' }),
    { notificationsEnabled: true }
  )
  assert(failureNotification, 'failed routine should build a notification when enabled')
  assert(failureNotification.body.includes('planned failure'), 'failure notification should carry the concrete error')
  assertEqual(
    personalOs.buildRoutineRunNotification(routines[0], failureNotificationRecord(now), {
      notificationsEnabled: false
    }),
    null
  )
  assertEqual(
    personalOs.buildRoutineRunNotification(
      { ...routines[0], notification: { enabled: true, onSuccess: false, onFailure: true } },
      run({ id: 'notify-muted-success', routineId: 'due', status: 'succeeded', startedAt: now }),
      { notificationsEnabled: true }
    ),
    null
  )

  const muted = personalOs.buildPersonalOsSnapshot({
    routines,
    routineRuns: runs,
    settings: { notificationsEnabled: false, preventDisplaySleep: false },
    now
  })
  assertEqual(muted.notificationPlan.routineFailures, 0)
  assertEqual(muted.powerPlan.active, false)

  const power = fakePowerAdapter()
  const release = personalOs.startPersonalOsPowerBlocker({ adapter: power, enabled: true, reason: 'smoke' })
  assertEqual(power.starts, 1)
  release()
  release()
  assertEqual(power.stops, 1)

  const disabledPower = fakePowerAdapter()
  const disabledRelease = personalOs.startPersonalOsPowerBlocker({ adapter: disabledPower, enabled: false })
  disabledRelease()
  assertEqual(disabledPower.starts, 0)

  const throwingPower = fakePowerAdapter()
  let threw = false
  try {
    await personalOs.runWithPersonalOsPowerBlocker(
      { adapter: throwingPower, enabled: true, reason: 'throwing-smoke' },
      async () => {
        throw new Error('expected task failure')
      }
    )
  } catch {
    threw = true
  }
  assert(threw, 'runWithPersonalOsPowerBlocker should rethrow task failures')
  assertEqual(throwingPower.starts, 1)
  assertEqual(throwingPower.stops, 1)

  const proactive = startSuggestions.buildStartSuggestions({
    projectDir,
    maxSuggestions: 10,
    routineSummaries: [
      { id: 'daily', title: 'Daily Routine', body: 'Daily review', source: 'routine', status: 'enabled', ok: true },
      { id: 'paused', title: 'Paused Routine', body: 'Paused review', source: 'routine', status: 'disabled', ok: true }
    ],
    routineRuns: []
  })
  assertHasSuggestion(proactive, 'routine-first-run', 'routine')
  assertHasSuggestion(proactive, 'routine-disabled-review', 'routine')

  console.log('personalOS smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function routine(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    prompt: 'Inspect routine state.',
    projectCwd: projectDir,
    schedule: 'every 1h',
    providerId: '',
    model: '',
    permissionMode: 'plan',
    budgetUsd: 0,
    notification: { enabled: true, onSuccess: true, onFailure: true },
    enabled: overrides.enabled ?? true,
    createdAt: nowish(),
    updatedAt: nowish(),
    lastRunAt: null,
    ...overrides
  }
}

function run(overrides) {
  return {
    id: overrides.id,
    routineId: overrides.routineId,
    routineName: overrides.routineId,
    projectCwd: projectDir,
    startedAt: overrides.startedAt,
    status: overrides.status,
    ...overrides
  }
}

function failureNotificationRecord(now) {
  return run({ id: 'notify-muted-global', routineId: 'due', status: 'failed', startedAt: now, error: 'muted' })
}

function fakePowerAdapter() {
  const active = new Set()
  return {
    starts: 0,
    stops: 0,
    start(type) {
      assertEqual(type, 'prevent-display-sleep')
      this.starts += 1
      const id = this.starts
      active.add(id)
      return id
    },
    stop(id) {
      this.stops += 1
      active.delete(id)
    },
    isStarted(id) {
      return active.has(id)
    }
  }
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

function assertHasSuggestion(suggestions, id, source) {
  assert(
    suggestions.some((suggestion) => suggestion.id === id && suggestion.source === source),
    `missing ${id}/${source}: ${suggestions.map((suggestion) => `${suggestion.id}:${suggestion.source}`).join(', ')}`
  )
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function nowish() {
  return 1_000
}
