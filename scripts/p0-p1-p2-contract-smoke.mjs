#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { verifySessionChoiceContract } from './lib/session-choice-contract.mjs'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-plan-contract-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')

try {
  verifyExactArtifacts()
  verifySourceContracts()
  verifyP2ExternalPreflightContracts()
  await verifyProviderModelDiscoveryBehavior()
  await verifyViewHardCap()
  console.log('p0/p1/p2 contract smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function verifyP2ExternalPreflightContracts() {
  const env = {
    ...process.env,
    CAOGEN_CHINA_REAL_NETWORK: '1',
    CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS: 'feishu',
    FEISHU_WEBHOOK_URL: ''
  }
  const output = execFileSync(process.execPath, ['scripts/p2-external-preflight.mjs'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8'
  })
  const report = JSON.parse(output)
  const china = report.checks.find((check) => check.name === 'china_real_network')
  assert(china, 'preflight report must include china_real_network check')
  assert(
    Array.isArray(china.requiredTargets) && china.requiredTargets.join(',') === 'feishu',
    'preflight must preserve CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS'
  )
  assert(
    Array.isArray(china.selectedTargets) && china.selectedTargets.length === 1 && china.selectedTargets[0].name === 'feishu',
    'preflight must only require selected China real-network targets when a filter is set'
  )
  assert(
    china.failures.some((failure) => failure.includes('feishu missing env')),
    'preflight must report the selected missing target'
  )
  assert(
    !china.failures.some((failure) => failure.includes('dingtalk missing env') || failure.includes('gitee_issue missing env')),
    'preflight target filter must not fail unselected targets'
  )
}

function verifyExactArtifacts() {
  const requiredFiles = [
    'caogen.md',
    'src/main/agent/tools/index.ts',
    'src/main/agent/tools/search-replace.ts',
    'src/main/agent/tools/view.ts',
    'src/main/sandbox/local-execution.ts',
    'src/main/browser/browser-manager.ts',
    'src/main/agent/tools/browser-tools.ts',
    'src/main/git/git-helper.ts',
    'src/main/agent/tools/git-tools.ts',
    'src/main/indexer/index.ts',
    'src/main/agent/context-loader.ts'
  ]
  for (const relPath of requiredFiles) {
    assert(existsSync(path.join(repoRoot, relPath)), `required artifact missing: ${relPath}`)
  }
}

function verifySourceContracts() {
  verifyRuntimeArtifactIgnoreContract()
  verifyBrowserSourceContracts()
  verifyOpenAiSourceContracts()
  verifyPackageGateContracts()
  verifyChinaExternalSourceContracts()
  verifyEngineSourceContracts()
  verifySessionRecoverySourceContracts()
  verifyProviderAndRendererSourceContracts()
}

function verifyRuntimeArtifactIgnoreContract() {
  const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
  for (const marker of ['.caogen/index.db', '.caogen/tmp/', '.caogen/audit.log']) {
    assert(gitignore.includes(marker), `.gitignore must ignore runtime artifact ${marker}`)
  }
}

function verifyBrowserSourceContracts() {
  const browserTools = readFileSync(path.join(repoRoot, 'src/main/agent/tools/browser-tools.ts'), 'utf8')
  assert(
    browserTools.includes("../../browser/browser-manager.js") ||
      browserTools.includes('../../browser/browser-manager.js'),
    'browser tools must route through src/main/browser/browser-manager.ts'
  )
  const browserView = readFileSync(path.join(repoRoot, 'src/main/browserView.ts'), 'utf8')
  const browserNavigation = readFileSync(path.join(repoRoot, 'src/main/browserNavigation.ts'), 'utf8')
  assert(
    browserNavigation.includes("export const DEFAULT_BROWSER_URL = 'https://caobao.chat/official'"),
    'BrowserView default URL must open the CaoBao official page'
  )
  assert(
    browserView.includes('async open(owner: BrowserWindow, sessionId: string, url = DEFAULT_BROWSER_URL)'),
    'BrowserView.open must use the official page when no URL is supplied'
  )
  assert(
    browserView.includes('loadURL(DEFAULT_BROWSER_URL)'),
    'BrowserView.open must load the default official page for a fresh browser panel'
  )
  const browserPanel = readFileSync(path.join(repoRoot, 'src/renderer/src/components/workbench/BrowserPanel.tsx'), 'utf8')
  assert(
    browserPanel.includes("browserUrlDraft || 'https://caobao.chat/official'"),
    'BrowserPanel URL field must show the CaoBao official page before navigation state arrives'
  )
  const workbenchRoot = readFileSync(path.join(repoRoot, 'src/renderer/src/components/workbench/WorkbenchRoot.tsx'), 'utf8')
  assert(
    workbenchRoot.includes('onSelect: () => void openBrowserPanel()') ||
      workbenchRoot.includes("onSelect: () => openPanel('browser')"),
    'Workbench browser tool must open the default browser page when no explicit URL is provided'
  )
}

function verifyOpenAiSourceContracts() {
  const prompt = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
  const endpointBuilder = readFileSync(path.join(repoRoot, 'src/main/provider/openai-provider-utils.ts'), 'utf8')
  verifyOpenAiPromptToolContract(prompt)
  const openaiTools = readFileSync(path.join(repoRoot, 'src/main/openaiTools.ts'), 'utf8')
  assert(openaiTools.includes('taskTimeoutMs'), 'DAG OpenAI tools must expose taskTimeoutMs watchdog control')
  const dagScheduler = readFileSync(path.join(repoRoot, 'src/main/agent/dag-scheduler.ts'), 'utf8')
  assert(dagScheduler.includes('onTaskTimeout'), 'DAG scheduler must expose a timeout callback')
  assert(prompt.includes('openAiEndpoint'), 'OpenAIEngine must use a shared endpoint builder')
  assert(endpointBuilder.includes('api\\/v\\d+') || endpointBuilder.includes('api/v'), 'OpenAI endpoint builder must recognize /api/vN endpoints')
  assert(endpointBuilder.includes('compatible-mode'), 'OpenAI endpoint builder must recognize DashScope compatible-mode endpoints')
}

function verifyPackageGateContracts() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  for (const scriptName of [
    'test:plan-contract',
    'test:search-replace',
    'test:chat-virtual-list',
    'test:git-tools',
    'test:p2-release-scope:required',
    'test:china-real-network:required',
    'test:china-tool-call-parity:required'
  ]) {
    assert(packageJson.scripts?.[scriptName], `package.json missing ${scriptName}`)
  }
  for (const retiredScript of [
    'test:ide-bridge', 'test:ide-plugins', 'test:ide-plugins:required',
    'test:jetbrains-ide-interaction', 'test:jetbrains-ide-interaction:required',
    'test:jetbrains-recorder-e2e', 'test:jetbrains-recorder-e2e:required',
    'test:vscode-extension-host:required', 'test:p2-ide-build-and-vscode:required',
    'test:p2-ide:required'
  ]) {
    assert(!packageJson.scripts?.[retiredScript], `${retiredScript} must remain retired`)
  }

  const deepTest = readFileSync(path.join(repoRoot, 'scripts/deep-test.mjs'), 'utf8')
  assert(deepTest.includes('p0-p1-p2-contract-smoke.mjs'), 'deep-test must include plan contract smoke')
  assert(deepTest.includes('chat-virtual-list-smoke.mjs'), 'deep-test must include chat virtual list smoke')
  assert(deepTest.includes('event-cursor-crash-smoke.mjs'), 'deep-test must include event cursor crash recovery')
  verifyAnthropicRegistrationGateWiring(packageJson, deepTest)
  const p2RequiredGate = readFileSync(path.join(repoRoot, 'scripts/p2-required-gate.mjs'), 'utf8')
  assert(!p2RequiredGate.includes('ide_build_and_vscode_required'), 'P2 required gate must not restore IDE plugin checks')
  assert(!p2RequiredGate.includes('jetbrains_ide_interaction_required'), 'P2 required gate must not restore JetBrains plugin checks')
}

function verifyChinaExternalSourceContracts() {
  const chinaParity = readFileSync(path.join(repoRoot, 'scripts/china-tool-call-parity.mjs'), 'utf8')
  assert(chinaParity.includes('loadProductToolMap'), 'China tool-call parity must load product tool schemas')
  assert(chinaParity.includes('OPENAI_CODING_TOOLS'), 'China tool-call parity must use OPENAI_CODING_TOOLS')
  assert(chinaParity.includes('search_code'), 'China tool-call parity must cover product search_code tool')
  assert(chinaParity.includes('search_replace'), 'China tool-call parity must cover product search_replace tool')
  assert(!chinaParity.includes("expectedName: 'search_files'"), 'China tool-call parity must not use removed search_files schema')
  assert(chinaParity.includes('parseMaxGap'), 'China tool-call parity must validate max-gap configuration before requests')
  assert(chinaParity.includes('parseRequestTimeout'), 'China tool-call parity must validate bounded request timeouts')
  assert(chinaParity.includes('AbortSignal.timeout(requestTimeoutMs)'), 'China tool-call parity requests must not wait without a deadline')
  assert(chinaParity.includes('Promise.all(providers.map'), 'China tool-call parity must run independent providers concurrently')
  assert(chinaParity.includes('provider.passRate === 0'), 'China providers with zero passing tool calls must never pass parity')
  assert(
    chinaParity.includes("provider.group === 'baseline'") &&
      chinaParity.includes('did not pass all golden tool-call cases'),
    'Every configured baseline provider must pass every golden tool-call case'
  )

  const projectRules = readFileSync(path.join(repoRoot, 'caogen.md'), 'utf8')
  assert(
    projectRules.includes('国产模型工具调用 parity') && projectRules.includes('不能用普通 smoke 代替'),
    'public project rules must keep real China provider parity separate from ordinary smoke evidence'
  )

  const chinaRealNetwork = readFileSync(path.join(repoRoot, 'scripts/china-real-network-smoke.mjs'), 'utf8')
  assert(chinaRealNetwork.includes('assertRequiredPublicEndpoint'), 'China real-network required must reject mock/local endpoints')
  assert(
    chinaRealNetwork.includes('required mode needs CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS'),
    'China real-network required must require explicit target declaration'
  )
}

function verifyEngineSourceContracts() {
  const engineContract = readFileSync(path.join(repoRoot, 'src/main/engine.ts'), 'utf8')
  assert(engineContract.includes('emitSyntheticEvent?'), 'Engine must expose optional synthetic event persistence hook')
  assert(engineContract.includes('请选择 Agent 引擎'), 'Engine creation must require explicit engine selection')
  assert(!engineContract.includes('registry.values().next'), 'Engine creation must not silently fall back to another engine')
  const builtinEngines = readFileSync(path.join(repoRoot, 'src/main/engines.ts'), 'utf8')
  const sharedTypes = readFileSync(path.join(repoRoot, 'src/shared/types.ts'), 'utf8')
  assert(!builtinEngines.includes("kind: 'claude'"), 'Claude Agent SDK must not remain registered')
  assert(
    builtinEngines.includes('...openAIEngineFactory') &&
      builtinEngines.includes('nativeRuntime: OPENAI_NATIVE_RUNTIME_ADAPTER') &&
      builtinEngines.includes('protocolAdapter: OPENAI_COMPATIBLE_PROTOCOL_ADAPTER'),
    'OpenAI must remain registered with its formal runtime and protocol adapters'
  )
  assert(!builtinEngines.includes("kind: 'codex'"), 'Codex CLI must not be registered as a product engine')
  assert(!builtinEngines.includes('geminiEngineFactory'), 'Gemini CLI must not be registered as a product engine')
  verifyAnthropicEngineTypeContract(builtinEngines, sharedTypes)
  assert(sharedTypes.includes('export interface AgentEventIdentity'), 'shared types must expose stable event identity')
  assert(sharedTypes.includes('lastAppliedEventSeq?: number'), 'TaskRun must persist its applied event cursor')
  assert(!existsSync(path.join(repoRoot, 'src/main/codexEngine.ts')), 'Codex CLI engine implementation must stay removed')
  assert(!existsSync(path.join(repoRoot, 'src/main/geminiEngine.ts')), 'Gemini CLI engine implementation must stay removed')
  assert(!existsSync(path.join(repoRoot, 'src/main/agentSession.ts')), 'Claude Agent SDK engine implementation must stay removed')
}

function verifySessionRecoverySourceContracts() {
  const sessionManager = readFileSync(path.join(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
  const sessionCreateLifecycle = readFileSync(
    path.join(repoRoot, 'src/main/session-create-lifecycle.ts'),
    'utf8'
  )
  for (const marker of [
    'dagExecutionSnapshots',
    'parent.emitSyntheticEvent(event)',
    "kind: 'task-dag-update'",
    'this.dagExecutionSnapshots.values()'
  ]) {
    assert(sessionManager.includes(marker), `SessionManager missing DAG persistence marker ${marker}`)
  }
  verifySessionChoiceContract(sessionManager, sessionCreateLifecycle, assert)
  assert(sessionManager.includes('normalizeEventIdentity'), 'SessionManager must normalize and dedupe event identities')
  assert(sessionManager.includes('reconcileSnapshotWithReceipts'), 'snapshot recovery must reconcile durable event tails')

  const transcript = readFileSync(path.join(repoRoot, 'src/main/transcript.ts'), 'utf8')
  assert(transcript.includes('nextEntry(event: AgentEvent)'), 'TranscriptWriter must return a stable event envelope')
  assert(transcript.includes('event-receipts'), 'TranscriptWriter must persist redacted lifecycle receipts')
  assert(!transcript.includes('this.append({ seq: ++this.seq, event: entry.event })'), 'bind must not renumber emitted events')

  const taskSnapshot = readFileSync(path.join(repoRoot, 'src/main/task/task-snapshot.ts'), 'utf8')
  const taskSnapshotMerge = readFileSync(path.join(repoRoot, 'src/main/task/task-snapshot-merge.ts'), 'utf8')
  verifyTaskSnapshotFinalizerContract(taskSnapshot)
  assert(
    taskSnapshot.includes("import { mergeTaskSnapshots } from './task-snapshot-merge'") &&
      taskSnapshot.includes('mergeTaskSnapshots(previous, snapshot)'),
    'TaskSnapshot persistence must delegate stale-write protection to its merge boundary'
  )
  assert(
    taskSnapshotMerge.includes('compareSnapshotFreshness') &&
      taskSnapshotMerge.includes('left.execution.cursor?.seq ?? left.execution.lastSeq') &&
      taskSnapshotMerge.includes('right.execution.cursor?.seq ?? right.execution.lastSeq'),
    'stale snapshots must not overwrite newer cursors'
  )
}

function verifyProviderAndRendererSourceContracts() {
  const settings = readFileSync(path.join(repoRoot, 'src/main/settings.ts'), 'utf8')
  assert(settings.includes("defaultProviderId: ''"), 'settings defaultProviderId must be empty, not a hidden provider')
  assert(settings.includes("defaultModel: ''"), 'settings defaultModel must be empty, not a hidden model')

  const providers = readFileSync(path.join(repoRoot, 'src/main/providers.ts'), 'utf8')
  assert(!providers.includes('defaultDeepSeekProvider'), 'first launch must not inject a DeepSeek Provider')
  assert(!providers.includes('首启默认 Provider'), 'providers must not advertise a first-run default Provider')
  assert(!providers.includes('DEEPSEEK_PROVIDER_ID'), 'providers must not hard-code a hidden DeepSeek Provider id')
  verifyProviderSchedulerWiring(providers)
  const modelDiscovery = readFileSync(path.join(repoRoot, 'src/main/provider/modelDiscovery.ts'), 'utf8')
  verifyProviderModelDiscoverySourceContracts(modelDiscovery)

  const welcome = readFileSync(path.join(repoRoot, 'src/renderer/src/components/WelcomeView.tsx'), 'utf8')
  const app = readFileSync(path.join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
  assert(
    !welcome.includes('EngineKind') &&
      !welcome.includes('listEngines') &&
      welcome.includes('modelOptionsForProvider'),
    'new session UI must derive engine/model choices from the selected Provider'
  )
  assert(!app.includes('<NewSessionModal'), 'new session must render as an inline workspace, not a modal')
  assert(providers.includes('resolveProviderEngine'), 'Provider configuration must own execution engine resolution')

  assert(
    providers.includes("if (engine === 'claude') return 'anthropic'"),
    'legacy Claude Providers must migrate to native Anthropic Messages'
  )
}

function verifyOpenAiPromptToolContract(prompt) {
  for (const marker of [
    'git_status', 'git_diff', 'git_stage', 'git_stage_all', 'git_commit', 'git_push',
    'git_create_pr', 'git_merge', 'code_forge_delivery', 'task_decompose',
    'task_dispatch_dag', 'task_decompose_and_dispatch_dag'
  ]) {
    assert(prompt.includes(marker), `system prompt must mention ${marker}`)
  }
}

function verifyTaskSnapshotFinalizerContract(source) {
  const finalizerStore = readFileSync(path.join(repoRoot, 'src/main/task/task-dag-finalization-store.ts'), 'utf8')
  assert(source.includes('const STORE_VERSION = 9'), 'task snapshot schema must persist the v9 Conversation Ledger recovery contract')
  assert(finalizerStore.includes('CREATE TABLE IF NOT EXISTS dag_finalizers'), 'task snapshot schema must persist DAG finalizer records')
  assert(source.includes('saveTaskDagFinalizationBarrier'), 'terminal DAG and finalizer intent must share a durable barrier')
}

function verifyProviderSchedulerWiring(source) {
  const sourceFile = ts.createSourceFile('providers.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assertNamedImports(sourceFile, './scheduler', ['recordProbeFailure', 'recordProbeSuccess'])
  assertNamedImports(sourceFile, './provider/providerDiagnostics', [
    'fetchProviderModels', 'probeProviderGenerationTarget'
  ])

  const fetchModels = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'fetchModels'
  )
  assert(fetchModels?.body, 'providers must define fetchModels with an implementation')
  assert(
    fetchModels.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      fetchModels.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
    'providers:fetchModels must remain an exported async entrypoint'
  )

  const delegation = returnedCall(fetchModels.body)
  assertIdentifierCall(delegation, 'fetchProviderModels', 2, 'providers:fetchModels must delegate to Provider diagnostics')
  assertIdentifier(delegation.arguments[1], 'providerDiagnosticsDependencies', 'model discovery must receive scoped diagnostics dependencies')

  const probe = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'probeProviderGeneration'
  )
  assert(probe?.body, 'providers must define probeProviderGeneration with an implementation')
  const probeDelegation = returnedCall(probe.body)
  assertIdentifierCall(probeDelegation, 'probeProviderGenerationTarget', 2, 'generation probe must delegate to Provider diagnostics')
  assertIdentifier(probeDelegation.arguments[1], 'providerDiagnosticsDependencies', 'generation probe must receive scoped diagnostics dependencies')

  const dependencies = variableInitializer(sourceFile, 'providerDiagnosticsDependencies')
  assert(dependencies && ts.isObjectLiteralExpression(dependencies), 'providers must define Provider diagnostics dependencies as an object')
  assertObjectProperties(dependencies, [
    'getProvider', 'providerAuthMode', 'decryptProviderToken', 'selectedKey',
    'recordProbeSuccess', 'recordProbeFailure'
  ], 'Provider diagnostics dependencies')

  const diagnostics = readFileSync(path.join(repoRoot, 'src/main/provider/providerDiagnostics.ts'), 'utf8')
  verifyProviderDiagnosticsBoundary(diagnostics)
}

function verifyProviderDiagnosticsBoundary(source) {
  const sourceFile = ts.createSourceFile('providerDiagnostics.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assertNamedImports(sourceFile, './modelDiscovery', ['discoverProviderModels'])
  assertNamedImports(sourceFile, './modelDiscoveryBinding', ['bindProviderModelDiscoveryInput'])
  const fetchModels = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'fetchProviderModels'
  )
  assert(fetchModels?.body, 'Provider diagnostics must define fetchProviderModels')
  const delegation = returnedCall(fetchModels.body)
  assertIdentifierCall(delegation, 'discoverProviderModels', 3, 'Provider diagnostics must delegate to model discovery')
  const callbacks = delegation.arguments[2]
  assert(ts.isObjectLiteralExpression(callbacks), 'Provider diagnostics must provide model discovery health callbacks')
  assertPropertyAccess(callbacks, 'success', 'dependencies', 'recordProbeSuccess')
  assertPropertyAccess(callbacks, 'failure', 'dependencies', 'recordProbeFailure')
}

function assertStringUnionMembers(source, aliasName, expected) {
  const sourceFile = ts.createSourceFile('shared-types.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === aliasName
  )
  assert(declaration && ts.isTypeAliasDeclaration(declaration), `missing type alias ${aliasName}`)
  assert(ts.isUnionTypeNode(declaration.type), `${aliasName} must be a union`)
  const actual = declaration.type.types.map((member) => {
    assert(
      ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
      `${aliasName} members must be string literals`
    )
    return member.literal.text
  })
  assert(
    actual.length === expected.length && expected.every((member) => actual.includes(member)),
    `${aliasName} must expose exactly ${expected.join(', ')}`
  )
}

function verifyAnthropicRegistrationGateWiring(packageJson, deepTest) {
  assert(
    packageJson.scripts?.['test:anthropic-engine-registration:required'],
    'package.json missing test:anthropic-engine-registration:required'
  )
  assert(
    deepTest.includes('anthropic-engine-registration-smoke.mjs'),
    'deep-test must include Anthropic production registration required smoke'
  )
}

function verifyAnthropicEngineTypeContract(builtinEngines, sharedTypes) {
  assert(builtinEngines.includes("kind: 'anthropic'"), 'Anthropic Messages must be a registered formal engine')
  assertStringUnionMembers(sharedTypes, 'EngineKind', ['anthropic', 'gemini', 'openai'])
}

function verifyProviderModelDiscoverySourceContracts(source) {
  const sourceFile = ts.createSourceFile('modelDiscovery.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const success = findFunction(sourceFile, 'successfulModelFetchResult')
  assertFunctionCall(success, sourceFile, 'health.success', ['context.providerId', 'latencyMs'])
  assertReturnedProperties(success, sourceFile, {
    ok: 'true',
    models: 'models',
    fetchedAt: 'fetchedAt',
    latencyMs: 'latencyMs',
    stale: 'false'
  })

  const failure = findFunction(sourceFile, 'failedModelFetchResult')
  assertFunctionCall(failure, sourceFile, 'health.failure', ['context.providerId', 'message'])
  assertFunctionCall(failure, sourceFile, 'modelFetchCache.delete', ['context.cacheKey'])
  assertReturnedProperties(failure, sourceFile, {
    ok: 'false',
    models: '[]',
    latencyMs: 'latencyMs',
    stale: 'true'
  })
}

function findFunction(sourceFile, name) {
  const declaration = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  )
  assert(declaration?.body, `model discovery must define ${name}`)
  return declaration
}

function assertFunctionCall(declaration, sourceFile, callee, expectedArguments) {
  const match = findDescendant(declaration.body, (node) =>
    ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === callee &&
      node.arguments.map((argument) => argument.getText(sourceFile)).join('|') === expectedArguments.join('|')
  )
  assert(match, `${declaration.name.text} must call ${callee}(${expectedArguments.join(', ')})`)
}

function assertReturnedProperties(declaration, sourceFile, expectedProperties) {
  const returned = findDescendant(declaration.body, (node) =>
    ts.isReturnStatement(node) && ts.isObjectLiteralExpression(node.expression)
  )
  assert(returned, `${declaration.name.text} must return a result object`)
  for (const [name, expectedValue] of Object.entries(expectedProperties)) {
    const property = returned.expression.properties.find((candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
        candidate.name.getText(sourceFile) === name
    )
    const actualValue = ts.isPropertyAssignment(property)
      ? property.initializer.getText(sourceFile)
      : ts.isShorthandPropertyAssignment(property)
        ? property.name.getText(sourceFile)
        : undefined
    assert(actualValue === expectedValue, `${declaration.name.text} must return ${name}: ${expectedValue}`)
  }
}

function findDescendant(root, predicate) {
  let match
  const visit = (node) => {
    if (match) return
    if (predicate(node)) {
      match = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return match
}

function assertNamedImports(sourceFile, moduleName, expectedNames) {
  const declaration = sourceFile.statements.find((statement) =>
    ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === moduleName
  )
  const bindings = declaration?.importClause?.namedBindings
  const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => element.name.text) : []
  for (const name of expectedNames) {
    assert(names.includes(name), `${moduleName} must import ${name}`)
  }
}

function variableInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const declaration = statement.declarationList.declarations.find((candidate) =>
      ts.isIdentifier(candidate.name) && candidate.name.text === name
    )
    if (declaration) return declaration.initializer
  }
  return undefined
}

function assertObjectProperties(object, expectedNames, label) {
  const names = object.properties.map((property) => property.name && ts.isIdentifier(property.name) ? property.name.text : '')
  for (const name of expectedNames) assert(names.includes(name), `${label} must provide ${name}`)
}

function assertIdentifier(node, expectedName, message) {
  assert(node && ts.isIdentifier(node) && node.text === expectedName, message)
}

function assertPropertyAccess(object, propertyName, receiverName, memberName) {
  const property = object.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) && candidate.name && ts.isIdentifier(candidate.name) && candidate.name.text === propertyName
  )
  assert(
    property && ts.isPropertyAssignment(property) &&
      ts.isPropertyAccessExpression(property.initializer) &&
      ts.isIdentifier(property.initializer.expression) && property.initializer.expression.text === receiverName &&
      property.initializer.name.text === memberName,
    `Provider diagnostics ${propertyName} callback must use ${receiverName}.${memberName}`
  )
}

function returnedCall(body) {
  const statement = body.statements.find(ts.isReturnStatement)
  return statement?.expression
}

function assertIdentifierCall(expression, expectedName, argumentCount, message) {
  assert(
    ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === expectedName &&
      expression.arguments.length === argumentCount,
    message
  )
}

function assertResolverCallback(callback) {
  const call = callbackExpression(callback)
  assertIdentifierCall(
    call,
    'resolveModelDiscoveryCredentials',
    2,
    'providers:fetchModels must inject its credential resolver into model discovery'
  )
  assert(
    ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === 'input' &&
      ts.isIdentifier(call.arguments[1]) && call.arguments[1].text === 'credentialProvider',
    'model discovery credential resolution must consume only the normalized bound input and bound credential provider'
  )
}

function assertBoundDiscoveryInput(body) {
  const declaration = body.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === 'input')
  assert(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer),
    'model discovery must build one normalized input from the bound provider configuration')
  const properties = declaration.initializer.properties
  assert(properties.some((property) =>
    ts.isSpreadAssignment(property)
      && ts.isPropertyAccessExpression(property.expression)
      && ts.isIdentifier(property.expression.expression)
      && property.expression.expression.text === 'bound'
      && property.expression.name.text === 'input'
  ), 'model discovery normalized input must inherit only bound.input')
  const authMode = properties.find((property) =>
    ts.isPropertyAssignment(property) && property.name.getText() === 'authMode'
  )
  assert(
    authMode && ts.isPropertyAssignment(authMode)
      && ts.isCallExpression(authMode.initializer)
      && ts.isIdentifier(authMode.initializer.expression)
      && authMode.initializer.expression.text === 'normalizeProviderAuthMode',
    'model discovery must validate the bound auth mode before credential resolution or network access'
  )
}

function assertSchedulerCallback(healthExpression, propertyName, schedulerName, expectedArguments) {
  assert(ts.isObjectLiteralExpression(healthExpression), 'model discovery health callbacks must be injected as an object')
  const property = healthExpression.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) && candidate.name.getText() === propertyName
  )
  const call = callbackExpression(property?.initializer)
  assertIdentifierCall(call, schedulerName, expectedArguments.length, `${propertyName} model discovery health must call ${schedulerName}`)
  assert(
    call.arguments.every((argument, index) => ts.isIdentifier(argument) && argument.text === expectedArguments[index]),
    `${schedulerName} must receive ${expectedArguments.join(', ')} from model discovery unchanged`
  )
}

function callbackExpression(callback) {
  assert(
    ts.isArrowFunction(callback) || ts.isFunctionExpression(callback),
    'model discovery dependency must be supplied as a callback'
  )
  if (!ts.isBlock(callback.body)) return callback.body
  return callback.body.statements.find(ts.isReturnStatement)?.expression
}

async function verifyProviderModelDiscoveryBehavior() {
  compileTypeScript(['src/main/provider/modelDiscovery.ts'])
  const modelDiscovery = await import(pathToFileURL(path.join(outDir, 'main/provider/modelDiscovery.js')).href)
  const originalFetch = globalThis.fetch
  try {
    await verifySuccessfulModelDiscovery(modelDiscovery.discoverProviderModels)
    await verifyFailedModelDiscovery(modelDiscovery.discoverProviderModels)
    await verifyVersionedBaseModelDiscovery(modelDiscovery.discoverProviderModels)
    await verifyRetryAfterPathAuthorization(modelDiscovery.discoverProviderModels)
    await verifyMixedPathAuthorizationDiagnostic(modelDiscovery.discoverProviderModels)
    await verifyUnavailableModelCatalogDiagnostic(modelDiscovery.discoverProviderModels)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function verifySuccessfulModelDiscovery(discoverProviderModels) {
  const calls = { success: [], failure: [] }
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 'fixture-model-a' }, { id: 'fixture-model-b' }, { id: 'fixture-model-a' }]
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
  const result = await discoverProviderModels(
    { baseUrl: 'https://provider.example/api', providerId: 'provider-success', openaiProtocol: 'responses' },
    (providerId) => {
      assert(providerId === 'provider-success', 'credential resolver must receive the successful provider id')
      return { token: 'fixture', customHeaderRejections: [], headers: {} }
    },
    modelDiscoveryHealth(calls)
  )

  assert(result.ok === true, 'successful model discovery must return ok=true')
  assert(result.providerId === 'provider-success', 'successful model discovery must expose providerId')
  assert(result.baseUrl === 'https://provider.example/api', 'successful model discovery must expose the public Base URL')
  assert(result.cacheKey === 'provider-success|https://provider.example/api|responses', 'successful model discovery must expose its cache key')
  assert(result.models.join(',') === 'fixture-model-a,fixture-model-b', 'successful model discovery must return unique model ids')
  assert(Number.isFinite(result.fetchedAt), 'successful model discovery must expose fetchedAt')
  assert(Number.isFinite(result.latencyMs) && result.latencyMs >= 0, 'successful model discovery must expose non-negative latencyMs')
  assert(result.stale === false && result.error === undefined, 'successful model discovery must return a fresh result without an error')
  assert(calls.success.length === 1 && calls.failure.length === 0, 'successful model discovery must report exactly one success health event')
  assert(
    calls.success[0].providerId === result.providerId && calls.success[0].latencyMs === result.latencyMs,
    'success health reporting must preserve providerId and the returned latencyMs'
  )
}

async function verifyFailedModelDiscovery(discoverProviderModels) {
  const calls = { success: [], failure: [] }
  globalThis.fetch = async () => new Response('', { status: 401 })
  const result = await discoverProviderModels(
    { baseUrl: 'https://provider.example/api', providerId: 'provider-failure', openaiProtocol: 'chat' },
    () => ({ token: 'fixture', customHeaderRejections: [], headers: {} }),
    modelDiscoveryHealth(calls)
  )

  assert(result.ok === false, 'failed model discovery must return ok=false')
  assert(result.providerId === 'provider-failure', 'failed model discovery must expose providerId')
  assert(result.baseUrl === 'https://provider.example/api', 'failed model discovery must expose the public Base URL')
  assert(result.cacheKey === 'provider-failure|https://provider.example/api|chat', 'failed model discovery must expose its cache key')
  assert(Array.isArray(result.models) && result.models.length === 0, 'failed model discovery must return an empty model list')
  assert(Number.isFinite(result.latencyMs) && result.latencyMs >= 0, 'failed model discovery must expose non-negative latencyMs')
  assert(result.stale === true && result.fetchedAt === undefined, 'failed model discovery must return a stale result without fetchedAt')
  assert(result.error?.kind === 'auth' && result.error.status === 401, '401 model discovery must expose its typed auth error')
  assert(result.error.reasonCode === 'credentials_rejected', 'all-auth failures must identify rejected credentials')
  assert(result.error.suggestedAction === 'review_credentials', 'all-auth failures must recommend credential review')
  assert(result.error.diagnosticContext.engine === 'openai', 'diagnostics must identify the effective engine')
  assert(result.error.diagnosticContext.generationProtocol === 'openai-chat-completions', 'diagnostics must identify the effective generation protocol')
  assert(result.error.diagnosticContext.generationEndpointPath === '/v1/chat/completions', 'diagnostics must expose the task path without an origin')
  assert(result.error.diagnosticContext.credentialSource === 'stored-active', 'saved-provider diagnostics must identify the stored active credential source')
  assert(result.error.diagnosticContext.catalogProbeOnly === true, 'diagnostics must distinguish catalog probing from generation')
  assert(result.error.attempts.length === 2, 'all safe endpoint candidates must be attempted before reporting auth failure')
  assert(
    result.error.providerId === result.providerId && result.error.baseUrl === result.baseUrl,
    'failed model discovery error must preserve provider identity and public Base URL'
  )
  assert(calls.failure.length === 1 && calls.success.length === 0, 'failed model discovery must report exactly one failure health event')
  assert(
    calls.failure[0].providerId === result.providerId && calls.failure[0].message === result.error.message,
    'failure health reporting must preserve providerId and the returned error message'
  )
}

async function verifyVersionedBaseModelDiscovery(discoverProviderModels) {
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    if (new URL(String(url)).pathname === '/gateway/v1/models') {
      return new Response(JSON.stringify({ data: [{ id: 'versioned-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('', { status: 401 })
  }
  const result = await discoverProviderModels(
    { baseUrl: 'https://provider.example/gateway/v1', authMode: 'api-key' },
    () => ({
      token: 'fixture',
      authMode: 'api-key',
      credentialHeaderNames: ['Authorization'],
      customHeaderRejections: [],
      headers: { Authorization: 'Bearer fixture' }
    }),
    modelDiscoveryHealth({ success: [], failure: [] })
  )

  assert(result.ok && result.models[0] === 'versioned-model', 'a Base URL ending in /v1 must discover /v1/models')
  assert(!urls.some((url) => new URL(url).pathname.includes('/v1/v1/')), 'model discovery must never duplicate a trailing /v1 segment')
}

async function verifyMixedPathAuthorizationDiagnostic(discoverProviderModels) {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    return new Response('', { status: path.endsWith('/v1/models') ? 401 : 404 })
  }
  const result = await discoverProviderModels(
    { baseUrl: 'https://provider.example/gateway', authMode: 'api-key' },
    () => ({
      token: 'fixture',
      authMode: 'api-key',
      credentialHeaderNames: ['api-key'],
      customHeaderRejections: [],
      headers: { 'api-key': 'fixture' }
    }),
    modelDiscoveryHealth({ success: [], failure: [] })
  )

  assert(!result.ok && result.error?.kind === 'auth', 'mixed 401/404 discovery must remain an auth-class failure')
  assert(result.error.reasonCode === 'base_url_or_credentials_mismatch', 'mixed 401/404 must not claim the key alone is invalid')
  assert(result.error.suggestedAction === 'review_base_url_and_credentials', 'mixed 401/404 must recommend reviewing URL and credentials')
  assert(result.error.credentialStyle.headerNames.join(',') === 'api-key', 'diagnostics must expose credential header names only')
  assert(result.error.diagnosticContext.generationProtocol === 'openai-responses', 'default OpenAI diagnostics must identify Responses')
  assert(result.error.diagnosticContext.generationEndpointPath === '/v1/responses', 'Responses diagnostics must expose the task path only')
  assert(result.error.diagnosticContext.credentialSource === 'explicit', 'unsaved-provider diagnostics must identify the form credential source')
  assert(result.error.attempts.every((attempt) => attempt.endpointPath.startsWith('/')), 'diagnostic attempts must expose path-only endpoints')
  assert(!JSON.stringify(result.error).includes('fixture'), 'diagnostics must never expose credential values')
  assert(!JSON.stringify(result.error.diagnosticContext).includes('provider.example'), 'diagnostic context must not contain the Provider origin')
}

async function verifyRetryAfterPathAuthorization(discoverProviderModels) {
  const paths = []
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    if (path.endsWith('/v1/models')) return new Response('', { status: 401 })
    return new Response(JSON.stringify({ data: [{ id: 'fallback-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  const result = await discoverProviderModels(
    { baseUrl: 'https://provider.example/gateway', authMode: 'api-key' },
    () => ({
      token: 'fixture',
      authMode: 'api-key',
      credentialHeaderNames: ['Authorization'],
      customHeaderRejections: [],
      headers: { Authorization: 'Bearer fixture' }
    }),
    modelDiscoveryHealth({ success: [], failure: [] })
  )

  assert(result.ok && result.models[0] === 'fallback-model', 'a path-specific 401 must not stop a later safe endpoint candidate')
  assert(paths.join(',') === '/gateway/v1/models,/gateway/models', 'safe endpoint candidates must retain deterministic order')
}

async function verifyUnavailableModelCatalogDiagnostic(discoverProviderModels) {
  globalThis.fetch = async () => new Response('', { status: 404 })
  const result = await discoverProviderModels(
    { baseUrl: 'https://provider.example/gateway', authMode: 'api-key' },
    () => ({
      token: 'fixture',
      authMode: 'api-key',
      credentialHeaderNames: ['Authorization'],
      customHeaderRejections: [],
      headers: { Authorization: 'Bearer fixture' }
    }),
    modelDiscoveryHealth({ success: [], failure: [] })
  )

  assert(!result.ok && result.error?.kind === 'not_found', '404-only discovery must report unavailable model catalog')
  assert(result.error.reasonCode === 'model_catalog_unavailable', '404-only discovery must not report invalid credentials')
  assert(result.error.suggestedAction === 'enter_models_manually', 'missing model catalog must offer manual model entry')
}

function modelDiscoveryHealth(calls) {
  return {
    success: (providerId, latencyMs) => calls.success.push({ providerId, latencyMs }),
    failure: (providerId, message) => calls.failure.push({ providerId, message })
  }
}

function compileTypeScript(files) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--outDir',
      outDir,
      '--rootDir',
      'src',
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

async function verifyViewHardCap() {
  mkdirSync(projectDir, { recursive: true })
  const filePath = path.join(projectDir, 'large.txt')
  writeFileSync(filePath, Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8')

  compileTypeScript(['src/main/agent/tools/view.ts'])

  const view = await import(pathToFileURL(path.join(outDir, 'main/agent/tools/view.js')).href)
  const result = await view.runView(projectDir, { file_path: filePath, start_line: 1, end_line: 10_000 })
  assert(result.ok, `view should read large text fixture: ${result.error ?? 'unknown error'}`)
  assert(result.startLine === 1, `expected startLine=1, got ${result.startLine}`)
  assert(result.endLine === 200, `view must hard-cap explicit end_line to 200 rows, got ${result.endLine}`)
  assert(result.truncated === true, 'view must report truncated=true for capped reads')
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
