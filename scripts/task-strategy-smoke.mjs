#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const outDir = mkdtempSync(path.join(tmpdir(), 'caogen-task-strategy-'))

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/task-strategy.ts',
      '--outDir', outDir,
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const strategy = await import(pathToFileURL(path.join(outDir, 'main', 'task', 'task-strategy.js')).href)

  assert.equal(strategy.normalizeTaskStrategy(undefined), 'execute')
  assert.equal(strategy.normalizeTaskStrategy('legacy-value'), 'execute')
  for (const value of ['view', 'plan', 'execute']) assert.equal(strategy.requireTaskStrategy(value), value)
  assert.throws(() => strategy.requireTaskStrategy('bypassPermissions'), /view、plan 或 execute/)

  allow(strategy, 'view', 'read_file')
  allow(strategy, 'view', 'git_diff')
  deny(strategy, 'view', 'bash')
  deny(strategy, 'view', 'write_file')
  deny(strategy, 'view', 'task_decompose')
  deny(strategy, 'view', 'mcp_call_tool')

  allow(strategy, 'plan', 'read_file')
  allow(strategy, 'plan', 'task_decompose')
  allow(strategy, 'plan', 'genesis_orchestrate')
  allow(strategy, 'plan', 'search_replace', { dry_run: true })
  deny(strategy, 'plan', 'search_replace', { dry_run: false })
  deny(strategy, 'plan', 'task_dispatch_dag')
  deny(strategy, 'plan', 'china_notify')
  deny(strategy, 'plan', 'bash')

  for (const tool of ['bash', 'write_file', 'task_dispatch_dag', 'mcp_call_tool']) {
    allow(strategy, 'execute', tool)
  }
  assert.match(strategy.taskStrategySystemPrompt('view'), /不得修改文件/)
  assert.match(strategy.taskStrategySystemPrompt('plan'), /用户批准/)
  assert.match(strategy.taskStrategySystemPrompt('execute'), /Effect/)

  verifyProductionWiring()
  console.log('task strategy smoke: PASS')
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

function allow(strategy, mode, tool, input = {}) {
  assert.equal(strategy.decideTaskStrategyTool(mode, tool, input).allow, true, `${mode} should allow ${tool}`)
}

function deny(strategy, mode, tool, input = {}) {
  const decision = strategy.decideTaskStrategyTool(mode, tool, input)
  assert.equal(decision.allow, false, `${mode} should deny ${tool}`)
  assert.ok(decision.message, `${mode}/${tool} denial must explain the contract`)
}

function verifyProductionWiring() {
  const nativeRuntime = source('src/main/native-tool-runtime.ts')
  const openai = source('src/main/openaiEngine.ts')
  const anthropic = source('src/main/anthropicEngine.ts')
  const manager = source('src/main/sessionManager.ts')
  const coordinator = source('src/main/task/task-plan-session-coordinator.ts')
  const lifecycle = source('src/main/session-create-lifecycle.ts')
  const history = source('src/main/history.ts')
  const audit = source('src/main/permission/audit-log.ts')
  const ipc = source('src/main/ipc.ts')
  const taskPlanIpc = source('src/main/ipc/task-plan-handlers.ts')
  const preload = source('src/preload/task-plan.ts')
  const welcome = source('src/renderer/src/components/WelcomeView.tsx')
  const chat = source('src/renderer/src/components/ChatView.tsx')
  const chatStrategy = source('src/renderer/src/components/experience/ChatTaskStrategyControl.tsx')
  const control = source('src/renderer/src/components/experience/TaskStrategyControl.tsx')

  assertBefore(nativeRuntime, 'const preflight = this.preflightToolGate', 'const mode = this.meta.permissionMode')
  assert.match(nativeRuntime, /const strategyDecision = decideTaskStrategyTool\(this\.meta\.taskStrategy/)
  assert.match(openai, /new NativeToolRuntime\(this\.meta/)
  assert.match(openai, /this\.nativeToolRuntime\.executeToolWithPermission\(/)
  assert.match(anthropic, /new NativeToolRuntime\(this\.meta/)
  assert.match(anthropic, /this\.nativeToolRuntime\.executeToolWithPermission\(/)
  assert.match(openai, /taskStrategySystemPrompt\(this\.meta\.taskStrategy\)/)
  assert.match(anthropic, /system: taskStrategySystemAppend\(this\.meta\.taskStrategy, projectContext\)/)
  assert.match(manager, /taskPlans\.assertExecution\(parent\.meta, '派发子 Agent'\)/)
  assert.match(manager, /requirePlanningTaskStrategy\(parent\.meta, '拆解任务 DAG'\)/)
  assert.match(manager, /taskPlans\.assertExecution\(parent\.meta, '执行任务 DAG'\)/)
  assert.match(manager, /taskPlans\.assertExecution\(parent\.meta, '继续执行任务 DAG'\)/)
  assert.match(coordinator, /requireExecuteTaskStrategy\(meta, action\)/)
  assert.match(coordinator, /store\.assertExecutionAuthorized\(meta\.id, false\)/)
  assert.match(lifecycle, /history\?\.taskStrategy \?\? opts\.taskStrategy \?\? parentMeta\?\.taskStrategy/)
  assert.match(history, /taskStrategy: normalizeTaskStrategy\(entry\.taskStrategy\)/)
  assert.match(audit, /privateSessionAuditRoot\(sessionAuditUserDataRoot\(\)\)/)
  assert.match(audit, /join\(canonicalRoot, 'task-audit'\)/)
  assert.match(ipc, /sessionMeta\?\.taskStrategy === 'execute'/)
  assert.match(taskPlanIpc, /handleTaskPlanIpc/)
  assert.match(taskPlanIpc, /action === 'strategy'/)
  assert.match(preload, /invoke\('strategy', sessionId, strategy\)/)
  assert.match(welcome, /<TaskStrategyControl/)
  assert.match(chat, /<ChatTaskStrategyControl value=\{meta\.taskStrategy\}/)
  assert.match(chatStrategy, /setTaskStrategy\(strategy\)/)
  assert.match(control, /aria-pressed=\{value === strategy\}/)
  assert.match(control, /data-task-strategy=\{value\}/)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function assertBefore(text, first, second) {
  const firstIndex = text.indexOf(first)
  const secondIndex = text.indexOf(second, firstIndex + first.length)
  assert.ok(firstIndex >= 0 && secondIndex > firstIndex, `${first} must precede ${second}`)
}
