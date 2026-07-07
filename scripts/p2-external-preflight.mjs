#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required') || process.env.CAOGEN_P2_EXTERNAL_PREFLIGHT_REQUIRED === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = normalizePath(process.env.CAOGEN_P2_EXTERNAL_PREFLIGHT_REPORT_ROOT) ?? path.join(repoRoot, 'test-results', 'p2-external-preflight')
const reportDir = path.join(reportRoot, runId)
const configurationGuide = 'docs/P2-EXTERNAL-REQUIRED.md'
const chinaRequiredTargets = parseRequiredTargets(process.env.CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS)
const expectedJetBrainsPluginVersion = readExpectedJetBrainsPluginVersion()
const jetBrainsPluginTargetPlatform = readJetBrainsPluginTargetPlatform()
const requiredJetBrainsSteps = [
  'installedPlugin',
  'connectCreateSession',
  'sendChatMessage',
  'sendSelection',
  'requestSelectionEdit',
  'previewSelectionDiff',
  'applySelectionEdit',
  'nativeUndoVerified',
  'toggleRealtimeSync',
  'documentSyncObserved',
  'showEvents',
  'openDesktop'
]
const requiredJetBrainsBridgeCounters = [
  'helloCount',
  'sessionCreateCount',
  'chatSendCount',
  'selectionSendCount',
  'editRequestSendCount',
  'documentSyncCount'
]
const requiredJetBrainsActionCounters = [
  'diffPreviewCount',
  'applyEditCount',
  'nativeUndoCount',
  'realtimeToggleCount',
  'openDesktopCount'
]
const jetBrainsExecutableNames = [
  'idea64.exe',
  'idea.exe',
  'webstorm64.exe',
  'webstorm.exe',
  'pycharm64.exe',
  'pycharm.exe',
  'clion64.exe',
  'clion.exe',
  'goland64.exe',
  'goland.exe',
  'rider64.exe',
  'rider.exe',
  'datagrip64.exe',
  'datagrip.exe',
  'phpstorm64.exe',
  'phpstorm.exe',
  'rubymine64.exe',
  'rubymine.exe'
]

mkdirSync(reportDir, { recursive: true })

const report = {
  status: 'passed',
  required,
  reportDir,
  configurationGuide,
  checks: [
    jetbrainsCheck(),
    chinaRealNetworkCheck(),
    chinaToolCallParityCheck()
  ]
}
const failures = report.checks.flatMap((check) => check.failures.map((failure) => `${check.name}: ${failure}`))
report.status = failures.length > 0 ? 'failed' : 'passed'
report.failures = failures

writeReport(report)
console.log(JSON.stringify(report, null, 2))
if (required && failures.length > 0) process.exitCode = 1

function jetbrainsCheck() {
  const pluginDistribution = path.join(repoRoot, 'plugins', 'jetbrains', 'build', 'distributions', 'caogen-jetbrains-bridge-0.0.1.zip')
  const evidencePath = normalizePath(process.env.CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON)
  const explicitRecorderPath = normalizePath(process.env.CAOGEN_JETBRAINS_IDE_RECORDER_JSONL)
    ?? normalizePath(process.env.CAOGEN_JETBRAINS_RECORDER_PATH)
  const discoveredRecorder = evidencePath || explicitRecorderPath ? undefined : discoverLatestJetBrainsRecorder()
  const recorderPath = explicitRecorderPath ?? discoveredRecorder?.recorderPath
  const recorderPathSource = explicitRecorderPath ? 'environment' : recorderPath ? 'latest-recorder-e2e' : undefined
  const recorderIdeContext = recorderPathSource === 'latest-recorder-e2e'
    ? jetBrainsIdeContextFromLatestRecorder(discoveredRecorder)
    : undefined
  const ideDiscovery = recorderIdeContext?.ideDiscovery ?? discoverIdeExecutable()
  const ideExecutable = recorderIdeContext?.ideExecutable ?? ideDiscovery.executable
  const ideMetadata = recorderIdeContext?.ideMetadata ?? inspectIdeExecutable(ideExecutable)
  const pluginCompatibility = evaluateJetBrainsPluginCompatibility(ideMetadata)
  const failures = []
  if (!existsSync(pluginDistribution)) failures.push('JetBrains plugin distribution zip is missing')
  if (!ideExecutable && !recorderIdeContext?.ideRuntime) failures.push('CAOGEN_JETBRAINS_IDE_PATH is missing and no JetBrains IDE executable was auto-discovered')
  if (ideExecutable && !existsSync(ideExecutable)) failures.push(`JetBrains IDE executable does not exist: ${ideExecutable}`)
  if (ideExecutable && existsSync(ideExecutable) && !looksLikeJetBrainsExecutable(ideExecutable)) {
    failures.push(`JetBrains IDE executable must be a known JetBrains IDE binary: ${ideExecutable}`)
  }
  if (pluginCompatibility.compatible === false) failures.push(pluginCompatibility.reason)
  if (!evidencePath && !recorderPath) failures.push('CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON or CAOGEN_JETBRAINS_IDE_RECORDER_JSONL is missing')
  if (evidencePath && !existsSync(evidencePath)) failures.push(`JetBrains evidence JSON does not exist: ${evidencePath}`)
  if (recorderPath && !existsSync(recorderPath)) failures.push(`JetBrains recorder JSONL does not exist: ${recorderPath}`)
  const evidenceValidation = evidencePath && existsSync(evidencePath)
    ? validateJetBrainsEvidenceFile(evidencePath, ideExecutable)
    : recorderPath && existsSync(recorderPath)
      ? validateJetBrainsRecorderFile(recorderPath, ideExecutable, recorderIdeContext)
    : undefined
  if (evidenceValidation?.failures.length) {
    for (const failure of evidenceValidation.failures) failures.push(`JetBrains evidence JSON is invalid: ${failure}`)
  }

  return {
    name: 'jetbrains_ide_interaction',
    status: failures.length > 0 ? 'missing_configuration' : 'ready',
    pluginDistribution: path.relative(repoRoot, pluginDistribution),
    pluginDistributionPresent: existsSync(pluginDistribution),
    ideExecutable,
    ideExecutablePresent: Boolean(ideExecutable && existsSync(ideExecutable)),
    ideDiscovery,
    ideMetadata,
    ideRuntime: recorderIdeContext?.ideRuntime,
    pluginTargetPlatform: jetBrainsPluginTargetPlatform,
    pluginCompatibility,
    evidencePath,
    recorderPath,
    recorderPathSource,
    evidenceJsonValid: evidenceValidation ? evidenceValidation.failures.length === 0 : false,
    evidenceSummary: evidenceValidation?.summary,
    requiredEnvironment: ['CAOGEN_JETBRAINS_IDE_PATH', 'CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON or CAOGEN_JETBRAINS_IDE_RECORDER_JSONL'],
    command: 'npm.cmd run test:jetbrains-ide-interaction:required',
    failures
  }
}

function chinaRealNetworkCheck() {
  const targets = [
    target('feishu', ['FEISHU_WEBHOOK_URL'], ['FEISHU_WEBHOOK_SECRET']),
    target('dingtalk', ['DINGTALK_WEBHOOK_URL'], ['DINGTALK_WEBHOOK_SECRET']),
    target('wecom', ['WECOM_WEBHOOK_URL'], []),
    target('gitee_issue', ['GITEE_ACCESS_TOKEN', 'GITEE_OWNER', 'GITEE_REPO'], ['GITEE_API_URL']),
    target('gitee_pull_request', ['GITEE_ACCESS_TOKEN', 'GITEE_OWNER', 'GITEE_REPO', 'GITEE_PR_HEAD', 'GITEE_PR_BASE'], ['GITEE_API_URL', 'GITEE_PR_DRAFT']),
    target(
      'aliyun_yunxiao_api',
      ['ALIYUN_YUNXIAO_API_URL'],
      ['ALIYUN_YUNXIAO_TOKEN', 'ALIYUN_YUNXIAO_METHOD', 'ALIYUN_YUNXIAO_BODY', 'ALIYUN_YUNXIAO_AUTH_PREFIX', 'ALIYUN_DEVOPS_TOKEN'],
      { ALIYUN_YUNXIAO_API_URL: ['ALIYUN_DEVOPS_CHECK_URL'] }
    ),
    target(
      'tencent_coding_api',
      ['TENCENT_CODING_API_URL'],
      ['TENCENT_CODING_TOKEN', 'TENCENT_CODING_METHOD', 'TENCENT_CODING_BODY', 'TENCENT_CODING_AUTH_PREFIX'],
      { TENCENT_CODING_API_URL: ['TENCENT_CODING_CHECK_URL'] }
    ),
    target(
      'wechat_miniprogram_api',
      ['WECHAT_MINIPROGRAM_API_URL'],
      ['WECHAT_MINIPROGRAM_TOKEN', 'WECHAT_MINIPROGRAM_METHOD', 'WECHAT_MINIPROGRAM_BODY', 'WECHAT_MINIPROGRAM_AUTH_PREFIX'],
      { WECHAT_MINIPROGRAM_API_URL: ['WECHAT_MINIPROGRAM_CHECK_URL'] }
    )
  ]
  const selectedTargets = chinaRequiredTargets.length > 0
    ? targets.filter((item) => chinaRequiredTargets.includes(item.name))
    : targets
  const unsupportedTargets = chinaRequiredTargets.filter((name) => !targets.some((item) => item.name === name))
  const enabled = process.env.CAOGEN_CHINA_REAL_NETWORK === '1'
  const failures = []
  if (!enabled) failures.push('CAOGEN_CHINA_REAL_NETWORK=1 is not set')
  if (required && chinaRequiredTargets.length === 0) failures.push('CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS must declare staged real-network targets in required mode')
  for (const name of unsupportedTargets) failures.push(`unsupported required target: ${name}`)
  for (const item of selectedTargets) {
    if (!item.ready) failures.push(`${item.name} missing env: ${item.missingRequired.join(', ')}`)
    const endpointFailure = item.ready ? publicEndpointFailure(endpointForTarget(item.name), item.name) : undefined
    if (endpointFailure) failures.push(endpointFailure)
  }
  return {
    name: 'china_real_network',
    status: failures.length > 0 ? 'missing_configuration' : 'ready',
    enabled,
    requiredTargets: chinaRequiredTargets,
    unsupportedTargets,
    targets,
    selectedTargets,
    command: 'npm.cmd run test:china-real-network:required',
    failures
  }
}

function chinaToolCallParityCheck() {
  const enabled = process.env.CAOGEN_CHINA_TOOL_CALL_PARITY === '1'
  const rawProviders = process.env.CAOGEN_CHINA_PARITY_PROVIDERS
  const providerSource = resolveProvidersSource(rawProviders)
  const validation = providerSource.text
    ? validateProviders(providerSource.text)
    : { ok: false, providers: [], error: providerSource.error ?? 'missing CAOGEN_CHINA_PARITY_PROVIDERS' }
  const baselineCount = validation.providers.filter((provider) => provider.group === 'baseline').length
  const chinaCount = validation.providers.filter((provider) => provider.group === 'china').length
  const failures = []
  if (!enabled) failures.push('CAOGEN_CHINA_TOOL_CALL_PARITY=1 is not set')
  if (!validation.ok) failures.push(validation.error)
  if (baselineCount < 1 && process.env.CAOGEN_CHINA_PARITY_REQUIRE_BASELINE !== '0') failures.push('missing baseline provider')
  if (chinaCount < 1) failures.push('missing China provider')
  return {
    name: 'china_tool_call_parity',
    status: failures.length > 0 ? 'missing_configuration' : 'ready',
    enabled,
    providerSource: providerSource.source,
    providerCount: validation.providers.length,
    baselineCount,
    chinaCount,
    providerIds: validation.providers.map((provider) => provider.id),
    requiredEnvironment: ['CAOGEN_CHINA_TOOL_CALL_PARITY=1', 'CAOGEN_CHINA_PARITY_PROVIDERS'],
    command: 'npm.cmd run test:china-tool-call-parity:required',
    failures
  }
}

function resolveProvidersSource(value) {
  const text = value?.trim()
  if (!text) return { source: 'missing' }
  const maybePath = normalizePath(text)
  if (maybePath && existsSync(maybePath)) {
    try {
      return { source: 'file', path: maybePath, text: readFileSync(maybePath, 'utf8') }
    } catch (error) {
      return { source: 'file', path: maybePath, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { source: 'inline', text }
}

function target(name, requiredEnv, optionalEnv, requiredAliases = {}) {
  const hasRequired = (key) => Boolean(envText(key) || requiredAliases[key]?.some((alias) => envText(alias)))
  const missingRequired = requiredEnv.filter((key) => !hasRequired(key))
  return {
    name,
    ready: missingRequired.length === 0,
    requiredEnv,
    requiredAliases,
    optionalEnv,
    presentRequired: requiredEnv.filter((key) => hasRequired(key)),
    presentOptional: optionalEnv.filter((key) => Boolean(envText(key))),
    missingRequired
  }
}

function validateProviders(text) {
  try {
    const parsed = JSON.parse(stripJsonBom(text))
    if (!Array.isArray(parsed)) return { ok: false, providers: [], error: 'CAOGEN_CHINA_PARITY_PROVIDERS must be a JSON array' }
    const providers = parsed.map((item, index) => {
      if (!isRecord(item)) throw new Error(`provider[${index}] must be an object`)
      const id = stringField(item, 'id')
      const group = stringField(item, 'group') === 'baseline' ? 'baseline' : 'china'
      const apiFormat = stringField(item, 'apiFormat') || 'openai-compatible'
      const baseUrl = stringField(item, 'baseUrl')
      const model = stringField(item, 'model')
      const apiKey = stringField(item, 'apiKey')
      if (!id || !baseUrl || !model || !apiKey) throw new Error(`provider[${index}] missing id/baseUrl/model/apiKey`)
      const endpointFailure = publicEndpointFailure(baseUrl, `provider[${index}]`)
      if (endpointFailure) throw new Error(endpointFailure)
      return { id, group, apiFormat, baseUrl: maskUrl(baseUrl), model }
    })
    return { ok: true, providers }
  } catch (error) {
    return { ok: false, providers: [], error: error instanceof Error ? error.message : String(error) }
  }
}

function stripJsonBom(text) {
  return text.replace(/^\uFEFF/, '')
}

function validateJetBrainsEvidenceFile(filePath, ideExecutable) {
  let parsed
  try {
    parsed = JSON.parse(stripJsonBom(readFileSync(filePath, 'utf8')))
  } catch (error) {
    return { failures: [error instanceof Error ? error.message : String(error)], summary: { path: filePath, source: 'json' } }
  }
  return validateJetBrainsEvidenceObject(parsed, filePath, ideExecutable, 'json')
}

function validateJetBrainsRecorderFile(filePath, ideExecutable, ideContext) {
  const failures = []
  const events = []
  for (const [index, line] of readFileSync(filePath, 'utf8').split(/\r?\n/).entries()) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text)
      if (isRecord(parsed)) events.push(parsed)
    } catch (error) {
      failures.push(`recorder line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (events.length === 0) failures.push('recorder JSONL has no events')
  const validation = validateJetBrainsEvidenceObject(synthesizeJetBrainsEvidenceFromRecorder(filePath, events, ideExecutable, ideContext), filePath, ideExecutable, 'recorder')
  return {
    failures: [...failures, ...validation.failures],
    summary: validation.summary
  }
}

function validateJetBrainsEvidenceObject(parsed, filePath, ideExecutable, source) {
  const failures = []
  if (!isRecord(parsed)) return { failures: ['evidence JSON must be an object'], summary: { path: filePath, source } }

  for (const key of ['ideName', 'ideVersion', 'pluginVersion', 'pluginDistribution', 'workspace']) {
    if (!stringField(parsed, key)) failures.push(`missing ${key}`)
  }
  const pluginVersion = stringField(parsed, 'pluginVersion')
  if (expectedJetBrainsPluginVersion && pluginVersion && pluginVersion !== expectedJetBrainsPluginVersion) {
    failures.push(`pluginVersion must match current JetBrains plugin version ${expectedJetBrainsPluginVersion}`)
  }
  const workspace = normalizePath(stringField(parsed, 'workspace'))
  if (workspace && !existsSync(workspace)) failures.push(`workspace does not exist: ${workspace}`)
  const pluginDistribution = path.join(repoRoot, 'plugins', 'jetbrains', 'build', 'distributions', 'caogen-jetbrains-bridge-0.0.1.zip')
  const evidenceDistribution = normalizePath(stringField(parsed, 'pluginDistribution'))
  if (evidenceDistribution && !existsSync(evidenceDistribution)) failures.push(`pluginDistribution does not exist: ${evidenceDistribution}`)
  if (evidenceDistribution && existsSync(evidenceDistribution) && path.resolve(evidenceDistribution) !== path.resolve(pluginDistribution)) {
    failures.push(`pluginDistribution must point to the current plugin distribution: ${pluginDistribution}`)
  }

  const steps = recordField(parsed, 'steps')
  for (const key of requiredJetBrainsSteps) {
    if (steps[key] !== true) failures.push(`steps.${key} must be true`)
  }

  const bridgeEvents = recordField(parsed, 'bridgeEvents')
  for (const key of requiredJetBrainsBridgeCounters) {
    if (numberField(bridgeEvents, key) < 1) failures.push(`bridgeEvents.${key} must be >= 1`)
  }
  if (numberField(bridgeEvents, 'sessionSendCount') < 3) failures.push('bridgeEvents.sessionSendCount must be >= 3')

  const actionCounts = recordField(parsed, 'actionCounts')
  for (const key of requiredJetBrainsActionCounters) {
    if (numberField(actionCounts, key) < 1) failures.push(`actionCounts.${key} must be >= 1`)
  }

  const ideRuntime = recordField(parsed, 'ideRuntime')
  const runtimeLogPath = normalizePath(stringField(ideRuntime, 'logPath'))
  const hasRunIdeRuntime = source === 'recorder'
    && stringField(ideRuntime, 'mode') === 'gradle-runIde'
    && Boolean(runtimeLogPath && existsSync(runtimeLogPath))
  const evidenceIde = normalizePath(stringField(parsed, 'ideExecutable')) || ideExecutable
  if (!evidenceIde && !hasRunIdeRuntime) failures.push('missing ideExecutable')
  if (evidenceIde && !existsSync(evidenceIde)) failures.push(`ideExecutable does not exist: ${evidenceIde}`)
  if (evidenceIde && existsSync(evidenceIde) && !looksLikeJetBrainsExecutable(evidenceIde)) {
    failures.push(`ideExecutable must be a known JetBrains IDE binary: ${evidenceIde}`)
  }
  const evidenceIdeMetadata = inspectIdeExecutable(evidenceIde, parsed)
  const evidencePluginCompatibility = evaluateJetBrainsPluginCompatibility(evidenceIdeMetadata)
  if (evidencePluginCompatibility.compatible === false) {
    failures.push(`JetBrains IDE/plugin compatibility mismatch: ${evidencePluginCompatibility.reason}`)
  }

  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((item) => typeof item === 'string') : []
  if (artifacts.length === 0) failures.push('artifacts must include at least one path or URL')
  for (const artifact of artifacts) {
    const artifactPath = normalizeArtifactPath(artifact)
    if (artifactPath && !existsSync(artifactPath)) failures.push(`artifact does not exist: ${artifact}`)
  }

  return {
    failures,
    summary: {
      path: filePath,
      source,
      ideName: stringField(parsed, 'ideName'),
      ideVersion: stringField(parsed, 'ideVersion'),
      pluginVersion,
      expectedPluginVersion: expectedJetBrainsPluginVersion,
      pluginDistribution: evidenceDistribution,
      workspace,
      ideExecutable: evidenceIde,
      ideMetadata: evidenceIdeMetadata,
      ideRuntime: Object.keys(ideRuntime).length > 0 ? ideRuntime : undefined,
      pluginCompatibility: evidencePluginCompatibility,
      artifactCount: artifacts.length
    }
  }
}

function synthesizeJetBrainsEvidenceFromRecorder(filePath, events, ideExecutable, ideContext) {
  const counters = latestRecorderCounters(events)
  const bridgeCounters = counters.bridgeCounters
  const actionCounters = counters.actionCounters
  const bridgeCounterNames = ['send.hello', 'send.sessions.create', 'send.sessions.send.chat', 'send.sessions.send.selection', 'send.sessions.send.edit', 'send.documents.sync']
  return {
    ideName: process.env.CAOGEN_JETBRAINS_IDE_NAME || 'JetBrains IDE',
    ideVersion: process.env.CAOGEN_JETBRAINS_IDE_VERSION || ideContext?.ideMetadata?.version || 'recorder-observed',
    ideBuildNumber: ideContext?.ideMetadata?.buildNumber,
    ideExecutable: ideExecutable || '',
    ideRuntime: ideContext?.ideRuntime,
    pluginVersion: expectedJetBrainsPluginVersion ?? '0.0.1',
    pluginDistribution: path.join(repoRoot, 'plugins', 'jetbrains', 'build', 'distributions', 'caogen-jetbrains-bridge-0.0.1.zip'),
    workspace: process.env.CAOGEN_JETBRAINS_WORKSPACE || inferWorkspaceFromRecorderPath(filePath) || repoRoot,
    steps: {
      installedPlugin: true,
      connectCreateSession: hasAnyRecorderStep(events, ['connect.established', 'send.sessions.create', 'session.active.captured']),
      sendChatMessage: hasRecorderStep(events, 'chat.sent') || hasRecorderStep(events, 'send.sessions.send.chat'),
      sendSelection: hasRecorderStep(events, 'sendSelection.sent') || hasRecorderStep(events, 'send.sessions.send.selection'),
      requestSelectionEdit: hasRecorderStep(events, 'requestSelectionEdit.sent') || hasRecorderStep(events, 'send.sessions.send.edit'),
      previewSelectionDiff: hasRecorderStep(events, 'previewSelectionDiff.shown'),
      applySelectionEdit: hasRecorderStep(events, 'applySelectionEdit.applied'),
      nativeUndoVerified: envFlag('CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED') || hasRecorderStep(events, 'nativeUndo.verified'),
      toggleRealtimeSync: hasRecorderStep(events, 'realtimeSync.enabled'),
      documentSyncObserved: hasRecorderStep(events, 'sync.send.snapshot') || hasRecorderStep(events, 'send.documents.sync'),
      showEvents: hasRecorderStep(events, 'showEvents.shown'),
      openDesktop: hasRecorderStep(events, 'openDesktop.opened')
    },
    bridgeEvents: {
      helloCount: countRecorderCounter(bridgeCounters, 'send.hello'),
      sessionCreateCount: countRecorderCounter(bridgeCounters, 'send.sessions.create'),
      chatSendCount: countRecorderCounter(bridgeCounters, 'send.sessions.send.chat'),
      selectionSendCount: countRecorderCounter(bridgeCounters, 'send.sessions.send.selection'),
      editRequestSendCount: countRecorderCounter(bridgeCounters, 'send.sessions.send.edit'),
      documentSyncCount: countRecorderCounter(bridgeCounters, 'send.documents.sync'),
      sessionSendCount: bridgeCounterNames.reduce((sum, key) => sum + countRecorderCounter(bridgeCounters, key), 0)
    },
    actionCounts: {
      diffPreviewCount: countRecorderCounter(actionCounters, 'previewSelectionDiff.shown'),
      applyEditCount: countRecorderCounter(actionCounters, 'applySelectionEdit.applied'),
      nativeUndoCount: envFlag('CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED') || hasRecorderStep(events, 'nativeUndo.verified') ? 1 : 0,
      realtimeToggleCount: countRecorderCounter(actionCounters, 'realtimeSync.enabled'),
      openDesktopCount: countRecorderCounter(actionCounters, 'openDesktop.opened')
    },
    artifacts: [filePath, ideContext?.ideRuntime?.logPath].filter(Boolean)
  }
}

function discoverLatestJetBrainsRecorder() {
  const latestPath = path.join(repoRoot, 'test-results', 'jetbrains-recorder-e2e', 'latest.json')
  if (!existsSync(latestPath)) return undefined
  try {
    const latest = JSON.parse(stripJsonBom(readFileSync(latestPath, 'utf8')))
    if (!isRecord(latest) || latest.status !== 'passed') return undefined
    const candidate = normalizePath(stringField(latest, 'recorderPath'))
    if (!candidate || !existsSync(candidate)) return undefined
    const validation = recordField(latest, 'validation')
    const validationReportPath = normalizePath(stringField(validation, 'reportPath'))
    return {
      recorderPath: candidate,
      validationReportPath,
      validationReport: readJsonReport(validationReportPath),
      recorderReport: latest
    }
  } catch {
    return undefined
  }
}

function readJsonReport(filePath) {
  if (!filePath || !existsSync(filePath)) return undefined
  try {
    const parsed = JSON.parse(stripJsonBom(readFileSync(filePath, 'utf8')))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function jetBrainsIdeContextFromRecorderValidation(report) {
  if (!isRecord(report)) return undefined
  const preflight = recordField(report, 'preflight')
  const evidence = recordField(report, 'evidence')
  const evidenceMetadata = recordField(evidence, 'ideMetadata')
  const preflightMetadata = recordField(preflight, 'ideMetadata')
  const metadata = Object.keys(evidenceMetadata).length > 0 ? evidenceMetadata : preflightMetadata
  const metadataExecutable = normalizePath(stringField(metadata, 'executable'))
  const ideExecutable = normalizePath(stringField(evidence, 'ideExecutable'))
    ?? normalizePath(stringField(preflight, 'ideExecutable'))
    ?? metadataExecutable
  const preflightDiscovery = recordField(preflight, 'ideDiscovery')
  if (!ideExecutable && Object.keys(metadata).length === 0 && Object.keys(preflightDiscovery).length === 0) return undefined
  const ideDiscovery = Object.keys(preflightDiscovery).length > 0
    ? {
        ...preflightDiscovery,
        executable: (ideExecutable ?? stringField(preflightDiscovery, 'executable')) || undefined,
        evidenceSource: 'latest-recorder-e2e-validation'
      }
    : {
        executable: ideExecutable,
        source: 'latest-recorder-e2e-validation',
        searchRoots: [],
        searched: false
      }
  return {
    ideExecutable,
    ideDiscovery,
    ideMetadata: Object.keys(metadata).length > 0
      ? { ...metadata, executable: metadataExecutable ?? ideExecutable }
      : undefined
  }
}

function jetBrainsIdeContextFromLatestRecorder(discovered) {
  const validationContext = jetBrainsIdeContextFromRecorderValidation(discovered?.validationReport)
  if (validationContext?.ideExecutable && existsSync(validationContext.ideExecutable)) return validationContext
  return jetBrainsIdeContextFromRecorderRun(discovered?.recorderReport) ?? validationContext
}

function jetBrainsIdeContextFromRecorderRun(report) {
  if (!isRecord(report)) return undefined
  const ideRun = recordField(report, 'ideRun')
  if (stringField(ideRun, 'status') !== 'completed') return undefined
  const diagnostics = recordField(ideRun, 'ideLogDiagnostics')
  const logPath = normalizePath(stringField(diagnostics, 'path'))
  if (!logPath || !existsSync(logPath)) return undefined
  const version = inferRunIdeVersion(logPath) ?? jetBrainsPluginTargetPlatform.version
  const buildNumber = inferRunIdeBuildNumber(diagnostics)
  const productCode = inferRunIdeProductCode(logPath)
  const ideMetadata = {
    executable: undefined,
    name: productCode === 'IC' ? 'IntelliJ IDEA Community' : 'JetBrains IDE',
    version,
    buildNumber,
    productCode,
    productInfoPath: undefined,
    source: 'jetbrains-recorder-e2e-runIde-log',
    buildBaseline: jetBrainsBuildNumberToBaseline(buildNumber) ?? jetBrainsReleaseToBuildBaseline(version)
  }
  const ideRuntime = {
    mode: 'gradle-runIde',
    command: stringField(ideRun, 'command') || undefined,
    workspace: normalizePath(stringField(ideRun, 'workspaceArg')),
    logPath,
    sandboxPath: inferRunIdeSandboxPath(logPath),
    evidenceSource: 'latest-recorder-e2e'
  }
  return {
    ideExecutable: undefined,
    ideDiscovery: {
      executable: undefined,
      source: 'latest-recorder-e2e-runIde',
      searched: false,
      runtimeMode: ideRuntime.mode,
      logPath
    },
    ideMetadata,
    ideRuntime
  }
}

function inferRunIdeVersion(value) {
  return value.match(/\b[A-Z]+-(20\d{2}\.\d+(?:\.\d+)?)\b/)?.[1]
}

function inferRunIdeProductCode(value) {
  return value.match(/\b([A-Z]+)-20\d{2}\.\d+(?:\.\d+)?\b/)?.[1]
}

function inferRunIdeBuildNumber(diagnostics) {
  const lines = Array.isArray(diagnostics.keywordLines) ? diagnostics.keywordLines : []
  for (const line of lines) {
    const match = typeof line === 'string' ? line.match(/\((\d{3}\.\d+(?:\.\d+)?)\)/) : undefined
    if (match) return match[1]
  }
  return undefined
}

function inferRunIdeSandboxPath(logPath) {
  const marker = `${path.sep}log${path.sep}`
  const index = logPath.lastIndexOf(marker)
  return index > 0 ? logPath.slice(0, index) : path.dirname(path.dirname(logPath))
}

function inferWorkspaceFromRecorderPath(filePath) {
  if (!filePath) return undefined
  const candidate = path.join(path.dirname(filePath), 'workspace')
  return existsSync(candidate) ? candidate : undefined
}

function latestRecorderCounters(events) {
  let bridgeCounters = {}
  let actionCounters = {}
  for (const event of events) {
    if (isRecord(event.bridgeCounters)) bridgeCounters = event.bridgeCounters
    if (isRecord(event.actionCounters)) actionCounters = event.actionCounters
  }
  return { bridgeCounters, actionCounters }
}

function hasRecorderStep(events, step) {
  return events.some((event) => event.step === step)
}

function hasAnyRecorderStep(events, steps) {
  return steps.some((step) => hasRecorderStep(events, step))
}

function countRecorderCounter(counters, key) {
  return typeof counters[key] === 'number' && Number.isFinite(counters[key]) ? counters[key] : 0
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes((process.env[name] ?? '').trim().toLowerCase())
}

function discoverIdeExecutable() {
  const explicit = normalizePath(process.env.CAOGEN_JETBRAINS_IDE_PATH)
  if (explicit) {
    return {
      executable: explicit,
      source: 'env:CAOGEN_JETBRAINS_IDE_PATH',
      searchRoots: [],
      searched: false
    }
  }
  if (process.platform !== 'win32') {
    return {
      executable: undefined,
      source: 'unsupported-platform',
      searchRoots: [],
      searched: false
    }
  }
  const roots = jetBrainsIdeSearchRoots()
  for (const root of roots) {
    const found = findExecutable(root, jetBrainsExecutableNames, 5)
    if (found) {
      return {
        executable: found,
        source: 'auto-discovered',
        searchRoots: roots,
        matchedRoot: root,
        searched: true
      }
    }
  }
  return {
    executable: undefined,
    source: 'not-found',
    searchRoots: roots,
    searched: true
  }
}

function jetBrainsIdeSearchRoots() {
  return uniquePaths([
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'JetBrains'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'JetBrains'),
    path.join(process.env.LOCALAPPDATA || '', 'JetBrains', 'Toolbox', 'apps'),
    path.join(process.env.LOCALAPPDATA || '', 'JetBrains'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    ...windowsCustomAppRoots()
  ].filter(Boolean))
}

function windowsCustomAppRoots() {
  const roots = []
  for (const drive of windowsDriveLetters()) {
    roots.push(`${drive}:\\app`)
    roots.push(`${drive}:\\apps`)
    roots.push(`${drive}:\\JetBrains`)
  }
  return roots
}

function windowsDriveLetters() {
  const letters = new Set(['C', 'D'])
  const repoDrive = path.parse(repoRoot).root.match(/^([a-z]):\\/i)?.[1]
  const systemDrive = process.env.SystemDrive?.match(/^([a-z]):/i)?.[1]
  if (repoDrive) letters.add(repoDrive.toUpperCase())
  if (systemDrive) letters.add(systemDrive.toUpperCase())
  for (let code = 69; code <= 90; code += 1) {
    const drive = String.fromCharCode(code)
    if (existsSync(`${drive}:\\app`) || existsSync(`${drive}:\\apps`) || existsSync(`${drive}:\\JetBrains`)) {
      letters.add(drive)
    }
  }
  return [...letters]
}

function uniquePaths(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const normalized = normalizePath(value)
    if (!normalized) continue
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function readExpectedJetBrainsPluginVersion() {
  const buildFile = path.join(repoRoot, 'plugins', 'jetbrains', 'build.gradle.kts')
  if (!existsSync(buildFile)) return undefined
  const match = readFileSync(buildFile, 'utf8').match(/\bversion\s*=\s*"([^"]+)"/)
  return match?.[1]
}

function readJetBrainsPluginTargetPlatform() {
  const buildFile = path.join(repoRoot, 'plugins', 'jetbrains', 'build.gradle.kts')
  if (!existsSync(buildFile)) return { source: path.relative(repoRoot, buildFile), status: 'missing' }
  const text = readFileSync(buildFile, 'utf8')
  const communityMatch = text.match(/\bintellijIdeaCommunity\(([^\r\n]+)\)/)
  const ultimateMatch = text.match(/\bintellijIdeaUltimate\(([^\r\n]+)\)/)
  const version = resolveJetBrainsPluginTargetVersion(text, communityMatch?.[1] ?? ultimateMatch?.[1])
  const product = communityMatch ? 'IntelliJ IDEA Community' : ultimateMatch ? 'IntelliJ IDEA Ultimate' : undefined
  return {
    source: path.relative(repoRoot, buildFile),
    product,
    version,
    buildBaseline: jetBrainsReleaseToBuildBaseline(version),
    status: version ? 'detected' : 'unknown'
  }
}

function resolveJetBrainsPluginTargetVersion(buildText, argument) {
  const explicit = (process.env.CAOGEN_JETBRAINS_PLATFORM_VERSION ?? '').trim()
  if (explicit) return explicit
  const literal = argument?.match(/"([^"]+)"/)?.[1]
  if (literal) return literal
  const variable = argument?.trim().replace(/\.get\(\)$/, '')
  if (!variable) return undefined
  const defaultMatch = buildText.match(new RegExp(`\\b${escapeRegExp(variable)}\\s*=\\s*providers\\.environmentVariable\\("CAOGEN_JETBRAINS_PLATFORM_VERSION"\\)\\.orElse\\("([^"]+)"\\)`))
  return defaultMatch?.[1]
}

function inspectIdeExecutable(executable, evidence = {}) {
  const metadata = {
    executable,
    name: stringField(evidence, 'ideName') || undefined,
    version: stringField(evidence, 'ideVersion') || undefined,
    buildNumber: stringField(evidence, 'ideBuildNumber') || stringField(evidence, 'ideBuild') || undefined,
    productCode: undefined,
    productInfoPath: undefined,
    source: 'evidence'
  }
  if (executable) {
    const productInfoPath = findProductInfoPath(executable)
    if (productInfoPath) {
      try {
        const productInfo = JSON.parse(stripJsonBom(readFileSync(productInfoPath, 'utf8')))
        if (isRecord(productInfo)) {
          metadata.name = stringField(productInfo, 'name') || metadata.name
          metadata.version = stringField(productInfo, 'version') || metadata.version
          metadata.buildNumber = stringField(productInfo, 'buildNumber') || metadata.buildNumber
          metadata.productCode = stringField(productInfo, 'productCode') || undefined
          metadata.productInfoPath = productInfoPath
          metadata.source = 'product-info.json'
        }
      } catch (error) {
        metadata.productInfoPath = productInfoPath
        metadata.source = `invalid product-info.json: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (!metadata.version) metadata.version = inferJetBrainsVersionFromPath(executable)
  }
  metadata.buildBaseline = jetBrainsBuildNumberToBaseline(metadata.buildNumber) ?? jetBrainsReleaseToBuildBaseline(metadata.version)
  return metadata
}

function findProductInfoPath(executable) {
  if (!executable) return undefined
  let current = path.dirname(executable)
  for (let index = 0; index < 4; index += 1) {
    const candidate = path.join(current, 'product-info.json')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

function inferJetBrainsVersionFromPath(value) {
  return value.match(/\b(20\d{2}\.\d+(?:\.\d+)?)\b/)?.[1]
}

function evaluateJetBrainsPluginCompatibility(metadata) {
  const targetBaseline = jetBrainsPluginTargetPlatform.buildBaseline
  const ideBaseline = metadata?.buildBaseline
  const base = {
    ideVersion: metadata?.version,
    ideBuildNumber: metadata?.buildNumber,
    ideBuildBaseline: ideBaseline,
    pluginTargetProduct: jetBrainsPluginTargetPlatform.product,
    pluginTargetVersion: jetBrainsPluginTargetPlatform.version,
    pluginTargetBuildBaseline: targetBaseline
  }
  if (!metadata?.executable && !ideBaseline) {
    return { ...base, compatible: undefined, status: 'unknown', reason: 'no JetBrains IDE executable was resolved' }
  }
  if (!targetBaseline) {
    return { ...base, compatible: undefined, status: 'unknown', reason: 'plugin target JetBrains platform version is not declared' }
  }
  if (!ideBaseline) {
    return { ...base, compatible: undefined, status: 'unknown', reason: 'JetBrains IDE version/build could not be determined' }
  }
  if (ideBaseline < targetBaseline) {
    return {
      ...base,
      compatible: false,
      status: 'incompatible',
      reason: `JetBrains IDE ${metadata.version ?? 'unknown version'} build ${metadata.buildNumber ?? ideBaseline} is older than plugin target ${jetBrainsPluginTargetPlatform.product ?? 'JetBrains platform'} ${jetBrainsPluginTargetPlatform.version} build baseline ${targetBaseline}`
    }
  }
  return {
    ...base,
    compatible: true,
    status: 'compatible',
    reason: `JetBrains IDE build baseline ${ideBaseline} satisfies plugin target build baseline ${targetBaseline}`
  }
}

function jetBrainsBuildNumberToBaseline(value) {
  const match = typeof value === 'string' ? value.trim().match(/^(\d{3})(?:\.|$)/) : undefined
  return match ? Number.parseInt(match[1], 10) : undefined
}

function jetBrainsReleaseToBuildBaseline(value) {
  const match = typeof value === 'string' ? value.trim().match(/^20(\d{2})\.(\d+)/) : undefined
  if (!match) return undefined
  return Number.parseInt(`${match[1]}${match[2]}`, 10)
}

function findExecutable(root, names, depth) {
  if (!root || depth < 0 || !existsSync(root)) return undefined
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isFile() && names.includes(entry.name.toLowerCase())) return fullPath
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findExecutable(path.join(root, entry.name), names, depth - 1)
    if (found) return found
  }
  return undefined
}

function normalizePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  return path.isAbsolute(text) ? text : path.join(repoRoot, text)
}

function normalizeArtifactPath(value) {
  if (/^[a-z]+:\/\//i.test(value)) return undefined
  return normalizePath(value)
}

function looksLikeJetBrainsExecutable(value) {
  return jetBrainsExecutableNames.includes(path.basename(value).toLowerCase())
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function envText(key) {
  const value = process.env[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function endpointForTarget(name) {
  switch (name) {
    case 'feishu':
      return envText('FEISHU_WEBHOOK_URL')
    case 'dingtalk':
      return envText('DINGTALK_WEBHOOK_URL')
    case 'wecom':
      return envText('WECOM_WEBHOOK_URL')
    case 'gitee_issue':
    case 'gitee_pull_request':
      return envText('GITEE_API_URL') || 'https://gitee.com/api/v5'
    case 'aliyun_yunxiao_api':
      return envText('ALIYUN_YUNXIAO_API_URL') || envText('ALIYUN_DEVOPS_CHECK_URL')
    case 'tencent_coding_api':
      return envText('TENCENT_CODING_API_URL') || envText('TENCENT_CODING_CHECK_URL')
    case 'wechat_miniprogram_api':
      return envText('WECHAT_MINIPROGRAM_API_URL') || envText('WECHAT_MINIPROGRAM_CHECK_URL')
    default:
      return undefined
  }
}

function publicEndpointFailure(rawUrl, target) {
  if (!required || !rawUrl) return undefined
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return `${target} endpoint must be a valid URL`
  }
  if (url.protocol !== 'https:') return `${target} endpoint must use https in required mode`
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'example.com' ||
    host.endsWith('.example.com') ||
    host === 'invalid' ||
    host.endsWith('.invalid') ||
    /(^|[-.])mock([-.]|$)/i.test(host) ||
    isPrivateHost(host)
  ) {
    return `${target} endpoint must be a public real-network host, got ${host}`
  }
  return undefined
}

function isPrivateHost(host) {
  if (host === '::1') return true
  if (/^(fc|fd|fe80):/i.test(host)) return true
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 0
  )
}

function parseRequiredTargets(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function stringField(record, key) {
  return typeof record[key] === 'string' ? record[key].trim() : ''
}

function numberField(record, key) {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : 0
}

function recordField(record, key) {
  return isRecord(record[key]) ? record[key] : {}
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maskUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    for (const key of [...url.searchParams.keys()]) if (/token|key|secret|sign|access/i.test(key)) url.searchParams.set(key, '***')
    return url.toString()
  } catch {
    return String(rawUrl).replace(/(token|key|secret|sign)=([^&\s]+)/gi, '$1=***')
  }
}

function writeReport(value) {
  const json = JSON.stringify(value, null, 2)
  writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), json, 'utf8')
}
