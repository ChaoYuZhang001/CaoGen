#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const repoRoot = process.cwd()
const routingOnly = process.argv.includes('--routing-only')
const gate = routingOnly
  ? 'test:routing-hard-policy:required'
  : 'test:outbound-context-policy:required'
const resultName = routingOnly ? 'routing-hard-policy' : 'outbound-context-policy'
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', resultName)
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-outbound-policy-'))
const userData = path.join(tempRoot, 'user-data')
const bundlePath = path.join(tempRoot, 'runtime.cjs')
const checks = []
const OUTBOUND_CREDENTIAL_CANARY = 'secret-for-smoke-outbound-context-canary'
let failure

mkdirSync(userData, { recursive: true })
process.env.CAOGEN_TEST_USER_DATA = userData

try {
  const runtime = await buildRuntime()
  const providers = createProviders(runtime)
  const fixtures = await createProjectFixtures(runtime)
  await exerciseAllowAndRedaction(runtime, providers, fixtures)
  await exerciseDeny(runtime, providers, fixtures)
  await exerciseLocalOnlyNoFailover(runtime, providers, fixtures)
  await exerciseManifestIntegrity(runtime, providers, fixtures)
  await exercisePolicyDrift(runtime, providers, fixtures)
  await exerciseRestart(runtime, providers, fixtures)
  exerciseReferencedFileContainment(runtime)
  await exerciseAttemptPreflight(runtime, providers)
  await exerciseDagPreflight(runtime, providers)
  assertProductionBoundaries()
  console.log(`${resultName}: PASS (${checks.length} checks)`)
} catch (error) {
  failure = serializeError(error)
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const report = {
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    gate,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    summary: {
      passed: checks.filter((check) => check.status === 'passed').length,
      failed: checks.filter((check) => check.status === 'failed').length
    },
    coverage: {
      policy: ['allow', 'deny', 'S3 forced deny', 'local_only', 'no cross-Provider failover'],
      integrity: ['manifest digest', 'Project policy revision/digest', 'fresh-process restore'],
      boundaries: [
        'OpenAI retry preflight',
        'Anthropic attempt preflight',
        'DAG decomposer preflight'
      ],
      privacy: [
        'content-free manifest',
        'path/URI/token redaction',
        'referenced-file canonical containment',
        'partial preview disclosure'
      ]
    },
    acceptance: {
      ROUTE_006: 'partial: resource privacy hard condition and no-failover foundation covered; all router dimensions remain open',
      NFR_PRIV_002: 'partial: message/image/resource preview and hard policy covered; complete engine-owned context preview remains open'
    },
    source: sourceSnapshot(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    error: failure
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
  if (failure) console.error(`${resultName}: FAIL: ${failure.message}`)
  else console.log(`report: ${reportPath}`)
}

async function buildRuntime() {
  const harnessPath = path.join(tempRoot, 'runtime.ts')
  writeFileSync(harnessPath, [
    `export * as outbound from ${JSON.stringify(path.join(repoRoot, 'src/main/project-workspace/outbound-context-policy.ts'))}`,
    `export * as providers from ${JSON.stringify(path.join(repoRoot, 'src/main/providers.ts'))}`,
    `export { ProjectWorkspaceStore } from ${JSON.stringify(path.join(repoRoot, 'src/main/project-workspace/store.ts'))}`,
    `export { OpenAIModelAttemptTracker } from ${JSON.stringify(path.join(repoRoot, 'src/main/task/openai-model-attempt-runtime.ts'))}`,
    `export { AnthropicModelAttemptTracker } from ${JSON.stringify(path.join(repoRoot, 'src/main/task/anthropic-model-attempt-runtime.ts'))}`,
    `export { createModelDagDecomposer } from ${JSON.stringify(path.join(repoRoot, 'src/main/agent/model-dag-decomposer.ts'))}`,
    `export { readReferencedFiles } from ${JSON.stringify(path.join(repoRoot, 'src/main/fileSuggest.ts'))}`
  ].join('\n'), 'utf8')
  await esbuild.build({
    entryPoints: [harnessPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    plugins: [{
      name: 'electron-outbound-policy-stub',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
          loader: 'js',
          contents: [
            "export const app = { getPath: () => process.env.CAOGEN_TEST_USER_DATA || '' }",
            'export const safeStorage = {',
            '  isEncryptionAvailable: () => true,',
            "  encryptString: (value) => Buffer.from(String(value), 'utf8'),",
            "  decryptString: (value) => Buffer.from(value).toString('utf8')",
            '}'
          ].join('\n')
        }))
      }
    }]
  })
  return require(bundlePath)
}

function createProviders(runtime) {
  const remote = runtime.providers.createProvider({
    name: 'Remote fixture',
    baseUrl: 'https://provider.example.test/v1',
    token: OUTBOUND_CREDENTIAL_CANARY,
    models: ['fixture-model'],
    engine: 'openai',
    openaiProtocol: 'responses'
  })
  const localA = runtime.providers.createProvider({
    name: 'Local fixture A',
    baseUrl: 'http://127.0.0.1:11434',
    models: ['local-model-a'],
    engine: 'openai',
    openaiProtocol: 'chat',
    authMode: 'none'
  })
  const localB = runtime.providers.createProvider({
    name: 'Local fixture B',
    baseUrl: 'http://localhost:1234/v1',
    models: ['local-model-b'],
    engine: 'openai',
    openaiProtocol: 'chat',
    authMode: 'none'
  })
  return { remote, localA, localB }
}

async function createProjectFixtures(runtime) {
  const store = await new runtime.ProjectWorkspaceStore(userData).open()
  const allowRoot = projectSource('allow', 'ALLOW-CONTENT-MUST-NOT-ENTER-MANIFEST')
  const denyRoot = projectSource('deny', 'DENY-CONTENT-MUST-NEVER-LEAVE')
  const localRoot = projectSource('local', 'LOCAL-ONLY-CONTENT')
  const allow = await store.createWorkspace({
    name: 'Allow project',
    kind: 'software',
    resources: [{
      kind: 'directory',
      label: 'Allow docs',
      path: allowRoot,
      dataClass: 'S2',
      egressPolicy: 'allow'
    }]
  })
  const deny = await store.createWorkspace({
    name: 'Deny project',
    kind: 'software',
    resources: [
      {
        kind: 'directory',
        label: 'Denied docs',
        path: denyRoot,
        dataClass: 'S2',
        egressPolicy: 'deny'
      },
      {
        kind: 'url',
        label: 'Sensitive URL',
        uri: 'https://user:password@example.test/private?token=must-not-leak#fragment',
        dataClass: 'S3',
        egressPolicy: 'allow'
      }
    ]
  })
  const local = await store.createWorkspace({
    name: 'Local-only project',
    kind: 'software',
    resources: [{
      kind: 'directory',
      label: 'Local docs',
      path: localRoot,
      dataClass: 'S2',
      egressPolicy: 'local_only'
    }]
  })
  return { store, allow, deny, local, roots: { allowRoot, denyRoot, localRoot } }
}

async function exerciseAllowAndRedaction(runtime, providers, fixtures) {
  const prepared = await checkAsync('allow policy permits the selected remote receiver', async () => {
    const value = await runtime.outbound.prepareOutboundContext({
      meta: sessionMeta('allow-session', fixtures.allow.id, providers.remote),
      rootDir: userData,
      payload: { text: 'Summarize this project', images: [] },
      now: 1_800_000_000_000
    })
    assert(!value.manifest.blocked, value.manifest.blockReasons.join('; '))
    assert(value.resourceContext.prompt.includes('ALLOW-CONTENT-MUST-NOT-ENTER-MANIFEST'),
      'allowed resource content must enter the Provider prompt')
    await runtime.outbound.assertOutboundContextAllowed({
      manifest: value.manifest,
      rootDir: userData,
      providerId: providers.remote.id,
      model: 'fixture-model',
      engine: 'openai'
    })
    return value
  })
  check('manifest is serializable and excludes content, paths, URI credentials, and Provider token', () => {
    const serialized = JSON.stringify(prepared.manifest)
    for (const forbidden of [
      fixtures.roots.allowRoot,
      'ALLOW-CONTENT-MUST-NOT-ENTER-MANIFEST',
      OUTBOUND_CREDENTIAL_CANARY,
      'password',
      'must-not-leak'
    ]) assert(!serialized.includes(forbidden), `manifest leaked ${forbidden}`)
    assert(prepared.manifest.scopeCompleteness === 'partial', 'preview/runtime scope must not claim complete coverage')
    assert(/^sha256:[a-f0-9]{64}$/.test(prepared.manifest.manifestDigest), 'manifest digest is missing')
  })
  await checkRejects('an unknown non-empty Provider ID fails closed', async () => {
    const value = await runtime.outbound.prepareOutboundContext({
      meta: sessionMeta('unknown-provider-session', fixtures.allow.id, providers.remote),
      rootDir: userData,
      payload: { text: 'Unknown receiver check', images: [] },
      providerId: 'missing-provider-id',
      model: 'fixture-model'
    })
    assert(value.manifest.receiver.locality === 'unknown', 'missing Provider was not classified as unknown')
    await runtime.outbound.assertOutboundContextAllowed({
      manifest: value.manifest,
      rootDir: userData,
      providerId: 'missing-provider-id',
      model: 'fixture-model',
      engine: 'openai'
    })
  }, (error) => error?.code === 'OUTBOUND_CONTEXT_DENIED')
}

async function exerciseDeny(runtime, providers, fixtures) {
  await checkAsync('deny and S3 resources are omitted before prompt construction', async () => {
    const value = await runtime.outbound.prepareOutboundContext({
      meta: sessionMeta('deny-session', fixtures.deny.id, providers.remote),
      rootDir: userData,
      payload: { text: 'Use only permitted context', images: [] }
    })
    assert(!value.resourceContext.prompt.includes('DENY-CONTENT-MUST-NEVER-LEAVE'),
      'denied content entered the Provider prompt')
    const excluded = value.manifest.items.filter((item) => item.decision === 'excluded')
    assert(excluded.length === 2, `expected two excluded resources, got ${excluded.length}`)
    assert(excluded.every((item) => item.egressPolicy === 'deny'), 'S3 must normalize to deny')
    await runtime.outbound.assertOutboundContextAllowed({
      manifest: value.manifest,
      rootDir: userData,
      providerId: providers.remote.id,
      model: 'fixture-model',
      engine: 'openai'
    })
  })
}

async function exerciseLocalOnlyNoFailover(runtime, providers, fixtures) {
  const prepared = await checkAsync('local_only allows its original loopback Provider', async () => {
    const value = await runtime.outbound.prepareOutboundContext({
      meta: sessionMeta('local-session', fixtures.local.id, providers.localA),
      rootDir: userData,
      payload: { text: 'Run locally', images: [] }
    })
    assert(!value.manifest.blocked, value.manifest.blockReasons.join('; '))
    assert(value.manifest.receiver.locality === 'local', 'loopback receiver must be local')
    assert(value.manifest.failoverAllowed === false, 'local_only must freeze cross-Provider failover')
    await runtime.outbound.assertOutboundContextAllowed({
      manifest: value.manifest,
      rootDir: userData,
      providerId: providers.localA.id,
      model: 'local-model-a',
      engine: 'openai'
    })
    return value
  })
  check('no-failover candidate filter rejects both second loopback and remote Providers', () => {
    assert(!runtime.outbound.providerAllowedByOutboundContext(
      prepared.manifest, providers.localB, 'local-model-b'
    ), 'second loopback Provider bypassed no-failover')
    assert(!runtime.outbound.providerAllowedByOutboundContext(
      prepared.manifest, providers.remote, 'fixture-model'
    ), 'remote Provider bypassed local_only')
    assert(runtime.outbound.providerAllowedByOutboundContext(
      prepared.manifest, providers.localA, 'local-model-a'
    ), 'original receiver was incorrectly rejected')
  })
  await checkRejects('preflight rejects a direct cross-Provider loopback switch', () =>
    runtime.outbound.assertOutboundContextAllowed({
      manifest: prepared.manifest,
      rootDir: userData,
      providerId: providers.localB.id,
      model: 'local-model-b',
      engine: 'openai'
    }), (error) => error?.code === 'OUTBOUND_CONTEXT_DENIED')
  await checkAsync('same-Provider key/model retry remains allowed', () =>
    runtime.outbound.assertOutboundContextAllowed({
      manifest: prepared.manifest,
      rootDir: userData,
      providerId: providers.localA.id,
      model: 'local-model-a-retry',
      engine: 'openai'
    }))
}

async function exerciseManifestIntegrity(runtime, providers, fixtures) {
  const prepared = await runtime.outbound.prepareOutboundContext({
    meta: sessionMeta('tamper-session', fixtures.allow.id, providers.remote),
    rootDir: userData,
    payload: { text: 'Integrity check', images: [] }
  })
  const tampered = structuredClone(prepared.manifest)
  tampered.items[0].decision = 'excluded'
  await checkRejects('manifest mutation fails closed before Provider dispatch', () =>
    runtime.outbound.assertOutboundContextAllowed({
      manifest: tampered,
      rootDir: userData,
      providerId: providers.remote.id,
      model: 'fixture-model',
      engine: 'openai'
    }), (error) => error?.code === 'OUTBOUND_CONTEXT_STALE' && /摘要/.test(error.message))
}

async function exercisePolicyDrift(runtime, providers, fixtures) {
  const prepared = await runtime.outbound.prepareOutboundContext({
    meta: sessionMeta('drift-session', fixtures.allow.id, providers.remote),
    rootDir: userData,
    payload: { text: 'Policy drift check', images: [] }
  })
  const current = await fixtures.store.getWorkspace(fixtures.allow.id)
  await fixtures.store.updateWorkspace(fixtures.allow.id, {
    resources: current.resources.map((resource) => ({ ...resource, egressPolicy: 'deny' }))
  }, current.revision)
  await checkRejects('persisted policy revision drift invalidates an in-flight manifest', () =>
    runtime.outbound.assertOutboundContextAllowed({
      manifest: prepared.manifest,
      rootDir: userData,
      providerId: providers.remote.id,
      model: 'fixture-model',
      engine: 'openai'
    }), (error) => error?.code === 'OUTBOUND_CONTEXT_STALE' && /已变化/.test(error.message))
}

async function exerciseRestart(_runtime, providers, fixtures) {
  await checkAsync('resource classification and no-failover survive a fresh process', async () => {
    const childPath = path.join(tempRoot, 'restart.cjs')
    writeFileSync(childPath, [
      `const runtime = require(${JSON.stringify(bundlePath)});`,
      '(async () => {',
      '  const value = await runtime.outbound.prepareOutboundContext({',
      `    meta: ${JSON.stringify(sessionMeta('restart-session', fixtures.local.id, providers.localA))},`,
      `    rootDir: ${JSON.stringify(userData)},`,
      "    payload: { text: 'Restart check', images: [] }",
      '  })',
      '  process.stdout.write(JSON.stringify(value.manifest))',
      '})().catch((error) => { console.error(error); process.exitCode = 1 })'
    ].join('\n'), 'utf8')
    const output = execFileSync(process.execPath, [childPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CAOGEN_TEST_USER_DATA: userData }
    })
    const manifest = JSON.parse(output)
    assert(manifest.receiver.providerId === providers.localA.id, 'fresh process lost Provider receiver')
    assert(manifest.failoverAllowed === false, 'fresh process lost local_only no-failover')
    assert(manifest.items.some((item) => item.resourceId && item.egressPolicy === 'local_only'),
      'fresh process lost persisted resource policy')
  })
}

function exerciseReferencedFileContainment(runtime) {
  check('referenced-file loading rejects sibling traversal and symlink escape', () => {
    const root = path.join(tempRoot, 'mention-root')
    const sibling = path.join(tempRoot, 'mention-root-secret')
    mkdirSync(root, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(path.join(root, 'allowed.txt'), 'ALLOWED-MENTION-CONTENT', 'utf8')
    const secret = path.join(sibling, 'secret.txt')
    writeFileSync(secret, 'FORBIDDEN-MENTION-CONTENT', 'utf8')
    const escapePath = process.platform === 'win32'
      ? path.join(root, 'escape-dir')
      : path.join(root, 'escape.txt')
    symlinkSync(process.platform === 'win32' ? sibling : secret, escapePath, process.platform === 'win32' ? 'junction' : 'file')
    const injected = runtime.readReferencedFiles(root, [
      'allowed.txt',
      `../${path.basename(sibling)}/secret.txt`,
      process.platform === 'win32' ? 'escape-dir/secret.txt' : 'escape.txt'
    ])
    assert(injected.includes('ALLOWED-MENTION-CONTENT'), 'allowed referenced file was not loaded')
    assert(!injected.includes('FORBIDDEN-MENTION-CONTENT'), 'referenced-file boundary leaked outside content')
  })
}

async function exerciseAttemptPreflight(runtime, providers) {
  let fetchCalls = 0
  await checkRejects('OpenAI retry preflight rejects before fetch/Attempt operation', async () => {
    const tracker = new runtime.OpenAIModelAttemptTracker()
    await tracker.fetch({
      run: { id: 'run-openai-preflight', steps: [] },
      providerId: providers.remote.id,
      model: 'fixture-model',
      protocol: 'openai.responses',
      url: 'https://provider.example.test/v1/responses',
      init: { method: 'POST' },
      signal: new AbortController().signal,
      auth: { token: OUTBOUND_CREDENTIAL_CANARY },
      readUsage: () => undefined,
      preflight: async () => { throw new Error('openai-preflight-denied') },
      fetch: async () => { fetchCalls += 1; throw new Error('fetch must not run') },
      consume: async () => undefined
    })
    throw new Error('OpenAI preflight unexpectedly allowed')
  }, (error) => error?.message === 'openai-preflight-denied')
  check('OpenAI denied preflight performed zero network calls', () => {
    assert(fetchCalls === 0, `OpenAI fetch ran ${fetchCalls} times`)
    const source = read('src/main/task/openai-model-attempt-runtime.ts')
    assert(source.indexOf('await input.preflight?.()') < source.indexOf('executePersistedModelAttempt({'),
      'OpenAI preflight is not before Attempt persistence')
  })

  let operationCalls = 0
  await checkRejects('Anthropic preflight rejects before durable/network operation', () =>
    new runtime.AnthropicModelAttemptTracker().execute({
      run: { id: 'run-anthropic-preflight', steps: [] },
      providerId: providers.remote.id,
      model: 'fixture-model',
      endpoint: 'https://provider.example.test/v1/messages',
      body: {},
      signal: new AbortController().signal,
      auth: { token: OUTBOUND_CREDENTIAL_CANARY },
      preflight: async () => { throw new Error('anthropic-preflight-denied') },
      operation: async () => { operationCalls += 1; throw new Error('operation must not run') }
    }), (error) => error?.message === 'anthropic-preflight-denied')
  check('Anthropic denied preflight performed zero network operations', () => {
    assert(operationCalls === 0, `Anthropic operation ran ${operationCalls} times`)
  })
}

async function exerciseDagPreflight(runtime, providers) {
  let fetchCalls = 0
  let preflightCalls = 0
  await checkRejects('DAG decomposer preflight rejects before Attempt persistence/network', () =>
    runtime.createModelDagDecomposer({
      request: 'Decompose without dispatch',
      providerId: providers.remote.id,
      model: 'fixture-model'
    }, {
      runId: 'run-dag-preflight',
      requestId: 'request-dag-preflight'
    }, {
      fetch: async () => { fetchCalls += 1; throw new Error('DAG fetch must not run') },
      preflight: async () => { preflightCalls += 1; throw new Error('dag-preflight-denied') }
    }).decompose(), (error) => error?.message === 'dag-preflight-denied')
  check('DAG denied preflight performed zero network calls', () => {
    assert(preflightCalls === 1, `DAG preflight ran ${preflightCalls} times`)
    assert(fetchCalls === 0, `DAG fetch ran ${fetchCalls} times`)
  })
}

function assertProductionBoundaries() {
  check('all owned Provider attempt boundaries invoke outbound policy preflight', () => {
    const openai = read('src/main/openaiEngine.ts')
    const anthropic = read('src/main/anthropicEngine.ts')
    const dag = read('src/main/agent/model-dag-decomposer.ts')
    const sessionManager = read('src/main/sessionManager.ts')
    assert(openai.includes('await assertOutboundContextAllowed({'), 'OpenAI attempt gate missing')
    assert(anthropic.includes('await assertOutboundContextAllowed({'), 'Anthropic attempt gate missing')
    const dagPreflight = dag.indexOf('await runtime.preflight?.({')
    const dagAttempt = dag.indexOf('executePersistedModelAttempt({')
    assert(dagPreflight >= 0, 'DAG outbound policy preflight missing')
    assert(dagAttempt >= 0, 'DAG Attempt boundary missing')
    assert(dagPreflight < dagAttempt,
      'DAG policy preflight must precede Attempt persistence')
    assert(sessionManager.includes('preflight: async ({ providerId, model, body }) => {'),
      'SessionManager DAG outbound policy binding missing')
  })
  check('retry and failover paths retain policy rechecks', () => {
    const openaiTracker = read('src/main/task/openai-model-attempt-runtime.ts')
    const anthropicTracker = read('src/main/task/anthropic-model-attempt-runtime.ts')
    const openai = read('src/main/openaiEngine.ts')
    const openaiRecovery = read('src/main/provider/openAiProviderModelRecovery.ts')
    const anthropic = read('src/main/anthropicEngine.ts')
    const anthropicRecovery = read('src/main/provider/anthropicRecovery.ts')
    assert(openaiTracker.includes('await input.preflight?.()'), 'OpenAI retry preflight is not async/repeated')
    assert(anthropicTracker.includes('await input.preflight?.()'), 'Anthropic attempt preflight is not async')
    assert(openai.includes('outboundContext: this.activeOutboundContext'), 'OpenAI failover policy binding missing')
    assert(openaiRecovery.includes('providerAllowedByOutboundContext(input.outboundContext'), 'OpenAI failover filter missing')
    assert(anthropic.includes('outboundContext: this.activeOutboundContext'), 'Anthropic failover policy binding missing')
    assert(anthropicRecovery.includes('providerAllowedByOutboundContext('), 'Anthropic failover filter missing')
  })
  check('Renderer preview is wired and truthfully marked partial', () => {
    const ipc = read('src/main/ipc.ts')
    const preload = read('src/preload/index.ts')
    const composer = read('src/renderer/src/components/Composer.tsx')
    const preview = read('src/renderer/src/components/OutboundContextPreview.tsx')
    assert(ipc.includes("ipcMain.handle('sessions:outboundContextPreview'"), 'preview IPC missing')
    assert(preload.includes('previewOutboundContext:'), 'preview preload API missing')
    assert(composer.includes('<OutboundContextPreview'), 'Composer preview surface missing')
    assert(preview.includes('data-outbound-scope-completeness'), 'preview completeness disclosure missing')
    assert(preview.includes("manifest.scopeCompleteness === 'partial'"), 'partial preview is not visible')
  })
}

function projectSource(name, content) {
  const root = path.join(tempRoot, `source-${name}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'README.md'), `${content}\n`, 'utf8')
  return root
}

function sessionMeta(id, workspaceId, provider) {
  return {
    id,
    workspaceId,
    projectId: workspaceId,
    providerId: provider.id,
    model: provider.models[0],
    engine: provider.engine,
    routingScope: 'fixed'
  }
}

function sourceSnapshot() {
  try {
    return {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      worktreeStatusCount: execFileSync(
        'git', ['status', '--porcelain=v1', '--untracked-files=all'],
        { cwd: repoRoot, encoding: 'utf8' }
      ).trim().split('\n').filter(Boolean).length
    }
  } catch {
    return { head: 'unknown', worktreeStatusCount: -1 }
  }
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function check(name, operation) {
  const started = Date.now()
  try {
    operation()
    checks.push({ name, status: 'passed', durationMs: Date.now() - started })
  } catch (error) {
    checks.push({ name, status: 'failed', durationMs: Date.now() - started, error: errorText(error) })
    throw error
  }
}

async function checkAsync(name, operation) {
  const started = Date.now()
  try {
    const result = await operation()
    checks.push({ name, status: 'passed', durationMs: Date.now() - started })
    return result
  } catch (error) {
    checks.push({ name, status: 'failed', durationMs: Date.now() - started, error: errorText(error) })
    throw error
  }
}

async function checkRejects(name, operation, predicate) {
  return checkAsync(name, async () => {
    try {
      await operation()
    } catch (error) {
      if (predicate(error)) return
      throw new Error(`${name}: unexpected rejection ${errorText(error)}`)
    }
    throw new Error(`${name}: operation unexpectedly succeeded`)
  })
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: errorText(error),
    stack: error instanceof Error ? error.stack : undefined
  }
}
