#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '..')
const moduleCache = new Map()

function loadTsModule(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/')
  if (moduleCache.has(normalized)) return moduleCache.get(normalized)
  const filename = path.join(repoRoot, normalized)
  const source = readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  }).outputText
  const module = { exports: {} }
  moduleCache.set(normalized, module.exports)
  const dirname = path.dirname(filename)
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) return require(specifier)
    const target = path.resolve(dirname, specifier)
    const withExtension = /\.[cm]?[jt]sx?$/.test(target) ? target : `${target}.ts`
    return loadTsModule(path.relative(repoRoot, withExtension))
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
    module.exports,
    localRequire,
    module,
    filename,
    dirname
  )
  moduleCache.set(normalized, module.exports)
  return module.exports
}

const projection = loadTsModule('src/renderer/src/components/experience/welcome-session-projection.ts')
const draftPersistence = loadTsModule('src/renderer/src/store/welcome-draft-persistence.ts')
const provider = { models: ['claude-sonnet', 'claude-opus'] }

assert.deepEqual(
  projection.welcomeDefaultComputeSelection(provider, 'claude-sonnet'),
  { model: 'claude-sonnet', routingMode: 'fixed' },
  'A concrete default model must create a fixed Provider session'
)

verifyPersistedWelcomeDraftMigration()
assert.deepEqual(
  projection.welcomeDefaultComputeSelection(provider, 'auto'),
  { model: 'auto', routingMode: 'provider' },
  'An automatic default model must remain inside the default Provider'
)
assert.deepEqual(
  projection.welcomeDefaultComputeSelection(provider, 'missing-model'),
  { model: 'auto', routingMode: 'provider' },
  'A stale default model must fail closed to Provider-scoped automatic routing'
)
assert.deepEqual(
  projection.welcomeDefaultComputeSelection(undefined, 'auto'),
  { model: '', routingMode: 'global' },
  'No default Provider should preserve the explicit global routing path'
)

const baseDraft = {
  cwd: 'C:/qa',
  driveMode: 'forge',
  model: 'claude-sonnet',
  taskStrategy: 'execute',
  providerId: 'slot-2',
  routingMode: 'fixed',
  unassigned: false
}
const fixedAssistant = projection.welcomeSessionOptions('assistant', baseDraft, 'read only')
assert.equal(fixedAssistant.driveMode, 'core')
assert.equal(fixedAssistant.providerId, 'slot-2')
assert.equal(fixedAssistant.model, 'claude-sonnet')
assert.equal(fixedAssistant.routingScope, 'fixed')

const providerAssistant = projection.welcomeSessionOptions(
  'assistant',
  { ...baseDraft, model: 'auto', routingMode: 'provider' },
  'read only'
)
assert.equal(providerAssistant.providerId, 'slot-2')
assert.equal(providerAssistant.model, 'auto')
assert.equal(providerAssistant.routingScope, 'provider')

const globalAssistant = projection.welcomeSessionOptions(
  'assistant',
  { ...baseDraft, model: 'auto', routingMode: 'global' },
  'read only'
)
assert.equal(globalAssistant.providerId, 'auto-provider')
assert.equal(globalAssistant.model, 'auto')
assert.equal(globalAssistant.routingScope, 'global')

const draftSource = readFileSync(
  path.join(repoRoot, 'src/renderer/src/components/experience/useWelcomeDraft.ts'),
  'utf8'
)
assert.match(draftSource, /resolveWelcomeComputeSelection\(/)
assert.match(draftSource, /computeSelectionSource:\s*'user'/)

const lifecycleSource = readFileSync(path.join(repoRoot, 'src/main/session-create-lifecycle.ts'), 'utf8')
assert.match(lifecycleSource, /return opts\.providerId === AUTO_PROVIDER_ID \? AUTO_MODEL : settings\.defaultModel/)
assert.match(lifecycleSource, /if \(opts\.providerId === undefined\) return settings\.defaultProviderId\.trim\(\)/)
assert.match(lifecycleSource, /opts\.providerId === AUTO_PROVIDER_ID \? 'global' : selectedModel === AUTO_MODEL \? 'provider' : 'fixed'/)

const engineSource = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
assert.match(engineSource, /compatibleProviders = listProviders\(\)\.filter\(\(provider\) => provider\.engine === 'openai'\)/)
assert.match(engineSource, /routingProviders = this\.meta\.routingScope === 'provider'/)
assert.match(engineSource, /providers: routingProviders/)
assert.match(engineSource, /const candidates = routingProviders/)

verifyMainProcessDefaultSelection()

console.log('provider-default-session-routing-smoke: PASS')

function verifyMainProcessDefaultSelection() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-default-routing-'))
  const outDir = path.join(tempRoot, 'compiled')
  const userData = path.join(tempRoot, 'user-data')
  const projectDir = path.join(tempRoot, 'project')
  mkdirSync(userData, { recursive: true })
  mkdirSync(projectDir, { recursive: true })

  const originalLoad = require('node:module').Module._load
  try {
    compileMainLifecycle(outDir)
    require('node:module').Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return {
          app: { getPath: () => userData },
          safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (value) => Buffer.from(`fixture:${String(value)}`, 'utf8'),
            decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^fixture:/, '')
          },
          powerSaveBlocker: {
            start: () => 1,
            stop: () => undefined,
            isStarted: () => false
          }
        }
      }
      return originalLoad.call(this, request, parent, isMain)
    }

    const lifecycle = require(findCompiledModule(outDir, 'session-create-lifecycle.js'))
    const providers = require(findCompiledModule(outDir, 'providers.js'))
    const settings = require(findCompiledModule(outDir, 'settings.js'))
    const defaultModel = 'claude-default-fixture'
    const defaultProvider = providers.createProvider({
      name: 'Default Anthropic fixture',
      baseUrl: 'http://127.0.0.1:47891',
      models: [defaultModel],
      engine: 'anthropic',
      token: ['temporary', 'provider', 'routing', 'fixture', 'key'].join('-')
    })

    settings.updateSettings({
      defaultProviderId: defaultProvider.id,
      defaultModel
    })
    const fixed = lifecycle.prepareSessionCreationDraft({
      cwd: projectDir,
      initialPrompt: 'read only',
      unassigned: true
    }).baseMeta
    assert.equal(fixed.providerId, defaultProvider.id)
    assert.equal(fixed.model, defaultModel)
    assert.equal(fixed.routingScope, 'fixed')
    assert.equal(fixed.engine, 'anthropic')

    settings.updateSettings({ defaultModel: 'auto' })
    const providerAutomatic = lifecycle.prepareSessionCreationDraft({
      cwd: projectDir,
      initialPrompt: 'read only',
      unassigned: true
    }).baseMeta
    assert.equal(providerAutomatic.providerId, defaultProvider.id)
    assert.equal(providerAutomatic.model, 'auto')
    assert.equal(providerAutomatic.routingScope, 'provider')
    assert.equal(providerAutomatic.engine, 'anthropic')
  } finally {
    require('node:module').Module._load = originalLoad
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function verifyPersistedWelcomeDraftMigration() {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
  const fallback = {
    text: '',
    projectChoice: null,
    cwd: null,
    driveMode: null,
    computeSelectionSource: 'default',
    routingMode: 'global',
    providerId: null,
    model: null,
    permissionMode: null
  }
  const legacyDraft = {
    ...fallback,
    text: 'read only',
    projectChoice: 'project-slot-3',
    cwd: 'C:/qa',
    routingMode: 'global',
    providerId: 'slot-2',
    model: 'auto'
  }
  delete legacyDraft.computeSelectionSource
  storage.setItem(
    draftPersistence.WELCOME_DRAFT_STORAGE_KEY,
    JSON.stringify({ schemaVersion: 1, draft: legacyDraft })
  )

  const migrated = draftPersistence.loadWelcomeDraft(fallback, storage)
  assert.equal(migrated.computeSelectionSource, 'default')
  assert.equal(
    JSON.parse(storage.getItem(draftPersistence.WELCOME_DRAFT_STORAGE_KEY)).schemaVersion,
    3,
    'A loaded v1 draft must be rewritten as schema v3'
  )
  assert.deepEqual(
    projection.resolveWelcomeComputeSelection(
      [{ id: 'slot-2', ready: true, models: ['default-model'] }],
      'slot-2',
      'default-model',
      migrated,
      true
    ),
    { providerId: 'slot-2', model: 'default-model', routingMode: 'fixed' },
    'A legacy global/auto draft must follow the newly saved default Provider and model'
  )

  storage.setItem(
    draftPersistence.WELCOME_DRAFT_STORAGE_KEY,
    JSON.stringify({ schemaVersion: 2, draft: migrated })
  )
  assert.equal(draftPersistence.loadWelcomeDraft(fallback, storage).text, 'read only')
  assert.equal(
    JSON.parse(storage.getItem(draftPersistence.WELCOME_DRAFT_STORAGE_KEY)).schemaVersion,
    3,
    'A loaded v2 draft must be rewritten as schema v3'
  )

  const explicitLegacy = {
    ...legacyDraft,
    routingMode: 'fixed',
    providerId: 'slot-3',
    model: 'explicit-model'
  }
  storage.setItem(
    draftPersistence.WELCOME_DRAFT_STORAGE_KEY,
    JSON.stringify({ schemaVersion: 1, draft: explicitLegacy })
  )
  const migratedExplicit = draftPersistence.loadWelcomeDraft(fallback, storage)
  assert.equal(migratedExplicit.computeSelectionSource, 'user')
  assert.deepEqual(
    projection.resolveWelcomeComputeSelection(
      [
        { id: 'slot-2', ready: true, models: ['default-model'] },
        { id: 'slot-3', ready: true, models: ['explicit-model'] }
      ],
      'slot-2',
      'default-model',
      migratedExplicit,
      true
    ),
    { providerId: 'slot-3', model: 'explicit-model', routingMode: 'fixed' },
    'A provably explicit legacy selection must remain stable'
  )
}

function compileMainLifecycle(outDir) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/session-create-lifecycle.ts',
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
  if (findCompiledModuleOptional(outDir, 'session-create-lifecycle.js')) return
  process.stderr.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  throw new Error('failed to compile main-process session lifecycle fixture')
}

function findCompiledModule(root, fileName) {
  const found = findCompiledModuleOptional(root, fileName)
  if (!found) throw new Error(`compiled module not found: ${fileName}`)
  return found
}

function findCompiledModuleOptional(root, fileName) {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        const found = findCompiledModuleOptional(fullPath, fileName)
        if (found) return found
      } else if (entry.isFile() && entry.name === fileName) {
        return fullPath
      }
    }
  } catch {
    return undefined
  }
  return undefined
}
