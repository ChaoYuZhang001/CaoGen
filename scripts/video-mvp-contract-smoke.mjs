#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'video-mvp-contract')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')

const sourceFiles = {
  runtime: 'src/main/media/media-runtime.ts',
  effectTarget: 'src/main/media/media-job-effect-target.ts',
  store: 'src/main/media/media-store.ts',
  scheduler: 'src/main/media/media-reconciliation-scheduler.ts',
  ipc: 'src/main/ipc/media-handlers.ts',
  shared: 'src/shared/media-types.ts',
  panel: 'src/renderer/src/components/studio/VideoStudioPanel.tsx',
  golden: 'scripts/video-studio-golden-e2e.mjs'
}

const source = Object.fromEntries(Object.entries(sourceFiles).map(([key, relativePath]) => [
  key,
  readSource(relativePath)
]))
const acceptanceContract = JSON.parse(readFileSync(
  path.join(repoRoot, 'scripts', 'contracts', 'product-1.0-acceptance-contract.json'),
  'utf8'
))

const checks = []
const gaps = []

function requireContract(condition, message) {
  assert.equal(condition, true, message)
  checks.push(message)
}

function requireMarker(name, key, pattern) {
  requireContract(pattern.test(source[key]), `${name} is present in ${sourceFiles[key]}`)
}

function openGap(id, title, evidence) {
  gaps.push({ id, status: 'open', title, evidence })
}

const videoScope = acceptanceContract.additionalReleaseBlockingScope?.items?.find((item) => item.id === 'VID-MVP-001')
requireContract(Boolean(videoScope), 'VID-MVP-001 is registered in the private 1.0 acceptance contract')
requireContract(
  JSON.stringify(videoScope?.pipeline) === JSON.stringify([
    'script_or_outline',
    'editable_storyboard',
    'material_import_and_version',
    'decodable_non_empty_preview',
    'revision_and_reorder',
    'traceable_export'
  ]),
  'VID-MVP-001 pipeline includes the traceable export stage'
)
requireContract(
  JSON.stringify(videoScope?.requiredGates) === JSON.stringify([
    'video_script_storyboard_edit',
    'video_material_version_binding',
    'video_preview_decode_non_empty',
    'video_revision_restore',
    'video_export_artifact_evidence_acceptance',
    'video_failure_cancel_restart_unknown_result'
  ]),
  'VID-MVP-001 registers export and recovery gates'
)

requireMarker('Local composition entrypoint', 'runtime', /composeMediaProduction\s*\(/)
requireMarker('Local composition registers the final output', 'runtime', /persistLocalMediaArtifact\s*\(/)
requireMarker('Canonical Artifact producer is used for media', 'runtime', /registerCanonicalProducedArtifact\s*\(/)
requireMarker('Composition manifest is persisted', 'runtime', /persistCompositionManifest\s*\(/)
requireMarker('Composition Artifact graph is persisted', 'runtime', /persistCompositionGraph\s*\(/)
requireMarker('Composition settles the canonical operation', 'runtime', /settleCanonicalSystemOperation\s*\(/)
requireMarker('Media operation target validates compose and unknown-result states', 'effectTarget', /compose[\s\S]*waiting_reconciliation/)
requireMarker('Media reconciliation verifies Artifact/Evidence/Acceptance', 'effectTarget', /reconcileLocalMediaArtifact[\s\S]*queryWorkflowEvidence[\s\S]*findWorkflowAcceptance/)
requireMarker('Media Store records cancellation and unknown-result transitions', 'store', /cancelled[\s\S]*waiting_reconciliation[\s\S]*assertMediaTransition/)
requireMarker('Media Store schedules unknown remote results', 'store', /scheduleMediaReconciliation\s*\(/)
requireMarker('Scheduler resumes downloads and due reconciliation', 'scheduler', /listRecoverableMediaDownloadJobIds[\s\S]*listDueMediaReconciliationJobIds[\s\S]*reconcileMediaJob/)
requireMarker('Media IPC exposes compose, cancel and reconcile operations', 'ipc', /rawAction === 'compose'[\s\S]*rawAction === 'job:reconcile'[\s\S]*rawAction === 'job:cancel'/)
requireMarker('Video Studio exposes local composition and adoption', 'panel', /data-video-compose-preview[\s\S]*data-video-adopt-preview/)
requireMarker('Video Studio renders explicit job recovery states', 'panel', /waiting_reconciliation[\s\S]*reconcile\([\s\S]*cancel\(/)
requireMarker('Golden E2E verifies a decodable, non-black preview', 'golden', /videoWidth[\s\S]*nonBlackRatio/)
requireMarker('Golden E2E verifies a revision creates another preview', 'golden', /structureRevisions\.length[\s\S]*local composition asset/)

const hasMediaExportAction = /rawAction\s*===\s*['"](?:job:)?export['"]/.test(source.ipc)
const hasMediaExportPreload = /exportMedia|exportVideo|exportMediaProduction/.test(readSource('src/preload/media.ts'))
const hasVideoExportUi = /data-video-export|exportVideo|exportMedia/.test(source.panel)
const hasGoldenExportCoverage = /data-video-export|exportMedia|exportVideo|download.*(?:mp4|video)/i.test(source.golden)
const hasGoldenFailureCoverage = /mockScenario|unknown_result|waiting_reconciliation|job:cancel|job:reconcile/.test(source.golden)
const hasGoldenRestartCoverage = /restart|fresh process|relaunch|SIGKILL/i.test(source.golden)

if (!hasMediaExportAction || !hasMediaExportPreload || !hasVideoExportUi || !hasGoldenExportCoverage) {
  openGap(
    'VID-MVP-001.export',
    '独立视频导出动作及其可读回证据尚未闭环',
    'compose currently creates a managed local preview Artifact, but media IPC/preload/UI and the Golden E2E do not expose or verify an explicit export-to-file operation.'
  )
}
if (!hasGoldenFailureCoverage || !hasGoldenRestartCoverage) {
  openGap(
    'VID-MVP-001.recovery',
    'Video Golden E2E 尚未覆盖失败、取消、重启和未知结果',
    'runtime/store/scheduler contain bounded states and reconciliation hooks, but the required UI evidence does not exercise each failure class or prove restart readback.'
  )
}

const report = {
  schemaVersion: 1,
  gate: 'test:video-mvp-contract',
  runId,
  status: 'contract_only',
  closure: gaps.length === 0 ? 'requires_runtime_and_human_evidence' : 'open',
  checks,
  gaps,
  observed: {
    hasMediaExportAction,
    hasMediaExportPreload,
    hasVideoExportUi,
    hasGoldenExportCoverage,
    hasGoldenFailureCoverage,
    hasGoldenRestartCoverage
  },
  sourceFiles: sourceFiles,
  explicitlyNotVerified: [
    'export-to-file bytes and a user-readable export location',
    'failure, cancellation, restart and unknown-result Video Golden task evidence',
    'real remote Media Provider quality, billing and latency',
    'five-user timed acceptance and clean release SHA binding'
  ]
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))

function readSource(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  return readFileSync(absolutePath, 'utf8')
}
