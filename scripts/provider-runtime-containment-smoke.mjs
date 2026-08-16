#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { buildProviderIpcContractAudit } from './lib/provider-runtime-containment-contracts.mjs'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-containment-'))
const outDir = path.join(tempRoot, 'compiled')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-runtime-containment', runId)
const credentialCanary = ['provider', 'runtime', 'containment', 'fixture'].join('-')
const checks = []

const rawCredentialNames = new Set(['decryptProviderToken', 'decryptToken', 'resolveProviderToken'])
const rawCredentialAllowlist = new Map([
  ['src/main/agent/model-dag-decomposer.ts', ['decryptProviderToken']]
])
let typeProgram
let typeChecker
let unreachableProgram

try {
  typeProgram = createTypeProgram()
  typeChecker = typeProgram.getTypeChecker()
  verifyTypeProgramDiagnostics()
  compileBroker()
  const brokerModule = await import(pathToFileURL(findCompiled(outDir, 'providerCredentialBroker.js')).href)
  verifyBrokerRuntime(brokerModule.ProviderCredentialBroker)
  verifyRawCredentialConsumers()
  verifyProcessBoundaries()
  verifyProviderViewSchema()
  verifyDelegationShapeGuard()
  verifyDelegationReachabilityGuard()
  verifyProviderIpcProjection()
  writeReport()
  console.log(`provider runtime containment smoke: PASS (${checks.length}/${checks.length})`)
  console.log(`report: ${reportDir}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function verifyBrokerRuntime(ProviderCredentialBroker) {
  const secureBroker = new ProviderCredentialBroker(secureBackend())
  const secureRef = { providerId: 'provider-secure', keyId: 'key-secure' }
  const secureRecord = secureBroker.store(secureRef, credentialCanary)
  check(secureRecord.encryptedToken.startsWith('enc:'),
    'Broker marks secure-backend output as an opaque encrypted record')
  check(!JSON.stringify(secureRecord).includes(credentialCanary),
    'serialized secure-backend record excludes plaintext')
  const secureResolution = secureBroker.resolve(secureRef, secureRecord)
  check(secureResolution.available && secureResolution.token === credentialCanary,
    'the owning main-process broker can resolve its encrypted credential')

  const sessionBroker = new ProviderCredentialBroker(sessionOnlyBackend())
  const sessionRef = { providerId: 'provider-session', keyId: 'key-session' }
  const sessionRecord = sessionBroker.store(sessionRef, credentialCanary)
  check(sessionRecord.sessionOnly === true && sessionRecord.encryptedToken === '',
    'non-secure storage emits only a session reference')
  check(!JSON.stringify(sessionRecord).includes(credentialCanary), 'serialized session record excludes plaintext')
  check(sessionBroker.resolve(sessionRef, sessionRecord).token === credentialCanary,
    'session credential remains available to the owning broker')

  const child = spawnSync(process.execPath, ['-e', childResolutionScript(
    findCompiled(outDir, 'providerCredentialBroker.js'), sessionRef, sessionRecord
  )], { encoding: 'utf8' })
  check(child.status === 0, 'isolated process containment probe exits successfully')
  const childResolution = JSON.parse(child.stdout)
  check(childResolution.available === false && childResolution.token === '',
    'session-only credential cannot be recovered by a fresh process')
  check(!child.stdout.includes(credentialCanary) && !child.stderr.includes(credentialCanary),
    'isolated process output excludes credential plaintext')

  const malformed = secureBroker.resolve(secureRef, { encryptedToken: 'enc:not-base64!' })
  check(malformed.available === false && malformed.token === '',
    'malformed encrypted records fail closed without plaintext')
}

function verifyRawCredentialConsumers() {
  const providerModule = programSource('src/main/providers.ts')
  const targets = new Map([...rawCredentialNames].map((name) => [name, exportedSymbol(providerModule, name)]))
  const discovered = new Set()
  const dynamicLoads = []
  for (const sourceFile of programSourcesUnder('src/main')) {
    const relative = relativePath(sourceFile.fileName)
    walk(sourceFile, (node) => {
      const symbol = resolvedSymbolAt(node)
      for (const [name, target] of targets) {
        if (symbol === target && relative !== 'src/main/providers.ts') discovered.add(`${relative}:${name}`)
      }
      const loadedModule = dynamicModuleSpecifier(node)
      if (loadedModule && isCredentialModuleSpecifier(loadedModule)) {
        dynamicLoads.push(`${relative}:${loadedModule}`)
      }
    })
  }
  const expected = [...rawCredentialAllowlist.entries()]
    .flatMap(([file, names]) => names.map((name) => `${file}:${name}`))
    .sort()
  equal([...discovered].sort(), expected,
    'raw credential resolver symbols stay in audited main-process executors')
  equal([...new Set(dynamicLoads)].sort(), [],
    'dynamic imports and require calls cannot bypass raw credential resolver auditing')
}

function verifyProcessBoundaries() {
  const boundaryFiles = [
    path.join(repoRoot, 'src', 'main', 'ipc.ts'),
    ...collectTypeScriptFiles(path.join(repoRoot, 'src', 'main', 'ipc')),
    ...collectTypeScriptFiles(path.join(repoRoot, 'src', 'preload')),
    ...collectTypeScriptFiles(path.join(repoRoot, 'src', 'renderer', 'src'))
  ]
  const sensitiveSymbols = serverOnlyCredentialSymbols()
  const sensitiveLabels = new Set(sensitiveSymbols.values())
  for (const name of [
    'commitProviderProfileStore',
    'getProvider',
    'loadProviderProfileStore',
    'reloadProviderProfileStoreFromDisk',
    'restoreProviderProfileStoreMemory'
  ]) {
    check(sensitiveLabels.has(`providers.${name}`),
      `raw Provider Store API ${name} is classified as server-only`)
  }
  const violations = []
  for (const file of boundaryFiles) {
    const sourceFile = typeProgram.getSourceFile(file)
    if (!sourceFile) throw new Error(`missing program source ${relativePath(file)}`)
    walk(sourceFile, (node) => {
      const symbol = resolvedSymbolAt(node)
      const sensitiveName = sensitiveSymbols.get(symbol)
      if (sensitiveName) violations.push(`${relativePath(file)}:${sensitiveName}`)
      const loadedModule = dynamicModuleSpecifier(node)
      if (loadedModule && isCredentialModuleSpecifier(loadedModule)) {
        violations.push(`${relativePath(file)}:dynamic:${loadedModule}`)
      }
    })
  }
  equal([...new Set(violations)].sort(), [],
    'IPC, preload, and renderer exclude server-only Provider records, Broker state, and resolver APIs')
}

function verifyProviderViewSchema() {
  const sourceFile = programSource('src/shared/types.ts')
  const providerType = exportedType(sourceFile, 'Provider')
  const providerViewType = exportedType(sourceFile, 'ProviderView')
  const keyType = exportedType(sourceFile, 'ProviderApiKey')
  const keyViewType = exportedType(sourceFile, 'ProviderApiKeyView')
  const providerFields = typeFields(providerType)
  const providerViewFields = typeFields(providerViewType)
  const keyFields = typeFields(keyType)
  const keyViewFields = typeFields(keyViewType)
  check(providerFields.has('encryptedToken') && keyFields.has('encryptedToken'),
    'schema fixture proves raw Provider records contain credential state')
  check(!typeChecker.getIndexInfoOfType(providerViewType, ts.IndexKind.String)
    && !typeChecker.getIndexInfoOfType(keyViewType, ts.IndexKind.String),
  'Provider view types have no string index signature that can admit hidden credential fields')
  for (const name of ['encryptedToken', 'sessionOnly', 'token']) {
    check(!providerViewFields.has(name), `ProviderView excludes ${name}`)
    check(!keyViewFields.has(name), `ProviderApiKeyView excludes ${name}`)
  }
  for (const name of ['hasToken', 'keyCount', 'credentialStorage', 'apiKeys']) {
    check(providerViewFields.has(name), `ProviderView retains safe credential metadata ${name}`)
  }
  for (const name of ['id', 'label', 'credentialStorage', 'available', 'active']) {
    check(keyViewFields.has(name), `ProviderApiKeyView retains safe key metadata ${name}`)
  }
  const apiKeysProperty = typeChecker.getPropertyOfType(providerViewType, 'apiKeys')
  if (!apiKeysProperty) throw new Error('ProviderView.apiKeys is missing')
  const apiKeysType = typeChecker.getNonNullableType(typeChecker.getTypeOfSymbolAtLocation(
    apiKeysProperty, apiKeysProperty.valueDeclaration ?? apiKeysProperty.declarations?.[0] ?? sourceFile
  ))
  const apiKeyElementType = typeChecker.getIndexTypeOfType(apiKeysType, ts.IndexKind.Number)
  if (!apiKeyElementType) throw new Error('ProviderView.apiKeys is not an array-like view')
  check(isExactAuditedType(apiKeyElementType, keyViewType),
    'ProviderView.apiKeys resolves exactly to ProviderApiKeyView without any, union, or intersection branches')
  verifyToViewProjection(providerViewType, keyViewType)
}

function verifyProviderIpcProjection() {
  const ipcSource = programSource('src/main/ipc.ts')
  const providerImports = importedNames(ipcSource, './providers')
  equal(providerImports.sort(), ['createProvider', 'deleteProvider', 'fetchModels', 'listProviders', 'probeProviderGeneration', 'updateProvider'],
    'provider IPC imports only sanitized CRUD and bound model-discovery APIs')
  const audit = buildProviderIpcContractAudit({ programSource, exportedSymbol, exportedType })
  const { contracts, expectedProviderChannels, types } = audit
  const {
    providerView: providerViewType,
    deviceAuthorizationView: deviceAuthorizationViewType,
    quickDeviceAuthorizationView: quickDeviceAuthorizationViewType,
    authorizationAccountView: authorizationAccountViewType,
    authorizationQuotaView: authorizationQuotaViewType,
    authorizationQuotaTierView: authorizationQuotaTierViewType
  } = types
  const providersSource = programSource('src/main/providers.ts')
  const mainRegistrations = collectMainIpcRegistrations(mainIpcSources())
  equal(mainRegistrations.nonLiteral, [], 'main-process IPC registrations use literal channel names')
  const providerRegistrations = mainRegistrations.records.filter((item) => item.channel.startsWith('providers:'))
  equal(providerRegistrations.map((item) => item.channel).sort(), expectedProviderChannels,
    'all main-process IPC modules expose each audited Provider channel exactly once')
  check(providerRegistrations.every((item) => item.method === 'handle'),
    'every Provider main-process channel is a request-response ipcMain.handle contract')
  const rawProviderTypes = rawProviderTypeSymbols()
  for (const registration of providerRegistrations) {
    const contract = contracts.get(registration.channel)
    if (!contract) throw new Error(`missing Provider IPC contract ${registration.channel}`)
    check(contract.verifyTarget
      ? handlerCopiesResolvedTokenToClipboard(registration.handler, contract.verifyTarget)
      : contract.sequence
        ? handlerHasExactDirectCallSequence(registration.handler, contract.sequence)
        : handlerDelegatesTo(registration.handler, contract.target, contract.returns),
    `${registration.channel} directly delegates on its effective return path`)
    const returnType = handlerReturnType(registration.handler)
    check(!typeContainsRawProvider(returnType, rawProviderTypes)
      && !typeContainsUnconstrainedBranch(returnType),
    `${registration.channel} handler return type excludes raw Provider, any, and unknown branches`)
    if (contract.expectedType) {
      check(functionReturnsExactPayloadType(contract.target, contract.expectedType, Boolean(contract.array)),
        `${registration.channel} service returns its exact audited public view type`)
    }
  }

  const preloadAudit = collectPreloadIpcCalls(preloadSources())
  equal(preloadAudit.nonLiteral, [],
    'preload IPC calls use literal channels outside the single audited invokeMain wrapper')
  const preloadProviderCalls = preloadAudit.records.filter((item) => item.channel.startsWith('providers:'))
  equal(preloadProviderCalls.map((item) => item.channel).sort(), expectedProviderChannels,
    'all preload modules expose each audited Provider channel exactly once')
  check(preloadProviderCalls.every((item) => item.auditedReceiver),
    'every Provider preload channel uses imported Electron ipcRenderer or the audited invokeMain wrapper')
  verifyInvokeMainWrapper()

  check(functionReturnsExactType(exportedSymbol(providersSource, 'listProviders'), providerViewType, true),
    'listProviders returns exactly ProviderView records')
  for (const functionName of ['createProvider', 'updateProvider']) {
    check(functionReturnsExactType(exportedSymbol(providersSource, functionName), providerViewType, false),
      `${functionName} returns exactly a ProviderView projection`)
  }

  verifyProviderPublicViewFields({
    deviceAuthorizationViewType,
    quickDeviceAuthorizationViewType,
    authorizationAccountViewType,
    authorizationQuotaViewType,
    authorizationQuotaTierViewType
  })
}

function verifyProviderPublicViewFields(types) {
  equal([...typeFields(types.deviceAuthorizationViewType)].sort(), [
    'expiresAt', 'flowId', 'intervalSeconds', 'providerId', 'service', 'userCode', 'verificationUri'
  ], 'device authorization IPC view exposes only the audited browser-flow fields')
  equal([...typeFields(types.quickDeviceAuthorizationViewType)].sort(), [
    'expiresAt', 'flowId', 'intervalSeconds', 'service', 'userCode', 'verificationUri'
  ], 'quick authorization IPC view excludes placeholder Provider and private device identifiers')
  equal([...typeFields(types.authorizationAccountViewType)].sort(), [
    'authenticatedAt', 'bound', 'credentialStorage', 'id', 'label', 'lastFailureAt', 'lastQuota', 'policy', 'providerId',
    'quota', 'requiresReauth', 'routingReason', 'routingState', 'service', 'updatedAt'
  ], 'authorization account IPC view excludes access, refresh, and encrypted credential material')
  equal([...typeFields(types.authorizationQuotaViewType)].sort(), [
    'accountId', 'errorCode', 'providerId', 'queriedAt', 'status', 'tiers'
  ], 'authorization quota IPC view exposes only account-safe utilization metadata')
  equal([...typeFields(types.authorizationQuotaTierViewType)].sort(), [
    'name', 'resetsAt', 'utilization', 'windowSeconds'
  ], 'authorization quota tier IPC view excludes credential and raw response fields')
}

function compileBroker() {
  writeFileSync(path.join(tempRoot, 'package.json'), '{"type":"commonjs"}\n')
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/providerCredentialBroker.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function childResolutionScript(compiledPath, ref, record) {
  return [
    `const { ProviderCredentialBroker } = require(${JSON.stringify(compiledPath)});`,
    'const backend = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error("disabled") },',
    'decryptString: () => { throw new Error("disabled") }, getSelectedStorageBackend: () => "basic_text" };',
    `const result = new ProviderCredentialBroker(backend).resolve(${JSON.stringify(ref)}, ${JSON.stringify(record)});`,
    'process.stdout.write(JSON.stringify(result));'
  ].join('\n')
}

function secureBackend() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8')
  }
}

function sessionOnlyBackend() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => { throw new Error('disabled') },
    decryptString: () => { throw new Error('disabled') }
  }
}

function importedNames(sourceFile, moduleName) {
  const names = []
  for (const node of sourceFile.statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== moduleName
      || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) continue
    for (const element of node.importClause.namedBindings.elements) {
      names.push(element.propertyName?.text ?? element.name.text)
    }
  }
  return names
}

function createTypeProgram() {
  const rootNames = new Set()
  let options = {}
  for (const configName of ['tsconfig.node.json', 'tsconfig.web.json']) {
    const configPath = path.join(repoRoot, configName)
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot, {}, configPath)
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'))
    }
    for (const file of parsed.fileNames) rootNames.add(path.resolve(file))
    options = { ...options, ...parsed.options }
  }
  return ts.createProgram({ rootNames: [...rootNames], options: { ...options, noEmit: true, skipLibCheck: true } })
}

function verifyTypeProgramDiagnostics() {
  const diagnostics = [
    ...typeProgram.getSyntacticDiagnostics(),
    ...typeProgram.getSemanticDiagnostics()
  ]
  const failures = diagnostics.map((diagnostic) => {
    const location = diagnostic.file && typeof diagnostic.start === 'number'
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined
    const prefix = diagnostic.file && location
      ? `${relativePath(diagnostic.file.fileName)}:${location.line + 1}:${location.character + 1}`
      : 'program'
    return `${prefix}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
  })
  equal(failures, [], 'combined node and renderer TypeScript audit program has no diagnostics')
}

function programSource(relative) {
  const file = path.join(repoRoot, relative)
  const sourceFile = typeProgram.getSourceFile(file)
  if (!sourceFile) throw new Error(`missing program source ${relative}`)
  return sourceFile
}

function programSourcesUnder(relativeRoot) {
  const prefix = `${relativeRoot.replace(/\\/g, '/').replace(/\/$/, '')}/`
  return typeProgram.getSourceFiles().filter((sourceFile) =>
    !sourceFile.isDeclarationFile && relativePath(sourceFile.fileName).startsWith(prefix))
}

function exportedSymbol(sourceFile, name) {
  const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile)
  const symbol = moduleSymbol && typeChecker.getExportsOfModule(moduleSymbol).find((item) => item.name === name)
  if (!symbol) throw new Error(`missing export ${name} in ${relativePath(sourceFile.fileName)}`)
  return resolvedSymbol(symbol)
}

function exportedType(sourceFile, name) {
  return typeChecker.getDeclaredTypeOfSymbol(exportedSymbol(sourceFile, name))
}

function resolvedSymbolAt(node) {
  return resolvedSymbol(typeChecker.getSymbolAtLocation(node))
}

function resolvedSymbol(symbol) {
  if (!symbol) return undefined
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol
  const target = typeChecker.getAliasedSymbol(symbol)
  return target && target !== symbol ? resolvedSymbol(target) : symbol
}

function typeFields(type) {
  return new Set(typeChecker.getPropertiesOfType(type).map((symbol) => symbol.name))
}

function serverOnlyCredentialSymbols() {
  const symbols = new Map()
  const providersSource = programSource('src/main/providers.ts')
  for (const name of rawCredentialNames) symbols.set(exportedSymbol(providersSource, name), name)
  const brokerSource = programSource('src/main/providerCredentialBroker.ts')
  const brokerSymbol = exportedSymbol(brokerSource, 'ProviderCredentialBroker')
  symbols.set(brokerSymbol, 'ProviderCredentialBroker')
  const brokerType = typeChecker.getDeclaredTypeOfSymbol(brokerSymbol)
  const sessionTokens = typeChecker.getPropertyOfType(brokerType, 'sessionTokens')
  if (sessionTokens) symbols.set(sessionTokens, 'ProviderCredentialBroker.sessionTokens')

  const runtimeSource = programSource('src/main/providerCredentialRuntime.ts')
  const runtimeModule = typeChecker.getSymbolAtLocation(runtimeSource)
  if (!runtimeModule) throw new Error('missing provider credential runtime module symbol')
  for (const exported of typeChecker.getExportsOfModule(runtimeModule)) {
    const target = resolvedSymbol(exported)
    if (target) symbols.set(target, `providerCredentialRuntime.${exported.name}`)
  }

  const authSource = programSource('src/main/providerRuntimeAuth.ts')
  const authModule = typeChecker.getSymbolAtLocation(authSource)
  if (!authModule) throw new Error('missing provider runtime auth module symbol')
  for (const exported of typeChecker.getExportsOfModule(authModule)) {
    const target = resolvedSymbol(exported)
    if (target) symbols.set(target, `providerRuntimeAuth.${exported.name}`)
  }

  const typesSource = programSource('src/shared/types.ts')
  const rawProviderTypes = rawProviderTypeSymbols()
  for (const typeName of ['Provider', 'ProviderApiKey']) {
    const typeSymbol = exportedSymbol(typesSource, typeName)
    symbols.set(typeSymbol, typeName)
    const type = typeChecker.getDeclaredTypeOfSymbol(typeSymbol)
    for (const field of ['encryptedToken', 'sessionOnly']) {
      const property = typeChecker.getPropertyOfType(type, field)
      if (property) symbols.set(property, `${typeName}.${field}`)
    }
  }
  const providersModule = typeChecker.getSymbolAtLocation(providersSource)
  if (!providersModule) throw new Error('missing providers module symbol')
  for (const exported of typeChecker.getExportsOfModule(providersModule)) {
    const target = resolvedSymbol(exported)
    if (target && symbolExposesRawProvider(target, rawProviderTypes)) {
      symbols.set(target, `providers.${exported.name}`)
    }
  }
  return symbols
}

function rawProviderTypeSymbols() {
  const typesSource = programSource('src/shared/types.ts')
  return new Set(['Provider', 'ProviderApiKey'].map((name) => exportedSymbol(typesSource, name)))
}

function symbolExposesRawProvider(symbol, rawProviderTypes) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (!declaration) return false
  const type = typeChecker.getTypeOfSymbolAtLocation(symbol, declaration)
  return typeChecker.getSignaturesOfType(type, ts.SignatureKind.Call).some((signature) => {
    const returnType = typeChecker.getReturnTypeOfSignature(signature)
    if (typeContainsRawProvider(returnType, rawProviderTypes)) return true
    return signature.parameters.some((parameter) => {
      const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? declaration
      return typeContainsRawProvider(
        typeChecker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration), rawProviderTypes
      )
    })
  })
}

function typeContainsRawProvider(type, rawProviderTypes, seen = new Set()) {
  if (!type || seen.has(type)) return false
  seen.add(type)
  if (type.symbol && rawProviderTypes.has(resolvedSymbol(type.symbol))) return true
  if (type.aliasSymbol && rawProviderTypes.has(resolvedSymbol(type.aliasSymbol))) return true
  if (type.isUnionOrIntersection()) {
    return type.types.some((branch) => typeContainsRawProvider(branch, rawProviderTypes, seen))
  }
  if (typeChecker.isArrayType(type) || typeChecker.isTupleType(type)) {
    return typeChecker.getTypeArguments(type).some((item) =>
      typeContainsRawProvider(item, rawProviderTypes, seen))
  }
  const containerName = type.symbol?.name
  if (['Promise', 'ReadonlyArray', 'Set', 'Map'].includes(containerName)
    && (type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
    if (typeChecker.getTypeArguments(type).some((item) =>
      typeContainsRawProvider(item, rawProviderTypes, seen))) return true
  }
  return typeChecker.getPropertiesOfType(type).some((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0]
    if (!declaration) return false
    return typeContainsRawProvider(typeChecker.getTypeOfSymbolAtLocation(property, declaration), rawProviderTypes, seen)
  })
}

function typeContainsUnconstrainedBranch(type, seen = new Set()) {
  if (!type || seen.has(type)) return false
  seen.add(type)
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
  if (type.isUnionOrIntersection()) {
    return type.types.some((branch) => typeContainsUnconstrainedBranch(branch, seen))
  }
  if (typeChecker.isArrayType(type) || typeChecker.isTupleType(type)) {
    return typeChecker.getTypeArguments(type).some((item) => typeContainsUnconstrainedBranch(item, seen))
  }
  if ((type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
    return typeChecker.getTypeArguments(type).some((item) => typeContainsUnconstrainedBranch(item, seen))
  }
  return false
}

function dynamicModuleSpecifier(node) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return ''
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
  if (!isRequire && !isDynamicImport) return ''
  const specifier = node.arguments[0]
  return ts.isStringLiteralLike(specifier) ? specifier.text : ''
}

function isCredentialModuleSpecifier(specifier) {
  const normalized = specifier.replace(/\\/g, '/').replace(/\.(c|m)?[jt]sx?$/, '')
  return /(^|\/)(providers|providerCredentialBroker|providerCredentialRuntime|providerRuntimeAuth)$/.test(normalized)
}

function verifyToViewProjection(providerViewType, keyViewType) {
  const sourceFile = programSource('src/main/providers.ts')
  const declaration = sourceFile.statements.find((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'toView')
  if (!declaration?.body) throw new Error('missing toView function body')

  const providerProjection = singleObjectReturn(declaration.body, 'toView')
  verifyObjectProjection(providerProjection, providerViewType, 'toView ProviderView projection')

  const apiKeysVariable = namedVariableDeclaration(declaration.body, 'apiKeys')
  if (!apiKeysVariable) throw new Error('toView apiKeys projection variable is missing')
  const initializer = apiKeysVariable?.initializer
  const keyProjection = mappedObjectProjection(initializer, 'toView apiKeys')
  verifyObjectProjection(keyProjection, keyViewType, 'toView ProviderApiKeyView projection')
  verifyProjectionVariableBinding(providerProjection, 'apiKeys', apiKeysVariable)
}

function singleObjectReturn(body, label) {
  const returns = directReturnExpressions(body)
  equal(returns.length, 1, `${label} has exactly one non-nested return path`)
  if (!returns[0] || !ts.isObjectLiteralExpression(returns[0])) {
    throw new Error(`${label} does not return a direct object projection`)
  }
  return returns[0]
}

function namedVariableDeclaration(body, name) {
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const match = statement.declarationList.declarations.find((item) =>
      ts.isIdentifier(item.name) && item.name.text === name)
    if (match) return match
  }
  return undefined
}

function mappedObjectProjection(initializer, label) {
  if (!initializer || !ts.isCallExpression(initializer)
    || !ts.isPropertyAccessExpression(initializer.expression)
    || initializer.expression.name.text !== 'map' || initializer.arguments.length !== 1) {
    throw new Error(`${label} projection is not an auditable map call`)
  }
  const callback = initializer.arguments[0]
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    throw new Error(`${label} projection has no auditable callback`)
  }
  if (ts.isObjectLiteralExpression(callback.body)) return callback.body
  return singleObjectReturn(callback.body, `${label} map`)
}

function verifyProjectionVariableBinding(projection, field, variable) {
  const returnedField = projection.properties.find((property) =>
    !ts.isSpreadAssignment(property) && propertyName(property.name) === field)
  const variableSymbol = typeChecker.getSymbolAtLocation(variable.name)
  const returnedSymbol = returnedField && projectionValueSymbol(returnedField)
  check(Boolean(variableSymbol) && returnedSymbol === variableSymbol,
    `toView returns the exact audited ${field} projection variable`)
}

function directReturnExpressions(body) {
  const results = []
  const visit = (node) => {
    if (node !== body && ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node)) {
      results.push(node.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return results
}

function projectionValueSymbol(property) {
  if (ts.isShorthandPropertyAssignment(property)) {
    return typeChecker.getShorthandAssignmentValueSymbol(property)
  }
  if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
    return typeChecker.getSymbolAtLocation(property.initializer)
  }
  return undefined
}

function verifyObjectProjection(objectLiteral, targetType, name) {
  const actual = new Set()
  const dynamic = []
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      dynamic.push('spread')
      continue
    }
    const field = propertyName(property.name)
    if (!field) dynamic.push('computed')
    else actual.add(field)
  }
  equal(dynamic, [], `${name} has no spread or computed fields`)
  const allowed = typeFields(targetType)
  const required = new Set(typeChecker.getPropertiesOfType(targetType)
    .filter((symbol) => (symbol.flags & ts.SymbolFlags.Optional) === 0)
    .map((symbol) => symbol.name))
  equal([...actual].filter((field) => !allowed.has(field)).sort(), [], `${name} emits no undeclared fields`)
  equal([...required].filter((field) => !actual.has(field)).sort(), [], `${name} emits every required field`)
  for (const field of ['encryptedToken', 'sessionOnly', 'token']) {
    check(!actual.has(field), `${name} excludes ${field}`)
  }
}

function mainIpcSources() {
  return sourceFilesFor([
    path.join(repoRoot, 'src', 'main', 'ipc.ts'),
    ...collectTypeScriptFiles(path.join(repoRoot, 'src', 'main', 'ipc'))
  ])
}

function preloadSources() {
  return sourceFilesFor(collectTypeScriptFiles(path.join(repoRoot, 'src', 'preload')))
}

function sourceFilesFor(files) {
  return [...new Set(files.map((file) => path.resolve(file)))].map((file) => {
    const sourceFile = typeProgram.getSourceFile(file)
    if (!sourceFile) throw new Error(`missing program source ${relativePath(file)}`)
    return sourceFile
  })
}

function collectMainIpcRegistrations(sourceFiles) {
  const records = []
  const nonLiteral = []
  const unauditedProviderUses = []
  for (const sourceFile of sourceFiles) {
    const ipcMainSymbol = importedLocalSymbol(sourceFile, 'electron', 'ipcMain')
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length === 0) return
      const channel = node.arguments[0]
      const providerLiteral = ts.isStringLiteralLike(channel) && channel.text.startsWith('providers:')
      const expression = node.expression
      const isRegistration = Boolean(ipcMainSymbol) && ts.isPropertyAccessExpression(expression)
        && typeChecker.getSymbolAtLocation(expression.expression) === ipcMainSymbol
        && ['handle', 'on'].includes(expression.name.text)
      if (!isRegistration) {
        if (providerLiteral) unauditedProviderUses.push(`${relativePath(sourceFile.fileName)}:${channel.text}`)
        return
      }
      if (!ts.isStringLiteralLike(channel)) {
        nonLiteral.push(`${relativePath(sourceFile.fileName)}:${expression.name.text}`)
        return
      }
      const handler = node.arguments[1]
      if (!handler || !ts.isFunctionLike(handler)) {
        if (providerLiteral) throw new Error(`non-function Provider IPC handler ${channel.text}`)
        return
      }
      records.push({
        channel: channel.text,
        handler,
        method: expression.name.text,
        source: relativePath(sourceFile.fileName)
      })
    })
  }
  equal(unauditedProviderUses, [],
    'main IPC modules contain no Provider channel literals outside imported Electron ipcMain registrations')
  return { records, nonLiteral }
}

function collectPreloadIpcCalls(sourceFiles) {
  const records = []
  const nonLiteral = []
  const indexSource = programSource('src/preload/index.ts')
  const invokeMainDeclaration = indexSource.statements.find((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'invokeMain')
  const invokeMainSymbol = invokeMainDeclaration?.name
    ? typeChecker.getSymbolAtLocation(invokeMainDeclaration.name)
    : undefined
  for (const sourceFile of sourceFiles) {
    const ipcRendererSymbol = importedLocalSymbol(sourceFile, 'electron', 'ipcRenderer')
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length === 0) return
      const channel = node.arguments[0]
      const expression = node.expression
      const directMethod = ts.isPropertyAccessExpression(expression)
        && Boolean(ipcRendererSymbol)
        && typeChecker.getSymbolAtLocation(expression.expression) === ipcRendererSymbol
        && ['invoke', 'send', 'sendSync', 'postMessage'].includes(expression.name.text)
      const wrappedInvoke = ts.isIdentifier(expression)
        && Boolean(invokeMainSymbol)
        && typeChecker.getSymbolAtLocation(expression) === invokeMainSymbol
      const providerLiteral = ts.isStringLiteralLike(channel) && channel.text.startsWith('providers:')
      if (!directMethod && !wrappedInvoke) {
        if (providerLiteral) {
          records.push({ channel: channel.text, auditedReceiver: false, source: relativePath(sourceFile.fileName) })
        }
        return
      }
      if (!ts.isStringLiteralLike(channel)) {
        const insideWrapper = Boolean(invokeMainDeclaration?.body) && isDescendantOf(node, invokeMainDeclaration.body)
        if (!insideWrapper) nonLiteral.push(`${relativePath(sourceFile.fileName)}:${callName(expression)}`)
        return
      }
      records.push({ channel: channel.text, auditedReceiver: true, source: relativePath(sourceFile.fileName) })
    })
  }
  return { records, nonLiteral }
}

function importedLocalSymbol(sourceFile, moduleName, importedName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== moduleName
      || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const item of statement.importClause.namedBindings.elements) {
      const imported = item.propertyName?.text ?? item.name.text
      if (imported === importedName) return typeChecker.getSymbolAtLocation(item.name)
    }
  }
  return undefined
}

function handlerDelegatesTo(handler, target, returns) {
  if (handlerContainsUnreachableCode(handler)) return false
  const matchesTarget = (call) => resolvedSymbolAt(call.expression) === target
  if (countHandlerCalls(handler, matchesTarget) !== 1 && countHandlerCallsIncludingNested(handler, matchesTarget) !== 1) return false
  const call = handlerDelegationRootCall(handler, returns)
  if (!call) return false
  if (resolvedSymbolAt(call.expression) === target) return true
  // Provider authorization and balance mutations are wrapped by the
  // operation-effect gateway; the audited target remains the sole nested call.
  return ts.isIdentifier(call.expression) && call.expression.text === 'executeProviderOperationEffect'
}

function handlerCopiesResolvedTokenToClipboard(handler, resolveTokenTarget) {
  if (handlerContainsUnreachableCode(handler) || !ts.isBlock(handler.body)) return false
  const [copyStatement, returnStatement] = handler.body.statements
  if (handler.body.statements.length !== 2
    || !ts.isExpressionStatement(copyStatement)
    || !ts.isReturnStatement(returnStatement)
    || returnStatement.expression?.kind !== ts.SyntaxKind.TrueKeyword) return false
  const copyCall = directRootCallExpression(copyStatement.expression)
  if (!copyCall || !ts.isPropertyAccessExpression(copyCall.expression)
    || copyCall.expression.name.text !== 'writeText' || copyCall.arguments.length !== 1) return false
  const clipboardSymbol = importedLocalSymbol(handler.getSourceFile(), 'electron', 'clipboard')
  if (!clipboardSymbol || typeChecker.getSymbolAtLocation(copyCall.expression.expression) !== clipboardSymbol) return false
  const tokenCall = directRootCallExpression(copyCall.arguments[0])
  return Boolean(tokenCall)
    && resolvedSymbolAt(tokenCall.expression) === resolveTokenTarget
    && countHandlerCallsIncludingNested(
      handler,
      (candidate) => resolvedSymbolAt(candidate.expression) === resolveTokenTarget
    ) === 1
}

function countHandlerCallsIncludingNested(handler, matches) {
  let count = 0
  const visit = (node) => {
    if (ts.isCallExpression(node) && matches(node)) count += 1
    ts.forEachChild(node, visit)
  }
  if (handler.body) visit(handler.body)
  return count
}

function handlerHasExactDirectCallSequence(handler, targets) {
  if (handlerContainsUnreachableCode(handler) || !ts.isBlock(handler.body)) return false
  if (handler.body.statements.length !== targets.length) return false
  return handler.body.statements.every((statement, index) => {
    if (!ts.isExpressionStatement(statement)) return false
    const call = directRootCallExpression(statement.expression)
    return Boolean(call) && resolvedSymbolAt(call.expression) === targets[index]
      && countHandlerCalls(handler, (candidate) => resolvedSymbolAt(candidate.expression) === targets[index]) === 1
  })
}

function countHandlerCalls(handler, matches) {
  let count = 0
  const visit = (node) => {
    if (node !== handler.body && ts.isFunctionLike(node)) return
    if (ts.isCallExpression(node) && matches(node)) count += 1
    ts.forEachChild(node, visit)
  }
  visit(handler.body)
  return count
}

function handlerDelegationRootCall(handler, returns) {
  if (!ts.isBlock(handler.body)) {
    return returns ? directRootCallExpression(handler.body) : undefined
  }
  const statements = handler.body.statements
  const finalStatement = statements.at(-1)
  const precedingStatements = statements.slice(0, -1)
  if (precedingStatements.some((statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement))) {
    return undefined
  }
  const returnExpressions = directReturnExpressions(handler.body)
  if (returns) {
    if (returnExpressions.length !== 1 || !finalStatement || !ts.isReturnStatement(finalStatement)) return undefined
    return directRootCallExpression(finalStatement.expression)
  }
  if (returnExpressions.length !== 0 || !finalStatement || !ts.isExpressionStatement(finalStatement)) return undefined
  return directRootCallExpression(finalStatement.expression)
}

function directRootCallExpression(expression) {
  let root = expression
  while (root && (ts.isParenthesizedExpression(root) || ts.isAwaitExpression(root))) {
    root = root.expression
  }
  return root && ts.isCallExpression(root) ? root : undefined
}

function verifyDelegationShapeGuard() {
  equal(fixtureHandlerRootCallName('() => target()', true), 'target',
    'IPC delegation accepts a direct target call')
  equal(fixtureHandlerRootCallName('async () => await (target())', true), 'target',
    'IPC delegation accepts only transparent await and parentheses around the target call')
  equal(fixtureHandlerRootCallName('() => (target(), otherValue)', true), '',
    'IPC delegation rejects a sequence that calls the target but returns another value')
  equal(fixtureHandlerRootCallName('() => other(target())', true), 'other',
    'IPC delegation identifies the root call instead of a nested target call')
  equal(fixtureHandlerRootCallName('() => { throw new Error(); return target() }', true), '',
    'IPC delegation rejects a target return made unreachable by a preceding abrupt statement')
  equal(fixtureHandlerRootCallName('() => { if (condition) return target() }', true), '',
    'IPC delegation rejects a target return nested in a partial control-flow path')
  equal(fixtureHandlerRootCallName('() => { false && target() }', false), '',
    'void IPC delegation rejects a nested or conditional target call')
  equal(fixtureHandlerRootCallName('() => { target(); other() }', false), 'other',
    'void IPC delegation audits the final root call rather than any earlier target call')
  equal(fixtureHandlerTargetCallCount('() => { target(); return target() }'), 2,
    'returning IPC delegation detects duplicate target calls')
  equal(fixtureHandlerTargetCallCount('() => { target(); target() }'), 2,
    'void IPC delegation detects duplicate target calls')
}

function handlerContainsUnreachableCode(handler) {
  if (!unreachableProgram) {
    unreachableProgram = ts.createProgram({
      rootNames: mainIpcSources().map((sourceFile) => sourceFile.fileName),
      options: {
        ...typeProgram.getCompilerOptions(),
        allowUnreachableCode: false,
        noEmit: true,
        skipLibCheck: true
      }
    })
  }
  const sourceFile = unreachableProgram.getSourceFile(handler.getSourceFile().fileName)
  if (!sourceFile) throw new Error(`missing unreachable-code audit source ${relativePath(handler.getSourceFile().fileName)}`)
  const start = handler.getStart(handler.getSourceFile())
  return unreachableProgram.getSemanticDiagnostics(sourceFile).some((diagnostic) =>
    diagnostic.code === 7027 && typeof diagnostic.start === 'number'
      && diagnostic.start >= start && diagnostic.start < handler.end)
}

function verifyDelegationReachabilityGuard() {
  const fixturePath = path.join(tempRoot, 'provider-containment-reachability-fixture.ts')
  writeFileSync(fixturePath, [
    'declare const condition: boolean',
    'declare function target(): unknown',
    'const returnAfterIfTrue = () => { if (true) throw new Error(); return target() }',
    'const returnAfterBlock = () => { { throw new Error() } return target() }',
    'const returnAfterLoop = () => { while (true) {} return target() }',
    'const voidAfterIfTrue = () => { if (true) throw new Error(); target() }',
    'const voidAfterBlock = () => { { throw new Error() } target() }',
    'const voidAfterLoop = () => { while (true) {} target() }',
    'const returnAfterGuard = () => { if (condition) throw new Error(); return target() }',
    'const voidAfterGuard = () => { if (condition) throw new Error(); target() }'
  ].join('\n'))
  const fixtureProgram = ts.createProgram({
    rootNames: [fixturePath],
    options: {
      allowUnreachableCode: false,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022
    }
  })
  const sourceFile = fixtureProgram.getSourceFile(fixturePath)
  if (!sourceFile) throw new Error('missing delegation reachability fixture')
  const unreachablePositions = fixtureProgram.getSemanticDiagnostics(sourceFile)
    .filter((diagnostic) => diagnostic.code === 7027 && typeof diagnostic.start === 'number')
    .map((diagnostic) => diagnostic.start)
  const hasUnreachableCode = (name) => {
    const declaration = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((item) => ts.isIdentifier(item.name) && item.name.text === name)
    if (!declaration?.initializer) throw new Error(`missing reachability fixture ${name}`)
    return unreachablePositions.some((position) =>
      position >= declaration.initializer.getStart(sourceFile) && position < declaration.initializer.end)
  }
  for (const name of [
    'returnAfterIfTrue', 'returnAfterBlock', 'returnAfterLoop',
    'voidAfterIfTrue', 'voidAfterBlock', 'voidAfterLoop'
  ]) {
    check(hasUnreachableCode(name), `IPC delegation reachability probe rejects ${name}`)
  }
  for (const name of ['returnAfterGuard', 'voidAfterGuard']) {
    check(!hasUnreachableCode(name), `IPC delegation reachability probe accepts ${name}`)
  }
}

function fixtureHandlerRootCallName(source, returns) {
  const handler = fixtureHandler(source)
  const call = handler ? handlerDelegationRootCall(handler, returns) : undefined
  return call && ts.isIdentifier(call.expression) ? call.expression.text : ''
}

function fixtureHandlerTargetCallCount(source) {
  const handler = fixtureHandler(source)
  return handler ? countHandlerCalls(handler, (call) =>
    ts.isIdentifier(call.expression) && call.expression.text === 'target') : 0
}

function fixtureHandler(source) {
  const sourceFile = ts.createSourceFile(
    'provider-containment-delegation-fixture.ts',
    `const handler = ${source}\nexport {}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const statement = sourceFile.statements[0]
  const initializer = ts.isVariableStatement(statement)
    ? statement.declarationList.declarations[0]?.initializer
    : undefined
  return initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined
}

function handlerReturnType(handler) {
  const type = typeChecker.getTypeAtLocation(handler)
  const signature = typeChecker.getSignaturesOfType(type, ts.SignatureKind.Call)[0]
  if (!signature) throw new Error('IPC handler has no call signature')
  return typeChecker.getReturnTypeOfSignature(signature)
}

function verifyInvokeMainWrapper() {
  const sourceFile = programSource('src/preload/index.ts')
  const declaration = sourceFile.statements.find((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'invokeMain')
  if (!declaration?.body || declaration.parameters.length < 2) throw new Error('missing invokeMain wrapper')
  const returns = directReturnExpressions(declaration.body)
  equal(returns.length, 1, 'invokeMain has exactly one return path')
  const ipcRendererSymbol = importedLocalSymbol(sourceFile, 'electron', 'ipcRenderer')
  const channelSymbol = typeChecker.getSymbolAtLocation(declaration.parameters[0].name)
  const argsSymbol = typeChecker.getSymbolAtLocation(declaration.parameters[1].name)
  const matches = []
  walk(returns[0], (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || typeChecker.getSymbolAtLocation(node.expression.expression) !== ipcRendererSymbol
      || node.expression.name.text !== 'invoke') return
    const first = node.arguments[0]
    const second = node.arguments[1]
    matches.push(ts.isIdentifier(first) && typeChecker.getSymbolAtLocation(first) === channelSymbol
      && ts.isSpreadElement(second) && ts.isIdentifier(second.expression)
      && typeChecker.getSymbolAtLocation(second.expression) === argsSymbol)
  })
  equal(matches, [true], 'invokeMain forwards its exact channel and arguments to imported Electron ipcRenderer.invoke')
}

function isDescendantOf(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true
  }
  return false
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return 'call'
}

function functionReturnsExactType(functionSymbol, expectedType, array) {
  const declaration = functionSymbol.valueDeclaration ?? functionSymbol.declarations?.[0]
  if (!declaration) return false
  const functionType = typeChecker.getTypeOfSymbolAtLocation(functionSymbol, declaration)
  const signature = typeChecker.getSignaturesOfType(functionType, ts.SignatureKind.Call)[0]
  if (!signature) return false
  let actual = typeChecker.getNonNullableType(typeChecker.getReturnTypeOfSignature(signature))
  if (array) {
    actual = typeChecker.getIndexTypeOfType(actual, ts.IndexKind.Number)
    if (!actual) return false
  }
  return isExactAuditedType(actual, expectedType)
}

function functionReturnsExactPayloadType(functionSymbol, expectedType, array) {
  const declaration = functionSymbol.valueDeclaration ?? functionSymbol.declarations?.[0]
  if (!declaration) return false
  const functionType = typeChecker.getTypeOfSymbolAtLocation(functionSymbol, declaration)
  const signature = typeChecker.getSignaturesOfType(functionType, ts.SignatureKind.Call)[0]
  if (!signature) return false
  const declaredReturn = typeChecker.getNonNullableType(typeChecker.getReturnTypeOfSignature(signature))
  let actual = typeChecker.getAwaitedType(declaredReturn) ?? declaredReturn
  if (array) {
    actual = typeChecker.getIndexTypeOfType(actual, ts.IndexKind.Number)
    if (!actual) return false
  }
  return actual === expectedType && !typeContainsUnconstrainedBranch(actual)
}

function isExactAuditedType(actual, expected) {
  if (!actual || (actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union
    | ts.TypeFlags.Intersection)) !== 0) return false
  return actual === expected
}

function propertyName(name) {
  if (!name) return ''
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return ''
}

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function collectTypeScriptFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(full))
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(full)
  }
  return files
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* continue */ }
    } else if (entry.isFile() && entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function relativePath(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/')
}

function writeReport() {
  mkdirSync(reportDir, { recursive: true })
  const report = JSON.stringify({
    schemaVersion: 1,
    runId,
    status: 'passed',
    sourceRevision: gitOutput(['rev-parse', 'HEAD']),
    worktreeClean: gitOutput(['status', '--porcelain=v1', '--untracked-files=all']) === '',
    scope: 'Broker record behavior plus typed and static Provider process-boundary containment foundation',
    limitations: [
      'The secure-storage backend is a deterministic test double; this gate does not attest platform cryptographic strength.',
      'Provider, project, session, operation, and expiry scoping plus an all-output secret canary remain open.',
      'Computed module specifiers and opaque helper-indirected IPC channels remain outside this static foundation.'
    ],
    checks
  }, null, 2)
  if (report.includes(credentialCanary)) throw new Error('containment report includes credential plaintext')
  writeFileSync(path.join(reportDir, 'report.json'), `${report}\n`)
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function equal(actual, expected, name) {
  check(JSON.stringify(actual) === JSON.stringify(expected), name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function check(condition, name, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail' })
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`)
}
