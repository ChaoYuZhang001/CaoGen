import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-task-snapshot-replay-'))
const require = createRequire(import.meta.url)

try {
  const source = readFileSync(path.join(repoRoot, 'src/main/task/task-snapshot-replay.ts'), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const modulePath = path.join(tempRoot, 'task-snapshot-replay.cjs')
  writeFileSync(modulePath, output, 'utf8')
  const { TaskSnapshotReplayCoordinator } = require(modulePath)

  await verifySequentialReplay(TaskSnapshotReplayCoordinator)
  await verifyFailureStopsReplay(TaskSnapshotReplayCoordinator)
  await verifyInitialRejection(TaskSnapshotReplayCoordinator)
  await verifyRejectedReplay(TaskSnapshotReplayCoordinator)
  await verifyThrownSendReason(TaskSnapshotReplayCoordinator)
  await verifySynchronousEngineError(TaskSnapshotReplayCoordinator)
  await verifyRecoveryRefreshFailure(TaskSnapshotReplayCoordinator)
  await verifyClosedSessionClearsReplay(TaskSnapshotReplayCoordinator)

  console.log('task snapshot replay smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function verifySequentialReplay(Coordinator) {
  const sent = []
  const events = []
  const coordinator = new Coordinator({
    send: (sessionId, prompt, options) => {
      sent.push({ sessionId, prompt, options })
      return true
    },
    emit: (sessionId, event) => events.push({ sessionId, event })
  })
  const options = { modelAttemptRecoveryReplay: true }
  assertEqual(coordinator.start('sequential', ['one', 'two', 'three'], options), true)
  assertPrompts(sent, ['one'])
  assertEqual(coordinator.blocksOrdinarySend('sequential', {}), true)
  assertEqual(coordinator.blocksOrdinarySend('sequential', options), false)

  coordinator.handleEvent('sequential', turnResult(false), Promise.resolve(true))
  const gate = deferred()
  coordinator.handleEvent('sequential', status('idle'), gate.promise)
  coordinator.handleEvent('sequential', status('idle'), Promise.resolve(true))
  assertPrompts(sent, ['one'])
  gate.resolve(true)
  await flushPromises()
  assertPrompts(sent, ['one', 'two'])

  coordinator.handleEvent('sequential', turnResult(false), Promise.resolve(true))
  coordinator.handleEvent('sequential', status('idle'), Promise.resolve(true))
  await flushPromises()
  assertPrompts(sent, ['one', 'two', 'three'])

  coordinator.handleEvent('sequential', turnResult(false), Promise.resolve(true))
  coordinator.handleEvent('sequential', status('idle'), Promise.resolve(true))
  await flushPromises()
  assertEqual(coordinator.hasPending('sequential'), false)
  assertEqual(coordinator.blocksOrdinarySend('sequential', {}), false)
  assertEqual(events.length, 0)
  for (const call of sent) assertEqual(call.options, options)
}

async function verifyFailureStopsReplay(Coordinator) {
  const harness = createHarness(Coordinator, () => true)
  harness.coordinator.start('failed', ['one', 'two'])
  harness.coordinator.handleEvent('failed', turnResult(true, 'provider failed'), Promise.resolve(true))
  harness.coordinator.handleEvent('failed', status('error', 'provider failed'), Promise.resolve(true))
  assertPrompts(harness.sent, ['one'])
  assertEvent(harness.events, 'task-snapshot-replay-failed', '1/2')
}

async function verifyInitialRejection(Coordinator) {
  const harness = createHarness(Coordinator, () => false)
  assertEqual(harness.coordinator.start('initial-rejection', ['one', 'two']), false)
  assertPrompts(harness.sent, ['one'])
  assertEvent(harness.events, 'task-snapshot-replay-rejected', '1/2')
}

async function verifyRejectedReplay(Coordinator) {
  let attempts = 0
  const harness = createHarness(Coordinator, () => {
    attempts += 1
    return attempts === 1
  })
  harness.coordinator.start('rejected', ['one', 'two', 'three'])
  harness.coordinator.handleEvent('rejected', turnResult(false), Promise.resolve(true))
  harness.coordinator.handleEvent('rejected', status('idle'), Promise.resolve(true))
  await flushPromises()
  assertPrompts(harness.sent, ['one', 'two'])
  assertEvent(harness.events, 'task-snapshot-replay-rejected', '2/3')
}

async function verifySynchronousEngineError(Coordinator) {
  const events = []
  let coordinator
  coordinator = new Coordinator({
    send: () => {
      coordinator.handleEvent('sync-error', status('error', 'engine rejected synchronously'), Promise.resolve(true))
      return true
    },
    emit: (_sessionId, event) => events.push(event)
  })
  assertEqual(coordinator.start('sync-error', ['one', 'two']), false)
  assertEvent(events.map((event) => ({ event })), 'task-snapshot-replay-rejected', '1/2')
}

async function verifyThrownSendReason(Coordinator) {
  const events = []
  const coordinator = new Coordinator({
    send: () => { throw new Error('fixture send failure') },
    emit: (_sessionId, event) => events.push({ event })
  })
  assertThrows(() => coordinator.start('thrown-send', ['one']), 'fixture send failure')
  assertEvent(events, 'task-snapshot-replay-rejected', 'fixture send failure')
}

async function verifyRecoveryRefreshFailure(Coordinator) {
  const harness = createHarness(Coordinator, () => true)
  harness.coordinator.start('gate-failure', ['one', 'two'])
  harness.coordinator.handleEvent('gate-failure', turnResult(false), Promise.resolve(true))
  harness.coordinator.handleEvent('gate-failure', status('idle'), Promise.reject(new Error('gate refresh failed')))
  await flushPromises()
  assertPrompts(harness.sent, ['one'])
  assertEvent(harness.events, 'task-snapshot-replay-gated', 'gate refresh failed')
}

async function verifyClosedSessionClearsReplay(Coordinator) {
  const harness = createHarness(Coordinator, () => true)
  harness.coordinator.start('closed', ['one', 'two'])
  harness.coordinator.handleEvent('closed', status('closed'), Promise.resolve(true))
  harness.coordinator.handleEvent('closed', turnResult(false), Promise.resolve(true))
  harness.coordinator.handleEvent('closed', status('idle'), Promise.resolve(true))
  await flushPromises()
  assertPrompts(harness.sent, ['one'])
  assertEqual(harness.events.length, 0)
  assertEqual(harness.coordinator.hasPending('closed'), false)
}

function createHarness(Coordinator, accept) {
  const sent = []
  const events = []
  const coordinator = new Coordinator({
    send: (sessionId, prompt, options) => {
      sent.push({ sessionId, prompt, options })
      return accept()
    },
    emit: (sessionId, event) => events.push({ sessionId, event })
  })
  return { coordinator, sent, events }
}

function turnResult(isError, resultText) {
  return { kind: 'turn-result', subtype: isError ? 'error' : 'success', isError, resultText }
}

function status(value, error) {
  return { kind: 'status', status: value, error }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

function assertPrompts(sent, expected) {
  assertEqual(JSON.stringify(sent.map((call) => call.prompt)), JSON.stringify(expected))
}

function assertEvent(events, name, detail) {
  const matched = events.find((entry) => entry.event.event === name)
  if (!matched) throw new Error(`missing ${name}: ${JSON.stringify(events)}`)
  if (!matched.event.detail.includes(detail)) {
    throw new Error(`${name} detail missing ${detail}: ${matched.event.detail}`)
  }
}

function assertEqual(actual, expected) {
  if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertThrows(callback, expected) {
  try {
    callback()
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return
    throw error
  }
  throw new Error(`expected error containing ${expected}`)
}
