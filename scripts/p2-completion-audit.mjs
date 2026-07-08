#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const reportRoot = path.join(repoRoot, 'test-results', 'p2-completion-audit')
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const reportDir = path.join(reportRoot, runId)
const required = process.argv.includes('--required')

const STATUS = {
  proved: 'proved',
  missingExternal: 'missing_external',
  missingEvidence: 'missing_evidence',
  partial: 'partial'
}

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) {
    return { relativePath, exists: false, data: null, error: 'missing file' }
  }

  try {
    const data = JSON.parse(readFileSync(absolutePath, 'utf8'))
    return { relativePath, exists: true, data, error: null }
  } catch (error) {
    return {
      relativePath,
      exists: true,
      data: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function sourceExists(relativePath) {
  return existsSync(path.join(repoRoot, relativePath))
}

function getResult(report, name) {
  const results = Array.isArray(report?.data?.results) ? report.data.results : []
  return results.find((item) => item?.name === name) ?? null
}

function evidenceStatus(readResult) {
  if (!readResult.exists) return 'missing'
  if (readResult.error) return 'invalid_json'
  return readResult.data?.status ?? 'unknown'
}

function hasStdoutMarkers(result, markers) {
  const text = typeof result?.stdoutTail === 'string' ? result.stdoutTail : ''
  return markers.every((marker) => text.includes(marker))
}

function hasAllSourceFiles(files) {
  return files.every((file) => sourceExists(file))
}

function passed(readResult) {
  return !readResult.error && (readResult.data?.status === 'passed' || readResult.data?.status === 'completed')
}

function hasPrototypeOnlyLimitations(readResult) {
  return Array.isArray(readResult.data?.prototypeOnlyLimitations) && readResult.data.prototypeOnlyLimitations.length > 0
}

function strictVscodeGuiEvidencePassed(readResult) {
  return (
    passed(readResult) &&
    readResult.data?.nativeStrictCreateMode === true &&
    readResult.data?.strictEditorInputE2E === true &&
    readResult.data?.terminalCommandE2E === true &&
    readResult.data?.markerExecutionMode === 'vscode-terminal' &&
    !hasPrototypeOnlyLimitations(readResult) &&
    Number(readResult.data?.sourceChars ?? 0) > 0 &&
    Number(readResult.data?.markerChars ?? 0) > 0
  )
}

function aggregatePassed(result) {
  return result?.status === 'pass' && result?.timedOut === false
}

function preflightReady(name) {
  const checks = Array.isArray(reports.p2ExternalPreflight.data?.checks) ? reports.p2ExternalPreflight.data.checks : []
  return checks.some((check) => check?.name === name && check?.status === 'ready')
}

function jetbrainsInteractionEvidencePassed(readResult) {
  const steps = readResult.data?.evidence?.steps
  const actionCounts = readResult.data?.evidence?.actionCounts
  return (
    readResult.data?.status === 'passed' &&
    Array.isArray(readResult.data?.failures) &&
    readResult.data.failures.length === 0 &&
    Array.isArray(readResult.data?.missingConfiguration) &&
    readResult.data.missingConfiguration.length === 0 &&
    steps?.installedPlugin === true &&
    steps?.connectCreateSession === true &&
    steps?.sendChatMessage === true &&
    steps?.sendSelection === true &&
    steps?.requestSelectionEdit === true &&
    steps?.previewSelectionDiff === true &&
    steps?.applySelectionEdit === true &&
    steps?.nativeUndoVerified === true &&
    steps?.toggleRealtimeSync === true &&
    steps?.documentSyncObserved === true &&
    steps?.showEvents === true &&
    steps?.openDesktop === true &&
    Number(actionCounts?.nativeUndoCount ?? 0) >= 1 &&
    Number(actionCounts?.openDesktopCount ?? 0) >= 1
  )
}

function buildRequirement(id, title, status, evidence, notes = []) {
  return { id, title, status, evidence, notes }
}

const reports = {
  p2Required: readJson('test-results/p2-required/latest.json'),
  p2ExternalPreflight: readJson('test-results/p2-external-preflight/latest.json'),
  p2ExternalPack: readJson('test-results/p2-external-pack/latest.json'),
  guiPermission: readJson('test-results/gui-permission/latest.json'),
  guiInputPreflight: readJson('test-results/gui-input-preflight/latest.json'),
  guiVscode: readJson('test-results/gui-vscode-e2e/latest.json'),
  guiCrossApp: readJson('test-results/gui-cross-app-e2e/latest.json'),
  idePlugins: readJson('test-results/ide-plugins/latest.json'),
  vscodeExtensionHost: readJson('test-results/vscode-extension-host/latest.json'),
  jetbrainsInteraction: readJson('test-results/jetbrains-ide-interaction/latest.json'),
  chinaRealNetwork: readJson('test-results/china-real-network/latest.json'),
  chinaToolCallParity: readJson('test-results/china-tool-call-parity/latest.json')
}

const p2DefaultSmoke = getResult(reports.p2Required, 'p2_default_smoke')
const guiDesktopRequired = getResult(reports.p2Required, 'gui_desktop_e2e_required')
const guiPermissionRequired = getResult(reports.p2Required, 'gui_permission_required')
const ideRequired =
  getResult(reports.p2Required, 'ide_required') ?? getResult(reports.p2Required, 'ide_build_and_vscode_required')
const ideRequiredName = ideRequired?.name ?? 'ide_required'
const jetbrainsRequired = getResult(reports.p2Required, 'jetbrains_ide_interaction_required')
const chinaNetworkRequired = getResult(reports.p2Required, 'china_real_network_required')
const chinaParityRequired = getResult(reports.p2Required, 'china_tool_call_parity_required')
const guiInputPreflightPresent = reports.guiInputPreflight.exists && !reports.guiInputPreflight.error

const guiEvidencePassed =
  aggregatePassed(guiDesktopRequired) &&
  guiInputPreflightPresent &&
  reports.guiInputPreflight.data?.status === 'passed' &&
  strictVscodeGuiEvidencePassed(reports.guiVscode) &&
  passed(reports.guiCrossApp) &&
  Number(reports.guiCrossApp.data?.noteChars ?? 0) > 0 &&
  Number(reports.guiCrossApp.data?.codeChars ?? 0) > 0

const guiPermissionEvidencePassed =
  aggregatePassed(guiPermissionRequired) &&
  reports.guiPermission.data?.status === 'passed' &&
  Array.isArray(reports.guiPermission.data?.checks) &&
  reports.guiPermission.data.checks.length >= 10 &&
  Array.isArray(reports.guiPermission.data?.failures) &&
  reports.guiPermission.data.failures.length === 0

const skillEvidencePassed =
  aggregatePassed(p2DefaultSmoke) &&
  hasStdoutMarkers(p2DefaultSmoke, [
    'skillLearner smoke ok',
    'autoSkillReview smoke ok',
    'skillOptimizer smoke ok',
    'skillInvocation smoke ok'
  ]) &&
  hasAllSourceFiles([
    'src/main/skill/skill-learner.ts',
    'src/main/skill/auto-skill-review.ts',
    'src/main/skill/skill-optimizer.ts',
    'src/main/skill/skill-invocation.ts'
  ])

const modelEvidencePassed =
  aggregatePassed(p2DefaultSmoke) &&
  hasStdoutMarkers(p2DefaultSmoke, [
    'model-router smoke ok',
    'modelOptimization smoke ok',
    'modelCrossValidation smoke ok'
  ]) &&
  hasAllSourceFiles([
    'src/main/model/model-router.ts',
    'src/main/model/model-profile.ts',
    'src/main/model/cross-validation.ts'
  ])

const chinaLocalEvidencePassed =
  aggregatePassed(p2DefaultSmoke) &&
  hasStdoutMarkers(p2DefaultSmoke, ['china ecosystem smoke ok', 'china model provider smoke ok']) &&
  hasAllSourceFiles([
    'scripts/china-ecosystem-smoke.mjs',
    'scripts/china-model-provider-smoke.mjs',
    'scripts/china-real-network-smoke.mjs',
    'scripts/china-tool-call-parity.mjs'
  ])

const chinaExternalPassed =
  aggregatePassed(chinaNetworkRequired) &&
  aggregatePassed(chinaParityRequired) &&
  reports.chinaRealNetwork.data?.status === 'passed' &&
  reports.chinaToolCallParity.data?.status === 'passed' &&
  preflightReady('china_real_network') &&
  preflightReady('china_tool_call_parity')

const ideLocalEvidencePassed =
  aggregatePassed(ideRequired) &&
  passed(reports.idePlugins) &&
  passed(reports.vscodeExtensionHost) &&
  reports.vscodeExtensionHost.data?.marker?.sidebarResolveMode === 'actual-view' &&
  reports.vscodeExtensionHost.data?.marker?.selectedCodeModificationChecked === true &&
  reports.vscodeExtensionHost.data?.marker?.oneClickDiffMergeChecked === true &&
  reports.vscodeExtensionHost.data?.marker?.realtimeSyncChecked === true &&
  reports.vscodeExtensionHost.data?.marker?.openDesktopChecked === true

const jetbrainsExternalPassed =
  aggregatePassed(jetbrainsRequired) &&
  jetbrainsInteractionEvidencePassed(reports.jetbrainsInteraction) &&
  (preflightReady('jetbrains_ide_interaction') || reports.jetbrainsInteraction.data?.recorderPathSource === 'latest-recorder-e2e')

const requirements = [
  buildRequirement(
    'P2-001',
    'GUI automation and permission boundary',
    guiEvidencePassed && guiPermissionEvidencePassed ? STATUS.proved : STATUS.missingEvidence,
    [
      { path: reports.guiVscode.relativePath, status: evidenceStatus(reports.guiVscode) },
      { path: reports.guiCrossApp.relativePath, status: evidenceStatus(reports.guiCrossApp) },
      { path: reports.guiInputPreflight.relativePath, status: evidenceStatus(reports.guiInputPreflight) },
      { path: reports.guiPermission.relativePath, status: evidenceStatus(reports.guiPermission) },
      { path: reports.p2Required.relativePath, check: 'gui_desktop_e2e_required', status: guiDesktopRequired?.status ?? 'missing' },
      { path: reports.p2Required.relativePath, check: 'gui_permission_required', status: guiPermissionRequired?.status ?? 'missing' }
    ],
    [
      'Permission boundary evidence is structured smoke based: default off, bypassPermissions ordering, scoped temporary grant token, and renderer settings are checked by scripts/gui-permission-smoke.mjs.',
      'P2-001 requires strict VS Code GUI evidence: native file create, editor input, integrated-terminal command marker, and no prototype-only filesystem fallback.',
      'Input preflight must pass for P2-001 because locked Windows desktop policies can make synthetic GUI input unprovable on this host.',
      'Cross-app GUI controller remains supporting evidence; OS-specific precision beyond Windows/VS Code evidence is prototype-only until tested per platform.'
    ]
  ),
  buildRequirement(
    'P2-002',
    'Skill learning, review, optimization, and invocation',
    skillEvidencePassed ? STATUS.proved : STATUS.missingEvidence,
    [{ path: reports.p2Required.relativePath, check: 'p2_default_smoke', status: p2DefaultSmoke?.status ?? 'missing' }]
  ),
  buildRequirement(
    'P2-003',
    'Model routing, optimization, and cross validation',
    modelEvidencePassed ? STATUS.proved : STATUS.missingEvidence,
    [{ path: reports.p2Required.relativePath, check: 'p2_default_smoke', status: p2DefaultSmoke?.status ?? 'missing' }]
  ),
  buildRequirement(
    'P2-004',
    'China ecosystem local support plus real network and tool-call parity',
    chinaExternalPassed ? STATUS.proved : chinaLocalEvidencePassed ? STATUS.missingExternal : STATUS.missingEvidence,
    [
      { path: reports.p2Required.relativePath, check: 'p2_default_smoke', status: p2DefaultSmoke?.status ?? 'missing' },
      { path: reports.chinaRealNetwork.relativePath, status: evidenceStatus(reports.chinaRealNetwork) },
      { path: reports.chinaToolCallParity.relativePath, status: evidenceStatus(reports.chinaToolCallParity) },
      { path: reports.p2ExternalPreflight.relativePath, status: evidenceStatus(reports.p2ExternalPreflight) }
    ],
    chinaExternalPassed
      ? []
      : ['Real China network and China provider tool-call parity need external credentials/provider JSON before this item can be closed.']
  ),
  buildRequirement(
    'P2-005',
    'IDE integrations: VS Code host workflow and JetBrains real IDE interaction',
    jetbrainsExternalPassed ? STATUS.proved : ideLocalEvidencePassed ? STATUS.missingExternal : STATUS.missingEvidence,
    [
      { path: reports.idePlugins.relativePath, status: evidenceStatus(reports.idePlugins) },
      { path: reports.vscodeExtensionHost.relativePath, status: evidenceStatus(reports.vscodeExtensionHost) },
      { path: reports.jetbrainsInteraction.relativePath, status: evidenceStatus(reports.jetbrainsInteraction) },
      { path: reports.p2Required.relativePath, check: ideRequiredName, status: ideRequired?.status ?? 'missing' }
    ],
    jetbrainsExternalPassed
      ? []
      : ['JetBrains build evidence exists, but P2-005 still needs VS Code host evidence plus compatible JetBrains interaction evidence JSON or recorder JSONL.']
  )
]

const failures = requirements
  .filter((requirement) => requirement.status !== STATUS.proved)
  .map((requirement) => `${requirement.id}: ${requirement.status}`)

const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  required,
  reportDir,
  runId,
  configurationGuide: 'docs/P2-EXTERNAL-REQUIRED.md',
  sourceReports: Object.fromEntries(
    Object.entries(reports).map(([name, reportFile]) => [
      name,
      { path: reportFile.relativePath, exists: reportFile.exists, status: evidenceStatus(reportFile), error: reportFile.error }
    ])
  ),
  requirements,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))

if (required && failures.length > 0) {
  process.exitCode = 1
}
