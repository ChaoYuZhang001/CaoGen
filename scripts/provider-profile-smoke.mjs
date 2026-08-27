#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { provider, verifyOperationJournalFileGuards } from './lib/provider-profile-smoke-helpers.mjs'
import { createProviderEvidenceReport, markProviderEvidenceFailed, markProviderEvidencePassed, writeProviderEvidenceReport } from './lib/provider-evidence-report.mjs'
import { readSourceEvidenceState } from './lib/source-evidence-binding.mjs'
const repoRoot = process.cwd()
const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-profile-smoke-'))
const outDir = path.join(tempRoot, 'compiled')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'provider-profile-smoke'); const reportDir = path.join(reportRoot, runId)
const checks = []
const backupPersistentPlaintextCanary = ['provider', 'profile', 'persistent', 'canary'].join('-')
const backupPersistentCipherCanary = Buffer.from(backupPersistentPlaintextCanary, 'utf8').toString('base64')
const backupSessionCanary = ['provider', 'profile', 'session', 'canary'].join('-')
const backupSensitiveMarkers = [backupPersistentPlaintextCanary, backupPersistentCipherCanary, backupSessionCanary]
let report = createProviderEvidenceReport(runId, 'test:provider-profile', checks); let runError; let stdoutLines = []
try {
  compile(outDir)
  const userDataDir = path.join(tempRoot, 'user-data')
  installElectronStub(outDir, userDataDir)
  const profile = await import(pathToFileURL(findCompiled(outDir, 'providerProfile.js')).href)
  const profileService = await import(pathToFileURL(findCompiled(outDir, 'providerProfileService.js')).href)
  const profileStore = await import(pathToFileURL(findCompiled(outDir, 'providerProfileStore.js')).href)
  const operationJournal = await import(pathToFileURL(findCompiled(outDir, 'providerProfileOperationJournal.js')).href)
  const providersApi = await import(pathToFileURL(findCompiled(outDir, 'providers.js')).href)
  verifyOperationJournalFileGuards(operationJournal, tempRoot, assert)
  const existing = [
    {
      ...provider('alpha', 'Alpha Gateway', 'https://alpha.example/v1', ['alpha-old']),
      keyCount: 1,
      activeKeyLabel: 'primary',
      authorization: {
        schemaVersion: 1,
        method: 'oauth',
        status: 'authorized',
        accountId: 'acct-alpha',
        accountLabel: 'Alpha account'
      },
      advancedConfig: {
        schemaVersion: 1,
        modelProfiles: [{
          model: 'alpha-old',
          aliases: ['alpha-latest'],
          pricing: {
            currency: 'USD',
            inputPerMillion: 1,
            outputPerMillion: 2,
            source: 'provider'
          }
        }],
        appBindings: {
          claude: { modelMap: { sonnet: 'alpha-old' } }
        }
      }
    },
    provider('target-owner', 'Target Owner', 'https://shared.example/v1', ['shared-model']),
    provider('name-owner', 'Name Collision', 'https://name.example/v1', ['name-model'])
  ]

  const exported = profile.renderProviderProfile(existing, '2026-07-29T00:00:00.000Z')
  assert(exported.includes('caogen-provider-profile'), 'export must carry the CaoGen profile schema')
  assert(!/(?:apiKeys|encryptedToken|activeKeyId|tokenLabel)/.test(exported), 'export must not contain credential fields')
  const parsedExport = profile.parseProviderProfile(exported)
  equal(parsedExport.entries.length, existing.length, 'exported provider count')
  equal(parsedExport.entries[0].authorization?.status, 'authorized', 'authorization metadata must round-trip')
  equal(parsedExport.entries[0].advancedConfig?.modelProfiles?.[0]?.pricing?.outputPerMillion, 2,
    'model pricing must round-trip')
  equal(parsedExport.entries[0].advancedConfig?.appBindings?.claude?.modelMap?.sonnet, 'alpha-old',
    'app binding model map must round-trip')

  const ignoredCredential = ['ignored', 'fixture'].join('-')
  const imported = profile.parseProviderProfile(JSON.stringify({
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [
      {
        name: 'Alpha Gateway',
        baseUrl: 'https://alpha.example/v1',
        engine: 'openai',
        openaiProtocol: 'chat',
        models: ['alpha-new'],
        apiKey: ignoredCredential
      },
      {
        name: 'New Local',
        baseUrl: 'http://127.0.0.1:11434/v1/',
        engine: 'openai',
        authMode: 'none',
        openaiProtocol: 'chat',
        models: ['local-model']
      }
    ]
  }))
  equal(imported.credentialFieldsIgnored, 1, 'credential field count')
  assert(!JSON.stringify(imported.entries).includes(ignoredCredential), 'ignored credential must not enter parsed entries')

  assertThrows(() => profile.parseProviderProfile(JSON.stringify({
    providers: [{
      name: 'Credential-like advanced config',
      baseUrl: 'https://advanced.example/v1',
      engine: 'openai',
      models: ['advanced-model'],
      advancedConfig: { request: { headers: { authorization: 'must-not-enter' } } }
    }]
  })), 'advanced config must reject credential headers')

  const plan = profile.planProviderProfileImport(imported.entries, existing)
  equal(plan[0].view.defaultAction, 'update', 'matching provider should update')
  equal(plan[0].view.targetProviderId, 'alpha', 'matching provider target')
  equal(plan[0].view.targetKeyCount, 1, 'matching provider preview must expose target key count')
  equal(plan[0].view.targetActiveKeyLabel, 'primary',
    'matching provider preview must expose the active key label')
  assert(plan[0].view.changedFields.includes('models'), 'model change must be visible in preview')
  equal(plan[1].view.defaultAction, 'create', 'new provider should create')
  equal(plan[1].view.authMode, 'none', 'local no-auth mode must survive import preview')
  equal(plan[1].input.authMode, 'none', 'local no-auth mode must survive import planning')
  equal(plan[1].view.baseUrl, 'http://127.0.0.1:11434/v1', 'preview must expose only normalized Base URL')

  const remoteNoAuthError = captureError(() => profile.planProviderProfileImport([{
    name: 'Remote no-auth',
    baseUrl: 'https://remote.example/v1',
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat',
    models: ['remote-model']
  }], existing))
  assert(/回环|无需密钥/.test(remoteNoAuthError), 'remote authMode:none must fail before preview')

  const urlSecret = ['profile', 'url', 'canary'].join('-')
  const sensitiveUrlError = captureError(() => profile.planProviderProfileImport([{
    name: 'Sensitive URL',
    baseUrl: `https://user:${urlSecret}@gateway.example/v1`,
    engine: 'openai',
    openaiProtocol: 'chat',
    models: ['sensitive-model']
  }], existing))
  assert(/Base URL|用户名|密码|userinfo/.test(sensitiveUrlError), 'sensitive Base URL must fail before preview')
  assert(!sensitiveUrlError.includes(urlSecret), 'sensitive Base URL error must not echo credential material')

  const unchanged = profile.planProviderProfileImport(parsedExport.entries.slice(0, 1), existing)
  equal(unchanged[0].view.defaultAction, 'skip', 'unchanged provider should skip')

  const ambiguous = profile.planProviderProfileImport([{
    name: 'Name Collision',
    baseUrl: 'https://shared.example/v1',
    engine: 'openai',
    openaiProtocol: 'chat',
    models: ['ambiguous']
  }], existing)
  equal(ambiguous[0].view.conflict, 'ambiguous', 'split name/target match must be ambiguous')
  equal(ambiguous[0].view.defaultAction, 'skip', 'ambiguous import must fail closed to skip')
  assert(!ambiguous[0].view.allowedActions.includes('update'), 'ambiguous import must not allow update')

  const nameTargetMismatch = profile.planProviderProfileImport([{
    name: 'Alpha Gateway',
    baseUrl: 'https://attacker.example/v1',
    engine: 'openai',
    openaiProtocol: 'chat',
    models: ['attacker-model']
  }], existing)
  equal(nameTargetMismatch[0].view.conflict, 'name', 'same name with a different target must be a name conflict')
  equal(nameTargetMismatch[0].view.defaultAction, 'skip', 'name-only target mismatch must fail closed to skip')
  assert(!nameTargetMismatch[0].view.allowedActions.includes('update'),
    'name-only target mismatch must not reuse the existing Provider credential binding')

  assertThrows(
    () => profile.parseProviderProfile(JSON.stringify({ providers: [
      { name: 'Duplicate', baseUrl: 'https://one.example/v1', models: [] },
      { name: 'duplicate', baseUrl: 'https://two.example/v1', models: [] }
    ] })),
    'duplicate provider names must be rejected'
  )
  assertThrows(
    () => profile.parseProviderProfile(JSON.stringify({ providers: [
      {
        name: 'DeepSeek implicit Anthropic path',
        baseUrl: 'https://api.deepseek.com',
        engine: 'anthropic',
        models: ['deepseek-chat']
      },
      {
        name: 'DeepSeek explicit Anthropic path',
        baseUrl: 'https://api.deepseek.com/anthropic',
        engine: 'anthropic',
        models: ['deepseek-chat']
      }
    ] })),
    'duplicate targets must be rejected after engine-specific Base URL normalization'
  )

  const caseSensitivePath = profile.planProviderProfileImport([{
    name: 'Case-sensitive path import',
    baseUrl: 'https://gateway.example/tenanta/v1',
    engine: 'openai',
    openaiProtocol: 'chat',
    models: ['case-model']
  }], [provider('case-path', 'Case-sensitive path existing', 'https://gateway.example/TenantA/v1', ['case-model'])])
  equal(caseSensitivePath[0].view.conflict, 'none', 'target matching must preserve URL path case')
  const canonicalHost = profile.planProviderProfileImport([{
    name: 'Canonical host',
    baseUrl: 'https://gateway.example/v1',
    engine: 'openai',
    openaiProtocol: 'chat',
    models: ['case-model']
  }], [provider('canonical-host', 'Canonical host', 'HTTPS://GATEWAY.EXAMPLE:443/v1/', ['case-model'])])
  equal(canonicalHost[0].view.conflict, 'same_provider',
    'target matching must normalize scheme, hostname, default port, and trailing slash')

  const ipv6Loopback = profile.planProviderProfileImport([{
    name: 'IPv6 local runtime',
    baseUrl: 'http://[::1]:11434/v1',
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat',
    models: ['ipv6-local']
  }], existing)
  equal(ipv6Loopback[0].input.authMode, 'none', 'IPv6 loopback must support local no-auth mode')
  for (const baseUrl of ['http://[::2]:11434/v1', 'https://[::1]:11434/v1']) {
    assertThrows(() => profile.planProviderProfileImport([{
      name: `Rejected IPv6 ${baseUrl}`,
      baseUrl,
      engine: 'openai',
      authMode: 'none',
      openaiProtocol: 'chat',
      models: ['ipv6-rejected']
    }], existing), `${baseUrl} must not qualify as an HTTP loopback no-auth target`)
  }

  const urlCanary = ['sk', 'profile', 'url', 'canary'].join('-')
  for (const [name, baseUrl] of [
    ['URL Userinfo', `https://profile:${urlCanary}@userinfo.example/v1`],
    ['URL Query', `https://query.example/v1?token=${urlCanary}`],
    ['URL Protocol', `file:///tmp/${urlCanary}`],
    ['URL Credential Path', `https://path.example/v1/${urlCanary}`]
  ]) {
    const error = capturedError(() => profile.planProviderProfileImport([{
      name,
      baseUrl,
      engine: 'openai',
      models: ['profile-model']
    }], existing))
    assert(error instanceof Error, `${name} must be rejected before preview`)
    assert(!error.message.includes(urlCanary), `${name} error must not echo URL credentials`)
  }

  for (const entry of [
    {
      name: 'Remote No Auth',
      baseUrl: 'https://remote-none.example/v1',
      engine: 'openai',
      authMode: 'none',
      models: ['remote-none']
    },
    {
      name: 'Anthropic No Auth',
      baseUrl: 'http://127.0.0.1:11435',
      engine: 'anthropic',
      authMode: 'none',
      models: ['anthropic-none']
    },
    {
      name: 'Claude No Auth',
      baseUrl: 'http://localhost:11436',
      engine: 'claude',
      authMode: 'none',
      models: ['claude-none']
    }
  ]) {
    assertThrows(
      () => profile.planProviderProfileImport([entry], existing),
      `${entry.name} must reject authMode none`
    )
  }

  const localInput = {
    name: 'Local Runtime',
    baseUrl: 'http://127.0.0.1:11434/v1/',
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat',
    models: ['local-initial']
  }
  const created = profileStore.applyProviderProfileMutations([{
    action: 'create',
    input: localInput
  }])
  equal(created.length, 1, 'store create count')
  equal(created[0].authMode, 'none', 'store create must preserve local no-auth mode')
  assert(created[0].ready === true && created[0].hasToken === false,
    'local no-auth provider must be immediately routable without a credential')

  const providersPath = path.join(userDataDir, 'providers.json')
  const persistedAfterCreate = readProviderEntries(providersPath)
  equal(persistedAfterCreate[0].authMode, 'none', 'local no-auth mode must be written to disk')
  const restartedAfterCreate = loadProvidersInFreshProcess(findCompiled(outDir, 'providers.js'))
  equal(restartedAfterCreate[0].authMode, 'none', 'local no-auth mode must survive a fresh process')
  assert(restartedAfterCreate[0].ready === true && restartedAfterCreate[0].hasToken === false,
    'fresh process must route the local no-auth provider without a credential')

  const beforeDuplicateMutation = readFileSync(providersPath, 'utf8')
  assertThrows(() => profileStore.applyProviderProfileMutations([
    {
      action: 'create',
      input: {
        name: 'Store implicit Anthropic path',
        baseUrl: 'https://api.deepseek.com',
        engine: 'anthropic',
        models: ['deepseek-chat']
      }
    },
    {
      action: 'create',
      input: {
        name: 'Store explicit Anthropic path',
        baseUrl: 'https://api.deepseek.com/anthropic',
        engine: 'anthropic',
        models: ['deepseek-chat']
      }
    }
  ]), 'Store must reject normalized duplicate targets defensively')
  equal(readFileSync(providersPath, 'utf8'), beforeDuplicateMutation,
    'normalized duplicate Store mutation must be atomic and leave disk unchanged')
  equal(providersApi.listProviders().length, 1,
    'normalized duplicate Store mutation must leave memory unchanged')

  const beforeRejectedMutation = readFileSync(providersPath, 'utf8')
  const directRemoteNoAuthError = captureError(() => profileStore.applyProviderProfileMutations([{
    action: 'create',
    input: {
      name: 'Direct Remote No Auth',
      baseUrl: 'https://remote-direct.example/v1',
      engine: 'openai',
      authMode: 'none',
      openaiProtocol: 'chat',
      models: ['remote-direct']
    }
  }]))
  assert(/\u56de\u73af|\u65e0\u9700\u5bc6\u94a5/.test(directRemoteNoAuthError),
    'store must reject remote no-auth mutations that bypass import planning')
  equal(readFileSync(providersPath, 'utf8'), beforeRejectedMutation,
    'rejected remote no-auth mutation must leave the persisted store unchanged')
  equal(providersApi.listProviders().length, 1,
    'rejected remote no-auth mutation must leave the in-memory store unchanged')

  const snapshotFixture = providersApi.createProvider({
    name: 'Authoritative snapshot fixture',
    baseUrl: 'https://snapshot.example/v1',
    engine: 'openai',
    authMode: 'api-key',
    openaiProtocol: 'chat',
    models: ['snapshot-model'],
    customHeaders: 'X-Route: blue',
    credentialHeaderNames: ['x-api-key'],
    budgetUsd: 12,
    note: 'remove on snapshot import'
  })
  const snapshotPlan = profile.planProviderProfileImport([{
    name: snapshotFixture.name,
    baseUrl: snapshotFixture.baseUrl,
    engine: 'openai',
    authMode: 'api-key',
    openaiProtocol: 'chat',
    models: ['snapshot-model']
  }], providersApi.listProviders())
  equal(snapshotPlan[0].view.defaultAction, 'update', 'authoritative snapshot fixture must plan an update')
  equal(snapshotPlan[0].view.targetCredentialBindingChanged, true,
    'clearing custom and credential headers must flag a target credential binding change')
  for (const field of ['customHeaders', 'credentialHeaderNames', 'budgetUsd', 'note']) {
    assert(snapshotPlan[0].view.changedFields.includes(field), `${field} clear must be visible in preview`)
  }
  const snapshotApplied = profileStore.applyProviderProfileMutations([{
    action: 'update',
    targetProviderId: snapshotFixture.id,
    input: snapshotPlan[0].input
  }]).find((provider) => provider.id === snapshotFixture.id)
  assert(
    snapshotApplied?.customHeaders === undefined
      && snapshotApplied.credentialHeaderNames?.join(',') === 'authorization'
      && snapshotApplied.budgetUsd === 0
      && snapshotApplied.note === undefined,
    'authoritative snapshot apply must clear optional fields and restore the safe credential-header default'
  )
  const protocolCleared = profileStore.applyProviderProfileMutations([{
    action: 'update',
    targetProviderId: snapshotFixture.id,
    input: {
      name: snapshotFixture.name,
      baseUrl: snapshotFixture.baseUrl,
      engine: 'openai',
      authMode: 'api-key',
      models: ['snapshot-model']
    }
  }]).find((provider) => provider.id === snapshotFixture.id)
  equal(protocolCleared?.openaiProtocol, undefined,
    'authoritative snapshot Store update must clear an omitted OpenAI protocol')

  const importPath = path.join(tempRoot, 'service-import.json')
  writeFileSync(importPath, JSON.stringify({
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [
      {
        ...localInput,
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: ['local-imported']
      },
      {
        name: 'Second Local Runtime',
        baseUrl: 'http://localhost:11435/v1',
        engine: 'openai',
        authMode: 'none',
        openaiProtocol: 'responses',
        models: ['second-local']
      }
    ]
  }, null, 2), { mode: 0o600 })

  if (process.platform !== 'win32') {
    const symlinkPath = path.join(tempRoot, 'service-import-link.json')
    symlinkSync(importPath, symlinkPath)
    assert(/常规文件/.test(captureError(() => profileService.previewProviderProfileFile(symlinkPath))),
      'service preview must reject symbolic links')
  }
  const oversizedPath = path.join(tempRoot, 'service-import-oversized.json')
  writeFileSync(oversizedPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), { mode: 0o600 })
  assert(/文件过大/.test(captureError(() => profileService.previewProviderProfileFile(oversizedPath))),
    'service preview must reject files larger than its bounded read limit')

  const preview = profileService.previewProviderProfileFile(importPath)
  equal(preview.updateCount, 1, 'service preview update count')
  equal(preview.createCount, 1, 'service preview create count')
  providersApi.updateProvider(created[0].id, { models: ['concurrent-change'] })
  const automaticBackups = profileService.listProviderProfileBackups()
  assert(automaticBackups.some((backup) => backup.reason === 'provider-create'),
    'ordinary Provider creation must create an automatic configuration version')
  assert(automaticBackups.some((backup) => backup.reason === 'provider-update'),
    'ordinary Provider update must create an automatic configuration version')
  const automaticBackupCount = automaticBackups.length
  providersApi.updateProvider(created[0].id, {})
  equal(profileService.listProviderProfileBackups().length, automaticBackupCount,
    'no-op Provider update must not create an automatic configuration version')
  const afterConcurrentMutation = readFileSync(providersPath, 'utf8')
  const backupsBeforeStaleApply = profileService.listProviderProfileBackups().length
  const staleApplyError = captureError(() => profileService.applyProviderProfilePreview(preview.previewId, []))
  assert(/\u9884\u89c8\u540e\u5df2\u53d8\u5316|\u91cd\u65b0\u9884\u89c8/.test(staleApplyError),
    'apply must reject provider configuration drift after preview')
  equal(readFileSync(providersPath, 'utf8'), afterConcurrentMutation,
    'stale apply must preserve the concurrently updated provider store')
  equal(profileService.listProviderProfileBackups().length, backupsBeforeStaleApply,
    'stale apply must not create a misleading backup')
  assert(/\u9884\u89c8\u5df2\u5931\u6548/.test(captureError(
    () => profileService.applyProviderProfilePreview(preview.previewId, [])
  )), 'stale preview must be consumed after drift rejection')

  const reboundPreview = profileService.previewProviderProfileFile(importPath)
  const applied = profileService.applyProviderProfilePreview(reboundPreview.previewId, [])
  equal(applied.updated, 1, 're-preview apply update count')
  equal(applied.created, 1, 're-preview apply create count')
  equal(profileService.listProviderProfileBackups().length, backupsBeforeStaleApply + 1,
    'successful apply must create one rollback backup')
  const appliedLocal = applied.providers.find((provider) => provider.id === created[0].id)
  const appliedSecond = applied.providers.find((provider) => provider.name === 'Second Local Runtime')
  assert(appliedLocal?.models.join(',') === 'local-imported' && appliedLocal.authMode === 'none',
    're-preview must apply the requested local update')
  assert(appliedSecond?.authMode === 'none' && appliedSecond.ready === true && appliedSecond.hasToken === false,
    'profile create must persist a routable local no-auth provider')
  const restartedAfterApply = loadProvidersInFreshProcess(findCompiled(outDir, 'providers.js'))
  const restartedSecond = restartedAfterApply.find((provider) => provider.name === 'Second Local Runtime')
  assert(restartedSecond?.authMode === 'none' && restartedSecond.ready === true && restartedSecond.hasToken === false,
    'profile-created local no-auth provider must survive a fresh process')

  const targetCredentialCanary = ['target', 'credential', 'canary'].join('-')
  const targetBound = providersApi.createProvider({
    name: 'Target-bound credential',
    baseUrl: 'https://trusted.example/v1',
    engine: 'openai',
    authMode: 'api-key',
    openaiProtocol: 'chat',
    models: ['trusted-model'],
    token: targetCredentialCanary
  })
  assert(providersApi.resolveProviderToken(providersApi.getProvider(targetBound.id)).token === targetCredentialCanary,
    'target-bound fixture must start with a usable credential')
  const retargeted = profileStore.applyProviderProfileMutations([{
    action: 'update',
    targetProviderId: targetBound.id,
    input: {
      name: targetBound.name,
      baseUrl: 'https://attacker.example/v1',
      engine: 'openai',
      authMode: 'api-key',
      openaiProtocol: 'chat',
      models: ['attacker-model']
    }
  }]).find((provider) => provider.id === targetBound.id)
  assert(retargeted?.credentialMigrationRequired === true && retargeted.ready === false && retargeted.hasToken === false,
    'defense-in-depth Store update must quarantine credentials after target drift')
  equal(providersApi.resolveProviderToken(providersApi.getProvider(targetBound.id)).token, '',
    'quarantined target credentials must not resolve at runtime')
  const reboundCredential = ['rebound', 'credential', 'canary'].join('-')
  const rebound = providersApi.updateProvider(targetBound.id, { token: reboundCredential })
  assert(rebound.credentialMigrationRequired === false && rebound.ready === true,
    'explicit credential replacement must rebind the changed target')
  equal(providersApi.resolveProviderToken(providersApi.getProvider(targetBound.id)).token, reboundCredential,
    'only the explicitly replaced target credential may resolve')

  const discoveryRequests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    discoveryRequests.push(new Headers(init?.headers))
    return new Response(JSON.stringify({ data: [{ id: 'local-no-auth-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  try {
    const localBaseUrl = 'http://127.0.0.1:11438/v1'
    const noAuthCredentialCanary = ['local', 'credential', 'canary'].join('-')
    const defaultHeaderDiscovery = await providersApi.fetchModels({
      baseUrl: localBaseUrl,
      token: noAuthCredentialCanary,
      authMode: 'api-key',
      openaiProtocol: 'chat'
    })
    assert(defaultHeaderDiscovery.ok && discoveryRequests.length > 0,
      'unsaved API-key model discovery must work without manually configuring a credential header')
    assert(discoveryRequests.every((headers) =>
      headers.get('authorization') === `Bearer ${noAuthCredentialCanary}` && !headers.has('x-api-key')),
    'unsaved OpenAI-compatible model discovery must inject the key as Authorization Bearer by default')

    discoveryRequests.length = 0
    const explicitHeaderDiscovery = await providersApi.fetchModels({
      baseUrl: localBaseUrl,
      token: noAuthCredentialCanary,
      authMode: 'api-key',
      openaiProtocol: 'chat',
      credentialHeaderNames: ['x-api-key']
    })
    assert(explicitHeaderDiscovery.ok && discoveryRequests.length > 0,
      'explicit managed credential headers must remain supported during model discovery')
    assert(discoveryRequests.every((headers) =>
      headers.get('x-api-key') === noAuthCredentialCanary && !headers.has('authorization')),
    'explicit x-api-key model discovery must not leak the credential into Authorization')

    discoveryRequests.length = 0
    const keyedLocal = providersApi.createProvider({
      name: 'Keyed local before no-auth',
      baseUrl: localBaseUrl,
      engine: 'openai',
      authMode: 'api-key',
      openaiProtocol: 'chat',
      models: ['local-no-auth-model'],
      token: noAuthCredentialCanary,
      credentialHeaderNames: ['x-api-key']
    })
    const authlessLocal = profileStore.applyProviderProfileMutations([{
      action: 'update',
      targetProviderId: keyedLocal.id,
      input: {
        name: keyedLocal.name,
        baseUrl: localBaseUrl,
        engine: 'openai',
        authMode: 'none',
        openaiProtocol: 'chat',
        models: ['local-no-auth-model'],
        credentialHeaderNames: ['x-api-key']
      }
    }]).find((provider) => provider.id === keyedLocal.id)
    assert(authlessLocal?.authMode === 'none' && authlessLocal.ready === true && authlessLocal.hasToken === false,
      'switching a keyed local Provider to no-auth must suppress all stored credentials')
    const authlessStored = providersApi.getProvider(keyedLocal.id)
    assert(authlessStored?.encryptedToken === '' && authlessStored.apiKeys?.length === 0 && !authlessStored.activeKeyId,
      'switching a keyed local Provider to no-auth must erase dormant credential records')
    equal(providersApi.resolveProviderToken(providersApi.getProvider(keyedLocal.id)).token, '',
      'no-auth Provider token resolution must remain empty after credential erasure')
    assert(Object.keys(providersApi.providerCredentialHeaders(
      providersApi.getProvider(keyedLocal.id), noAuthCredentialCanary
    )).length === 0, 'no-auth Provider must suppress managed credential headers defensively')

    const discovered = await providersApi.fetchModels({
      providerId: keyedLocal.id,
      baseUrl: localBaseUrl,
      authMode: 'none',
      openaiProtocol: 'chat'
    })
    assert(discovered.ok && discovered.models.includes('local-no-auth-model'),
      'saved no-auth Provider model discovery must work without a credential')
    assert(discoveryRequests.length > 0 && discoveryRequests.every((headers) =>
      !headers.has('authorization') && !headers.has('x-api-key')),
    'saved no-auth model discovery must send neither Authorization nor managed API-key headers')

    discoveryRequests.length = 0
    const unsavedDiscovery = await providersApi.fetchModels({
      baseUrl: localBaseUrl,
      token: noAuthCredentialCanary,
      authMode: 'none',
      openaiProtocol: 'chat',
      credentialHeaderNames: ['x-api-key']
    })
    assert(unsavedDiscovery.ok && discoveryRequests.length > 0,
      'unsaved loopback no-auth discovery must remain available')
    assert(discoveryRequests.every((headers) =>
      !headers.has('authorization') && !headers.has('x-api-key')),
    'unsaved no-auth discovery must ignore supplied credential material')

    const directCredentialCanary = ['direct', 'no-auth', 'canary'].join('-')
    const directKeyed = providersApi.createProvider({
      name: 'Direct keyed local before no-auth',
      baseUrl: 'http://localhost:11440/v1',
      engine: 'openai',
      authMode: 'api-key',
      openaiProtocol: 'chat',
      models: ['direct-local-model'],
      token: directCredentialCanary
    })
    assert(directKeyed.credentialHeaderNames?.join(',') === 'authorization',
      'new OpenAI-compatible Providers must persist the Authorization default')
    assert(providersApi.providerCredentialHeaders(
      providersApi.getProvider(directKeyed.id), directCredentialCanary
    ).authorization === `Bearer ${directCredentialCanary}`,
    'new OpenAI-compatible Providers must inject their saved key without extra header configuration')
    const directNoAuth = providersApi.updateProvider(directKeyed.id, { authMode: 'none' })
    const directNoAuthStored = providersApi.getProvider(directKeyed.id)
    assert(directNoAuth.authMode === 'none' && directNoAuth.hasToken === false && directNoAuth.ready === true,
      'direct Provider edit must switch a loopback target to no-auth')
    assert(directNoAuthStored?.encryptedToken === '' && directNoAuthStored.apiKeys?.length === 0,
      'direct Provider edit to no-auth must erase stored credentials')
    const directRekeyRequired = providersApi.updateProvider(directKeyed.id, { authMode: 'api-key' })
    assert(directRekeyRequired.ready === false && directRekeyRequired.hasToken === false,
      'switching back to API-key mode must require an explicitly re-entered credential')
  } finally {
    globalThis.fetch = originalFetch
  }

  const backupProviderId = 'credential-backup-provider'
  const backupKeyId = 'credential-backup-key'
  const persistentEncryptedToken = `enc:${backupPersistentCipherCanary}`
  profileStore.restoreProviderStoreBackup([{
    id: backupProviderId,
    name: 'Credential Backup Provider',
    baseUrl: 'https://credential-backup.example/v1',
    encryptedToken: persistentEncryptedToken,
    apiKeys: [{
      id: backupKeyId,
      label: 'Persistent fixture key',
      encryptedToken: persistentEncryptedToken,
      createdAt: 1,
      disabled: false
    }],
    activeKeyId: backupKeyId,
    models: ['credential-backup-before'],
    authMode: 'api-key',
    engine: 'openai',
    openaiProtocol: 'chat',
    budgetUsd: 0,
    createdAt: 1
  }])
  assert(providersApi.resolveProviderToken(providersApi.getProvider(backupProviderId)).token
    === backupPersistentPlaintextCanary,
  'backup fixture must start with a decryptable persistent credential')
  const sessionBackupProvider = providersApi.createProvider({
    name: 'Session Backup Provider',
    baseUrl: 'https://session-backup.example/v1',
    token: backupSessionCanary,
    models: ['session-backup-model'],
    authMode: 'api-key',
    engine: 'openai',
    openaiProtocol: 'chat'
  })
  assert(providersApi.getProvider(sessionBackupProvider.id)?.apiKeys?.some((key) => key.sessionOnly === true),
    'backup fixture must include a session-only credential before snapshot')

  writeFileSync(importPath, JSON.stringify({
    kind: 'caogen-provider-profile',
    schemaVersion: 1,
    providers: [{
      name: 'Credential Backup Provider',
      baseUrl: 'https://credential-backup.example/v1',
      models: ['credential-backup-after'],
      authMode: 'api-key',
      engine: 'openai',
      openaiProtocol: 'chat'
    }]
  }, null, 2), { mode: 0o600 })
  const credentialBackupPreview = profileService.previewProviderProfileFile(importPath)
  equal(credentialBackupPreview.updateCount, 1,
    'credential-bearing Provider must produce an update before backup sanitization')
  const credentialBackupApply = profileService.applyProviderProfilePreview(credentialBackupPreview.previewId, [])
  equal(credentialBackupApply.backup.excludedCredentialCount, 1,
    'new backup metadata must count the excluded persistent credential')
  equal(credentialBackupApply.backup.nonPersistentCredentialCount, 1,
    'new backup metadata must count the excluded session-only credential')
  const credentialBackupDir = path.join(userDataDir, 'provider-profile-backups')
  const credentialBackupPath = path.join(credentialBackupDir, `${credentialBackupApply.backup.id}.json`)
  const credentialBackupRaw = readFileSync(credentialBackupPath, 'utf8')
  const credentialBackupDocument = JSON.parse(credentialBackupRaw)
  const mismatchedBackupId = '2026-07-31T03-00-00-000Z-00000000-0000-4000-8000-000000000003'
  const mismatchedBackupPath = path.join(credentialBackupDir, `${mismatchedBackupId}.json`)
  writeFileSync(mismatchedBackupPath, credentialBackupRaw, { mode: 0o600 })
  const storeBeforeMismatchedRollback = readFileSync(providersPath, 'utf8')
  assert(/\u5185\u5d4c ID|ID \u4e0d\u5339\u914d/.test(captureError(
    () => profileService.rollbackProviderProfileBackup(mismatchedBackupId)
  )), 'rollback must reject a backup whose filename and embedded ID differ')
  equal(readFileSync(providersPath, 'utf8'), storeBeforeMismatchedRollback,
    'backup identity rejection must preserve the Provider Store')
  rmSync(mismatchedBackupPath)
  const persistentBackupSnapshot = credentialBackupDocument.providers.find(
    (provider) => provider.id === backupProviderId
  )
  const sessionBackupSnapshot = credentialBackupDocument.providers.find(
    (provider) => provider.id === sessionBackupProvider.id
  )
  assert(credentialBackupDocument.providers.every((provider) =>
    provider.encryptedToken === ''
      && Array.isArray(provider.apiKeys)
      && provider.apiKeys.length === 0
      && !provider.activeKeyId),
  'new backup must contain no persistent or session credential records')
  assert(persistentBackupSnapshot?.credentialMigrationRequired === true,
    'new backup must mark a formerly keyed Provider for explicit credential re-entry')
  assert(Boolean(sessionBackupSnapshot) && !credentialBackupRaw.includes('"sessionOnly"'),
    'new backup must retain session Provider configuration without session credential state')
  assert(!credentialBackupRaw.includes('enc:')
    && !containsSensitiveMarker(credentialBackupRaw, backupSensitiveMarkers),
  'new backup file must contain zero credential canary material')

  assert(providersApi.getProvider(backupProviderId)?.apiKeys?.some((key) => key.id === backupKeyId),
    'profile apply must leave the live persistent key available for explicit deletion')
  providersApi.updateProvider(backupProviderId, { removeKeyIds: [backupKeyId] })
  const afterExplicitKeyDeletion = providersApi.getProvider(backupProviderId)
  assert(afterExplicitKeyDeletion?.encryptedToken === ''
    && afterExplicitKeyDeletion.apiKeys?.length === 0
    && !afterExplicitKeyDeletion.activeKeyId,
  'explicit key deletion must remove the credential from the live Provider Store')
  const credentialRollback = profileService.rollbackProviderProfileBackup(credentialBackupApply.backup.id)
  const credentialRollbackView = credentialRollback.providers.find((provider) => provider.id === backupProviderId)
  const credentialRollbackStored = providersApi.getProvider(backupProviderId)
  assert(credentialRollbackView?.hasToken === false
    && credentialRollbackView.ready === false
    && credentialRollbackView.credentialMigrationRequired === true,
  'rollback after key deletion must require explicit credential re-entry')
  assert(credentialRollbackStored?.encryptedToken === ''
    && credentialRollbackStored.apiKeys?.length === 0
    && !credentialRollbackStored.activeKeyId,
  'rollback must not restore a deleted persistent key record')
  const sessionRollbackView = credentialRollback.providers.find(
    (provider) => provider.id === sessionBackupProvider.id
  )
  assert(sessionRollbackView?.hasToken === false && sessionRollbackView.ready === false,
    'rollback must not restore an excluded session-only key')

  const legacyBackupId = '2026-07-31T03-00-00-000Z-00000000-0000-4000-8000-000000000001'
  const legacyBackupPayload = {
    kind: 'caogen-provider-profile-backup',
    schemaVersion: 1,
    id: legacyBackupId,
    createdAt: '2026-07-31T03:00:00.000Z',
    reason: 'manual',
    providerCount: 1,
    nonPersistentCredentialCount: 0,
    providers: [{
      id: backupProviderId,
      name: 'Credential Backup Provider',
      baseUrl: 'https://credential-backup.example/v1',
      encryptedToken: persistentEncryptedToken,
      apiKeys: [{
        id: backupKeyId,
        label: 'Legacy persistent fixture key',
        encryptedToken: persistentEncryptedToken,
        createdAt: 1,
        disabled: false
      }],
      activeKeyId: backupKeyId,
      models: ['legacy-credential-backup'],
      authMode: 'api-key',
      engine: 'openai',
      openaiProtocol: 'chat',
      budgetUsd: 0,
      createdAt: 1
    }]
  }
  const legacyBackupPath = path.join(credentialBackupDir, `${legacyBackupId}.json`)
  writeFileSync(legacyBackupPath, `${JSON.stringify({
    ...legacyBackupPayload,
    payloadDigest: createHash('sha256').update(JSON.stringify(legacyBackupPayload)).digest('hex')
  }, null, 2)}\n`, { mode: 0o600 })
  const migratedLegacyView = profileService.listProviderProfileBackups().find((backup) => backup.id === legacyBackupId)
  equal(migratedLegacyView?.excludedCredentialCount, 1,
    'valid legacy backup migration must report one excluded persistent credential')
  const migratedLegacyRaw = readFileSync(legacyBackupPath, 'utf8')
  const migratedLegacyDocument = JSON.parse(migratedLegacyRaw)
  const migratedLegacyProvider = migratedLegacyDocument.providers[0]
  assert(migratedLegacyProvider.encryptedToken === ''
    && migratedLegacyProvider.apiKeys.length === 0
    && !migratedLegacyProvider.activeKeyId
    && migratedLegacyProvider.credentialMigrationRequired === true,
  'valid legacy backup must be rewritten as a credential-free re-entry snapshot')
  assert(!migratedLegacyRaw.includes('enc:')
    && !containsSensitiveMarker(migratedLegacyRaw, backupSensitiveMarkers),
  'migrated legacy backup file must contain zero credential canary material')
  const { payloadDigest: migratedLegacyDigest, ...migratedLegacyPayload } = migratedLegacyDocument
  equal(migratedLegacyDigest,
    createHash('sha256').update(JSON.stringify(migratedLegacyPayload)).digest('hex'),
    'migrated legacy backup must receive a digest for its sanitized payload')

  const countedSessionBackupId = '2026-07-31T03-00-00-000Z-00000000-0000-4000-8000-000000000002'
  const countedSessionBackupPayload = {
    kind: 'caogen-provider-profile-backup',
    schemaVersion: 1,
    id: countedSessionBackupId,
    createdAt: '2026-07-31T03:00:00.000Z',
    reason: 'manual',
    providerCount: 1,
    nonPersistentCredentialCount: 1,
    excludedCredentialCount: 1,
    providers: [{
      id: 'counted-session-backup-provider',
      name: 'Counted Session Backup Provider',
      baseUrl: 'https://counted-session-backup.example/v1',
      encryptedToken: backupSessionCanary,
      apiKeys: [{
        id: 'counted-session-backup-key',
        label: 'Counted session fixture key',
        encryptedToken: backupSessionCanary,
        createdAt: 1,
        disabled: false,
        sessionOnly: true
      }],
      activeKeyId: 'counted-session-backup-key',
      models: ['counted-session-backup-model'],
      authMode: 'api-key',
      engine: 'openai',
      openaiProtocol: 'chat',
      budgetUsd: 0,
      createdAt: 1
    }]
  }
  const countedSessionBackupPath = path.join(credentialBackupDir, `${countedSessionBackupId}.json`)
  writeFileSync(countedSessionBackupPath, `${JSON.stringify({
    ...countedSessionBackupPayload,
    payloadDigest: createHash('sha256').update(JSON.stringify(countedSessionBackupPayload)).digest('hex')
  }, null, 2)}\n`, { mode: 0o600 })
  const countedSessionView = profileService.listProviderProfileBackups().find(
    (backup) => backup.id === countedSessionBackupId
  )
  equal(countedSessionView?.excludedCredentialCount, 1,
    'credential-counted backup migration must not double-count a session-only key')
  const countedSessionRaw = readFileSync(countedSessionBackupPath, 'utf8')
  const countedSessionDocument = JSON.parse(countedSessionRaw)
  assert(countedSessionDocument.providers[0]?.encryptedToken === ''
    && countedSessionDocument.providers[0]?.apiKeys?.length === 0
    && !countedSessionDocument.providers[0]?.activeKeyId
    && !countedSessionRaw.includes('"sessionOnly"')
    && !containsSensitiveMarker(countedSessionRaw, backupSensitiveMarkers),
  'credential-counted backup must still be rewritten without session-only credential state')
  const { payloadDigest: countedSessionDigest, ...countedSessionSanitizedPayload } = countedSessionDocument
  equal(countedSessionDigest,
    createHash('sha256').update(JSON.stringify(countedSessionSanitizedPayload)).digest('hex'),
    'credential-counted backup must receive a digest for its sanitized payload')

  const legacyRollback = profileService.rollbackProviderProfileBackup(legacyBackupId)
  const legacyRollbackView = legacyRollback.providers.find((provider) => provider.id === backupProviderId)
  const legacyRollbackStored = providersApi.getProvider(backupProviderId)
  assert(legacyRollbackView?.models.join(',') === 'legacy-credential-backup'
    && legacyRollbackView.hasToken === false
    && legacyRollbackView.ready === false
    && legacyRollbackView.credentialMigrationRequired === true,
  'legacy backup rollback must restore configuration while requiring credential re-entry')
  assert(legacyRollbackStored?.encryptedToken === ''
    && legacyRollbackStored.apiKeys?.length === 0
    && providersApi.resolveProviderToken(legacyRollbackStored).token === '',
  'legacy backup rollback must never reactivate the deleted persistent key')
  const backupCorpus = readdirSync(credentialBackupDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(path.join(credentialBackupDir, name), 'utf8'))
    .join('\n')
  assert(!containsSensitiveMarker(backupCorpus, backupSensitiveMarkers),
    'all Provider Profile backup files must contain zero credential canary material')

  const deletionFixture = providersApi.createProvider({
    name: 'Automatic history deletion fixture',
    baseUrl: 'http://127.0.0.1:11438/v1',
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat',
    models: ['history-fixture']
  })
  providersApi.deleteProvider(deletionFixture.id)
  assert(profileService.listProviderProfileBackups().some((backup) => backup.reason === 'provider-delete'),
    'ordinary Provider deletion must create an automatic configuration version')

  const versionBackup = profileService.listProviderProfileBackups().find(
    (backup) => backup.reason === 'provider-update'
  )
  assert(versionBackup, 'automatic update history must remain available for preview')
  const versionPreview = profileService.previewProviderProfileBackup(versionBackup.id)
  assert(versionPreview.items.length > 0
    && versionPreview.createCount + versionPreview.updateCount
      + versionPreview.deleteCount + versionPreview.unchangedCount === versionPreview.items.length,
  'local version preview must provide a complete create/update/delete/unchanged plan')
  const serializedVersionPreview = JSON.stringify(versionPreview)
  assert(!serializedVersionPreview.includes('https://')
    && !serializedVersionPreview.includes('http://')
    && !containsSensitiveMarker(serializedVersionPreview, backupSensitiveMarkers),
  'local version preview must expose neither Provider endpoint values nor credential canaries')

  const driftTarget = providersApi.listProviders()[0]
  providersApi.updateProvider(driftTarget.id, { note: 'version-preview-drift-fixture' })
  assert(/changed after preview|preview the version again/i.test(captureError(
    () => profileService.applyProviderProfileBackupPreview(versionPreview.previewId)
  )), 'local version apply must reject Provider configuration drift after preview')
  const freshVersionPreview = profileService.previewProviderProfileBackup(versionBackup.id)
  const backupCountBeforeVersionApply = profileService.listProviderProfileBackups().length
  const versionRollback = profileService.applyProviderProfileBackupPreview(freshVersionPreview.previewId)
  equal(versionRollback.restoredBackupId, versionBackup.id,
    'local version apply must restore the exact previewed backup')
  assert(profileService.listProviderProfileBackups().length === backupCountBeforeVersionApply + 1,
    'local version apply must create a reverse safety backup before rollback')

  const remoteDiscoveryError = await captureAsyncError(() => providersApi.fetchModels({
    baseUrl: 'https://remote-no-auth.example/v1',
    authMode: 'none',
    openaiProtocol: 'chat'
  }))
  assert(/\u56de\u73af|\u65e0\u9700\u5bc6\u94a5/.test(remoteDiscoveryError),
    'unsaved remote no-auth model discovery must fail before network access')
  assertThrows(() => providersApi.createProvider({
    name: 'Contradictory no-auth credential',
    baseUrl: 'http://127.0.0.1:11439/v1',
    engine: 'openai',
    authMode: 'none',
    openaiProtocol: 'chat',
    models: ['local-model'],
    token: ['must', 'not', 'persist'].join('-')
  }), 'no-auth Provider creation must reject credential input')

  const restoredUnsafe = profileStore.restoreProviderStoreBackup([{
    id: 'unsafe-backup-provider',
    name: 'Unsafe Backup Provider',
    baseUrl: 'https://unsafe-backup.example/v1',
    encryptedToken: '',
    apiKeys: [],
    models: ['unsafe-backup-model'],
    authMode: 'none',
    engine: 'openai',
    budgetUsd: 0,
    createdAt: 1
  }])
  equal(restoredUnsafe[0].authMode, 'api-key',
    'backup restore must downgrade remote no-auth configuration')
  assert(restoredUnsafe[0].ready === false && restoredUnsafe[0].credentialMigrationRequired === true,
    'downgraded backup provider must remain unroutable without a credential')

  writeFileSync(providersPath, JSON.stringify([{
    id: 'legacy-local-no-auth-with-key',
    name: 'Legacy local no-auth with dormant key',
    baseUrl: 'http://127.0.0.1:11441/v1',
    encryptedToken: 'enc:AA==',
    apiKeys: [{
      id: 'legacy-dormant-key',
      label: 'Legacy dormant key',
      encryptedToken: 'enc:AA==',
      createdAt: 1
    }],
    activeKeyId: 'legacy-dormant-key',
    models: ['legacy-local-model'],
    authMode: 'none',
    engine: 'openai',
    openaiProtocol: 'chat',
    budgetUsd: 0,
    createdAt: 1
  }], null, 2), { mode: 0o600 })
  const migratedLocalNoAuth = loadProvidersInFreshProcess(findCompiled(outDir, 'providers.js'))[0]
  assert(migratedLocalNoAuth.authMode === 'none' && migratedLocalNoAuth.apiKeys?.length === 0,
    'fresh-process migration must erase dormant keys from a legacy local no-auth Provider')
  const persistedMigratedLocalNoAuth = readProviderEntries(providersPath)[0]
  assert(persistedMigratedLocalNoAuth.encryptedToken === ''
    && persistedMigratedLocalNoAuth.apiKeys.length === 0
    && !persistedMigratedLocalNoAuth.activeKeyId,
  'fresh-process migration must persist the local no-auth credential erasure')

  writeFileSync(providersPath, JSON.stringify([{
    id: 'unsafe-loaded-provider',
    name: 'Unsafe Loaded Provider',
    baseUrl: 'https://unsafe-loaded.example/v1',
    encryptedToken: '',
    apiKeys: [],
    models: ['unsafe-loaded-model'],
    authMode: 'none',
    engine: 'openai',
    budgetUsd: 0,
    createdAt: 1
  }], null, 2), { mode: 0o600 })
  if (process.platform !== 'win32') {
    chmodSync(userDataDir, 0o500)
    try {
      const fallbackFreshLoadError = captureError(
        () => loadProvidersInFreshProcess(findCompiled(outDir, 'providers.js'))
      )
      assert(/mutation lock|LOCK_IO|EACCES|permission denied/i.test(fallbackFreshLoadError),
        'unwritable Provider Store must fail closed before migration without bypassing the mutation lock')
      equal(readProviderEntries(providersPath)[0].authMode, 'none',
        'failed migration writeback fixture must leave the unsafe disk input unchanged')
    } finally {
      chmodSync(userDataDir, 0o700)
    }
  }
  const sanitizedFreshLoad = loadProvidersInFreshProcess(findCompiled(outDir, 'providers.js'))
  equal(sanitizedFreshLoad[0].authMode, 'api-key',
    'fresh process load must downgrade remote no-auth configuration')
  assert(sanitizedFreshLoad[0].ready === false && sanitizedFreshLoad[0].credentialMigrationRequired === true,
    'fresh process downgrade must fail closed without a credential')
  const persistedSanitizedLoad = readProviderEntries(providersPath)
  equal(persistedSanitizedLoad[0].authMode, 'api-key',
    'fresh process downgrade must be persisted')

  writeFileSync(providersPath, JSON.stringify([
    {
      id: 'legacy-openai-default-header',
      name: 'Legacy OpenAI header fixture',
      baseUrl: 'https://legacy-openai.example/v1',
      encryptedToken: '',
      apiKeys: [],
      models: ['legacy-openai-model'],
      authMode: 'api-key',
      engine: 'openai',
      openaiProtocol: 'chat',
      budgetUsd: 0,
      createdAt: 1
    },
    {
      id: 'legacy-anthropic-default-header',
      name: 'Legacy Anthropic header fixture',
      baseUrl: 'https://legacy-anthropic.example',
      encryptedToken: '',
      apiKeys: [],
      models: ['legacy-anthropic-model'],
      authMode: 'api-key',
      engine: 'anthropic',
      budgetUsd: 0,
      createdAt: 1
    }
  ], null, 2), { mode: 0o600 })
  const migratedDefaultHeaders = loadProvidersInFreshProcess(findCompiled(outDir, 'providers.js'))
  equal(migratedDefaultHeaders[0].credentialHeaderNames?.join(','), 'authorization',
    'legacy OpenAI-compatible Providers must migrate to Authorization')
  equal(migratedDefaultHeaders[1].credentialHeaderNames?.join(','), 'x-api-key',
    'legacy Anthropic Providers must migrate to x-api-key')
  const persistedDefaultHeaders = readProviderEntries(providersPath)
  equal(persistedDefaultHeaders[0].credentialHeaderNames?.join(','), 'authorization',
    'OpenAI credential-header migration must be persisted')
  equal(persistedDefaultHeaders[1].credentialHeaderNames?.join(','), 'x-api-key',
    'Anthropic credential-header migration must be persisted')

  mkdirSync(reportDir, { recursive: true })
  assert(!containsSensitiveMarker(JSON.stringify(checks), backupSensitiveMarkers),
    'Provider Profile report check ledger must contain zero credential canary material')
  const projectedStdoutCount = checks.length + 1
  const projectedStdout = [
    `provider profile smoke ok: ${reportDir}`,
    `${projectedStdoutCount}/${projectedStdoutCount} checks passed`
  ].join('\n')
  assert(!containsSensitiveMarker(projectedStdout, backupSensitiveMarkers),
    'Provider Profile stdout summary must contain zero credential canary material')
  markProviderEvidencePassed(report)
  stdoutLines = [
    `provider profile smoke ok: ${reportDir}`,
    `${checks.length}/${checks.length} checks passed`
  ]
  if (containsSensitiveMarker(stdoutLines.join('\n'), backupSensitiveMarkers)) {
    throw new Error('Provider Profile stdout contains credential canary material')
  }
} catch (error) {
  runError = error
  markProviderEvidenceFailed(report, error, 'Provider Profile smoke failed')
  process.exitCode = 1
} finally {
  const passed = writeProviderEvidenceReport({
    report,
    repoRoot,
    reportRoot,
    reportDir,
    sourceAtStart: sourceEvidenceAtStart,
    label: 'Provider Profile smoke',
    redaction: {
      contains: containsSensitiveMarker,
      markers: backupSensitiveMarkers,
      failureMessage: 'Provider Profile report redaction failed'
    }
  })
  if (!passed) process.exitCode = 1
  rmSync(tempRoot, { recursive: true, force: true })
}
if (report.status === 'passed' && !process.exitCode) {
  for (const line of stdoutLines) console.log(line)
} else {
  console.error(`Provider Profile smoke failed (${runError ? 'see report digest' : 'evidence provenance'})`)
}
function compile(outDirPath) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/provider/providerProfile.ts',
      'src/main/provider/providerProfileStore.ts',
      'src/main/provider/providerProfileService.ts',
      '--outDir',
      outDirPath,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}
function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function installElectronStub(compiledRoot, userDataDir) {
  const modulesRoot = path.join(compiledRoot, 'node_modules')
  const electronRoot = path.join(modulesRoot, 'electron')
  mkdirSync(electronRoot, { recursive: true })
  symlinkSync(
    path.join(repoRoot, 'node_modules', 'sql.js'),
    path.join(modulesRoot, 'sql.js'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({
    name: 'electron',
    version: '0.0.0-provider-profile-smoke',
    main: 'index.js'
  }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = {\n  app: {\n    getPath(name) {\n      if (name !== 'userData') throw new Error('unsupported Electron path: ' + name)\n      return ${JSON.stringify(userDataDir)}\n    }\n  },\n  safeStorage: {\n    isEncryptionAvailable() { return true },\n    encryptString(value) {\n      if (value === ${JSON.stringify(backupSessionCanary)}) {\n        throw new Error('injected session-only credential')\n      }\n      return Buffer.from(value, 'utf8')\n    },\n    decryptString(value) { return Buffer.from(value).toString('utf8') },\n    getSelectedStorageBackend() { return 'keychain' }\n  }\n}\n`)
}

function loadProvidersInFreshProcess(compiledProvidersPath) {
  const output = execFileSync(process.execPath, [
    '-e',
    `const providers = require(${JSON.stringify(compiledProvidersPath)}); process.stdout.write(JSON.stringify(providers.listProviders()))`
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(output)
}

function readProviderEntries(filePath) {
  const value = JSON.parse(readFileSync(filePath, 'utf8'))
  return Array.isArray(value) ? value : value.entries
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(fullPath, fileName) } catch { /* keep looking */ }
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled ${fileName} not found`)
}

function assertThrows(action, message) {
  assert(capturedError(action) instanceof Error, message)
}

function capturedError(action) {
  try {
    action()
    return null
  } catch (error) {
    return error
  }
}

function captureError(action) {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected action to fail')
}

function containsSensitiveMarker(value, markers) {
  return markers.some((marker) => marker && value.includes(marker))
}

async function captureAsyncError(action) {
  try {
    await action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected async action to fail')
}

function equal(actual, expected, message) {
  const condition = actual === expected
  checks.push({ name: message, status: condition ? 'pass' : 'fail' })
  if (!condition) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message) {
  checks.push({ name: message, status: condition ? 'pass' : 'fail' })
  if (!condition) throw new Error(message)
}
