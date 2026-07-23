import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const brokerSource = read('src/main/providerCredentialBroker.ts')
const providers = read('src/main/providers.ts')
const types = read('src/shared/types.ts')
const editor = read('src/renderer/src/components/ProviderEditor.tsx')
const settings = read('src/renderer/src/components/SettingsModal.tsx')
const providerSavedKeys = read('src/renderer/src/components/settings/ProviderSavedKeys.tsx')
const providerList = read('src/renderer/src/components/settings/ProviderList.tsx')
const controlCenter = read('src/renderer/src/controlCenter.ts')
const openaiEngine = read('src/main/openaiEngine.ts')
const agentSession = read('src/main/agentSession.ts')
const dagDecomposer = read('src/main/agent/model-dag-decomposer.ts')
const providerRuntimeAuth = read('src/main/providerRuntimeAuth.ts')

assert(!/from\s+['"]electron['"]/.test(brokerSource), 'credential broker must not import Electron')
assert(!/return\s+[`'"]b64:/.test(brokerSource), 'credential broker must never write b64 records')

const brokerModule = await compileAndImportBroker(brokerSource)
runBrokerBehaviorChecks(brokerModule)

const staticFailures = []
const staticAssert = (condition, message) => {
  if (!condition) staticFailures.push(message)
}

staticAssert(types.includes('export interface ProviderApiKey'), 'ProviderApiKey storage type is missing')
staticAssert(types.includes('export interface ProviderApiKeyView'), 'ProviderApiKeyView metadata type is missing')
staticAssert(
  types.includes('lastFailureReason?: string'),
  'Provider key view must expose sanitized failure metadata'
)
staticAssert(
  types.includes('additionalTokens?: ProviderApiKeyInput[]'),
  'ProviderInput must support adding multiple API keys'
)
staticAssert(
  types.includes('keyUpdates?: ProviderApiKeyUpdateInput[]'),
  'ProviderInput must support key metadata updates'
)
staticAssert(
  types.includes('removeKeyIds?: string[]'),
  'ProviderInput must support key removal without exposing secrets'
)
staticAssert(
  types.includes('ProviderCredentialStorage') && types.includes('credentialStorage'),
  'provider views must expose credential storage state'
)
staticAssert(
  types.includes('credentialHeaderNames?: string[]'),
  'provider contracts must expose managed credential header names without values'
)
staticAssert(
  /ProviderModelFetchInput[\s\S]{0,240}customHeaders\?: string/.test(types),
  'model discovery must carry provider routing headers'
)

staticAssert(
  providers.includes('function normalizedProviderKeys'),
  'providers.ts must normalize legacy and multi-key storage'
)
staticAssert(
  providers.includes('export function decryptProviderToken'),
  'providers.ts must expose active-key decryption helper'
)
staticAssert(
  providers.includes('export function rotateProviderKey'),
  'providers.ts must support automatic key rotation'
)
staticAssert(
  providers.includes('legacyKeyId(provider.id)'),
  'legacy encryptedToken must migrate into a deterministic key view'
)
staticAssert(providers.includes('apiKeys,'), 'create/update provider path must persist apiKeys')
staticAssert(providers.includes('activeKeyId'), 'provider storage must track activeKeyId')
staticAssert(
  providers.includes('encryptedToken: activeKey?.encryptedToken ??'),
  'legacy encryptedToken mirror must follow active key'
)
staticAssert(!providers.includes('caogen-relay'), 'provider key storage must not inject a hidden relay provider')
staticAssert(
  !/return\s+[`'"]b64:/.test(providers),
  'providers.ts must not contain a b64 credential write fallback'
)
staticAssert(
  providers.includes('sessionOnly') &&
    /filter\([\s\S]{0,240}sessionOnly/.test(providers),
  'providers.ts must filter session-only credentials out of persisted snapshots'
)
staticAssert(providers.includes('renameSync('), 'providers.ts must atomically replace provider storage')
staticAssert(
  providers.includes('normalizedCustomHeaders') && providers.includes('inspectProviderCustomHeaders'),
  'provider create/update paths must reject sensitive custom headers'
)
staticAssert(
  providers.includes('inspectProviderBaseUrl') && providers.includes('Base URL 不允许包含用户名'),
  'provider create/update paths must reject credentials embedded in Base URLs'
)
staticAssert(
  providers.includes('credentialMigrationRequired: true'),
  'legacy sensitive custom headers must be scrubbed and marked for re-entry'
)
staticAssert(
  providers.includes('snapshotProvider') && providers.includes('restoreProvider'),
  'critical provider writes must roll back in-memory credentials when persistence fails'
)
staticAssert(
  providers.includes('export function providerCredentialHeaders')
    && providers.includes('export function providerCredentialHeaderLines'),
  'providers must inject Broker tokens into managed credential header names'
)
staticAssert(
  providers.includes('names.push(normalized)'),
  'managed credential header names must be case-normalized to avoid duplicate HTTP headers'
)
staticAssert(
  providers.includes('sanitizeLoadedProvidersForRuntime(loadedProviders)'),
  'failed credential migration writes must fall back to honest legacy runtime state'
)
staticAssert(
  /!firstRun[\s\S]{0,100}chmodSync\(file, 0o600\)/.test(providers),
  'existing provider files must have permissions tightened on load'
)
staticAssert(
  !providers.includes('const { encryptedToken, apiKeys: _apiKeys'),
  'ProviderView must be constructed explicitly instead of spreading stored credential fields'
)

for (const file of walk(path.join(repoRoot, 'src/main'))) {
  if (!file.endsWith('.ts')) continue
  const rel = path.relative(repoRoot, file)
  const source = read(rel)
  if (rel === 'src/main/providers.ts') continue
  staticAssert(
    !source.includes('decryptToken(provider.encryptedToken)'),
    `${rel} still decrypts provider.encryptedToken directly`
  )
}

staticAssert(
  editor.includes("import ProviderSavedKeys from './settings/ProviderSavedKeys'")
    && editor.includes('<ProviderSavedKeys')
    && providerSavedKeys.includes('function SavedKeyRow'),
  'ProviderEditor must render saved key metadata rows'
)
staticAssert(
  providerSavedKeys.includes("t('apiKeyLastFailure'"),
  'ProviderEditor must show key failure metadata'
)
staticAssert(
  editor.includes('additionalApiKeysLabel'),
  'ProviderEditor must expose additional API key input'
)
staticAssert(editor.includes('type="password"'), 'ProviderEditor must keep API key entry as a password field')
staticAssert(!editor.includes('encryptedToken'), 'ProviderEditor must not render encrypted token fields')
staticAssert(
  editor.includes('credentialStorage'),
  'ProviderEditor must render credential storage state'
)
staticAssert(
  settings.includes("import ProviderList from './settings/ProviderList'")
    && settings.includes('<ProviderList')
    && providerList.includes('credentialStorage'),
  'provider settings list must render credential storage state'
)
staticAssert(
  editor.includes('credentialHeaderNamesText') && editor.includes('credentialHeaderNamesLabel'),
  'ProviderEditor must configure managed credential header names without secret values'
)
staticAssert(
  openaiEngine.includes("import { mergeProviderCredentialHeaders } from './providerRuntimeAuth'")
    && openaiEngine.includes('mergeProviderCredentialHeaders(provider, selection.token')
    && providerRuntimeAuth.includes('providerCredentialHeaders(provider, token)'),
  'OpenAI requests must receive Broker-managed credential headers'
)
staticAssert(
  agentSession.includes("import { applyClaudeProviderEnvironment } from './providerRuntimeAuth'")
    && agentSession.includes('applyClaudeProviderEnvironment(env, provider, token)')
    && providerRuntimeAuth.includes('providerCredentialHeaderLines(provider, token)'),
  'Claude SDK sessions must receive Broker-managed credential headers'
)
staticAssert(
  providerRuntimeAuth.includes('delete env.ANTHROPIC_CUSTOM_HEADERS')
    && providerRuntimeAuth.includes("'ANTHROPIC_API_KEY'")
    && providerRuntimeAuth.includes("'ANTHROPIC_AUTH_TOKEN'")
    && providerRuntimeAuth.includes('for (const key of CLAUDE_HOST_CREDENTIAL_KEYS) delete env[key]'),
  'Claude Provider sessions must clear unrelated host credentials before Broker injection'
)
staticAssert(
  dagDecomposer.includes('providerCredentialHeaders(provider, token)'),
  'DAG model requests must receive Broker-managed credential headers'
)

staticAssert(controlCenter.includes('totalKeys'), 'Control Center summary must include total key count')
staticAssert(
  controlCenter.includes('activeKeyLabel'),
  'Control Center provider rows must expose active key label metadata'
)

if (staticFailures.length > 0) {
  console.log('provider credential broker dynamic checks ok')
  throw new Error(`provider credential integration checks failed:\n- ${staticFailures.join('\n- ')}`)
}

console.log('provider keys smoke ok')

async function compileAndImportBroker(source) {
  const typescriptModule = await import('typescript')
  const ts = typescriptModule.default ?? typescriptModule
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true
    },
    fileName: 'providerCredentialBroker.ts',
    reportDiagnostics: true
  })
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  )
  assert(errors.length === 0, formatDiagnostics(ts, errors))

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
  return import(moduleUrl)
}

function runBrokerBehaviorChecks(module) {
  const storage = runCredentialStorageChecks(module.ProviderCredentialBroker)
  runProviderSnapshotChecks(module.ProviderCredentialBroker)
  runLegacyCredentialChecks(storage)
  runProviderHeaderPolicyChecks(module)
  runProviderCustomHeaderChecks(module.inspectProviderCustomHeaders)
  runProviderBaseUrlChecks(module.inspectProviderBaseUrl)
}

function runCredentialStorageChecks(ProviderCredentialBroker) {
  const secureToken = credentialCanary('secure-value')
  const basicTextToken = credentialCanary('basic-text')
  const unavailableToken = credentialCanary('unavailable')
  const encryptFailureToken = credentialCanary('encrypt-failed')
  const secureRef = { providerId: 'provider-secure', keyId: 'key-1' }
  const secureBroker = new ProviderCredentialBroker(createCryptoBackend())
  assert(secureBroker.canPersistSecurely(), 'secure backend should permit persistence')
  const secureRecord = secureBroker.store(secureRef, secureToken)
  assert(secureRecord.encryptedToken.startsWith('enc:'), 'secure credential must use enc storage')
  assert(!secureRecord.sessionOnly, 'secure credential must not be session-only')
  assert(
    !JSON.stringify(secureRecord).includes(secureToken),
    'secure record must not contain credential plaintext'
  )
  assertDeepEqual(
    secureBroker.resolve(secureRef, secureRecord),
    { token: secureToken, storage: 'encrypted', available: true },
    'secure credential must resolve through the injected backend'
  )

  const basicTextRef = { providerId: 'provider-basic-text', keyId: 'key-1' }
  const basicTextBroker = new ProviderCredentialBroker(
    createCryptoBackend({ selectedBackend: 'basic_text' })
  )
  assert(!basicTextBroker.canPersistSecurely(), 'basic_text must not count as secure persistence')
  const basicTextRecord = basicTextBroker.store(basicTextRef, basicTextToken)
  assertDeepEqual(
    basicTextRecord,
    { encryptedToken: '', sessionOnly: true },
    'basic_text credential must remain session-only'
  )
  assertDeepEqual(
    basicTextBroker.resolve(basicTextRef, basicTextRecord),
    { token: basicTextToken, storage: 'session', available: true },
    'basic_text session credential must resolve in the current process'
  )

  const unavailableRef = { providerId: 'provider-unavailable', keyId: 'key-1' }
  const unavailableBroker = new ProviderCredentialBroker(
    createCryptoBackend({ available: false })
  )
  const unavailableRecord = unavailableBroker.store(unavailableRef, unavailableToken)
  assertDeepEqual(
    unavailableRecord,
    { encryptedToken: '', sessionOnly: true },
    'unavailable storage must produce only a session record'
  )
  assert(
    !JSON.stringify(unavailableRecord).includes(unavailableToken),
    'session record must not serialize credential plaintext'
  )
  for (const unsafeToken of [
    'line\nbreak',
    'line\rbreak',
    `nul${String.fromCharCode(0)}break`,
    `vertical${String.fromCharCode(0x0b)}tab`,
    `delete${String.fromCharCode(0x7f)}control`
  ]) {
    assertThrows(
      () => unavailableBroker.store({ providerId: 'unsafe', keyId: 'unsafe' }, unsafeToken),
      'Broker must reject tokens containing ASCII control characters'
    )
  }
  const restartedUnavailableBroker = new ProviderCredentialBroker(
    createCryptoBackend({ available: false })
  )
  assertDeepEqual(
    restartedUnavailableBroker.resolve(unavailableRef, unavailableRecord),
    { token: '', storage: 'unavailable', available: false },
    'a new broker instance must not recover a prior process session credential'
  )
  unavailableBroker.forget(unavailableRef)
  assertDeepEqual(
    unavailableBroker.resolve(unavailableRef, unavailableRecord),
    { token: '', storage: 'unavailable', available: false },
    'forgotten session credential must be unavailable'
  )

  const throwingRef = { providerId: 'provider-throwing', keyId: 'key-1' }
  const throwingBroker = new ProviderCredentialBroker(
    createCryptoBackend({ encryptThrows: true })
  )
  const throwingRecord = throwingBroker.store(throwingRef, encryptFailureToken)
  assertDeepEqual(
    throwingRecord,
    { encryptedToken: '', sessionOnly: true },
    'encryption failure must fall back to process memory'
  )
  assertDeepEqual(
    throwingBroker.resolve(throwingRef, throwingRecord),
    { token: encryptFailureToken, storage: 'session', available: true },
    'encryption failure fallback must resolve in the current process'
  )

  return { secureRef, secureBroker, basicTextBroker, unavailableBroker, throwingBroker }
}

function runProviderSnapshotChecks(ProviderCredentialBroker) {
  const providerAToken = credentialCanary('provider-a')
  const providerBToken = credentialCanary('provider-b')
  const providerForgetBroker = new ProviderCredentialBroker(
    createCryptoBackend({ available: false })
  )
  const providerARef = { providerId: 'provider-a', keyId: 'shared-key-id' }
  const providerBRef = { providerId: 'provider-b', keyId: 'shared-key-id' }
  const providerARecord = providerForgetBroker.store(providerARef, providerAToken)
  const providerBRecord = providerForgetBroker.store(providerBRef, providerBToken)
  const providerASnapshot = providerForgetBroker.snapshotProvider('provider-a')
  providerForgetBroker.forgetProvider('provider-a')
  assert(
    !providerForgetBroker.resolve(providerARef, providerARecord).available,
    'forgetProvider must remove that provider credentials'
  )
  assertDeepEqual(
    providerForgetBroker.resolve(providerBRef, providerBRecord),
    { token: providerBToken, storage: 'session', available: true },
    'forgetProvider must not remove another provider credentials'
  )
  providerForgetBroker.restoreProvider('provider-a', providerASnapshot)
  assertDeepEqual(
    providerForgetBroker.resolve(providerARef, providerARecord),
    { token: providerAToken, storage: 'session', available: true },
    'restoring a provider snapshot must restore its session credentials after a failed transaction'
  )
}

function runLegacyCredentialChecks({
  secureRef,
  secureBroker,
  basicTextBroker,
  unavailableBroker,
  throwingBroker
}) {
  const legacyToken = credentialCanary('legacy-凭据')
  const legacyRecord = {
    encryptedToken: `b64:${Buffer.from(legacyToken, 'utf8').toString('base64')}`
  }
  const legacyRef = { providerId: 'provider-legacy', keyId: 'legacy-key' }
  assertDeepEqual(
    unavailableBroker.resolve(legacyRef, legacyRecord),
    { token: legacyToken, storage: 'legacy-b64', available: true },
    'legacy b64 record must remain readable without secure storage'
  )
  assert(
    unavailableBroker.migrateLegacy(legacyRef, legacyRecord.encryptedToken) === null,
    'legacy record must not migrate when secure persistence is unavailable'
  )
  for (const unsafeLegacyToken of [
    'legacy\ninjected',
    'legacy\rinjected',
    `legacy${String.fromCharCode(0)}injected`,
    `legacy${String.fromCharCode(0x0b)}injected`,
    `legacy${String.fromCharCode(0x7f)}injected`
  ]) {
    const unsafeLegacyRecord = {
      encryptedToken: `b64:${Buffer.from(unsafeLegacyToken, 'utf8').toString('base64')}`
    }
    assertDeepEqual(
      unavailableBroker.resolve(legacyRef, unsafeLegacyRecord),
      { token: '', storage: 'unavailable', available: false },
      'legacy credentials containing ASCII control characters must not enter managed headers'
    )
  }
  assert(
    basicTextBroker.migrateLegacy(legacyRef, legacyRecord.encryptedToken) === null,
    'legacy record must not migrate into basic_text storage'
  )
  const migratedRecord = secureBroker.migrateLegacy(legacyRef, legacyRecord.encryptedToken)
  assert(migratedRecord?.encryptedToken.startsWith('enc:'), 'legacy record must migrate to enc storage')
  assert(!migratedRecord?.sessionOnly, 'migrated credential must be persistent')
  assertDeepEqual(
    secureBroker.resolve(legacyRef, migratedRecord),
    { token: legacyToken, storage: 'encrypted', available: true },
    'migrated credential must resolve through secure storage'
  )
  assert(
    throwingBroker.migrateLegacy(legacyRef, legacyRecord.encryptedToken) === null,
    'failed legacy encryption must leave the old record untouched'
  )

  for (const malformed of ['b64:', 'b64:not*base64', 'b64:abc', 'b64:////']) {
    assertDeepEqual(
      secureBroker.resolve(legacyRef, { encryptedToken: malformed }),
      { token: '', storage: 'unavailable', available: false },
      `malformed legacy record must be unavailable: ${malformed}`
    )
  }
  assertDeepEqual(
    secureBroker.resolve(secureRef, { encryptedToken: 'enc:not*base64' }),
    { token: '', storage: 'unavailable', available: false },
    'malformed encrypted record must be unavailable'
  )
  assertDeepEqual(
    secureBroker.resolve(secureRef, { encryptedToken: 'enc:' }),
    { token: '', storage: 'unavailable', available: false },
    'empty encrypted payload must be unavailable'
  )
  assertDeepEqual(
    secureBroker.resolve(secureRef, { encryptedToken: '' }),
    { token: '', storage: 'missing', available: false },
    'empty persistent record must be reported as missing'
  )
}

function runProviderHeaderPolicyChecks({
  isAllowedProviderCustomHeaderName,
  isAllowedProviderManagedCredentialHeaderName,
  isSensitiveProviderHeaderName,
  looksLikeProviderCredentialValue
}) {
  for (const name of [
    'Authorization',
    'Proxy-Authorization',
    'Cookie',
    'Set-Cookie',
    'X-API-Key',
    'Api-Key',
    'X-Auth-Token',
    'X-Access-Token',
    'X-Goog-Api-Key',
    'Ocp-Apim-Subscription-Key',
    'X-RapidAPI-Key',
    'ApiKey',
    'Api_Key',
    'ApiSecret',
    'X-ApiSecret',
    'API-Sign',
    'X-Sig',
    'X-HMAC',
    'AuthCode',
    'ClientSecret',
    'X-Auth-Key',
    'Client-Private-Key',
    'X-Custom-Secret',
    'Credential-Id',
    'Db-Password',
    'Request-Signature',
    'Service-Access-Key-Id'
  ]) {
    assert(isSensitiveProviderHeaderName(name), `${name} must be classified as sensitive`)
  }
  assert(!isSensitiveProviderHeaderName('Content-Type'), 'Content-Type must remain non-sensitive')
  assert(!isSensitiveProviderHeaderName('X-Trace-Id'), 'X-Trace-Id must remain non-sensitive')
  assert(isAllowedProviderCustomHeaderName('Content-Type'), 'Content-Type must be allowed')
  assert(isAllowedProviderCustomHeaderName('X-Gateway-Route'), 'gateway routing metadata must be allowed')
  assert(isAllowedProviderCustomHeaderName('X-Account-Id'), 'account routing metadata must be allowed')
  assert(isAllowedProviderCustomHeaderName('Helicone-Property-Session'), 'Helicone metadata must be allowed')
  assert(isAllowedProviderCustomHeaderName('X-Debug-Mode'), 'debug metadata must be allowed')
  assert(isAllowedProviderCustomHeaderName('X-RapidAPI-Host'), 'RapidAPI host metadata must be allowed')
  assert(!isAllowedProviderCustomHeaderName('X-License'), 'unknown custom headers must fail closed')
  for (const name of [
    'Authorization',
    'api-key',
    'X-API-Key',
    'X-Goog-Api-Key',
    'X-RapidAPI-Key',
    'Ocp-Apim-Subscription-Key'
  ]) {
    assert(
      isAllowedProviderManagedCredentialHeaderName(name),
      `${name} must be accepted as an explicit managed credential header`
    )
  }
  for (const name of [
    'x-api-key-sk-live-secret',
    'x-api-key-sk_live_51ABCDEF',
    'x-api-key-AKIAIOSFODNN7EXAMPLE',
    'x-api-key-0123456789abcdef0123456789abcdef',
    'Proxy-Authorization',
    'X-Custom-Secret'
  ]) {
    assert(
      !isAllowedProviderManagedCredentialHeaderName(name),
      `${name} must not be accepted as a managed credential header name`
    )
  }
  for (const value of [
    'sk_live_51ABCDEF',
    'sk_test_51ABCDEF',
    'AKIAIOSFODNN7EXAMPLE',
    'ASIAIOSFODNN7EXAMPLE',
    'glpat-example-token',
    'npm_example_token',
    'xoxb-example-token',
    'ya29.example-token'
  ]) {
    assert(looksLikeProviderCredentialValue(value), `${value} must be classified as credential-like`)
  }
}

function runProviderCustomHeaderChecks(inspectProviderCustomHeaders) {
  const headerToken = credentialCanary('header')
  const inspected = inspectProviderCustomHeaders(
    [
      'Content-Type: application/json',
      'Authorization: Bearer do-not-persist',
      'X-Trace-Id: trace-123',
      'X-Gateway-Route: openai',
      'X-Custom-Token: do-not-persist-either',
      'X-Route: Bearer do-not-persist-under-safe-name',
      'X-Project-Route: sk_live_51ABCDEF',
      'X-License: do-not-persist-under-unknown-name',
      'X-Route-sk_live_51ABCDEF: benign',
      'X-Project-AKIAIOSFODNN7EXAMPLE: benign',
      `X-Route-${String.fromCharCode(0)}: malformed-name`,
      'X-Route- bad: malformed-name',
      `X-Debug-Mode: route${String.fromCharCode(0)}injected`,
      `${String.fromCharCode(0x0b)}X-Route: malformed-name-padding`,
      `X-Debug-Mode: ${String.fromCharCode(0x0b)}malformed-value-padding`,
      `X-Debug-Mode: malformed-value-padding${String.fromCharCode(0x0c)}`,
      `Bearer ${headerToken}`
    ].join('\n')
  )
  assertDeepEqual(
    inspected,
    {
      safeValue: [
        'Content-Type: application/json',
        'X-Trace-Id: trace-123',
        'X-Gateway-Route: openai'
      ].join('\n'),
      rejectedNames: [
        'Authorization',
        'X-Custom-Token',
        'X-Route',
        'X-Project-Route',
        'X-License',
        '(credential-like header name)',
        '(invalid header name)',
        'X-Debug-Mode',
        '(invalid header line)'
      ]
    },
    'custom header inspection must preserve only allowlisted non-secret routing metadata'
  )
  assert(
    !inspected.safeValue.includes('do-not-persist'),
    'safe custom headers must not retain sensitive values'
  )
  assert(
    !inspected.rejectedNames.some((name) => name.includes(headerToken)),
    'custom header rejection diagnostics must not echo malformed credential values'
  )
  assert(
    !/[\0\x0b\x0c\x7f]/.test(inspected.safeValue),
    'safe custom headers must not retain ASCII control characters'
  )
}

function runProviderBaseUrlChecks(inspectProviderBaseUrl) {
  const headerToken = credentialCanary('header')
  const inspectedUrl = inspectProviderBaseUrl(
    'https://user:password@example.com/v1?api_key=do-not-persist&route=fast'
  )
  assertDeepEqual(
    inspectedUrl.rejectedNames,
    ['URL userinfo', 'api_key', 'route'],
    'Base URL inspection must detect userinfo and reject all query parameters'
  )
  assert(!inspectedUrl.safeValue.includes('password'), 'safe Base URL must remove password userinfo')
  assert(!inspectedUrl.safeValue.includes('api_key'), 'safe Base URL must remove credential query parameters')
  assertDeepEqual(
    inspectProviderBaseUrl('https://example.com/v1?alt=sse&format=json'),
    { safeValue: 'https://example.com/v1', rejectedNames: ['alt', 'format'] },
    'Base URL query parameters must fail closed until adapters support structured URL options'
  )
  for (const queryName of ['apiSecret', 'clientSecret', 'sig', 'hmac', 'authCode', 'license']) {
    const queryInspection = inspectProviderBaseUrl(`https://example.com/v1?${queryName}=do-not-persist`)
    assert(
      queryInspection.rejectedNames.includes(queryName),
      `Base URL inspection must reject credential query alias: ${queryName}`
    )
  }
  for (const [queryName, queryValue] of [
    ['project', headerToken],
    ['tenant', 'Bearer canary'],
    ['route', ['ey', 'Jcanary'].join('')],
    ['route', 'sk_live_51ABCDEF'],
    ['region', 'AKIAIOSFODNN7EXAMPLE']
  ]) {
    const queryInspection = inspectProviderBaseUrl(
      `https://example.com/v1?${queryName}=${encodeURIComponent(queryValue)}`
    )
    assert(
      queryInspection.rejectedNames.includes(queryName),
      `Base URL inspection must reject credential-like values under allowed query names: ${queryName}`
    )
  }
  assertDeepEqual(
    inspectProviderBaseUrl('not-a-valid-provider-url'),
    { safeValue: '', rejectedNames: ['invalid Base URL'] },
    'invalid Base URLs must fail closed instead of being persisted verbatim'
  )
  assertDeepEqual(
    inspectProviderBaseUrl('file:///tmp/provider-secret'),
    { safeValue: '', rejectedNames: ['URL protocol file:'] },
    'non-HTTP Provider URL protocols must fail closed'
  )
  assertDeepEqual(
    inspectProviderBaseUrl('https://example.com/v1#credential-fragment'),
    { safeValue: 'https://example.com/v1', rejectedNames: ['URL fragment'] },
    'Base URL fragments must fail closed instead of corrupting appended endpoints'
  )
  const credentialQueryName = 'route-sk_live_51ABCDEF'
  const credentialQueryInspection = inspectProviderBaseUrl(
    `https://example.com/v1?${credentialQueryName}=benign`
  )
  assertDeepEqual(
    credentialQueryInspection,
    {
      safeValue: 'https://example.com/v1',
      rejectedNames: ['(credential-like query parameter)']
    },
    'Base URL rejection diagnostics must not echo credential-like parameter names'
  )
  assert(
    !JSON.stringify(credentialQueryInspection).includes('51ABCDEF'),
    'Base URL rejection diagnostics must not echo credential-like canaries'
  )
  const credentialPathInspection = inspectProviderBaseUrl(
    'https://example.com/v1/sk_live_51ABCDEF/models'
  )
  assertDeepEqual(
    credentialPathInspection,
    { safeValue: 'https://example.com/', rejectedNames: ['credential-like URL path'] },
    'Base URL paths must reject and redact known credential formats'
  )
  const credentialHostInspection = inspectProviderBaseUrl(
    'https://sk_live_51ABCDEF.example.com/v1'
  )
  assertDeepEqual(
    credentialHostInspection,
    { safeValue: '', rejectedNames: ['credential-like URL host'] },
    'Base URL hosts must reject and redact known credential formats'
  )
}

function createCryptoBackend({
  available = true,
  selectedBackend = 'keychain',
  encryptThrows = false
} = {}) {
  return {
    isEncryptionAvailable() {
      return available
    },
    getSelectedStorageBackend() {
      return selectedBackend
    },
    encryptString(value) {
      if (encryptThrows) throw new Error('injected encryption failure')
      return xorBuffer(Buffer.from(value, 'utf8'))
    },
    decryptString(value) {
      return xorBuffer(value).toString('utf8')
    }
  }
}

function xorBuffer(value) {
  return Buffer.from(Array.from(value, (byte) => byte ^ 0xa5))
}

function credentialCanary(label) {
  return ['sk', label, 'fixture'].join('-')
}

function formatDiagnostics(ts, diagnostics) {
  if (diagnostics.length === 0) return ''
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => '\n'
  })
}

function read(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8')
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  assert(actualJson === expectedJson, `${message}\nexpected: ${expectedJson}\nactual:   ${actualJson}`)
}

function assertThrows(fn, message) {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  assert(threw, message)
}

function walk(root) {
  const entries = []
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) entries.push(...walk(full))
    else entries.push(full)
  }
  return entries
}
