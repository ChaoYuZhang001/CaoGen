#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-anthropic-registration-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'userData')
const project = path.join(tempRoot, 'project')
const require = createRequire(import.meta.url)
const token = 'anthropic-token-for-smoke-registration'
const model = 'claude-registration-model'
const prompt = 'prove the registered Anthropic Messages production path'
const responseText = 'Anthropic production registration OK'

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

mkdirSync(userData, { recursive: true })
mkdirSync(project, { recursive: true })

verifyStaticRegistrationContracts()
compileSessionManagerHarness()

const requests = []
const server = createServer(async (request, response) => {
  const body = await readRequestBody(request)
  requests.push({
    method: request.method,
    url: request.url,
    headers: { ...request.headers },
    body: JSON.parse(body)
  })
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    id: 'msg-registration',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: responseText }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 9,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  }))
})

const electronStub = {
  app: {
    getPath: () => userData,
    isPackaged: false,
    focus() {}
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`registration:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^registration:/, '')
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  powerSaveBlocker: {
    start: () => 1,
    stop() {},
    isStarted: () => false
  },
  Notification: class {
    static isSupported() { return false }
    once() {}
    show() {}
  }
}

const originalLoad = require('node:module').Module._load
let manager
let sessionId

try {
  const port = await listen(server)
  require('node:module').Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }

  const sessionManagerModule = require(findCompiled(outDir, 'sessionManager.js'))
  const providersModule = require(findCompiled(outDir, 'providers.js'))
  const engineModule = require(findCompiled(outDir, 'engine.js'))
  const snapshotModule = require(findCompiled(outDir, 'task-snapshot.js'))
  const modelAttemptModule = require(findCompiled(outDir, 'model-attempt-api.js'))

  const provider = providersModule.createProvider({
    name: 'Anthropic registration fixture',
    baseUrl: `http://127.0.0.1:${port}`,
    models: [model],
    engine: 'anthropic',
    token,
    tokenLabel: 'registration-primary'
  })
  assert.equal(provider.engine, 'anthropic', 'saved Provider must retain the Anthropic engine kind')
  const persistedProviders = JSON.parse(readFileSync(path.join(userData, 'providers.json'), 'utf8'))
  assert.equal(persistedProviders[0]?.engine, 'anthropic', 'providers.json must persist engine=anthropic')
  assert.equal(JSON.stringify(persistedProviders).includes(token), false, 'providers.json must not contain the raw API key')

  manager = sessionManagerModule.sessionManager
  await manager.init()
  const engineKinds = new Set(engineModule.listEngines().map((engine) => engine.kind))
  assert.deepEqual(
    engineKinds,
    new Set(['claude', 'anthropic', 'openai']),
    'builtins must expose exactly the three formal engines'
  )

  const meta = await manager.create({
    cwd: project,
    isolated: false,
    unassigned: true,
    providerId: provider.id,
    model,
    permissionMode: 'bypassPermissions',
    title: 'Anthropic registration smoke'
  })
  sessionId = meta.id
  assert.equal(meta.engine, 'anthropic', 'SessionManager must resolve the saved Provider to AnthropicEngine')
  await eventually(
    () => manager.get(sessionId)?.meta.status === 'idle',
    'registered Anthropic engine start'
  )
  assert.match(
    manager.get(sessionId)?.meta.sdkSessionId ?? '',
    /^anthropic-/,
    'the production registry must create AnthropicEngine, not another engine kind'
  )

  assert.equal(manager.send(sessionId, prompt), true, 'SessionManager must accept the Anthropic turn')
  await eventually(
    () => manager.getTranscript(sessionId).some((entry) => entry.event.kind === 'turn-result'),
    'Anthropic turn result'
  )

  const transcript = manager.getTranscript(sessionId)
  const turnResult = transcript.find((entry) => entry.event.kind === 'turn-result')?.event
  assert(
    turnResult?.kind === 'turn-result' && turnResult.isError === false,
    `registered Anthropic turn failed: ${JSON.stringify(turnResult)}`
  )
  assert(
    transcript.some(
      (entry) => entry.event.kind === 'assistant-message' &&
        entry.event.blocks.some((block) => block.type === 'text' && block.text === responseText)
    ),
    'the local Messages response must reach the normal SessionManager transcript'
  )
  assert.equal(requests.length, 1, 'the registered engine must make exactly one local Messages request')
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, '/v1/messages')
  assert.equal(requests[0].headers['x-api-key'], token)
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(requests[0].body.model, model)
  assert.equal(requests[0].body.stream, true)
  assert(
    JSON.stringify(requests[0].body.messages).includes(prompt),
    'the SessionManager prompt must reach the Messages request body'
  )

  const runtimeRun = manager.taskRuns.get(sessionId)
  assert(runtimeRun, 'SessionManager must create a TaskRun before Anthropic provider execution')
  await eventuallyAsync(async () => {
    const runs = await snapshotModule.listTaskRuns(sessionId, userData)
    return runs.some((run) => run.id === runtimeRun.id && run.status === 'completed')
  }, 'durable completed Anthropic TaskRun')

  const selection = await modelAttemptModule.queryPersistedModelAttempts(
    { runId: runtimeRun.id, providerId: provider.id },
    userData
  )
  assert.equal(selection.attempts.length, 1, 'the production turn must persist one ModelAttempt')
  const attempt = selection.attempts[0]
  assert.equal(attempt.status, 'succeeded')
  assert.equal(attempt.protocol, 'anthropic.messages')
  assert.equal(attempt.adapterVersion, 'anthropic-messages-v1')
  assert.equal(attempt.model, model)
  assert.deepEqual(attempt.usage, {
    inputTokens: 9,
    outputTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  })

  console.log('anthropic engine production registration smoke ok')
} finally {
  if (manager && sessionId) await manager.close(sessionId).catch(() => undefined)
  require('node:module').Module._load = originalLoad
  await closeServer(server)
  rmSync(tempRoot, { recursive: true, force: true })
}

function verifyStaticRegistrationContracts() {
  const sharedTypes = sourceFile('src/shared/types.ts', ts.ScriptKind.TS)
  const members = stringUnionMembers(sharedTypes, 'EngineKind')
  assert.deepEqual(
    members,
    new Set(['claude', 'anthropic', 'openai']),
    'EngineKind must expose exactly the three formal engines'
  )

  const providerEditor = sourceFile('src/renderer/src/components/ProviderEditor.tsx', ts.ScriptKind.TSX)
  const optionValues = jsxSelectOptionValues(providerEditor, 'engine')
  for (const kind of ['claude', 'anthropic', 'openai']) {
    assert(optionValues.has(kind), `ProviderEditor must expose an independent ${kind} engine option`)
  }
}

function sourceFile(relativePath, scriptKind) {
  const source = readFileSync(path.join(repoRoot, relativePath), 'utf8')
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind)
}

function stringUnionMembers(source, aliasName) {
  let members
  for (const statement of source.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== aliasName) continue
    assert(ts.isUnionTypeNode(statement.type), `${aliasName} must be a string literal union`)
    members = new Set(statement.type.types.map((member) => {
      assert(
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
        `${aliasName} members must be string literals`
      )
      return member.literal.text
    }))
  }
  assert(members, `type alias ${aliasName} not found`)
  return members
}

function jsxSelectOptionValues(source, valueIdentifier) {
  let values
  const visit = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'select') {
      const valueAttribute = node.openingElement.attributes.properties.find(
        (item) => ts.isJsxAttribute(item) && item.name.getText(source) === 'value'
      )
      const initializer = valueAttribute && ts.isJsxAttribute(valueAttribute)
        ? valueAttribute.initializer
        : undefined
      if (
        initializer && ts.isJsxExpression(initializer) &&
        ts.isIdentifier(initializer.expression) && initializer.expression.text === valueIdentifier
      ) {
        values = new Set(node.children.flatMap((child) => {
          if (!ts.isJsxElement(child) || child.openingElement.tagName.getText(source) !== 'option') return []
          const optionValue = child.openingElement.attributes.properties.find(
            (item) => ts.isJsxAttribute(item) && item.name.getText(source) === 'value'
          )
          return optionValue && ts.isJsxAttribute(optionValue) &&
            optionValue.initializer && ts.isStringLiteral(optionValue.initializer)
            ? [optionValue.initializer.text]
            : []
        }))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert(values, `ProviderEditor select bound to ${valueIdentifier} not found`)
  return values
}

function compileSessionManagerHarness() {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/sessionManager.ts',
      '--outDir', outDir,
      '--rootDir', 'src',
      '--target', 'ES2022',
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--types', 'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (!findCompiledMaybe(outDir, 'sessionManager.js')) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error('failed to compile Anthropic registration SessionManager harness')
  }
}

function findCompiled(root, fileName) {
  const found = findCompiledMaybe(root, fileName)
  if (!found) throw new Error(`compiled file not found: ${fileName}`)
  return found
}

function findCompiledMaybe(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledMaybe(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function listen(serverInstance) {
  return new Promise((resolve, reject) => {
    serverInstance.once('error', reject)
    serverInstance.listen(0, '127.0.0.1', () => {
      serverInstance.off('error', reject)
      const address = serverInstance.address()
      if (!address || typeof address === 'string') {
        reject(new Error('mock Anthropic server did not expose a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.once('end', () => resolve(body))
    request.once('error', reject)
  })
}

function closeServer(serverInstance) {
  return new Promise((resolve) => {
    if (!serverInstance.listening) {
      resolve(undefined)
      return
    }
    serverInstance.close(() => resolve(undefined))
  })
}

async function eventually(predicate, label, timeoutMs = 10_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function eventuallyAsync(predicate, label, timeoutMs = 10_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${label}`)
}
