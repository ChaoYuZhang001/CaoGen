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

  const initialChildren = await scheduler.start()
  assert.equal(initialChildren.length, 2, '第一层应返回两个已启动的子会话')
  assert.deepEqual(
    starts.map((start) => start.taskId).sort(),
    ['backend-auth', 'frontend-auth'],
    '第一层无依赖任务应并行启动'
  )

  const frontendSession = [...sessions.entries()].find(([, taskId]) => taskId === 'frontend-auth')[0]
  await scheduler.completeSession(frontendSession, { ok: true, resultText: 'frontend ok' })
  assert.equal(starts.filter((start) => start.taskId === 'qa-auth-flow').length, 0, 'QA 必须等待全部依赖完成')

  const backendSession1 = [...sessions.entries()].find(([, taskId]) => taskId === 'backend-auth')[0]
  await scheduler.completeSession(backendSession1, { ok: false, error: 'first failure' })
  assert.equal(starts.filter((start) => start.taskId === 'backend-auth').length, 2, '失败后应自动重试')

  const backendSession2 = [...sessions.entries()].filter(([, taskId]) => taskId === 'backend-auth')[1][0]
  await scheduler.completeSession(backendSession2, { ok: false, error: 'second failure' })
  const backendSession3 = [...sessions.entries()].filter(([, taskId]) => taskId === 'backend-auth')[2][0]
  await scheduler.completeSession(backendSession3, { ok: false, error: 'third failure' })

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
  await scheduler.completeSession(qaSession, { ok: true, resultText: 'qa saw upstream failure' })
  const final = updates[updates.length - 1]
  assert.equal(final.status, 'failed', '存在失败任务时 DAG 状态应为 failed')
  assert.match(final.summary, /2\/3 成功/, '最终摘要应统计成功数量')
  await assertSchedulerEdgeCases(result.dag)

  console.log('task-dag smoke: PASS')
}

async function assertSchedulerEdgeCases(dag) {
  await assertTaskTimeoutRetries(dag)
  await assertAsyncReadyTaskCreation(dag)
  await assertReadyBatchWatchdogStartsAfterPrompt(dag)
  await assertPromptStartRejectionBlocks(dag)
  await assertRunTaskErrorRetryPolicy(dag)
  await assertProvisioningBlockRetainsRunningSibling(dag)
  await assertRuntimeSnapshotRestore()
}

async function assertReadyBatchWatchdogStartsAfterPrompt(dag) {
  const readyDag = {
    ...dag,
    id: 'dag-ready-batch-watchdog',
    tasks: dag.tasks.slice(0, 2).map((task) => ({ ...task, dependencies: [] }))
  }
  const starts = []
  const timeouts = []
  const scheduler = new TaskDagScheduler(
    'parent-ready-batch-watchdog',
    { dag: readyDag, isolated: true, maxRetries: 0, taskTimeoutMs: 100 },
    {
      async runTask(task) {
        if (task.id === readyDag.tasks[1].id) await new Promise((resolve) => setTimeout(resolve, 180))
        const sessionId = `watchdog-${task.id}`
        return {
          sessionId,
          dispatchItem: makeDispatchItem(sessionId, task, task.prompt),
          start() { starts.push(task.id) }
        }
      },
      onUpdate() {},
      onTaskTimeout(_sessionId, taskId) { timeouts.push(taskId) }
    }
  )
  await scheduler.start()
  assert.deepEqual(timeouts, [], 'provisioning latency must not consume the prompt execution timeout')
  assert.deepEqual(starts, readyDag.tasks.map((task) => task.id))
  for (const task of readyDag.tasks) {
    await scheduler.completeSession(`watchdog-${task.id}`, { ok: true, resultText: 'done' })
  }
}

async function assertPromptStartRejectionBlocks(dag) {
  const task = { ...dag.tasks[0], id: 'prompt-rejected', dependencies: [] }
  let completions = 0
  const scheduler = new TaskDagScheduler(
    'parent-prompt-rejected',
    { dag: { ...dag, id: 'dag-prompt-rejected', tasks: [task] }, maxRetries: 2, taskTimeoutMs: 0 },
    {
      runTask() {
        const sessionId = 'prompt-rejected-session'
        return {
          sessionId,
          dispatchItem: makeDispatchItem(sessionId, task, task.prompt),
          start() { throw new Error('budget gate rejected prompt') }
        }
      },
      onUpdate() {},
      onComplete() { completions += 1 }
    }
  )
  await scheduler.start()
  const view = scheduler.view()
  assert.equal(view.status, 'failed')
  assert.match(view.tasks[0].error, /budget gate rejected prompt/)
  assert.equal(view.tasks[0].attempts, 1, 'rejected prompt must not create a retry worktree')
  assert.equal(completions, 1)
}

async function assertAsyncReadyTaskCreation(dag) {
  const readyDag = {
    ...dag,
    id: 'dag-async-create-smoke',
    tasks: dag.tasks.slice(0, 2).map((task) => ({ ...task, dependencies: [] }))
  }
  const lifecycle = []
  const sessionIds = []
  const scheduler = new TaskDagScheduler(
    'parent-async-create',
    { dag: readyDag, isolated: true, maxRetries: 0, taskTimeoutMs: 0 },
    {
      async runTask(task) {
        lifecycle.push(`create:start:${task.id}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        const sessionId = `async-${task.id}`
        lifecycle.push(`create:confirmed:${task.id}`)
        sessionIds.push(sessionId)
        return {
          sessionId,
          dispatchItem: makeDispatchItem(sessionId, task, task.prompt),
          start() {
            lifecycle.push(`execute:start:${task.id}`)
          }
        }
      },
      onUpdate() {}
    }
  )

  const launched = await scheduler.start()
  assert.equal(launched.length, 2, 'all ready children should be returned after durable creation')
  assert.deepEqual(
    lifecycle,
    [
      `create:start:${readyDag.tasks[0].id}`,
      `create:confirmed:${readyDag.tasks[0].id}`,
      `create:start:${readyDag.tasks[1].id}`,
      `create:confirmed:${readyDag.tasks[1].id}`,
      `execute:start:${readyDag.tasks[0].id}`,
      `execute:start:${readyDag.tasks[1].id}`
    ],
    'the full ready batch must cross durable creation barriers before any child prompt starts'
  )
  assert.equal(
    scheduler.view().tasks.filter((task) => task.status === 'running').length,
    2,
    'confirmed children should execute concurrently after sequential creation barriers'
  )
  for (const sessionId of sessionIds) {
    await scheduler.completeSession(sessionId, { ok: true, resultText: 'done' })
  }

  const blockedLifecycle = []
  let provisioningCalls = 0
  const blockedScheduler = new TaskDagScheduler(
    'parent-ready-batch-block',
    { dag: { ...readyDag, id: 'dag-ready-batch-block' }, isolated: true, maxRetries: 0, taskTimeoutMs: 0 },
    {
      async runTask(task) {
        provisioningCalls += 1
        if (provisioningCalls === 2) {
          throw Object.assign(new Error('second create outcome is unknown'), {
            nonRetryable: true,
            requiresReconciliation: true
          })
        }
        const sessionId = `frozen-${task.id}`
        return {
          sessionId,
          dispatchItem: makeDispatchItem(sessionId, task, task.prompt),
          start() {
            blockedLifecycle.push(`execute:start:${task.id}`)
          }
        }
      },
      onUpdate() {}
    }
  )
  await blockedScheduler.start()
  assert.deepEqual(blockedLifecycle, [], 'no sibling prompt may start before the whole ready batch is provisioned')
  assert.equal(blockedScheduler.view().status, 'failed')
  assert.equal(
    blockedScheduler.view().tasks.find((task) => task.task.id === readyDag.tasks[0].id).status,
    'failed',
    'already provisioned sibling must be frozen when a later create is unknown'
  )
  assert.match(blockedScheduler.view().error, /No prompt was sent to earlier sessions/)
}

async function assertRunTaskErrorRetryPolicy(dag) {
  const oneTaskDag = {
    ...dag,
    id: 'dag-run-task-error-policy',
    tasks: [{ ...dag.tasks[0], id: 'create-child', dependencies: [] }]
  }
  let transientCalls = 0
  const transientScheduler = new TaskDagScheduler(
    'parent-transient-create',
    { dag: oneTaskDag, isolated: true, maxRetries: 2, taskTimeoutMs: 0 },
    {
      async runTask(task) {
        transientCalls += 1
        if (transientCalls === 1) throw new Error('transient provisioning failure')
        const sessionId = 'transient-create-retry'
        return { sessionId, dispatchItem: makeDispatchItem(sessionId, task, task.prompt) }
      },
      onUpdate() {}
    }
  )
  await transientScheduler.start()
  assert.equal(transientCalls, 2, 'ordinary provisioning failures should retain configured retries')

  let reconciliationCalls = 0
  const dependentTask = {
    ...dag.tasks[0],
    id: 'must-not-run-after-unknown-create',
    dependencies: ['create-child']
  }
  const reconciliationScheduler = new TaskDagScheduler(
    'parent-reconciliation-create',
    {
      dag: {
        ...oneTaskDag,
        id: 'dag-reconciliation-create',
        tasks: [...oneTaskDag.tasks, dependentTask]
      },
      isolated: true,
      maxRetries: 3,
      taskTimeoutMs: 0
    },
    {
      async runTask(task) {
        assert.equal(task.id, 'create-child', 'unknown create must block every dependent task')
        reconciliationCalls += 1
        throw Object.assign(new Error('unknown create [requires reconciliation: operation:create-unknown]'), {
          nonRetryable: true,
          requiresReconciliation: true,
          snapshotId: 'operation:create-unknown'
        })
      },
      onUpdate() {}
    }
  )
  await reconciliationScheduler.start()
  const failed = reconciliationScheduler.view().tasks[0]
  assert.equal(reconciliationCalls, 1, 'unknown lifecycle effects must never provision a second worktree')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempts, 1)
  assert.match(failed.error, /operation:create-unknown/, 'DAG failure must preserve the recovery snapshot reference')
  const dependent = reconciliationScheduler.view().tasks.find(
    (task) => task.task.id === 'must-not-run-after-unknown-create'
  )
  assert.equal(dependent.status, 'waiting', 'unknown lifecycle state must not release downstream dependencies')
  assert.match(reconciliationScheduler.view().error, /Automatic downstream scheduling is disabled/)
}

async function assertProvisioningBlockRetainsRunningSibling(dag) {
  const template = dag.tasks[0]
  const blockedDag = {
    ...dag,
    id: 'dag-running-sibling-block',
    tasks: [
      { ...template, id: 'long-running', dependencies: [], prompt: 'long running' },
      { ...template, id: 'unlock-blocked-task', dependencies: [], prompt: 'unlock' },
      { ...template, id: 'unknown-create', dependencies: ['unlock-blocked-task'], prompt: 'unknown create' },
      { ...template, id: 'must-remain-waiting', dependencies: ['unknown-create'], prompt: 'must not run' }
    ]
  }
  const runCalls = []
  const starts = []
  const completions = []
  const scheduler = new TaskDagScheduler(
    'parent-running-sibling-block',
    { dag: blockedDag, isolated: true, maxRetries: 2, taskTimeoutMs: 0 },
    {
      async runTask(task) {
        runCalls.push(task.id)
        if (task.id === 'unknown-create') {
          throw Object.assign(new Error('unknown managed create'), {
            nonRetryable: true,
            requiresReconciliation: true
          })
        }
        const sessionId = `session-${task.id}`
        return {
          sessionId,
          dispatchItem: makeDispatchItem(sessionId, task, task.prompt),
          start() {
            starts.push(task.id)
          }
        }
      },
      onUpdate() {},
      onComplete(execution) {
        completions.push(execution)
      }
    }
  )

  await scheduler.start()
  assert.deepEqual(starts.sort(), ['long-running', 'unlock-blocked-task'])
  await scheduler.completeSession('session-unlock-blocked-task', { ok: true, resultText: 'unlock done' })

  const blocked = scheduler.view()
  assert.equal(blocked.status, 'failed', 'unknown provisioning must block the DAG globally')
  assert.equal(blocked.completedAt, undefined, 'block must remain nonterminal while a sibling is still running')
  assert.equal(
    blocked.tasks.find((task) => task.task.id === 'long-running').status,
    'running',
    'already-running sibling must remain tracked after provisioning blocks'
  )
  assert.equal(blocked.tasks.find((task) => task.task.id === 'unknown-create').attempts, 1)
  assert.equal(blocked.tasks.find((task) => task.task.id === 'must-remain-waiting').status, 'waiting')
  assert.deepEqual(runCalls, ['long-running', 'unlock-blocked-task', 'unknown-create'])
  assert.equal(completions.length, 0, 'blocked DAG must wait for already-running siblings before completion')

  const restoredCompletions = []
  const restored = TaskDagScheduler.fromRuntimeSnapshot(
    scheduler.runtimeSnapshot(),
    blocked,
    {
      runTask() { throw new Error('recovery block must not launch new work') },
      onUpdate() {},
      onComplete(view) { restoredCompletions.push(view) }
    },
    new Set(['session-long-running'])
  )
  await restored.resume()
  assert.equal(restored.view().status, 'failed', 'persisted recovery block must survive scheduler restore')
  assert.equal(restored.view().completedAt, undefined)
  assert.equal(restored.view().tasks.find((task) => task.task.id === 'long-running').status, 'running')
  await restored.completeSession('session-long-running', { ok: true, resultText: 'restored sibling retained' })
  assert.equal(restored.view().tasks.find((task) => task.task.id === 'must-remain-waiting').status, 'waiting')
  assert.equal(restoredCompletions.length, 1, 'restored recovery block must complete exactly once')

  await scheduler.completeSession('session-long-running', { ok: true, resultText: 'long result retained' })
  const settled = scheduler.view()
  const retained = settled.tasks.find((task) => task.task.id === 'long-running')
  assert.equal(retained.status, 'success', 'running sibling completion must survive the global block')
  assert.equal(retained.resultText, 'long result retained')
  assert.equal(settled.status, 'failed')
  assert.equal(typeof settled.completedAt, 'number', 'blocked DAG becomes terminal only after running siblings settle')
  assert.equal(settled.tasks.find((task) => task.task.id === 'must-remain-waiting').status, 'waiting')
  assert.deepEqual(runCalls, ['long-running', 'unlock-blocked-task', 'unknown-create'])
  assert.equal(completions.length, 1, 'blocked DAG must notify completion exactly once after siblings settle')
  assert.equal(completions[0].tasks.find((task) => task.task.id === 'long-running').resultText, 'long result retained')
  await scheduler.resume()
  assert.equal(completions.length, 1, 'resuming a terminal blocked DAG must not repeat completion')
}

async function assertRuntimeSnapshotRestore() {
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
  await scheduler.start()
  assert.equal(starts.length, 1, 'restore smoke should launch the root task')
  await scheduler.completeSession(starts[0].sessionId, { ok: true, resultText: 'prepare ok' })
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
  assert.equal((await activeRestored.resume()).length, 0, 'active running child should not be relaunched')
  await activeRestored.completeSession(runningVerify.sessionId, { ok: true, resultText: 'verify ok' })
  assert.equal(activeUpdates[activeUpdates.length - 1].status, 'success', 'active restored DAG should finish')
  assert.equal(activeStarts.length, 0, 'active restored DAG must not duplicate running work')

  const missingStarts = []
  const missingUpdates = []
  const missingCompletions = []
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
      },
      onComplete(executionView) {
        missingCompletions.push(executionView)
      }
    },
    new Set()
  )
  assert.equal(missingCompletions.length, 0, 'runtime construction must not fire completion callbacks')
  const relaunched = await missingRestored.resume()
  assert.equal(relaunched.length, 0, 'missing running child must not create a replacement session')
  assert.equal(missingStarts.length, 0, 'missing running child must preserve the original worktree evidence')
  const blocked = missingUpdates[missingUpdates.length - 1]
  assert.equal(blocked.status, 'failed', 'missing-child recovery must fail closed')
  assert.match(blocked.error, /DAG recovery blocked/, 'blocked recovery must expose an actionable error')
  const blockedVerify = blocked.tasks.find((task) => task.task.id === 'verify')
  assert.equal(blockedVerify.status, 'failed')
  assert.deepEqual(blockedVerify.sessionIds, [runningVerify.sessionId], 'blocked recovery must retain the frozen session id')
  assert.match(blockedVerify.error, /snapshot and worktree evidence/, 'blocked task must explain why replacement is unsafe')
  assert.equal(missingCompletions.length, 1, 'resume must publish one blocked completion after recovery construction')
  await missingRestored.resume()
  assert.equal(missingCompletions.length, 1, 'blocked recovery completion must be emitted exactly once')
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
  await timeoutScheduler.start()
  assert.equal(timeoutStarts.length, 1, 'timeout smoke should start first attempt')
  const staleSession = timeoutStarts[0].sessionId
  await new Promise((resolve) => setTimeout(resolve, 180))
  assert.equal(timeoutEvents.length, 1, 'timeout should emit one timeout callback')
  assert.equal(timeoutStarts.length, 2, 'timeout should retry the task once')
  assert.match(timeoutEvents[0].error, /超时/, 'timeout error should explain timeout')
  await timeoutScheduler.completeSession(staleSession, { ok: true, resultText: 'stale success' })
  const runningAfterStale = timeoutUpdates[timeoutUpdates.length - 1].tasks[0]
  assert.equal(runningAfterStale.status, 'running', 'stale completion must not override current retry')
  await timeoutScheduler.completeSession(timeoutStarts[1].sessionId, { ok: true, resultText: 'retry success' })
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
