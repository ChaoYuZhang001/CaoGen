#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'p2-external-validators', runId)
const preflightRoot = path.join(reportRoot, 'preflight')
const fixtureDir = path.join(reportRoot, 'fixtures')
const providerPath = path.join(fixtureDir, 'providers-bom.json')
const chinaOnlyProviderPath = path.join(fixtureDir, 'providers-china-only.json')
const localProviderPath = path.join(fixtureDir, 'providers-localhost.json')
const evidencePath = path.join(fixtureDir, 'jetbrains-evidence-bom.json')
const weakEvidencePath = path.join(fixtureDir, 'jetbrains-evidence-weak-session.json')
const stalePluginEvidencePath = path.join(fixtureDir, 'jetbrains-evidence-stale-plugin.json')
const recorderPath = path.join(fixtureDir, 'jetbrains-recorder.jsonl')
const weakRecorderPath = path.join(fixtureDir, 'jetbrains-recorder-weak.jsonl')
const artifactPath = path.join(fixtureDir, 'jetbrains-evidence.log')
const fakeIdePath = path.join(fixtureDir, 'idea64.exe')
const pluginDistributionPath = path.join(repoRoot, 'plugins', 'jetbrains', 'build', 'distributions', 'caogen-jetbrains-bridge-0.0.1.zip')

mkdirSync(fixtureDir, { recursive: true })

writeFileSync(providerPath, `\uFEFF${JSON.stringify(providerFixture(), null, 2)}\n`, 'utf8')
writeFileSync(chinaOnlyProviderPath, `${JSON.stringify(chinaOnlyProviderFixture(), null, 2)}\n`, 'utf8')
writeFileSync(localProviderPath, `${JSON.stringify(localProviderFixture(), null, 2)}\n`, 'utf8')
writeFileSync(artifactPath, `JetBrains interaction evidence artifact fixture ${runId}\n`, 'utf8')
writeFileSync(fakeIdePath, `JetBrains executable name fixture ${runId}\n`, 'utf8')
writeFileSync(evidencePath, `\uFEFF${JSON.stringify(jetBrainsEvidenceFixture(), null, 2)}\n`, 'utf8')
writeFileSync(weakEvidencePath, `${JSON.stringify(weakJetBrainsEvidenceFixture(), null, 2)}\n`, 'utf8')
writeFileSync(stalePluginEvidencePath, `${JSON.stringify(stalePluginEvidenceFixture(), null, 2)}\n`, 'utf8')
writeFileSync(recorderPath, `${recorderFixture().map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
writeFileSync(weakRecorderPath, `${weakRecorderFixture().map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')

const preflight = runNodeScript('scripts/p2-external-preflight.mjs', {
  CAOGEN_P2_EXTERNAL_PREFLIGHT_REPORT_ROOT: preflightRoot,
  CAOGEN_P2_EXTERNAL_PREFLIGHT_REQUIRED: '0',
  CAOGEN_CHINA_TOOL_CALL_PARITY: '1',
  CAOGEN_CHINA_PARITY_PROVIDERS: providerPath,
  CAOGEN_CHINA_PARITY_REQUIRE_BASELINE: '1',
  CAOGEN_CHINA_REAL_NETWORK: '0',
  CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS: '',
  CAOGEN_JETBRAINS_IDE_PATH: fakeIdePath,
  CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: evidencePath
})
assert(preflight.status === 0, preflight.output)

const preflightReport = readJson(path.join(preflightRoot, 'latest.json'))
const jetBrains = checkByName(preflightReport, 'jetbrains_ide_interaction')
const parity = checkByName(preflightReport, 'china_tool_call_parity')
const chinaNetwork = checkByName(preflightReport, 'china_real_network')
assertEqual(jetBrains.status, 'ready')
assertEqual(jetBrains.evidenceJsonValid, true)
assertEqual(parity.status, 'ready')
assertEqual(parity.providerSource, 'file')
assertEqual(parity.providerCount, 2)
assertEqual(chinaNetwork.status, 'missing_configuration')

const weakJetBrains = runNodeScript('scripts/p2-external-preflight.mjs', readyPreflightEnv(path.join(reportRoot, 'preflight-weak-jetbrains'), {
  CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: weakEvidencePath
}))
assert(weakJetBrains.status === 1, weakJetBrains.output)
const weakJetBrainsReport = readJson(path.join(reportRoot, 'preflight-weak-jetbrains', 'latest.json'))
const weakJetBrainsCheck = checkByName(weakJetBrainsReport, 'jetbrains_ide_interaction')
assertEqual(weakJetBrainsCheck.status, 'missing_configuration')
assert(
  weakJetBrainsCheck.failures.some((failure) => failure.includes('sessionSendCount')),
  'weak JetBrains evidence must fail on sessionSendCount'
)

const stalePlugin = runNodeScript('scripts/p2-external-preflight.mjs', readyPreflightEnv(path.join(reportRoot, 'preflight-stale-jetbrains-plugin'), {
  CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: stalePluginEvidencePath
}))
assert(stalePlugin.status === 1, stalePlugin.output)
const stalePluginReport = readJson(path.join(reportRoot, 'preflight-stale-jetbrains-plugin', 'latest.json'))
const stalePluginCheck = checkByName(stalePluginReport, 'jetbrains_ide_interaction')
assertEqual(stalePluginCheck.status, 'missing_configuration')
assert(
  stalePluginCheck.failures.some((failure) => failure.includes('pluginVersion')),
  'stale JetBrains plugin evidence must fail on pluginVersion'
)

const recorderPreflight = runNodeScript('scripts/p2-external-preflight.mjs', readyPreflightEnv(path.join(reportRoot, 'preflight-recorder'), {
  CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: '',
  CAOGEN_JETBRAINS_IDE_RECORDER_JSONL: recorderPath,
  CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED: '1'
}))
assert(recorderPreflight.status === 0, recorderPreflight.output)
const recorderPreflightReport = readJson(path.join(reportRoot, 'preflight-recorder', 'latest.json'))
const recorderPreflightCheck = checkByName(recorderPreflightReport, 'jetbrains_ide_interaction')
assertEqual(recorderPreflightCheck.status, 'ready')
assertEqual(recorderPreflightCheck.evidenceSummary.source, 'recorder')

const weakRecorderPreflight = runNodeScript('scripts/p2-external-preflight.mjs', readyPreflightEnv(path.join(reportRoot, 'preflight-weak-recorder'), {
  CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: '',
  CAOGEN_JETBRAINS_IDE_RECORDER_JSONL: weakRecorderPath
}))
assert(weakRecorderPreflight.status === 1, weakRecorderPreflight.output)
const weakRecorderPreflightReport = readJson(path.join(reportRoot, 'preflight-weak-recorder', 'latest.json'))
const weakRecorderPreflightCheck = checkByName(weakRecorderPreflightReport, 'jetbrains_ide_interaction')
assertEqual(weakRecorderPreflightCheck.status, 'missing_configuration')
assert(
  weakRecorderPreflightCheck.failures.some((failure) => failure.includes('nativeUndoVerified') || failure.includes('sessionSendCount')),
  'weak JetBrains recorder evidence must fail strict validation'
)

const chinaOnlyParity = runNodeScript('scripts/p2-external-preflight.mjs', readyPreflightEnv(path.join(reportRoot, 'preflight-china-only-parity'), {
  CAOGEN_CHINA_PARITY_PROVIDERS: chinaOnlyProviderPath
}))
assert(chinaOnlyParity.status === 1, chinaOnlyParity.output)
const chinaOnlyParityReport = readJson(path.join(reportRoot, 'preflight-china-only-parity', 'latest.json'))
const chinaOnlyParityCheck = checkByName(chinaOnlyParityReport, 'china_tool_call_parity')
assertEqual(chinaOnlyParityCheck.status, 'missing_configuration')
assert(
  chinaOnlyParityCheck.failures.some((failure) => failure.includes('missing baseline provider')),
  'China parity preflight must require a baseline provider'
)

const privateEndpoint = runNodeScript('scripts/p2-external-preflight.mjs', readyPreflightEnv(path.join(reportRoot, 'preflight-private-endpoint'), {
  FEISHU_WEBHOOK_URL: 'https://127.0.0.1/open-apis/bot/v2/hook/fixture'
}))
assert(privateEndpoint.status === 1, privateEndpoint.output)
const privateEndpointReport = readJson(path.join(reportRoot, 'preflight-private-endpoint', 'latest.json'))
const privateEndpointCheck = checkByName(privateEndpointReport, 'china_real_network')
assertEqual(privateEndpointCheck.status, 'missing_configuration')
assert(
  privateEndpointCheck.failures.some((failure) => failure.includes('public real-network host')),
  'China real-network preflight must reject private or localhost endpoints'
)

const aliasEndpoint = runNodeScript('scripts/p2-external-preflight.mjs', readyPreflightEnv(path.join(reportRoot, 'preflight-alias-endpoint'), {
  CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS: 'aliyun_yunxiao_api',
  FEISHU_WEBHOOK_URL: '',
  ALIYUN_DEVOPS_CHECK_URL: 'https://devops.aliyun.com/fixture'
}))
assert(aliasEndpoint.status === 0, aliasEndpoint.output)
const aliasEndpointReport = readJson(path.join(reportRoot, 'preflight-alias-endpoint', 'latest.json'))
const aliasEndpointCheck = checkByName(aliasEndpointReport, 'china_real_network')
assertEqual(aliasEndpointCheck.status, 'ready')

const localProviderPreflight = runNodeScript('scripts/p2-external-preflight.mjs', readyPreflightEnv(path.join(reportRoot, 'preflight-local-provider'), {
  CAOGEN_CHINA_PARITY_PROVIDERS: localProviderPath
}))
assert(localProviderPreflight.status === 1, localProviderPreflight.output)
const localProviderPreflightReport = readJson(path.join(reportRoot, 'preflight-local-provider', 'latest.json'))
const localProviderPreflightCheck = checkByName(localProviderPreflightReport, 'china_tool_call_parity')
assertEqual(localProviderPreflightCheck.status, 'missing_configuration')
assert(
  localProviderPreflightCheck.failures.some((failure) => failure.includes('public real-network host')),
  'China parity preflight must reject private or localhost provider endpoints'
)

const localProviderParity = runNodeScript('scripts/china-tool-call-parity.mjs', {
  CAOGEN_CHINA_TOOL_CALL_PARITY: '1',
  CAOGEN_CHINA_TOOL_CALL_PARITY_REQUIRED: '1',
  CAOGEN_CHINA_PARITY_PROVIDERS: localProviderPath,
  CAOGEN_CHINA_PARITY_REQUIRE_BASELINE: '1'
})
assert(localProviderParity.status === 1, localProviderParity.output)
assert(
  localProviderParity.output.includes('public real-network host'),
  'China parity required gate must reject private or localhost provider endpoints'
)

const doctor = runNodeScript('scripts/p2-external-doctor.mjs', {
  CAOGEN_CHINA_REAL_NETWORK: '',
  CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS: '',
  CAOGEN_CHINA_TOOL_CALL_PARITY: '',
  CAOGEN_CHINA_PARITY_PROVIDERS: '',
  CAOGEN_JETBRAINS_IDE_PATH: '',
  CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: ''
})
assert(doctor.status === 0, doctor.output)
const doctorReport = readJson(path.join(repoRoot, 'test-results', 'p2-external-doctor', 'latest.json'))
assertEqual(doctorReport.status, 'missing_external')
assert(doctorReport.missingDomains.includes('china_real_network'), 'doctor must report China real-network gap')
assert(doctorReport.missingDomains.includes('china_tool_call_parity'), 'doctor must report China parity gap')
assert(doctorReport.nextCommands.includes('npm.cmd run test:p2-external:pack'), 'doctor must point to external pack while gaps remain')

const jetBrainsGate = runNodeScript('scripts/jetbrains-ide-interaction-smoke.mjs', {
  CAOGEN_JETBRAINS_IDE_INTERACTION_REPORT_ROOT: path.join(reportRoot, 'jetbrains-gate-positive'),
  CAOGEN_JETBRAINS_IDE_INTERACTION_REQUIRED: '1',
  CAOGEN_JETBRAINS_IDE_PATH: fakeIdePath,
  CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: evidencePath
})
assert(jetBrainsGate.status === 0, jetBrainsGate.output)
const jetBrainsGateReport = readJson(path.join(reportRoot, 'jetbrains-gate-positive', 'latest.json'))
assertEqual(jetBrainsGateReport.status, 'passed')

const weakJetBrainsGate = runNodeScript('scripts/jetbrains-ide-interaction-smoke.mjs', {
  CAOGEN_JETBRAINS_IDE_INTERACTION_REPORT_ROOT: path.join(reportRoot, 'jetbrains-gate-weak-session'),
  CAOGEN_JETBRAINS_IDE_INTERACTION_REQUIRED: '1',
  CAOGEN_JETBRAINS_IDE_PATH: fakeIdePath,
  CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: weakEvidencePath
})
assert(weakJetBrainsGate.status === 1, weakJetBrainsGate.output)
const weakJetBrainsGateReport = readJson(path.join(reportRoot, 'jetbrains-gate-weak-session', 'latest.json'))
assert(
  weakJetBrainsGateReport.failures.some((failure) => failure.includes('sessionSendCount')),
  'JetBrains required gate must reject weak session evidence'
)

const recorderJetBrainsGate = runNodeScript('scripts/jetbrains-ide-interaction-smoke.mjs', {
  CAOGEN_JETBRAINS_IDE_INTERACTION_REPORT_ROOT: path.join(reportRoot, 'jetbrains-gate-recorder'),
  CAOGEN_JETBRAINS_IDE_INTERACTION_REQUIRED: '1',
  CAOGEN_JETBRAINS_IDE_PATH: fakeIdePath,
  CAOGEN_JETBRAINS_IDE_RECORDER_JSONL: recorderPath,
  CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED: '1'
})
assert(recorderJetBrainsGate.status === 0, recorderJetBrainsGate.output)
const recorderJetBrainsGateReport = readJson(path.join(reportRoot, 'jetbrains-gate-recorder', 'latest.json'))
assertEqual(recorderJetBrainsGateReport.status, 'passed')
assertEqual(recorderJetBrainsGateReport.evidence.steps.nativeUndoVerified, true)

const pack = runNodeScript('scripts/p2-external-pack.mjs', {})
assert(pack.status === 0, pack.output)
const packReport = readJson(path.join(repoRoot, 'test-results', 'p2-external-pack', 'latest.json'))
for (const name of [
  'README.md',
  '.env.template',
  'china-parity-providers.template.json',
  'jetbrains-evidence.template.json',
  'run-required-gates.ps1'
]) {
  assert(packReport.files.some((file) => file.name === name && existsSync(path.join(repoRoot, file.path))), `pack missing ${name}`)
}

const providerTemplate = readPackJson(packReport, 'china-parity-providers.template.json')
assert(Array.isArray(providerTemplate) && providerTemplate.some((item) => item.group === 'baseline'), 'provider template needs a baseline provider')
assert(providerTemplate.some((item) => item.group === 'china'), 'provider template needs a China provider')

const jetBrainsTemplate = readPackJson(packReport, 'jetbrains-evidence.template.json')
for (const key of ['ideName', 'ideVersion', 'ideExecutable', 'pluginVersion', 'pluginDistribution', 'workspace', 'steps', 'bridgeEvents', 'actionCounts', 'artifacts']) {
  assert(Object.prototype.hasOwnProperty.call(jetBrainsTemplate, key), `JetBrains template missing ${key}`)
}

const runnerText = readPackText(packReport, 'run-required-gates.ps1')
for (const marker of [
  '$EnvFile',
  'Import-P2EnvFile',
  'Assert-NoPlaceholderEnv',
  'test:p2-external:doctor',
  'test:p2-external:preflight',
  'test:china-real-network:required',
  'test:china-tool-call-parity:required',
  'test:jetbrains-ide-interaction:required',
  'test:p2-required'
]) {
  assert(runnerText.includes(marker), `external runner missing ${marker}`)
}

const report = {
  status: 'passed',
  reportRoot,
  preflightReport: path.relative(repoRoot, path.join(preflightRoot, 'latest.json')),
  packReport: path.relative(repoRoot, path.join(repoRoot, 'test-results', 'p2-external-pack', 'latest.json')),
  checks: [
    'BOM provider JSON file accepted by preflight',
    'BOM JetBrains evidence JSON accepted by preflight',
    'China real-network remains missing without real credentials',
    'Weak JetBrains session evidence is rejected by preflight',
    'Stale JetBrains plugin evidence is rejected by preflight',
    'JetBrains recorder JSONL evidence is accepted by preflight',
    'Weak JetBrains recorder JSONL evidence is rejected by preflight',
    'China tool-call parity without a baseline provider is rejected by preflight',
    'Private/local China real-network endpoints are rejected by preflight',
    'China real-network preflight accepts documented legacy endpoint aliases',
    'China tool-call parity preflight rejects private/local provider endpoints',
    'China tool-call parity required gate rejects private/local provider endpoints',
    'P2 external doctor summarizes missing external domains and next commands',
    'JetBrains required gate accepts strict evidence in an isolated fixture',
    'JetBrains required gate rejects weak session evidence in an isolated fixture',
    'JetBrains required gate accepts recorder JSONL evidence in an isolated fixture',
    'External evidence pack contains required templates, env loader, placeholder guard, and runner commands'
  ]
}
writeFileSync(path.join(reportRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(repoRoot, 'test-results', 'p2-external-validators', 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log('p2ExternalValidators smoke ok')

function providerFixture() {
  return [
    {
      id: 'baseline-fixture',
      group: 'baseline',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      apiKey: 'fixture-key'
    },
    {
      id: 'deepseek-fixture',
      group: 'china',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'fixture-key'
    }
  ]
}

function chinaOnlyProviderFixture() {
  return providerFixture().filter((provider) => provider.group === 'china')
}

function localProviderFixture() {
  return providerFixture().map((provider) => ({ ...provider, baseUrl: 'https://127.0.0.1/v1' }))
}

function jetBrainsEvidenceFixture() {
  return {
    ideName: 'IntelliJ IDEA Fixture',
    ideVersion: 'fixture-version',
    ideExecutable: fakeIdePath,
    pluginVersion: '0.0.1',
    pluginDistribution: pluginDistributionPath,
    workspace: repoRoot,
    steps: {
      installedPlugin: true,
      connectCreateSession: true,
      sendChatMessage: true,
      sendSelection: true,
      requestSelectionEdit: true,
      previewSelectionDiff: true,
      applySelectionEdit: true,
      nativeUndoVerified: true,
      toggleRealtimeSync: true,
      documentSyncObserved: true,
      showEvents: true,
      openDesktop: true
    },
    bridgeEvents: {
      helloCount: 1,
      sessionCreateCount: 1,
      sessionSendCount: 3,
      chatSendCount: 1,
      selectionSendCount: 1,
      editRequestSendCount: 1,
      documentSyncCount: 1
    },
    actionCounts: {
      diffPreviewCount: 1,
      applyEditCount: 1,
      nativeUndoCount: 1,
      realtimeToggleCount: 1,
      openDesktopCount: 1
    },
    artifacts: [artifactPath]
  }
}

function weakJetBrainsEvidenceFixture() {
  const fixture = jetBrainsEvidenceFixture()
  fixture.bridgeEvents.sessionSendCount = 2
  return fixture
}

function stalePluginEvidenceFixture() {
  const fixture = jetBrainsEvidenceFixture()
  fixture.pluginVersion = '0.0.0-stale'
  return fixture
}

function recorderFixture() {
  const steps = [
    ['bridge', 'connect.connected'],
    ['bridge', 'send.hello'],
    ['bridge', 'send.sessions.create'],
    ['bridge', 'session.active.captured'],
    ['bridge', 'send.sessions.send.chat'],
    ['bridge', 'send.sessions.send.selection'],
    ['bridge', 'send.sessions.send.edit'],
    ['bridge', 'send.documents.sync'],
    ['action', 'connect.established'],
    ['action', 'chat.sent'],
    ['action', 'sendSelection.sent'],
    ['action', 'requestSelectionEdit.sent'],
    ['action', 'previewSelectionDiff.shown'],
    ['action', 'applySelectionEdit.applied'],
    ['action', 'realtimeSync.enabled'],
    ['action', 'showEvents.shown'],
    ['action', 'openDesktop.opened']
  ]
  const bridgeCounters = {}
  const actionCounters = {}
  return steps.map(([category, step], index) => {
    const counters = category === 'bridge' ? bridgeCounters : actionCounters
    counters[step] = (counters[step] ?? 0) + 1
    return {
      timestamp: new Date(1_800_000_000_000 + index).toISOString(),
      sequence: index + 1,
      category,
      step,
      bridgeCounters: { ...bridgeCounters },
      actionCounters: { ...actionCounters },
      fields: { fixture: true }
    }
  })
}

function weakRecorderFixture() {
  return recorderFixture().filter((event) => event.step !== 'send.documents.sync' && event.step !== 'applySelectionEdit.applied')
}

function readyPreflightEnv(caseReportRoot, overrides = {}) {
  return {
    CAOGEN_P2_EXTERNAL_PREFLIGHT_REPORT_ROOT: caseReportRoot,
    CAOGEN_P2_EXTERNAL_PREFLIGHT_REQUIRED: '1',
    CAOGEN_CHINA_TOOL_CALL_PARITY: '1',
    CAOGEN_CHINA_PARITY_PROVIDERS: providerPath,
    CAOGEN_CHINA_PARITY_REQUIRE_BASELINE: '1',
    CAOGEN_CHINA_REAL_NETWORK: '1',
    CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS: 'feishu',
    FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture',
    CAOGEN_JETBRAINS_IDE_PATH: fakeIdePath,
    CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON: evidencePath,
    ...overrides
  }
}

function runNodeScript(script, env) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, script)], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error?.message
  }
}

function checkByName(report, name) {
  const check = report.checks.find((item) => item.name === name)
  assert(check, `preflight check not found: ${name}`)
  return check
}

function readPackJson(packReport, name) {
  return JSON.parse(readPackText(packReport, name).replace(/^\uFEFF/, ''))
}

function readPackText(packReport, name) {
  const entry = packReport.files.find((file) => file.name === name)
  assert(entry, `pack entry missing: ${name}`)
  return readFileSync(path.join(repoRoot, entry.path), 'utf8')
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
