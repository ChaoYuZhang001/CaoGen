const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-task-dag-smoke-'))
esbuild.buildSync({
  entryPoints: [
    path.resolve(__dirname, '../src/main/agent/task-decomposer.ts'),
    path.resolve(__dirname, '../src/main/agent/dag-scheduler.ts')
  ],
  outdir: tempDir,
  bundle: false,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent'
})

const { decomposeTask } = require(path.join(tempDir, 'task-decomposer.js'))
const { TaskDagScheduler, validateTaskDag } = require(path.join(tempDir, 'dag-scheduler.js'))

function makeDispatchItem(sessionId, task, prompt) {
  return {
    taskId: task.id,
    prompt,
    meta: {
      id: sessionId,
      title: task.title,
      cwd: process.cwd(),
      model: '',
      providerId: '',
      permissionMode: 'default',
      status: 'running',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: Date.now(),
      parentSessionId: 'parent',
      orchestrationId: 'dag-smoke',
      childTaskId: task.id,
      childRole: task.role,
      isolated: false
    }
  }
}

async function run() {
  const result = await decomposeTask({
    request: '实现完整登录功能，含前端 / 后端 / 测试'
  })
  assert.equal(result.dag.tasks.length, 3, '复杂登录需求应拆成 3 个任务')
  assert.equal(result.strategy, 'local-heuristic', '未提供模型客户端时应使用本地启发式')
  assert.deepEqual(
    result.dag.tasks.find((task) => task.id === 'qa-auth-flow').dependencies.sort(),
    ['backend-auth', 'frontend-auth'],
    'QA 任务应依赖前后端任务'
  )
  assert.equal(validateTaskDag(result.dag).ok, true, '拆解结果必须是合法 DAG')

  const modelResult = await decomposeTask(
    { request: '实现完整登录功能，含前端 / 后端 / 测试' },
    {
      modelDecomposer: {
        async decompose() {
          return {
            title: '模型拆解登录能力',
            tasks: [
              {
                id: 'api-login',
                title: '登录 API',
                description: '实现认证接口与会话状态。',
                dependencies: [],
                role: 'backend'
              },
              {
                id: 'ui-login',
                title: '登录 UI',
                description: '实现登录表单和错误态。',
                dependencies: [],
                role: 'frontend'
              },
              {
                id: 'qa-login',
                title: '登录验证',
                description: '补充登录全链路验证。',
                dependencies: ['api-login', 'ui-login'],
                role: 'qa'
              }
            ]
          }
        }
      }
    }
  )
  assert.equal(modelResult.strategy, 'model', '复杂任务有模型客户端时应优先走模型拆解')
  assert.equal(modelResult.dag.tasks.find((task) => task.id === 'qa-login').dependencies.length, 2)

  const modelDisabledResult = await decomposeTask(
    { request: '实现完整登录功能，含前端 / 后端 / 测试', useModel: false },
    {
      modelDecomposer: {
        async decompose() {
          throw new Error('model should not be called when useModel=false')
        }
      }
    }
  )
  assert.equal(modelDisabledResult.strategy, 'local-heuristic', '关闭模型拆解时应固定使用本地启发式')

  const fallbackResult = await decomposeTask(
    { request: '实现完整登录功能，含前端 / 后端 / 测试' },
    {
      modelDecomposer: {
        async decompose() {
          throw new Error('model unavailable')
        }
      }
    }
  )
  assert.equal(fallbackResult.strategy, 'local-heuristic', '模型失败时应回退本地启发式')
  assert.match(fallbackResult.warnings.join('\n'), /model unavailable/, '回退结果应保留模型失败原因')

  const updates = []
  const starts = []
  const sessions = new Map()
  let seq = 0
  const scheduler = new TaskDagScheduler(
    'parent',
    { dag: result.dag, isolated: false, maxRetries: 2 },
    {
      runTask(task, context) {
        const sessionId = `${task.id}-${context.attempt}-${++seq}`
        starts.push({
          taskId: task.id,
          attempt: context.attempt,
          deps: context.dependencyResults.map((dep) => ({
            taskId: dep.taskId,
            status: dep.status,
            resultText: dep.resultText,
            error: dep.error
          }))
        })
        sessions.set(sessionId, task.id)
        return { sessionId, dispatchItem: makeDispatchItem(sessionId, task, task.prompt) }
      },
      onUpdate(execution) {
        updates.push(execution)
      }
    }
  )

  const initialChildren = scheduler.start()
  assert.equal(initialChildren.length, 2, '第一层应返回两个已启动的子会话')
  assert.deepEqual(
    starts.map((start) => start.taskId).sort(),
    ['backend-auth', 'frontend-auth'],
    '第一层无依赖任务应并行启动'
  )

  const frontendSession = [...sessions.entries()].find(([, taskId]) => taskId === 'frontend-auth')[0]
  scheduler.completeSession(frontendSession, { ok: true, resultText: 'frontend ok' })
  assert.equal(starts.filter((start) => start.taskId === 'qa-auth-flow').length, 0, 'QA 必须等待全部依赖完成')

  const backendSession1 = [...sessions.entries()].find(([, taskId]) => taskId === 'backend-auth')[0]
  scheduler.completeSession(backendSession1, { ok: false, error: 'first failure' })
  assert.equal(starts.filter((start) => start.taskId === 'backend-auth').length, 2, '失败后应自动重试')

  const backendSession2 = [...sessions.entries()].filter(([, taskId]) => taskId === 'backend-auth')[1][0]
  scheduler.completeSession(backendSession2, { ok: false, error: 'second failure' })
  const backendSession3 = [...sessions.entries()].filter(([, taskId]) => taskId === 'backend-auth')[2][0]
  scheduler.completeSession(backendSession3, { ok: false, error: 'third failure' })

  const qaStart = starts.find((start) => start.taskId === 'qa-auth-flow')
  assert.ok(qaStart, '依赖失败到达终态后 QA 仍应启动,由主 Agent 接管风险')
  assert.deepEqual(
    qaStart.deps.map((dep) => dep.taskId).sort(),
    ['backend-auth', 'frontend-auth'],
    '下游任务应收到上游结果上下文'
  )
  assert.ok(
    qaStart.deps.some(
      (dep) => dep.taskId === 'backend-auth' && dep.status === 'failed' && dep.error === 'third failure'
    ),
    '下游任务应收到失败依赖的错误摘要'
  )
  assert.ok(
    qaStart.deps.some(
      (dep) => dep.taskId === 'frontend-auth' && dep.status === 'success' && dep.resultText === 'frontend ok'
    ),
    '下游任务应收到成功依赖的结果摘要'
  )

  const qaSession = [...sessions.entries()].find(([, taskId]) => taskId === 'qa-auth-flow')[0]
  scheduler.completeSession(qaSession, { ok: true, resultText: 'qa saw upstream failure' })
  const final = updates[updates.length - 1]
  assert.equal(final.status, 'failed', '存在失败任务时 DAG 状态应为 failed')
  assert.match(final.summary, /2\/3 成功/, '最终摘要应统计成功数量')

  await assertTaskTimeoutRetries(result.dag)
  assertRuntimeSnapshotRestore()

  console.log('task-dag smoke: PASS')
}

function assertRuntimeSnapshotRestore() {
  const restoreDag = {
    id: 'dag-restore-smoke',
    title: 'Runtime restore',
    source: 'smoke',
    complexity: 'multi',
    createdAt: Date.now(),
    tasks: [
      {
        id: 'prepare',
        title: 'Prepare',
        description: 'Prepare dependency data',
        dependencies: [],
        role: 'backend',
        prompt: 'prepare'
      },
      {
        id: 'verify',
        title: 'Verify',
        description: 'Verify after prepare',
        dependencies: ['prepare'],
        role: 'qa',
        prompt: 'verify'
      }
    ]
  }
  const starts = []
  const updates = []
  let completed
  let restoreSeq = 0
  const callbacks = {
    runTask(task, context) {
      const sessionId = `${task.id}-${context.attempt}-${++restoreSeq}`
      starts.push({ taskId: task.id, attempt: context.attempt, sessionId, deps: context.dependencyResults })
      return { sessionId, dispatchItem: makeDispatchItem(sessionId, task, task.prompt) }
    },
    onUpdate(execution) {
      updates.push(execution)
    },
    onComplete(execution) {
      completed = execution
    }
  }
  const scheduler = new TaskDagScheduler(
    'parent-restore',
    { dag: restoreDag, isolated: false, maxRetries: 1, taskTimeoutMs: 0 },
    callbacks
  )
  scheduler.start()
  assert.equal(starts.length, 1, 'restore smoke should launch the root task')
  scheduler.completeSession(starts[0].sessionId, { ok: true, resultText: 'prepare ok' })
  const runningVerify = starts.find((start) => start.taskId === 'verify')
  assert.ok(runningVerify, 'restore smoke should launch dependent task before snapshot')

  const runtime = scheduler.runtimeSnapshot({ autoMerge: { enabled: true, verificationCommand: 'echo ok' } })
  const execution = scheduler.view()
  assert.deepEqual(runtime.runningTasks, [{ taskId: 'verify', sessionId: runningVerify.sessionId }])
  assert.equal(runtime.autoMerge.enabled, true)

  const activeStarts = []
  const activeUpdates = []
  const activeRestored = TaskDagScheduler.fromRuntimeSnapshot(
    runtime,
    execution,
    {
      runTask(task, context) {
        const sessionId = `active-${task.id}-${context.attempt}-${activeStarts.length + 1}`
        activeStarts.push({ taskId: task.id, attempt: context.attempt, sessionId })
        return { sessionId, dispatchItem: makeDispatchItem(sessionId, task, task.prompt) }
      },
      onUpdate(executionView) {
        activeUpdates.push(executionView)
      }
    },
    new Set([runningVerify.sessionId])
  )
  assert.equal(activeRestored.resume().length, 0, 'active running child should not be relaunched')
  activeRestored.completeSession(runningVerify.sessionId, { ok: true, resultText: 'verify ok' })
  assert.equal(activeUpdates[activeUpdates.length - 1].status, 'success', 'active restored DAG should finish')
  assert.equal(activeStarts.length, 0, 'active restored DAG must not duplicate running work')

  const missingStarts = []
  const missingUpdates = []
  const missingRestored = TaskDagScheduler.fromRuntimeSnapshot(
    runtime,
    execution,
    {
      runTask(task, context) {
        const sessionId = `missing-${task.id}-${context.attempt}-${missingStarts.length + 1}`
        missingStarts.push({ taskId: task.id, attempt: context.attempt, sessionId, deps: context.dependencyResults })
        return { sessionId, dispatchItem: makeDispatchItem(sessionId, task, task.prompt) }
      },
      onUpdate(executionView) {
        missingUpdates.push(executionView)
      }
    },
    new Set()
  )
  const relaunched = missingRestored.resume()
  assert.equal(relaunched.length, 1, 'missing running child should be relaunched after recovery')
  assert.equal(missingStarts[0].taskId, 'verify')
  assert.equal(missingStarts[0].attempt, 2, 'fresh recovery attempt should advance attempt count')
  assert.equal(missingStarts[0].deps[0].resultText, 'prepare ok')
  missingRestored.completeSession(missingStarts[0].sessionId, { ok: true, resultText: 'verify recovered ok' })
  assert.equal(missingUpdates[missingUpdates.length - 1].status, 'success', 'missing-child recovery should finish')
  assert.equal(completed, undefined, 'original scheduler should remain unfinished in this smoke')
}

async function assertTaskTimeoutRetries(dag) {
  const oneTaskDag = {
    ...dag,
    id: 'dag-timeout-smoke',
    tasks: [
      {
        id: 'timeout-task',
        title: 'Timeout task',
        description: 'Task that times out once',
        dependencies: [],
        role: 'backend',
        prompt: 'timeout once'
      }
    ]
  }
  const timeoutStarts = []
  const timeoutUpdates = []
  const timeoutEvents = []
  let timeoutSeq = 0
  const timeoutScheduler = new TaskDagScheduler(
    'parent-timeout',
    { dag: oneTaskDag, isolated: false, maxRetries: 1, taskTimeoutMs: 30 },
    {
      runTask(task, context) {
        const sessionId = `${task.id}-${context.attempt}-${++timeoutSeq}`
        timeoutStarts.push({ taskId: task.id, attempt: context.attempt, sessionId })
        return { sessionId, dispatchItem: makeDispatchItem(sessionId, task, task.prompt) }
      },
      onUpdate(execution) {
        timeoutUpdates.push(execution)
      },
      onTaskTimeout(sessionId, taskId, error) {
        timeoutEvents.push({ sessionId, taskId, error })
      }
    }
  )
  timeoutScheduler.start()
  assert.equal(timeoutStarts.length, 1, 'timeout smoke should start first attempt')
  const staleSession = timeoutStarts[0].sessionId
  await new Promise((resolve) => setTimeout(resolve, 180))
  assert.equal(timeoutEvents.length, 1, 'timeout should emit one timeout callback')
  assert.equal(timeoutStarts.length, 2, 'timeout should retry the task once')
  assert.match(timeoutEvents[0].error, /超时/, 'timeout error should explain timeout')
  timeoutScheduler.completeSession(staleSession, { ok: true, resultText: 'stale success' })
  const runningAfterStale = timeoutUpdates[timeoutUpdates.length - 1].tasks[0]
  assert.equal(runningAfterStale.status, 'running', 'stale completion must not override current retry')
  timeoutScheduler.completeSession(timeoutStarts[1].sessionId, { ok: true, resultText: 'retry success' })
  const timeoutFinal = timeoutUpdates[timeoutUpdates.length - 1]
  assert.equal(timeoutFinal.status, 'success', 'retry success should complete DAG')
  assert.equal(timeoutFinal.tasks[0].resultText, 'retry success')
}

run()
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
