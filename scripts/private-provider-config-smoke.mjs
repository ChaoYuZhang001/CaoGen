#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PrivateProviderConfigError,
  defaultPrivateProviderConfigPath,
  resolvePrivateProviderConfig
} from './lib/private-provider-config.mjs'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const { loadPrivateChatProvider } = require('./lib/private-provider-e2e.cjs')
const tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'caogen-private-provider-config-')))
const testHome = path.join(tempRoot, 'home')
const privateDir = path.join(testHome, '.caogen-private')
const providerFile = path.join(privateDir, 'provider-parity.json')
const fixtureCredential = ['private', 'provider', 'credential', 'canary'].join('-')

try {
  mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  chmodSync(privateDir, 0o700)
  writeProviderFile(providerFile)

  assert.equal(defaultPrivateProviderConfigPath(testHome), providerFile)
  const loaded = resolvePrivateProviderConfig({ homeDirectory: testHome, repoRoot })
  assert.equal(loaded.source, 'private-default')
  assert.equal(JSON.parse(loaded.text)[0].apiKey, fixtureCredential)

  if (process.platform !== 'win32') {
    chmodSync(providerFile, 0o644)
    assertConfigError(
      () => resolvePrivateProviderConfig({ homeDirectory: testHome, repoRoot }),
      'provider_config_permissions'
    )
    chmodSync(providerFile, 0o600)

    chmodSync(privateDir, 0o755)
    assertConfigError(
      () => resolvePrivateProviderConfig({ homeDirectory: testHome, repoRoot }),
      'provider_config_directory_permissions'
    )
    chmodSync(privateDir, 0o700)
  }

  assertConfigError(
    () => resolvePrivateProviderConfig({ setting: providerFile, repoRoot }),
    'provider_config_override_disabled'
  )

  const symlinkFile = linkedProviderFile()
  assertConfigError(
    () => resolvePrivateProviderConfig({ setting: symlinkFile, repoRoot, allowTestOverride: true }),
    'provider_config_not_regular'
  )

  assertConfigError(
    () => resolvePrivateProviderConfig({
      setting: JSON.stringify([{ apiKey: fixtureCredential }]),
      repoRoot,
      allowTestOverride: true
    }),
    'provider_config_inline_disabled'
  )
  const inlineFixture = resolvePrivateProviderConfig({
    setting: JSON.stringify([{ apiKey: fixtureCredential }]),
    repoRoot,
    allowInline: true,
    allowTestOverride: true
  })
  assert.equal(inlineFixture.source, 'inline')

  await verifyRealProviderE2ePolicy()
  verifyProductionOverrideIsBlocked()
  verifyForcedGitAddIsBlocked()
  console.log('private provider config smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function writeProviderFile(file) {
  writeFileSync(file, `${JSON.stringify([{
    id: 'fixture',
    group: 'baseline',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    model: 'fixture-model',
    apiKey: fixtureCredential
  }])}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

function linkedProviderFile() {
  if (process.platform !== 'win32') {
    const link = path.join(privateDir, 'symlink.json')
    symlinkSync(providerFile, link)
    return link
  }
  const targetDirectory = path.join(tempRoot, 'provider-link-target')
  const junction = path.join(privateDir, 'provider-junction')
  mkdirSync(targetDirectory)
  copyFileSync(providerFile, path.join(targetDirectory, 'provider.json'))
  symlinkSync(targetDirectory, junction, 'junction')
  return path.join(junction, 'provider.json')
}

function assertConfigError(action, code) {
  assert.throws(action, (error) =>
    error instanceof PrivateProviderConfigError && error.code === code)
}

async function verifyRealProviderE2ePolicy() {
  const previousLegacyKey = process.env.CHAT_E2E_KEY
  process.env.CHAT_E2E_KEY = 'legacy-environment-credential-canary'
  try {
    const skipped = await loadPrivateChatProvider(repoRoot, { homeDirectory: testHome, enabled: false })
    assert.equal(skipped.state, 'skipped')

    const loaded = await loadPrivateChatProvider(repoRoot, { homeDirectory: testHome, enabled: true })
    assert.equal(loaded.state, 'ready')
    assert.equal(loaded.provider.apiKey, fixtureCredential)
    assert.notEqual(loaded.provider.apiKey, process.env.CHAT_E2E_KEY)
  } finally {
    if (previousLegacyKey === undefined) delete process.env.CHAT_E2E_KEY
    else process.env.CHAT_E2E_KEY = previousLegacyKey
  }

  for (const file of [
    'scripts/chat-protocol-e2e.cjs',
    'scripts/coding-agent-e2e.cjs',
    'scripts/cross-route-e2e.cjs',
    'scripts/orchestration-e2e.cjs',
    'scripts/stress-32-agents.cjs'
  ]) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8')
    assert.match(source, /private-provider-e2e\.cjs/)
    assert.doesNotMatch(source, /CHAT_E2E_(?:KEY|BASE_URL|MODEL)/)
    assert.doesNotMatch(source, /api\.deepseek\.com/i)
  }
}

function verifyProductionOverrideIsBlocked() {
  const reportRoot = path.join(tempRoot, 'override-blocked-report')
  const result = spawnSync(process.execPath, ['scripts/china-tool-call-parity.mjs', '--required'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAOGEN_PRIVATE_PROVIDER_TEST_MODE: '',
      CAOGEN_CHINA_TOOL_CALL_PARITY: '1',
      CAOGEN_CHINA_PARITY_PROVIDERS: providerFile,
      CAOGEN_CHINA_TOOL_CALL_PARITY_REPORT_ROOT: reportRoot
    }
  })
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1)
  assert.match(output, /provider_config_override_disabled/)
  assert.equal(output.includes(fixtureCredential), false)
}

function verifyForcedGitAddIsBlocked() {
  const gitRoot = path.join(tempRoot, 'git-scan')
  const scanner = path.join(gitRoot, 'scripts', 'secret-scan.mjs')
  const forcedPrivateFile = path.join(gitRoot, '.caogen-private', 'provider-parity.json')
  mkdirSync(path.dirname(scanner), { recursive: true })
  mkdirSync(path.dirname(forcedPrivateFile), { recursive: true })
  copyFileSync(path.join(repoRoot, 'scripts', 'secret-scan.mjs'), scanner)
  writeFileSync(forcedPrivateFile, JSON.stringify([{ apiKey: fixtureCredential }]), { mode: 0o600 })
  runGit(gitRoot, ['init', '--quiet'])
  runGit(gitRoot, ['add', '-f', '.caogen-private/provider-parity.json', 'scripts/secret-scan.mjs'])

  const result = spawnSync(process.execPath, ['scripts/secret-scan.mjs'], {
    cwd: gitRoot,
    encoding: 'utf8'
  })
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1)
  assert.match(output, /caogen-private-config/)
  assert.equal(output.includes(fixtureCredential), false)
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
