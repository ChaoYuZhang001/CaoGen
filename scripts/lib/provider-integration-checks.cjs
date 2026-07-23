function createProviderEnvIsolationCheck({ newSession, eq, assert }) {
  return async function providerEnvIsolationCheck() {
    const inherited = {
      ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN
    }
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-API-Key: host-secret'
    process.env.ANTHROPIC_API_KEY = 'host-api-key'
    process.env.ANTHROPIC_AUTH_TOKEN = 'host-auth-token'
    const cleanSession = newSession('prov-b', 'm-b').s
    const customSession = newSession('prov-custom', 'm-custom').s
    try {
      const cleanEnv = cleanSession.buildEnv()
      eq(cleanEnv.ANTHROPIC_CUSTOM_HEADERS, undefined, '无 Provider 头时必须删除宿主自定义鉴权头')
      eq(cleanEnv.ANTHROPIC_API_KEY, 'k2', 'API key 必须来自所选 Provider Broker')
      eq(cleanEnv.ANTHROPIC_AUTH_TOKEN, 'k2', 'Auth token 必须来自所选 Provider Broker')

      const customEnv = customSession.buildEnv()
      eq(
        customEnv.ANTHROPIC_CUSTOM_HEADERS,
        'X-Gateway-Route: provider-custom\nx-api-key: k5',
        'Provider 自定义头必须只由当前 Provider 配置和 Broker Key 重建'
      )
      assert(!customEnv.ANTHROPIC_CUSTOM_HEADERS.includes('host-secret'), '宿主 Header 不得进入第三方 Provider')
    } finally {
      cleanSession.dispose()
      customSession.dispose()
      for (const [name, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }
}

function createClaudeTurnSuccessCheck(dependencies) {
  return async function claudeTurnSuccessCheck() {
    await withSeededClaudeTurn(dependencies, {
      providerId: 'prov-b',
      model: 'm-b',
      runId: 'claude-itest-success-run',
      text: '你好世界'
    }, async ({ events, meta }) => {
      const kinds = events.map((entry) => entry.event.kind)
      for (const kind of ['init', 'user-message', 'status', 'text-delta', 'assistant-message', 'turn-result']) {
        dependencies.assert(kinds.includes(kind), `缺事件 ${kind}(实际:${kinds.join(',')})`)
      }
      const result = events.find((entry) => entry.event.kind === 'turn-result').event
      dependencies.assert(!result.isError, '本应成功')
      dependencies.assert(Math.abs(meta.costUsd - 0.0123) < 1e-9, `费用未入 meta:${meta.costUsd}`)
      dependencies.eq(meta.status, 'idle', '轮后状态')
    })
  }
}

function createClaudeProviderFailoverCheck(dependencies) {
  return async function claudeProviderFailoverCheck() {
    dependencies.settings.updateSettings({ failoverEnabled: true })
    await withSeededClaudeTurn(dependencies, {
      providerId: 'prov-a',
      model: 'm-a',
      runId: 'claude-itest-rate-limit-run',
      text: '这条会先撞 429'
    }, async ({ events, meta }) => {
      await dependencies.waitFor(
        () => events.some((entry) => entry.event.kind === 'turn-result' && !entry.event.isError),
        5000,
        '等待切换后成功'
      )
      const failover = events.find((entry) => entry.event.kind === 'failover')
      dependencies.assert(failover, '缺 failover 事件')
      dependencies.eq(failover.event.fromProviderId, 'prov-a', '来源厂商')
      dependencies.assert(failover.event.toProviderId !== 'prov-a', '目标厂商不能是自己')
      dependencies.assert(String(failover.event.reason).includes('限流'), `原因分类应为限流:${failover.event.reason}`)
      dependencies.assert(meta.providerId !== 'prov-a', 'meta.providerId 未切换')
      dependencies.eq(events.filter((entry) => entry.event.kind === 'user-message').length, 1, 'user-message 重复')
    }, { waitForResult: false })
  }
}

function createClaudeStreamFailoverCheck(dependencies) {
  return async function claudeStreamFailoverCheck() {
    await withSeededClaudeTurn(dependencies, {
      providerId: 'prov-crash',
      model: 'm-c',
      runId: 'claude-itest-stream-crash-run',
      text: '这条会遇到流崩溃'
    }, async ({ events }) => {
      await dependencies.waitFor(
        () => events.some((entry) => entry.event.kind === 'turn-result' && !entry.event.isError),
        5000,
        '等崩溃切换成功'
      )
      dependencies.assert(events.some((entry) => entry.event.kind === 'failover'), '缺 failover 事件')
    }, { waitForResult: false })
  }
}

function createClaudeInterruptCheck(dependencies) {
  return async function claudeInterruptCheck() {
    await withSeededClaudeTurn(dependencies, {
      providerId: 'prov-slow',
      model: 'm-s',
      runId: 'claude-itest-interrupt-run',
      text: '这条会被中断'
    }, async ({ events, s }) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await s.interrupt()
      await dependencies.waitFor(() => events.some((entry) => entry.event.kind === 'turn-result'), 5000)
      dependencies.assert(!events.some((entry) => entry.event.kind === 'failover'), '中断后不应 failover')
    }, { waitForResult: false })
  }
}

function createClaudeFailoverDisabledCheck(dependencies) {
  return async function claudeFailoverDisabledCheck() {
    dependencies.settings.updateSettings({ failoverEnabled: false })
    try {
      await withSeededClaudeTurn(dependencies, {
        providerId: 'prov-a',
        model: 'm-a',
        runId: 'claude-itest-failover-disabled-run',
        text: '关掉开关后的 429'
      }, async ({ events }) => {
        const result = events.find((entry) => entry.event.kind === 'turn-result').event
        dependencies.assert(result.isError, '应以错误收尾')
        dependencies.assert(!events.some((entry) => entry.event.kind === 'failover'), '关闭后不应 failover')
      })
    } finally {
      dependencies.settings.updateSettings({ failoverEnabled: true })
    }
  }
}

async function withSeededClaudeTurn(dependencies, fixture, check, options = {}) {
  const session = dependencies.newSession(fixture.providerId, fixture.model)
  const cleanupRun = await seedClaudeModelAttemptFixture({
    load: dependencies.load,
    meta: session.meta,
    rootDir: dependencies.rootDir,
    runId: fixture.runId,
    text: fixture.text
  })
  try {
    await session.s.start()
    await dependencies.waitFor(() => session.events.some((entry) => entry.event.kind === 'init'), 3000)
    session.s.send(fixture.text)
    if (options.waitForResult !== false) {
      await dependencies.waitFor(() => session.events.some((entry) => entry.event.kind === 'turn-result'), 3000)
    }
    await check(session)
  } finally {
    await session.s.dispose()
    await cleanupRun()
  }
}

function createFetchModelsHttpCheck({ providers, http, eq, assert }) {
  return async function fetchModelsHttpCheck() {
    const modelRequests = []
    const server = http.createServer(createModelServerHandler(modelRequests))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const base = `http://127.0.0.1:${port}`
    let managedProvider
    try {
      const managedNameCanary = ['x-api-key-sk', 'live', 'diagnostic-canary'].join('_')
      let managedHeaderError = ''
      try {
        providers.createProvider({
          name: 'Rejected managed header mock', baseUrl: base, token: 'good-key',
          models: [], engine: 'openai', credentialHeaderNames: [managedNameCanary]
        })
      } catch (err) {
        managedHeaderError = String(err?.message || err)
      }
      assert(managedHeaderError, 'credential-like managed header name must be rejected')
      assert(!managedHeaderError.includes('diagnostic-canary'), 'managed header rejection must not echo secret canary')

      managedProvider = providers.createProvider({
        name: 'Managed model discovery mock',
        baseUrl: base,
        token: 'good-key',
        models: [],
        engine: 'openai',
        customHeaders: 'X-RapidAPI-Host: 127.0.0.1',
        credentialHeaderNames: ['X-RapidAPI-Key']
      })
      const ids = await providers.fetchModels({ baseUrl: base, providerId: managedProvider.id })
      assert(ids.ok, `fetchModels data 形状失败:${JSON.stringify(ids)}`)
      eq(JSON.stringify(ids.models), JSON.stringify(['model-x', 'model-y']), 'data 形状 + 去重')
      eq(
        modelRequests.find((request) => request.url === '/v1/models')?.rapidApiKey,
        'good-key',
        'saved Provider model discovery 应由 Broker 注入受管凭据头'
      )
      eq(
        modelRequests.find((request) => request.url === '/v1/models')?.rapidApiHost,
        '127.0.0.1',
        'saved Provider model discovery 应携带已审查的路由头'
      )
      const bare = await providers.fetchModels({ baseUrl: `${base}/bare`, token: 'good-key' })
      assert(bare.ok, `fetchModels 裸数组失败:${JSON.stringify(bare)}`)
      eq(JSON.stringify(bare.models), JSON.stringify(['bare-1', 'bare-2']), '裸数组形状')
      const authFail = await providers.fetchModels({ baseUrl: base, token: 'bad-key' })
      assert(!authFail.ok && authFail.error?.kind === 'auth' && authFail.error?.status === 401, `401 未按结构化 auth 报错:${JSON.stringify(authFail)}`)
      eq(JSON.stringify(authFail.models), JSON.stringify([]), '失败时不得返回陈旧模型列表')
    } finally {
      if (managedProvider) providers.deleteProvider(managedProvider.id)
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

function createModelServerHandler(modelRequests) {
  return function modelServerHandler(req, res) {
    modelRequests.push({
      url: req.url,
      rapidApiKey: req.headers['x-rapidapi-key'] || '',
      rapidApiHost: req.headers['x-rapidapi-host'] || ''
    })
    const auth = req.headers['x-api-key'] || String(req.headers['authorization'] || '').replace('Bearer ', '')
    if (req.url === '/v1/models') {
      if (auth !== 'good-key') { res.writeHead(401); return res.end('{}') }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'model-x' }, { id: 'model-y' }, { id: 'model-x' }] }))
    }
    if (req.url === '/bare/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(['bare-1', 'bare-2']))
    }
    res.writeHead(404)
    res.end()
  }
}

async function seedOpenAiModelAttemptFixture({ load, meta, rootDir, runId }) {
  const taskRun = load('main/task/task-run.js')
  const taskStore = load('main/task/task-snapshot.js')
  const runtime = load('main/task/task-runtime-registry.js').taskRuntimeRegistry
  const digitalWorkerBinding = ensureUnscopedFixtureBinding(meta)
  const run = taskRun.createTaskRun({
    id: runId, sessionId: meta.id, taskId: meta.id, digitalWorkerBinding
  })
  runtime.set(meta.id, run)
  await taskStore.saveTaskSnapshot(taskStore.buildTaskSnapshot({
    meta,
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run
  }), rootDir)
  return async () => {
    runtime.delete(meta.id)
    await taskStore.deleteTaskSnapshot(meta.id, rootDir)
  }
}

async function seedClaudeModelAttemptFixture({ load, meta, rootDir, runId, text }) {
  const taskRun = load('main/task/task-run.js')
  const taskExecution = load('main/task/task-execution.js')
  const taskStore = load('main/task/task-snapshot.js')
  const runtime = load('main/task/task-runtime-registry.js').taskRuntimeRegistry
  const userEvent = { kind: 'user-message', messageId: `${runId}-message`, text }
  const digitalWorkerBinding = ensureUnscopedFixtureBinding(meta)
  let run = taskRun.createTaskRun({
    id: runId, sessionId: meta.id, taskId: meta.id, digitalWorkerBinding
  })
  run = taskExecution.reduceTaskExecutionEvent(run, userEvent, meta.cwd)
  runtime.set(meta.id, run)
  await taskStore.saveTaskSnapshot(taskStore.buildTaskSnapshot({
    meta,
    transcript: [{ seq: 1, event: userEvent }],
    lastSeq: 1,
    lastEventKind: 'user-message',
    eventCount: 1,
    reason: 'important-event',
    run
  }), rootDir)
  return async () => {
    runtime.delete(meta.id)
    await taskStore.deleteTaskSnapshot(meta.id, rootDir)
  }
}

async function seedExecutingClaudeEffectFixture({ load, rootDir, session, meta, providerLabel }) {
  const taskRun = load('main/task/task-run.js')
  const taskExecution = load('main/task/task-execution.js')
  const taskStore = load('main/task/task-snapshot.js')
  const runtime = load('main/task/task-runtime-registry.js').taskRuntimeRegistry
  const effectRuntime = load('main/task/effect-runtime.js')
  const toolUseId = `claude-${providerLabel}-unknown-write`
  const toolInput = {
    path: `claude-${providerLabel}-unknown.txt`,
    content: `${providerLabel} unknown\n`
  }
  const userEvent = {
    kind: 'user-message',
    messageId: `claude-${providerLabel}-user`,
    text: `write ${providerLabel}`
  }
  const toolEvent = {
    kind: 'assistant-message',
    blocks: [{ type: 'tool_use', id: toolUseId, name: 'Write', input: toolInput }]
  }
  const digitalWorkerBinding = ensureUnscopedFixtureBinding(meta)
  let run = taskRun.createTaskRun({
    id: `claude-${providerLabel}-run`,
    sessionId: meta.id,
    taskId: meta.id,
    digitalWorkerBinding
  })
  run = taskExecution.reduceTaskExecutionEvent(run, userEvent, meta.cwd)
  run = taskExecution.reduceTaskExecutionEvent(run, toolEvent, meta.cwd)
  runtime.set(meta.id, run)
  await taskStore.saveTaskSnapshot(taskStore.buildTaskSnapshot({
    meta,
    transcript: [{ seq: 1, event: userEvent }, { seq: 2, event: toolEvent }],
    lastSeq: 2,
    lastEventKind: 'assistant-message',
    eventCount: 2,
    reason: 'important-event',
    run
  }), rootDir)
  const handle = await effectRuntime.prepareEffectExecution({
    sessionId: meta.id,
    cwd: meta.cwd,
    toolUseId,
    toolName: 'write_file',
    toolInput
  })
  await effectRuntime.markEffectExecutionStarted(handle, {
    sessionId: meta.id,
    cwd: meta.cwd,
    toolUseId,
    toolName: 'write_file',
    toolInput
  })
  meta.status = 'running'
  return { handle, toolUseId, session }
}

function ensureUnscopedFixtureBinding(meta) {
  meta.digitalWorkerBinding ??= { kind: 'unscoped' }
  return meta.digitalWorkerBinding
}

module.exports = {
  createClaudeFailoverDisabledCheck,
  createClaudeInterruptCheck,
  createClaudeProviderFailoverCheck,
  createClaudeStreamFailoverCheck,
  createClaudeTurnSuccessCheck,
  createFetchModelsHttpCheck,
  createProviderEnvIsolationCheck,
  seedClaudeModelAttemptFixture,
  seedExecutingClaudeEffectFixture,
  seedOpenAiModelAttemptFixture
}
