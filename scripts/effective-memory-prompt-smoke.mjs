#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-effective-memory-prompt-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataRoot = path.join(tempRoot, 'user-data')
const memoryRoot = path.join(userDataRoot, 'memory')
const learningRoot = path.join(userDataRoot, 'learning')
const projectRoot = path.join(tempRoot, 'project')
const failures = []

const ACTIVE_TOKEN = 'AUTO_REQUIRED_ACTIVE_MEMORY_7D3C'
const DRAFT_TOKEN = 'AUTO_REQUIRED_DRAFT_MEMORY_8E4D'
const EXPIRED_TOKEN = 'AUTO_REQUIRED_EXPIRED_MEMORY_9F5E'
const USER_REQUEST = 'Verify the effective project memory prompt contract.'

process.env.CAOGEN_USER_DATA_DIR = userDataRoot
process.env.CAOGEN_MEMORY_DIR = memoryRoot

try {
  mkdirSync(projectRoot, { recursive: true })
  compileRuntime()
  const runtime = loadRuntime()
  runtime.providerHealth.configureProviderHealthDir(userDataRoot)
  runtime.modelStats.configureModelStatsDir(userDataRoot)

  const authority = (action) => runtime.security.createTrustedUserLearningDecision(`effective-memory-smoke:${action}`)
  const active = await createMemoryDraft(runtime.lifecycle, ACTIVE_TOKEN, 'active-memory')
  const draft = await createMemoryDraft(runtime.lifecycle, DRAFT_TOKEN, 'draft-memory')
  const expiring = await createMemoryDraft(runtime.lifecycle, EXPIRED_TOKEN, 'expired-memory', {
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  })

  await runtime.lifecycle.approveLearningDraft(projectRoot, learningRoot, active.id, authority('approve-active'))
  await runtime.lifecycle.approveLearningDraft(projectRoot, learningRoot, expiring.id, authority('approve-expiring'))
  await runtime.lifecycle.expireDueLearningRecords(projectRoot, learningRoot, Date.now() + 120_000)

  await check('fixture has one active, one unapproved, and one expired Memory record', async () => {
    const snapshot = await runtime.lifecycle.listLearningProject(projectRoot, learningRoot)
    equal(requiredRecord(snapshot, active.id).status, 'active', 'active Memory status')
    equal(requiredRecord(snapshot, draft.id).status, 'draft', 'unapproved Memory status')
    equal(requiredRecord(snapshot, expiring.id).status, 'expired', 'expired Memory status')
  })

  await check('Anthropic prepareClaudeUserMessage injects only approved, unexpired project Memory', async () => {
    const prepared = await runtime.claude.prepareClaudeUserMessage({
      payload: { text: USER_REQUEST, images: [] },
      meta: sessionMeta('anthropic-memory-smoke', 'claude'),
      lastProjectContextAppend: ''
    })
    const prompt = prepared.message.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    assertEffectivePrompt(prompt, 'Anthropic prepared user message')
  })

  for (const protocol of ['chat', 'responses']) {
    await check(`OpenAI ${protocol} send boundary receives only approved, unexpired project Memory`, async () => {
      const captured = await captureOpenAISendPayload(runtime.openai.OpenAIEngine, protocol)
      assertEffectivePrompt(captured.text, `OpenAI ${protocol} payload`)
    })
  }

  if (failures.length > 0) {
    throw new Error(`effectiveMemoryPrompt smoke failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join('\n')}`)
  }
  console.log('effectiveMemoryPrompt smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function createMemoryDraft(lifecycle, token, logicalId, extra = {}) {
  return lifecycle.createLearningDraft(
    projectRoot,
    learningRoot,
    {
      kind: 'memory',
      source: `required-smoke:${logicalId}`,
      confidence: 0.91,
      ...extra,
      payload: {
        type: 'memory',
        memoryKind: 'workflow-rule',
        title: token,
        body: `${token} must be visible only while this record is active.`,
        reason: 'Effective prompt integration fixture.'
      }
    },
    { requestedLogicalId: logicalId }
  )
}

async function captureOpenAISendPayload(OpenAIEngine, protocol) {
  const engine = Object.create(OpenAIEngine.prototype)
  engine.meta = sessionMeta(`openai-${protocol}-memory-smoke`, 'openai')
  engine.turnStartedAt = Date.now()
  engine.triedProviderKeys = new Set()
  engine.authConfig = () => ({
    baseUrl: 'https://required-smoke.invalid',
    token: 'synthetic-required-smoke-token',
    headers: {}
  })
  engine.protocol = () => protocol
  engine.effectiveModel = () => 'required-smoke-model'
  engine.finishTurn = () => undefined

  let captured
  engine.runChatCompletion = async (payload) => {
    captured = payload
  }
  engine.runResponsesLoop = async (payload) => {
    captured = payload
  }

  await engine.runResponse({ text: USER_REQUEST, images: [] }, new AbortController())
  assert(captured, `OpenAI ${protocol} send function did not receive a payload`)
  return captured
}

function assertEffectivePrompt(prompt, label) {
  assert(typeof prompt === 'string' && prompt.includes(USER_REQUEST), `${label} lost the current user request`)
  assert(prompt.includes(ACTIVE_TOKEN), `${label} omitted approved project Memory`)
  assert(!prompt.includes(DRAFT_TOKEN), `${label} leaked an unapproved project Memory draft`)
  assert(!prompt.includes(EXPIRED_TOKEN), `${label} leaked an expired project Memory`)
}

function sessionMeta(id, engine) {
  return {
    id,
    title: 'Effective Memory Prompt Smoke',
    cwd: projectRoot,
    sourceCwd: projectRoot,
    model: 'required-smoke-model',
    providerId: `required-smoke-${engine}`,
    engine,
    permissionMode: 'default',
    status: 'idle',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: Date.now()
  }
}

async function check(name, run) {
  try {
    await run()
    console.log(`ok - ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    console.error(`not ok - ${name}: ${message}`)
  }
}

function compileRuntime() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/learning/learning-lifecycle.ts',
      'src/main/claude-user-message.ts',
      'src/main/openaiEngine.ts',
      '--outDir',
      outDir,
      '--rootDir',
      'src',
      '--target',
      'ES2022',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--types',
      'node',
      '--lib',
      'ES2022,DOM,DOM.Iterable',
      '--strict',
      '--skipLibCheck',
      '--esModuleInterop',
      '--resolveJsonModule'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function loadRuntime() {
  const originalLoad = Module._load
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') return electronStub()
      return originalLoad.call(this, request, parent, isMain)
    }
    return {
      claude: require(findCompiled(outDir, 'claude-user-message.js')),
      lifecycle: require(findCompiled(outDir, 'learning-lifecycle.js')),
      modelStats: require(findCompiled(outDir, 'modelStats.js')),
      openai: require(findCompiled(outDir, 'openaiEngine.js')),
      providerHealth: require(findCompiled(outDir, 'providerHealth.js')),
      security: require(findCompiled(outDir, 'learning-security.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

function electronStub() {
  class BrowserWindow {
    static getAllWindows() { return [] }
    static getFocusedWindow() { return null }
  }
  return {
    app: {
      getPath: () => userDataRoot,
      getAppPath: () => repoRoot,
      getVersion: () => '1.0.0-required-smoke',
      isPackaged: false,
      focus() {}
    },
    BrowserWindow,
    Notification: class {
      static isSupported() { return false }
      once() {}
      show() {}
    },
    clipboard: { readText: () => '', writeText() {} },
    desktopCapturer: { getSources: async () => [] },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: { handle() {}, removeHandler() {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    },
    screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }) },
    shell: { openExternal: async () => undefined, openPath: async () => '' }
  }
}

function requiredRecord(snapshot, id) {
  const record = snapshot.records.find((item) => item.id === id)
  assert(record, `Learning record not found: ${id}`)
  return record
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
  try {
    return findCompiled(root, fileName)
  } catch {
    return null
  }
}

function equal(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
