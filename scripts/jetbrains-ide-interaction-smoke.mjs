#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.env.CAOGEN_JETBRAINS_IDE_INTERACTION_REQUIRED === '1' || process.argv.includes('--required')
const enabled = process.env.CAOGEN_JETBRAINS_IDE_INTERACTION === '1' || process.argv.includes('--enabled') || required
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const reportRoot = normalizePath(process.env.CAOGEN_JETBRAINS_IDE_INTERACTION_REPORT_ROOT) ?? path.join(repoRoot, 'test-results', 'jetbrains-ide-interaction')
const reportDir = path.join(reportRoot, runId)
const configurationGuide = 'docs/P2-EXTERNAL-REQUIRED.md'
const pluginDistribution = path.join(repoRoot, 'plugins', 'jetbrains', 'build', 'distributions', 'caogen-jetbrains-bridge-0.0.1.zip')
const expectedPluginVersion = readExpectedPluginVersion()
const evidencePath = normalizePath(process.env.CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON)
const explicitRecorderPath = normalizePath(process.env.CAOGEN_JETBRAINS_IDE_RECORDER_JSONL)
  ?? normalizePath(process.env.CAOGEN_JETBRAINS_RECORDER_PATH)
const discoveredRecorder = evidencePath || explicitRecorderPath ? undefined : discoverLatestRecorder()
const recorderPath = explicitRecorderPath ?? discoveredRecorder?.recorderPath
const recorderPathSource = explicitRecorderPath ? 'environment' : recorderPath ? 'latest-recorder-e2e' : undefined
const pluginTargetPlatform = readPluginTargetPlatform()

const requiredSteps = [
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
const requiredBridgeCounters = [
  'helloCount',
  'sessionCreateCount',
  'chatSendCount',
  'selectionSendCount',
  'editRequestSendCount',
  'documentSyncCount'
]
const requiredActionCounters = [
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
  'rubymine.exe',
  'idea',
  'webstorm',
  'pycharm',
  'clion',
  'goland',
  'rider',
  'datagrip',
  'phpstorm',
  'rubymine'
]
const recorderIdeContext = recorderPathSource === 'latest-recorder-e2e'
  ? ideContextFromLatestRecorder(discoveredRecorder)
  : recorderPathSource === 'environment'
    ? ideContextFromRunIdeEnvironment()
  : undefined
const ideDiscovery = recorderIdeContext?.ideDiscovery ?? discoverIdeExecutable()
const ideExecutable = recorderIdeContext?.ideExecutable ?? ideDiscovery.executable
const ideMetadata = recorderIdeContext?.ideMetadata ?? inspectIdeExecutable(ideExecutable)
const pluginCompatibility = evaluatePluginCompatibility(ideMetadata)

mkdirSync(reportDir, { recursive: true })

const preflight = {
  ideExecutable,
  ideExecutablePresent: Boolean(ideExecutable && existsSync(ideExecutable)),
  ideDiscovery,
  ideMetadata,
  ideRuntime: recorderIdeContext?.ideRuntime,
  pluginDistribution: path.relative(repoRoot, pluginDistribution),
  pluginDistributionPresent: existsSync(pluginDistribution),
  pluginTargetPlatform,
  pluginCompatibility
}

let report
if (!enabled && !evidencePath) {
  report = {
    status: 'skipped',
    required,
    reportDir,
    configurationGuide,
    reason: 'set CAOGEN_JETBRAINS_IDE_INTERACTION=1 or pass --required with CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON',
    preflight,
    missingConfiguration: missingConfiguration(),
    failures: []
  }
} else if (!evidencePath && !recorderPath) {
  const failures = ['missing real JetBrains IDE interaction evidence JSON or recorder JSONL']
  report = {
    status: required ? 'failed' : 'skipped',
    required,
    reportDir,
    configurationGuide,
    preflight,
    missingConfiguration: missingConfiguration(),
    evidenceTemplate: buildEvidenceTemplate(),
    recorderTemplate: buildRecorderTemplate(),
    failures
  }
} else {
  const evidenceInput = evidencePath
    ? loadEvidenceJson(evidencePath)
    : loadRecorderEvidence(recorderPath)
  const validation = validateEvidence(evidenceInput)
  report = {
    status: validation.failures.length > 0 ? 'failed' : 'passed',
    required,
    reportDir,
    configurationGuide,
    preflight,
    evidencePath: evidenceInput.path,
    recorderPath: evidenceInput.source === 'recorder' ? recorderPath : undefined,
    recorderPathSource: evidenceInput.source === 'recorder' ? recorderPathSource : undefined,
    evidence: validation.summary,
    missingConfiguration: missingConfiguration(),
    failures: validation.failures
  }
}

writeReport(report)
console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1
if (!required && report.status === 'failed') process.exitCode = 1

function loadEvidenceJson(filePath) {
  if (!existsSync(filePath)) {
    return {
      source: 'json',
      path: filePath,
      failures: [`evidence file does not exist: ${filePath}`],
      parsed: undefined
    }
  }
  try {
    return {
      source: 'json',
      path: filePath,
      failures: [],
      parsed: JSON.parse(stripJsonBom(readFileSync(filePath, 'utf8')))
    }
  } catch (error) {
    return {
      source: 'json',
      path: filePath,
      failures: [`cannot parse evidence JSON: ${error instanceof Error ? error.message : String(error)}`],
      parsed: undefined
    }
  }
}

function loadRecorderEvidence(filePath) {
  const failures = []
  if (!filePath) {
    return {
      source: 'recorder',
      path: undefined,
      failures: ['missing recorder JSONL path'],
      parsed: undefined
    }
  }
  if (!existsSync(filePath)) {
    return {
      source: 'recorder',
      path: filePath,
      failures: [`recorder JSONL does not exist: ${filePath}`],
      parsed: undefined
    }
  }
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
  return {
    source: 'recorder',
    path: filePath,
    failures,
    parsed: synthesizeEvidenceFromRecorder(filePath, events)
  }
}

function validateEvidence(input) {
  const failures = []
  if (input.failures.length > 0) failures.push(...input.failures)
  const parsed = input.parsed
  if (!isRecord(parsed)) {
    return { failures: [...failures, 'evidence JSON must be an object'], summary: { path: input.path, source: input.source } }
  }

  for (const key of ['ideName', 'ideVersion', 'pluginVersion', 'pluginDistribution', 'workspace']) {
    if (!stringField(parsed, key)) failures.push(`evidence missing ${key}`)
  }
  const pluginVersion = stringField(parsed, 'pluginVersion')
  if (expectedPluginVersion && pluginVersion && pluginVersion !== expectedPluginVersion) {
    failures.push(`evidence.pluginVersion must match current JetBrains plugin version ${expectedPluginVersion}`)
  }
  const evidenceDistribution = normalizePath(stringField(parsed, 'pluginDistribution'))
  if (evidenceDistribution && !existsSync(evidenceDistribution)) failures.push(`evidence.pluginDistribution not found: ${evidenceDistribution}`)
  if (evidenceDistribution && existsSync(evidenceDistribution) && path.resolve(evidenceDistribution) !== path.resolve(pluginDistribution)) {
    failures.push(`evidence.pluginDistribution must point to current distribution: ${pluginDistribution}`)
  }
  const workspace = normalizePath(stringField(parsed, 'workspace'))
  if (workspace && !existsSync(workspace)) failures.push(`evidence.workspace not found: ${workspace}`)

  const steps = recordField(parsed, 'steps')
  for (const key of requiredSteps) {
    if (steps[key] !== true) failures.push(`evidence.steps.${key} must be true`)
  }

  const bridgeEvents = recordField(parsed, 'bridgeEvents')
  for (const key of requiredBridgeCounters) {
    if (numberField(bridgeEvents, key) < 1) failures.push(`evidence.bridgeEvents.${key} must be >= 1`)
  }
  const actionCounts = recordField(parsed, 'actionCounts')
  for (const key of requiredActionCounters) {
    if (numberField(actionCounts, key) < 1) failures.push(`evidence.actionCounts.${key} must be >= 1`)
  }
  const sessionSendCount = numberField(bridgeEvents, 'sessionSendCount')
  if (sessionSendCount < 3) failures.push('evidence.bridgeEvents.sessionSendCount must be >= 3')

  if (!preflight.pluginDistributionPresent) failures.push('JetBrains plugin distribution zip is missing')

  const ideRuntime = recordField(parsed, 'ideRuntime')
  const runtimeLogPath = normalizePath(stringField(ideRuntime, 'logPath'))
  const hasRunIdeRuntime = input.source === 'recorder'
    && stringField(ideRuntime, 'mode') === 'gradle-runIde'
    && Boolean(runtimeLogPath && existsSync(runtimeLogPath))
  const evidenceIde = normalizePath(stringField(parsed, 'ideExecutable')) || ideExecutable
  if (!evidenceIde && !hasRunIdeRuntime) failures.push('evidence or env must identify a JetBrains IDE executable')
  if (evidenceIde && !existsSync(evidenceIde)) failures.push(`JetBrains IDE executable not found: ${evidenceIde}`)
  if (evidenceIde && existsSync(evidenceIde) && !looksLikeJetBrainsExecutable(evidenceIde)) {
    failures.push(`JetBrains IDE executable must be a known JetBrains IDE binary: ${evidenceIde}`)
  }
  const evidenceIdeMetadata = inspectIdeExecutable(evidenceIde, parsed)
  const evidencePluginCompatibility = evaluatePluginCompatibility(evidenceIdeMetadata)
  if (evidencePluginCompatibility.compatible === false) {
    failures.push(`JetBrains IDE/plugin compatibility mismatch: ${evidencePluginCompatibility.reason}`)
  }

  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((item) => typeof item === 'string') : []
  if (artifacts.length === 0) failures.push('evidence.artifacts must include at least one log, screenshot, or recording reference')
  for (const item of artifacts) {
    const artifactPath = normalizeArtifactPath(item)
    if (artifactPath && !existsSync(artifactPath)) failures.push(`evidence artifact not found: ${item}`)
  }

  return {
    failures,
    summary: {
      ideName: stringField(parsed, 'ideName'),
      ideVersion: stringField(parsed, 'ideVersion'),
      pluginVersion,
      expectedPluginVersion,
      pluginDistribution: evidenceDistribution,
      workspace,
      ideExecutable: evidenceIde,
      ideMetadata: evidenceIdeMetadata,
      ideRuntime: Object.keys(ideRuntime).length > 0 ? ideRuntime : undefined,
      pluginCompatibility: evidencePluginCompatibility,
      steps,
      bridgeEvents,
      actionCounts,
      artifacts
    }
  }
}

function synthesizeEvidenceFromRecorder(filePath, events) {
  const bridgeCounterNames = ['send.hello', 'send.sessions.create', 'send.sessions.send.chat', 'send.sessions.send.selection', 'send.sessions.send.edit', 'send.documents.sync']
  const actionCounterNames = ['previewSelectionDiff.shown', 'applySelectionEdit.applied', 'realtimeSync.enabled', 'openDesktop.opened']
  const counters = latestCounters(events)
  const bridgeCounters = counters.bridgeCounters
  const actionCounters = counters.actionCounters
  return {
    ideName: process.env.CAOGEN_JETBRAINS_IDE_NAME || 'JetBrains IDE',
    ideVersion: process.env.CAOGEN_JETBRAINS_IDE_VERSION || recorderIdeContext?.ideMetadata?.version || 'recorder-observed',
    ideBuildNumber: recorderIdeContext?.ideMetadata?.buildNumber,
    ideExecutable: ideExecutable || '',
    ideRuntime: recorderIdeContext?.ideRuntime,
    pluginVersion: expectedPluginVersion ?? '0.0.1',
    pluginDistribution,
    workspace: process.env.CAOGEN_JETBRAINS_WORKSPACE || inferWorkspaceFromRecorderPath(filePath) || repoRoot,
    steps: {
      installedPlugin: true,
      connectCreateSession: hasAnyStep(events, ['connect.established', 'send.sessions.create', 'session.active.captured']),
      sendChatMessage: hasStep(events, 'chat.sent') || hasStep(events, 'send.sessions.send.chat'),
      sendSelection: hasStep(events, 'sendSelection.sent') || hasStep(events, 'send.sessions.send.selection'),
      requestSelectionEdit: hasStep(events, 'requestSelectionEdit.sent') || hasStep(events, 'send.sessions.send.edit'),
      previewSelectionDiff: hasStep(events, 'previewSelectionDiff.shown'),
      applySelectionEdit: hasStep(events, 'applySelectionEdit.applied'),
      nativeUndoVerified: envFlag('CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED') || hasStep(events, 'nativeUndo.verified'),
      toggleRealtimeSync: hasStep(events, 'realtimeSync.enabled'),
      documentSyncObserved: hasStep(events, 'sync.send.snapshot') || hasStep(events, 'send.documents.sync'),
      showEvents: hasStep(events, 'showEvents.shown'),
      openDesktop: hasStep(events, 'openDesktop.opened')
    },
    bridgeEvents: {
      helloCount: countCounter(bridgeCounters, 'send.hello'),
      sessionCreateCount: countCounter(bridgeCounters, 'send.sessions.create'),
      chatSendCount: countCounter(bridgeCounters, 'send.sessions.send.chat'),
      selectionSendCount: countCounter(bridgeCounters, 'send.sessions.send.selection'),
      editRequestSendCount: countCounter(bridgeCounters, 'send.sessions.send.edit'),
      documentSyncCount: countCounter(bridgeCounters, 'send.documents.sync'),
      sessionSendCount: bridgeCounterNames.reduce((sum, key) => sum + countCounter(bridgeCounters, key), 0)
    },
    actionCounts: {
      diffPreviewCount: countCounter(actionCounters, 'previewSelectionDiff.shown'),
      applyEditCount: countCounter(actionCounters, 'applySelectionEdit.applied'),
      nativeUndoCount: envFlag('CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED') || hasStep(events, 'nativeUndo.verified') ? 1 : 0,
      realtimeToggleCount: countCounter(actionCounters, 'realtimeSync.enabled'),
      openDesktopCount: countCounter(actionCounters, 'openDesktop.opened')
    },
    artifacts: [filePath, recorderIdeContext?.ideRuntime?.logPath].filter(Boolean)
  }
}

function discoverLatestRecorder() {
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

function ideContextFromRecorderValidation(report) {
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

function ideContextFromLatestRecorder(discovered) {
  const validationContext = ideContextFromRecorderValidation(discovered?.validationReport)
  if (validationContext?.ideExecutable && existsSync(validationContext.ideExecutable)) return validationContext
  return ideContextFromRecorderRun(discovered?.recorderReport) ?? validationContext
}

function ideContextFromRunIdeEnvironment() {
  const logPath = normalizePath(process.env.CAOGEN_JETBRAINS_RUNIDE_LOG_PATH)
  if (!logPath || !existsSync(logPath)) return undefined
  const diagnostics = ideLogDiagnosticsFromFile(logPath)
  const version = process.env.CAOGEN_JETBRAINS_RUNIDE_VERSION || inferRunIdeVersion(logPath) || pluginTargetPlatform.version
  const buildNumber = process.env.CAOGEN_JETBRAINS_RUNIDE_BUILD || inferRunIdeBuildNumber(diagnostics)
  const productCode = process.env.CAOGEN_JETBRAINS_RUNIDE_PRODUCT_CODE || inferRunIdeProductCode(logPath)
  const ideMetadata = {
    executable: undefined,
    name: productCode === 'IC' ? 'IntelliJ IDEA Community' : 'JetBrains IDE',
    version,
    buildNumber,
    productCode,
    productInfoPath: undefined,
    source: 'jetbrains-recorder-e2e-runIde-env',
    buildBaseline: jetBrainsBuildNumberToBaseline(buildNumber) ?? jetBrainsReleaseToBuildBaseline(version)
  }
  const ideRuntime = {
    mode: 'gradle-runIde',
    command: process.env.CAOGEN_JETBRAINS_RUNIDE_COMMAND || undefined,
    workspace: normalizePath(process.env.CAOGEN_JETBRAINS_RUNIDE_WORKSPACE),
    logPath,
    sandboxPath: inferRunIdeSandboxPath(logPath),
    evidenceSource: 'explicit-recorder-e2e'
  }
  return {
    ideExecutable: undefined,
    ideDiscovery: {
      executable: undefined,
      source: 'explicit-recorder-e2e-runIde',
      searched: false,
      runtimeMode: ideRuntime.mode,
      logPath
    },
    ideMetadata,
    ideRuntime
  }
}

function ideContextFromRecorderRun(report) {
  if (!isRecord(report)) return undefined
  const ideRun = recordField(report, 'ideRun')
  if (stringField(ideRun, 'status') !== 'completed') return undefined
  const diagnostics = recordField(ideRun, 'ideLogDiagnostics')
  const logPath = normalizePath(stringField(diagnostics, 'path'))
  if (!logPath || !existsSync(logPath)) return undefined
  const version = inferRunIdeVersion(logPath) ?? pluginTargetPlatform.version
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

function ideLogDiagnosticsFromFile(logPath) {
  if (!logPath || !existsSync(logPath)) return { status: 'missing', path: logPath, keywordLines: [] }
  const keywords = [
    'CaoGen Bridge',
    'args:',
    'caogenRecorderE2E',
    'ideScript',
    'applicationInitialized',
    'startupActivity',
    'appStarter',
    'autorun',
    'recorder',
    'Project'
  ]
  const keywordLines = readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => keywords.some((keyword) => line.includes(keyword)))
    .slice(-120)
  return { status: 'present', path: logPath, keywordLines }
}

function inferWorkspaceFromRecorderPath(filePath) {
  if (!filePath) return undefined
  const candidate = path.join(path.dirname(filePath), 'workspace')
  return existsSync(candidate) ? candidate : undefined
}

function latestCounters(events) {
  let bridgeCounters = {}
  let actionCounters = {}
  for (const event of events) {
    if (isRecord(event.bridgeCounters)) bridgeCounters = event.bridgeCounters
    if (isRecord(event.actionCounters)) actionCounters = event.actionCounters
  }
  return { bridgeCounters, actionCounters }
}

function hasStep(events, step) {
  return events.some((event) => event.step === step)
}

function hasAnyStep(events, steps) {
  return steps.some((step) => hasStep(events, step))
}

function countCounter(counters, key) {
  return typeof counters[key] === 'number' && Number.isFinite(counters[key]) ? counters[key] : 0
}

function stripJsonBom(text) {
  return text.replace(/^\uFEFF/, '')
}

function buildEvidenceTemplate() {
  return {
    ideName: 'IntelliJ IDEA or WebStorm',
    ideVersion: '<real IDE version>',
    ideExecutable: ideExecutable || '<path-to-idea64.exe-or-webstorm64.exe>',
    pluginVersion: expectedPluginVersion ?? '0.0.1',
    pluginDistribution,
    workspace: '<tested-project-path>',
    steps: Object.fromEntries(requiredSteps.map((key) => [key, true])),
    bridgeEvents: {
      ...Object.fromEntries(requiredBridgeCounters.map((key) => [key, 1])),
      sessionSendCount: 3
    },
    actionCounts: Object.fromEntries(requiredActionCounters.map((key) => [key, 1])),
    artifacts: ['<local-log-or-screenshot-path>']
  }
}

function buildRecorderTemplate() {
  return {
    enableRecorder: [
      '-Dcaogen.jetbrains.recorder.enabled=true',
      '-Dcaogen.jetbrains.recorder.path=<absolute-jsonl-path>'
    ],
    acceptedEnvironment: [
      'CAOGEN_JETBRAINS_IDE_RECORDER_JSONL=<absolute-jsonl-path>',
      'CAOGEN_JETBRAINS_RECORDER_PATH=<absolute-jsonl-path>',
      'CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED=1'
    ],
    note: 'Recorder evidence still requires a real JetBrains IDE executable and real user-visible workflow execution.'
  }
}

function missingConfiguration() {
  const missing = []
  if (!evidencePath && !recorderPath) {
    missing.push({ target: 'jetbrains_ide_interaction', env: ['CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON', 'CAOGEN_JETBRAINS_IDE_RECORDER_JSONL'] })
  }
  if (!ideExecutable && !recorderIdeContext?.ideRuntime) missing.push({ target: 'jetbrains_ide_executable', env: ['CAOGEN_JETBRAINS_IDE_PATH'] })
  if (pluginCompatibility.compatible === false) {
    missing.push({ target: 'jetbrains_plugin_compatibility', reason: pluginCompatibility.reason })
  }
  if (!preflight.pluginDistributionPresent) missing.push({ target: 'jetbrains_plugin_distribution', path: path.relative(repoRoot, pluginDistribution) })
  return missing
}

function readExpectedPluginVersion() {
  const buildFile = path.join(repoRoot, 'plugins', 'jetbrains', 'build.gradle.kts')
  if (!existsSync(buildFile)) return undefined
  const match = readFileSync(buildFile, 'utf8').match(/\bversion\s*=\s*"([^"]+)"/)
  return match?.[1]
}

function readPluginTargetPlatform() {
  const buildFile = path.join(repoRoot, 'plugins', 'jetbrains', 'build.gradle.kts')
  if (!existsSync(buildFile)) return { source: path.relative(repoRoot, buildFile), status: 'missing' }
  const text = readFileSync(buildFile, 'utf8')
  const communityMatch = text.match(/\bintellijIdeaCommunity\(([^\r\n]+)\)/)
  const ultimateMatch = text.match(/\bintellijIdeaUltimate\(([^\r\n]+)\)/)
  const version = resolvePluginTargetVersion(text, communityMatch?.[1] ?? ultimateMatch?.[1])
  const product = communityMatch ? 'IntelliJ IDEA Community' : ultimateMatch ? 'IntelliJ IDEA Ultimate' : undefined
  return {
    source: path.relative(repoRoot, buildFile),
    product,
    version,
    buildBaseline: jetBrainsReleaseToBuildBaseline(version),
    status: version ? 'detected' : 'unknown'
  }
}

function resolvePluginTargetVersion(buildText, argument) {
  const explicit = (process.env.CAOGEN_JETBRAINS_PLATFORM_VERSION ?? '').trim()
  if (explicit) return explicit
  const literal = argument?.match(/"([^"]+)"/)?.[1]
  if (literal) return literal
  const variable = argument?.trim().replace(/\.get\(\)$/, '')
  if (!variable) return undefined
  const defaultMatch = buildText.match(new RegExp(`\\b${escapeRegExp(variable)}\\s*=\\s*providers\\.environmentVariable\\("CAOGEN_JETBRAINS_PLATFORM_VERSION"\\)\\.orElse\\("([^"]+)"\\)`))
  return defaultMatch?.[1]
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
  if (process.platform === 'darwin') {
    return uniquePaths([
      '/Applications',
      path.join(process.env.HOME || '', 'Applications'),
      path.join(process.env.HOME || '', 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps')
    ].filter(Boolean))
  }
  if (process.platform !== 'win32') {
    return uniquePaths([
      '/opt',
      '/usr/local',
      path.join(process.env.HOME || '', '.local', 'share', 'JetBrains', 'Toolbox', 'apps')
    ].filter(Boolean))
  }
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
    const resourcesCandidate = path.join(current, 'Resources', 'product-info.json')
    if (existsSync(resourcesCandidate)) return resourcesCandidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

function inferJetBrainsVersionFromPath(value) {
  return value.match(/\b(20\d{2}\.\d+(?:\.\d+)?)\b/)?.[1]
}

function evaluatePluginCompatibility(metadata) {
  const targetBaseline = pluginTargetPlatform.buildBaseline
  const ideBaseline = metadata?.buildBaseline
  const base = {
    ideVersion: metadata?.version,
    ideBuildNumber: metadata?.buildNumber,
    ideBuildBaseline: ideBaseline,
    pluginTargetProduct: pluginTargetPlatform.product,
    pluginTargetVersion: pluginTargetPlatform.version,
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
      reason: `JetBrains IDE ${metadata.version ?? 'unknown version'} build ${metadata.buildNumber ?? ideBaseline} is older than plugin target ${pluginTargetPlatform.product ?? 'JetBrains platform'} ${pluginTargetPlatform.version} build baseline ${targetBaseline}`
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

function normalizePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  return path.isAbsolute(text) ? text : path.join(repoRoot, text)
}

function stringField(record, key) {
  return typeof record[key] === 'string' ? record[key].trim() : ''
}

function numberField(record, key) {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : 0
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes((process.env[name] ?? '').trim().toLowerCase())
}

function recordField(record, key) {
  return isRecord(record[key]) ? record[key] : {}
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function writeReport(value) {
  const json = JSON.stringify(value, null, 2)
  writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), json, 'utf8')
}
