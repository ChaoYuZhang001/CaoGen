#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-plan-contract-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')

try {
  verifyExactArtifacts()
  verifySourceContracts()
  verifyP2ExternalPreflightContracts()
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
    'src/main/sandbox/docker-sandbox.ts',
    'src/main/sandbox/system-sandbox.ts',
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
  const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
  for (const marker of ['.caogen/index.db', '.caogen/tmp/', '.caogen/audit.log']) {
    assert(gitignore.includes(marker), `.gitignore must ignore runtime artifact ${marker}`)
  }

  const browserTools = readFileSync(path.join(repoRoot, 'src/main/agent/tools/browser-tools.ts'), 'utf8')
  assert(
    browserTools.includes("../../browser/browser-manager.js") ||
      browserTools.includes('../../browser/browser-manager.js'),
    'browser tools must route through src/main/browser/browser-manager.ts'
  )
  const browserView = readFileSync(path.join(repoRoot, 'src/main/browserView.ts'), 'utf8')
  assert(
    browserView.includes("const DEFAULT_URL = 'https://caobao.chat/official'"),
    'BrowserView default URL must open the CaoBao official page'
  )
  assert(
    browserView.includes('async open(owner: BrowserWindow, sessionId: string, url = DEFAULT_URL)'),
    'BrowserView.open must use the official page when no URL is supplied'
  )
  assert(
    browserView.includes('loadURL(DEFAULT_URL)'),
    'BrowserView.open must load the default official page for a fresh browser panel'
  )
  const browserPanel = readFileSync(path.join(repoRoot, 'src/renderer/src/components/workbench/BrowserPanel.tsx'), 'utf8')
  assert(
    browserPanel.includes("browserUrlDraft || 'https://caobao.chat/official'"),
    'BrowserPanel URL field must show the CaoBao official page before navigation state arrives'
  )
  const workbenchRoot = readFileSync(path.join(repoRoot, 'src/renderer/src/components/workbench/WorkbenchRoot.tsx'), 'utf8')
  assert(
    workbenchRoot.includes('onSelect: () => void openBrowserPanel()'),
    'Workbench browser tool must open the default browser page when no explicit URL is provided'
  )

  const prompt = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
  for (const marker of [
    'git_status',
    'git_diff',
    'git_commit',
    'git_push',
    'git_create_pr',
    'git_merge',
    'code_forge_delivery',
    'task_decompose',
    'task_dispatch_dag',
    'task_decompose_and_dispatch_dag'
  ]) {
    assert(prompt.includes(marker), `system prompt must mention ${marker}`)
  }
  const openaiTools = readFileSync(path.join(repoRoot, 'src/main/openaiTools.ts'), 'utf8')
  assert(openaiTools.includes('taskTimeoutMs'), 'DAG OpenAI tools must expose taskTimeoutMs watchdog control')
  const dagScheduler = readFileSync(path.join(repoRoot, 'src/main/agent/dag-scheduler.ts'), 'utf8')
  assert(dagScheduler.includes('onTaskTimeout'), 'DAG scheduler must expose a timeout callback')
  assert(prompt.includes('openAiEndpoint'), 'OpenAIEngine must use a shared endpoint builder')
  assert(prompt.includes('api\\/v\\d+') || prompt.includes('api/v'), 'OpenAI endpoint builder must recognize /api/vN endpoints')
  assert(prompt.includes('compatible-mode'), 'OpenAI endpoint builder must recognize DashScope compatible-mode endpoints')

  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  for (const scriptName of [
    'test:plan-contract',
    'test:search-replace',
    'test:chat-virtual-list',
    'test:git-tools',
    'test:p2-ide-build-and-vscode:required',
    'test:p2-ide:required'
  ]) {
    assert(packageJson.scripts?.[scriptName], `package.json missing ${scriptName}`)
  }
  assert(
    packageJson.scripts['test:p2-ide:required'].includes('test:jetbrains-ide-interaction:required'),
    'test:p2-ide:required must include real JetBrains IDE interaction'
  )

  const deepTest = readFileSync(path.join(repoRoot, 'scripts/deep-test.mjs'), 'utf8')
  assert(deepTest.includes('p0-p1-p2-contract-smoke.mjs'), 'deep-test must include plan contract smoke')
  assert(deepTest.includes('chat-virtual-list-smoke.mjs'), 'deep-test must include chat virtual list smoke')
  assert(deepTest.includes('event-cursor-crash-smoke.mjs'), 'deep-test must include event cursor crash recovery')

  const p2RequiredGate = readFileSync(path.join(repoRoot, 'scripts/p2-required-gate.mjs'), 'utf8')
  assert(p2RequiredGate.includes("name: 'ide_build_and_vscode_required'"), 'P2 required gate must use precise IDE build/VS Code check name')
  assert(p2RequiredGate.includes('test:p2-ide-build-and-vscode:required'), 'P2 required gate must call the precise IDE build/VS Code script')

  const chinaParity = readFileSync(path.join(repoRoot, 'scripts/china-tool-call-parity.mjs'), 'utf8')
  assert(chinaParity.includes('loadProductToolMap'), 'China tool-call parity must load product tool schemas')
  assert(chinaParity.includes('OPENAI_CODING_TOOLS'), 'China tool-call parity must use OPENAI_CODING_TOOLS')
  assert(chinaParity.includes('search_code'), 'China tool-call parity must cover product search_code tool')
  assert(chinaParity.includes('search_replace'), 'China tool-call parity must cover product search_replace tool')
  assert(!chinaParity.includes("expectedName: 'search_files'"), 'China tool-call parity must not use removed search_files schema')

  const chinaRealNetwork = readFileSync(path.join(repoRoot, 'scripts/china-real-network-smoke.mjs'), 'utf8')
  assert(chinaRealNetwork.includes('assertRequiredPublicEndpoint'), 'China real-network required must reject mock/local endpoints')
  assert(
    chinaRealNetwork.includes('required mode needs CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS'),
    'China real-network required must require explicit target declaration'
  )

  const engineContract = readFileSync(path.join(repoRoot, 'src/main/engine.ts'), 'utf8')
  assert(engineContract.includes('emitSyntheticEvent?'), 'Engine must expose optional synthetic event persistence hook')
  assert(engineContract.includes('请选择 Agent 引擎'), 'Engine creation must require explicit engine selection')
  assert(!engineContract.includes("factory = registry.get('claude')"), 'Engine creation must not silently fall back to Claude')
  const builtinEngines = readFileSync(path.join(repoRoot, 'src/main/engines.ts'), 'utf8')
  const sharedTypes = readFileSync(path.join(repoRoot, 'src/shared/types.ts'), 'utf8')
  assert(builtinEngines.includes("kind: 'claude'"), 'Claude must remain a registered formal engine')
  assert(builtinEngines.includes('registerEngine(openAIEngineFactory)'), 'OpenAI must remain a registered formal engine')
  assert(!builtinEngines.includes("kind: 'codex'"), 'Codex CLI must not be registered as a product engine')
  assert(!builtinEngines.includes('geminiEngineFactory'), 'Gemini CLI must not be registered as a product engine')
  assert(sharedTypes.includes("export type EngineKind = 'claude' | 'openai'"), 'EngineKind must expose only formal engines')
  assert(sharedTypes.includes('export interface AgentEventIdentity'), 'shared types must expose stable event identity')
  assert(sharedTypes.includes('lastAppliedEventSeq?: number'), 'TaskRun must persist its applied event cursor')
  assert(!existsSync(path.join(repoRoot, 'src/main/codexEngine.ts')), 'Codex CLI engine implementation must stay removed')
  assert(!existsSync(path.join(repoRoot, 'src/main/geminiEngine.ts')), 'Gemini CLI engine implementation must stay removed')

  const sessionManager = readFileSync(path.join(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
  for (const marker of [
    'dagExecutionSnapshots',
    'parent.emitSyntheticEvent(event)',
    "kind: 'task-dag-update'",
    'this.dagExecutionSnapshots.values()'
  ]) {
    assert(sessionManager.includes(marker), `SessionManager missing DAG persistence marker ${marker}`)
  }
  assert(
    sessionManager.includes('assertExplicitSessionChoice') &&
      sessionManager.includes('请选择已配置 API key 的 Provider') &&
      sessionManager.includes('请选择模型或显式选择自动调度'),
    'SessionManager must reject implicit engine/provider/model defaults for new non-CLI sessions'
  )
  assert(sessionManager.includes('normalizeEventIdentity'), 'SessionManager must normalize and dedupe event identities')
  assert(sessionManager.includes('reconcileSnapshotWithReceipts'), 'snapshot recovery must reconcile durable event tails')

  const transcript = readFileSync(path.join(repoRoot, 'src/main/transcript.ts'), 'utf8')
  assert(transcript.includes('nextEntry(event: AgentEvent)'), 'TranscriptWriter must return a stable event envelope')
  assert(transcript.includes('event-receipts'), 'TranscriptWriter must persist redacted lifecycle receipts')
  assert(!transcript.includes('this.append({ seq: ++this.seq, event: entry.event })'), 'bind must not renumber emitted events')

  const taskSnapshot = readFileSync(path.join(repoRoot, 'src/main/task/task-snapshot.ts'), 'utf8')
  assert(taskSnapshot.includes('const STORE_VERSION = 4'), 'task snapshot schema must persist the v4 recovery cursor contract')
  assert(taskSnapshot.includes('compareSnapshotFreshness'), 'stale snapshots must not overwrite newer cursors')

  const settings = readFileSync(path.join(repoRoot, 'src/main/settings.ts'), 'utf8')
  assert(settings.includes("defaultProviderId: ''"), 'settings defaultProviderId must be empty, not a hidden provider')
  assert(settings.includes("defaultModel: ''"), 'settings defaultModel must be empty, not a hidden model')

  const providers = readFileSync(path.join(repoRoot, 'src/main/providers.ts'), 'utf8')
  assert(!providers.includes('defaultDeepSeekProvider'), 'first launch must not inject a DeepSeek Provider')
  assert(!providers.includes('首启默认 Provider'), 'providers must not advertise a first-run default Provider')
  assert(!providers.includes('DEEPSEEK_PROVIDER_ID'), 'providers must not hard-code a hidden DeepSeek Provider id')
  assert(providers.includes("import { recordFailure, recordSuccess } from './scheduler'"), 'providers:fetchModels must report health to scheduler')
  assert(providers.includes('recordSuccess(providerId, latencyMs)'), 'successful model fetch must record provider latency')
  assert(providers.includes('recordFailure(providerId, message)'), 'failed model fetch must record provider failure reason')
  assert(providers.includes('latencyMs,'), 'model fetch result must expose latencyMs')

  const newSessionModal = readFileSync(path.join(repoRoot, 'src/renderer/src/components/NewSessionModal.tsx'), 'utf8')
  assert(newSessionModal.includes("useState<EngineKind | ''>('')"), 'new session UI must not default to Claude engine')
  assert(
    newSessionModal.includes("useState('')") &&
      newSessionModal.includes("t('selectProviderPlaceholder')") &&
      newSessionModal.includes("t('selectModelPlaceholder')"),
    'new session UI must start with explicit provider/model placeholders'
  )

  const agentSession = readFileSync(path.join(repoRoot, 'src/main/agentSession.ts'), 'utf8')
  const hiddenAnthropicName = '\u5b98\u65b9 Anthropic'
  assert(
    !agentSession.includes(`{ id: '', name: '${hiddenAnthropicName}'`),
    'Claude failover must not inject an empty-provider candidate'
  )
}

async function verifyViewHardCap() {
  mkdirSync(projectDir, { recursive: true })
  const filePath = path.join(projectDir, 'large.txt')
  writeFileSync(filePath, Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8')

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/agent/tools/view.ts',
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
