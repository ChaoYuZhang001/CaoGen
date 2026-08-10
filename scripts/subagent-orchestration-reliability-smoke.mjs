import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-subagent-orchestration-'))
const require = createRequire(import.meta.url)

try {
  const source = readFileSync(
    path.join(repoRoot, 'src/main/task/subagent-orchestration-coordinator.ts'),
    'utf8'
  )
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const modulePath = path.join(tempRoot, 'subagent-orchestration-coordinator.cjs')
  writeFileSync(modulePath, output, 'utf8')
  const { SubagentOrchestrationCoordinator } = require(modulePath)

  await verifyAcceptedFanIn(SubagentOrchestrationCoordinator)
  await verifyRejectedChildDoesNotHang(SubagentOrchestrationCoordinator)
  await verifyBusyParentDefersSummary(SubagentOrchestrationCoordinator)
  await verifyRejectedSummaryIsRetried(SubagentOrchestrationCoordinator)
  await verifyClosedParentClearsSummary(SubagentOrchestrationCoordinator)
  verifyProductionWiring()

  console.log('subagent orchestration reliability smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function verifyAcceptedFanIn(Coordinator) {
  const harness = createHarness(Coordinator)
  const children = beginWithChildren(harness, 'accepted', 2)
  await harness.coordinator.finishProvisioning('accepted', children)
  assertEqual(harness.childPrompts.length, 2)
  harness.coordinator.recordChildResult(children[0].meta, turnResult(false, 'first done'))
  harness.coordinator.recordChildResult(children[1].meta, turnResult(false, 'second done'))
  await flushPromises()
  assertEqual(harness.parentPrompts.length, 1)
  assertIncludes(harness.parentPrompts[0], '[子代理编排完成] 2/2 成功')
  assertEqual(harness.coordinator.states().length, 0)
}

async function verifyRejectedChildDoesNotHang(Coordinator) {
  const harness = createHarness(Coordinator, {
    childSend: (sessionId) => {
      if (sessionId !== 'rejected-child-1') return true
      harness.metas.get(sessionId).lastError = 'fixture child gate rejection'
      return false
    }
  })
  const children = beginWithChildren(harness, 'rejected', 2)
  await harness.coordinator.finishProvisioning('rejected', children)
  assertEqual(harness.coordinator.states()[0].pending.size, 1)
  assertEvent(harness.events, 'subagent-dispatch-rejected', 'fixture child gate rejection')
  assertEqual(harness.events.some((entry) => entry.event.kind === 'subagent-result' && entry.event.status === 'error'), true)

  harness.coordinator.recordChildResult(children[1].meta, turnResult(false, 'survivor done'))
  await flushPromises()
  assertEqual(harness.parentPrompts.length, 1)
  assertIncludes(harness.parentPrompts[0], '[子代理编排完成] 1/2 成功')
  assertIncludes(harness.parentPrompts[0], '子任务首条指令未被接受')
  assertEqual(harness.acknowledged.sort().join(','), 'rejected-child-1,rejected-child-2')
}

async function verifyBusyParentDefersSummary(Coordinator) {
  const harness = createHarness(Coordinator)
  harness.parent.status = 'running'
  const [child] = beginWithChildren(harness, 'busy', 1)
  await harness.coordinator.finishProvisioning('busy', [child])
  harness.coordinator.recordChildResult(child.meta, turnResult(false, 'done while parent busy'))
  assertEqual(harness.parentPrompts.length, 0)
  assertEqual(harness.coordinator.states().length, 1)

  harness.parent.status = 'idle'
  harness.coordinator.handleEvent(harness.parent.id, status('idle'))
  await flushPromises()
  assertEqual(harness.parentPrompts.length, 1)
  assertEqual(harness.coordinator.states().length, 0)
}

async function verifyRejectedSummaryIsRetried(Coordinator) {
  let parentAttempts = 0
  let harness
  harness = createHarness(Coordinator, {
    parentSend: () => {
      parentAttempts += 1
      if (parentAttempts !== 1) return true
      harness.parent.lastError = 'fixture parent recovery gate'
      harness.parent.status = 'error'
      harness.coordinator.handleEvent(harness.parent.id, status('error', harness.parent.lastError))
      return false
    }
  })
  const [child] = beginWithChildren(harness, 'retry', 1)
  await harness.coordinator.finishProvisioning('retry', [child])
  harness.coordinator.recordChildResult(child.meta, turnResult(false, 'ready to summarize'))
  await flushPromises()
  assertEqual(parentAttempts, 1)
  assertEqual(harness.coordinator.states().length, 1)
  assertEvent(harness.events, 'subagent-summary-delivery-rejected', 'fixture parent recovery gate')

  harness.parent.status = 'idle'
  harness.coordinator.handleEvent(harness.parent.id, status('idle'))
  await flushPromises()
  assertEqual(parentAttempts, 2)
  assertEqual(harness.parentPrompts.length, 2)
  assertEqual(harness.parentPrompts[0], harness.parentPrompts[1])
  assertEqual(harness.coordinator.states().length, 0)
}

async function verifyClosedParentClearsSummary(Coordinator) {
  const harness = createHarness(Coordinator)
  harness.parent.status = 'running'
  const [child] = beginWithChildren(harness, 'closed', 1)
  await harness.coordinator.finishProvisioning('closed', [child])
  harness.coordinator.recordChildResult(child.meta, turnResult(false, 'done'))
  await flushPromises()
  harness.parent.status = 'closed'
  harness.coordinator.handleEvent(harness.parent.id, status('closed'))
  assertEqual(harness.coordinator.states().length, 0)
}

function verifyProductionWiring() {
  const manager = readFileSync(path.join(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const deep = readFileSync(path.join(repoRoot, 'scripts/deep-test.mjs'), 'utf8')
  assertEqual(manager.includes('for (const child of children) this.send(child.meta.id, child.prompt)'), false)
  assertEqual(manager.includes('this.send(state.parentSessionId, lines.join'), false)
  assertIncludes(manager, 'this.subagentOrchestration.finishProvisioning(orchestrationId, children)')
  assertIncludes(manager, 'this.subagentOrchestration.handleEvent(sessionId, event)')
  assertIncludes(packageJson.scripts['test:task-run'], 'subagent-orchestration-reliability-smoke.mjs')
  assertIncludes(deep, 'subagent-orchestration-reliability-smoke.mjs')
}

function createHarness(Coordinator, options = {}) {
  const parent = meta('parent', { status: 'idle' })
  const metas = new Map([[parent.id, parent]])
  const events = []
  const acknowledged = []
  const childPrompts = []
  const parentPrompts = []
  const coordinator = new Coordinator({
    send: (sessionId, prompt) => {
      if (sessionId === parent.id) {
        parentPrompts.push(prompt)
        return options.parentSend?.(prompt) ?? true
      }
      childPrompts.push(prompt)
      return options.childSend?.(sessionId, prompt) ?? true
    },
    getMeta: (sessionId) => metas.get(sessionId),
    emit: (sessionId, event) => events.push({ sessionId, event }),
    acknowledgeSessionCreation: (sessionId) => acknowledged.push(sessionId),
    now: () => 2_000
  })
  return { coordinator, parent, metas, events, acknowledged, childPrompts, parentPrompts }
}

function beginWithChildren(harness, orchestrationId, count) {
  harness.coordinator.begin(orchestrationId, harness.parent.id)
  const children = []
  for (let index = 1; index <= count; index += 1) {
    const id = `${orchestrationId}-child-${index}`
    const childMeta = meta(id, {
      parentSessionId: harness.parent.id,
      orchestrationId,
      childTaskId: `task-${index}`,
      childRole: index === 1 ? 'backend' : 'frontend'
    })
    harness.metas.set(id, childMeta)
    children.push({ taskId: `task-${index}`, prompt: `prompt ${index}`, meta: childMeta })
    harness.coordinator.addChild(orchestrationId, id)
  }
  return children
}

function meta(id, overrides = {}) {
  return {
    id,
    cwd: '/tmp/project',
    model: 'test-model',
    providerId: 'test-provider',
    permissionMode: 'default',
    status: 'idle',
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    contextTokens: 0,
    createdAt: 1_000,
    ...overrides
  }
}

function turnResult(isError, resultText) {
  return { kind: 'turn-result', subtype: isError ? 'error' : 'success', isError, resultText }
}

function status(value, error) {
  return { kind: 'status', status: value, error }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

function assertEvent(events, name, detail) {
  const matched = events.find((entry) => entry.event.kind === 'hook-event' && entry.event.event === name)
  if (!matched) throw new Error(`missing ${name}: ${JSON.stringify(events)}`)
  assertIncludes(matched.event.detail, detail)
}

function assertIncludes(actual, expected) {
  if (!String(actual).includes(expected)) throw new Error(`expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`)
}

function assertEqual(actual, expected) {
  if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
