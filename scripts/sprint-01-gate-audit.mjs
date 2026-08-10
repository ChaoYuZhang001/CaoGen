#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const planPath = path.join(repoRoot, 'docs', 'SPRINT-01-GATE-BASELINE.md')
const masterPlanPath = path.join(repoRoot, 'docs', 'COMPETITOR-REPLACEMENT-MASTER-PLAN.md')
const requirementsPath = path.join(repoRoot, 'docs', 'PRODUCT-REQUIREMENTS.md')
const mainEntryPath = path.join(repoRoot, 'src', 'main', 'index.ts')
const ownerRetestPath = path.join(repoRoot, 'docs', 'OWNER-FIX-000-RETEST.md')
const portableOwnerGuidePath = path.join(repoRoot, 'docs', 'OWNER-FIX-000-PORTABLE-KIT.md')
const d0DescriptorPath = path.join(repoRoot, 'docs', 'FIX-000-D0.json')
const statusPath = path.join(repoRoot, 'STATUS.md')
const plan = readFileSync(planPath, 'utf8')
const masterPlan = readFileSync(masterPlanPath, 'utf8')
const requirements = readFileSync(requirementsPath, 'utf8')
const mainEntry = readFileSync(mainEntryPath, 'utf8')
const ownerRetest = readFileSync(ownerRetestPath, 'utf8')
const portableOwnerGuide = readFileSync(portableOwnerGuidePath, 'utf8')
const projectStatus = readFileSync(statusPath, 'utf8')
let d0Descriptor
try { d0Descriptor = JSON.parse(readFileSync(d0DescriptorPath, 'utf8')) } catch { d0Descriptor = undefined }
const checks = []

const documentedD0 = parseDocumentedD0(plan)
check('Sprint baseline declares an exact FIX-000 D0 artifact', () => documentedD0 !== undefined, documentedD0 || { status: 'missing_or_invalid' })
check('structured FIX-000 D0 descriptor matches the Sprint baseline', () => documentedD0 !== undefined &&
  d0Descriptor?.schemaVersion === 1 &&
  d0Descriptor?.gateId === 'fix_000_d0' &&
  d0Descriptor?.relativePath === documentedD0.path &&
  d0Descriptor?.size === documentedD0.size &&
  d0Descriptor?.sha256 === documentedD0.sha256 &&
  d0Descriptor?.artifactSetSha256 === documentedD0.artifactSetSha256 &&
  d0Descriptor?.platform === 'windows-x64' &&
  d0Descriptor?.distributionChannel === 'unsigned_preview')
check(
  'master plan and STATUS share the current D0 digests',
  () => documentedD0 !== undefined &&
    masterPlan.includes(documentedD0.sha256) &&
    masterPlan.includes(documentedD0.artifactSetSha256) &&
    projectStatus.includes(documentedD0.sha256) &&
    projectStatus.includes(documentedD0.artifactSetSha256)
)
check(
  'Owner FIX-000 retest is SHA-bound and covers cancel/confirm uninstall outcomes',
  () => documentedD0 !== undefined &&
    ownerRetest.includes(documentedD0.sha256) &&
    ownerRetest.includes(documentedD0.artifactSetSha256) &&
    ownerRetest.includes('choose the default **No**') &&
    ownerRetest.includes('choose **Yes**') &&
    ownerRetest.includes('deleteAppDataOnUninstall=false')
)
check('portable Owner guide is a non-development exact-D0 entry', () => documentedD0 !== undefined &&
  portableOwnerGuide.includes(documentedD0.sha256) &&
  portableOwnerGuide.includes(documentedD0.artifactSetSha256) &&
  portableOwnerGuide.includes('RUN-FIX-000-PREFLIGHT.cmd') &&
  portableOwnerGuide.includes('RUN-FIX-000-PACKAGED-SMOKE.cmd') &&
  portableOwnerGuide.includes('RUN-FIX-000') &&
  !portableOwnerGuide.includes('npm run'))

const expectedExecutionOrder = ['PKG-000', 'OWNER-TEST-000', 'FIX-000', 'PKG-001', 'OWNER-RETEST-001']
const section5 = masterPlan.slice(masterPlan.indexOf('## 5.'), masterPlan.indexOf('## 6.'))
const section5Order = expectedExecutionOrder.map((item) => section5.indexOf(`\`${item}\``))
check(
  'Section 5 and STATUS preserve the mandatory package/Owner order',
  () => section5Order.every((position, index) => position >= 0 && (index === 0 || position > section5Order[index - 1])) &&
    projectStatus.includes(expectedExecutionOrder.join(' -> ')),
  { expectedExecutionOrder, section5Order }
)

const shellStartupIndex = mainEntry.indexOf('ensureApplicationShell()')
const providerRecoveryIndex = mainEntry.indexOf('reconcileProviderProfileOperations()', shellStartupIndex)
const providerRecoveryCatch = mainEntry.match(
  /try\s*{\s*reconcileProviderProfileOperations\(\)\s*}\s*catch\s*\(error\)\s*{([\s\S]*?)}\s*try\s*{\s*await recoverLearningMaterializationAtStartup/
)
check(
  'startup shell precedes Provider Profile recovery and recovery failure keeps the shell alive',
  () => shellStartupIndex >= 0 && providerRecoveryIndex > shellStartupIndex &&
    providerRecoveryCatch?.[1].includes('console.error') === true &&
    !providerRecoveryCatch[1].includes('app.quit') &&
    !providerRecoveryCatch[1].includes('return'),
  { shellStartupIndex, providerRecoveryIndex, recoveryCatchMatched: providerRecoveryCatch !== null }
)

check('requirements contain exactly 64 P0 and 38 P1 rows', () => {
  const rows = [...requirements.matchAll(/^\|\s*([A-Z][A-Z0-9-]+)\s*\|\s*(P[01])\s*\|/gm)]
  return rows.length === 102 && rows.filter((row) => row[2] === 'P0').length === 64 && rows.filter((row) => row[2] === 'P1').length === 38
})

const requirementRows = [...requirements.matchAll(/^\|\s*([A-Z][A-Z0-9-]+)\s*\|\s*(P[01])\s*\|/gm)]
  .map((row) => `${row[1]}|${row[2]}`)
const mappedRows = [...plan.matchAll(/^\|\s*([A-Z][A-Z0-9-]+)\s*\|\s*(P[01])\s*\|\s*([^|]+)\|/gm)]
  .map((row) => `${row[1]}|${row[2]}`)
const duplicates = mappedRows.filter((row, index) => mappedRows.indexOf(row) !== index)
const missing = requirementRows.filter((row) => !mappedRows.includes(row))
const extra = mappedRows.filter((row) => !requirementRows.includes(row))
check('P0/P1 mapping is exhaustive and unique', () => mappedRows.length === 102 && duplicates.length === 0 && missing.length === 0 && extra.length === 0, {
  mapped: mappedRows.length,
  duplicates: [...new Set(duplicates)],
  missing,
  extra: [...new Set(extra)]
})

const workflows = [...plan.matchAll(/^\|\s*GW-(\d+)\s*\|/gm)].map((row) => Number(row[1]))
check('GATE-002 defines 20 golden workflows', () => workflows.length === 20 && workflows.every((value, index) => value === index + 1))
for (const heading of ['## GATE-001:', '## GATE-002:', '## GATE-003:', '## ARCH-001:', '## VIS-001:', '## QA-001:']) {
  check(`${heading} section exists`, () => plan.includes(heading))
}

const auditPath = path.join(repoRoot, 'test-results', 'windows-preview-audit', 'latest-x64.json')
check('latest D0 package audit exists and passed', () => {
  if (!existsSync(auditPath) || !documentedD0) return false
  const report = JSON.parse(readFileSync(auditPath, 'utf8'))
  const artifactEntries = Object.values(report.artifactSet?.files || {})
  const artifactEntry = artifactEntries.find((entry) =>
    entry?.size === documentedD0.size && entry?.sha256 === documentedD0.sha256)
  return report.status === 'passed'
    && report.allowDirtyPreview === true
    && report.distributionChannel === 'unsigned_preview'
    && report.artifactSetSha256 === documentedD0.artifactSetSha256
    && artifactEntry?.size === documentedD0.size
    && artifactEntry?.sha256 === documentedD0.sha256
}, documentedD0)

check('documented FIX-000 D0 artifact exists and matches SHA-256', () => {
  if (!documentedD0) return false
  const artifactPath = path.join(repoRoot, documentedD0.path)
  if (!existsSync(artifactPath) || statSync(artifactPath).size !== documentedD0.size) return false
  return createHash('sha256').update(readFileSync(artifactPath)).digest('hex') === documentedD0.sha256
})

const ownerKitBuildPath = path.join(repoRoot, 'test-results', 'fix-000-owner-kit', 'latest.json')
let ownerKitBuild
if (existsSync(ownerKitBuildPath)) {
  try { ownerKitBuild = JSON.parse(readFileSync(ownerKitBuildPath, 'utf8')) } catch { ownerKitBuild = undefined }
}
check('FIX-000 portable Owner kit is built and SHA-bound to D0', () => {
  if (!documentedD0 || ownerKitBuild?.status !== 'passed' || ownerKitBuild?.required !== true) return false
  if (
    ownerKitBuild?.evidenceClass !== 'fix_000_owner_portable_kit_build' ||
    ownerKitBuild?.artifact?.size !== documentedD0.size ||
    ownerKitBuild?.artifact?.sha256 !== documentedD0.sha256 ||
    ownerKitBuild?.artifactSetSha256 !== documentedD0.artifactSetSha256 ||
    ownerKitBuild?.manifest?.fileCount !== 10 ||
    !/^[a-f0-9]{64}$/.test(ownerKitBuild?.manifest?.sha256 || '') ||
    !/^[a-f0-9]{64}$/.test(ownerKitBuild?.manifest?.contentSetSha256 || '') ||
    !Number.isInteger(ownerKitBuild?.zip?.size) ||
    ownerKitBuild.zip.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(ownerKitBuild?.zip?.sha256 || '') ||
    !Array.isArray(ownerKitBuild?.failures) ||
    ownerKitBuild.failures.length !== 0
  ) return false
  if (
    !plan.includes(ownerKitBuild.zip.sha256) ||
    !masterPlan.includes(ownerKitBuild.zip.sha256) ||
    !ownerRetest.includes(ownerKitBuild.zip.sha256)
  ) return false
  const outputDir = path.join(repoRoot, ownerKitBuild.outputDir || '')
  const kitDir = path.join(outputDir, 'CaoGen-FIX-000-Owner-Kit')
  const zipPath = path.join(outputDir, 'CaoGen-FIX-000-Owner-Kit.zip')
  const relative = path.relative(repoRoot, zipPath)
  if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(zipPath) || statSync(zipPath).size !== ownerKitBuild.zip.size) return false
  const manifestPath = path.join(kitDir, 'MANIFEST.json')
  if (!existsSync(manifestPath) || createHash('sha256').update(readFileSync(manifestPath)).digest('hex') !== ownerKitBuild.manifest.sha256) return false
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const expectedPayload = [
    'CaoGen-0.1.8-windows-x64-unsigned-preview.exe',
    'FIX-000-D0.json',
    'FIX-000-PACKAGED-SMOKE.mjs',
    'OWNER-FIX-000-RESULT.template.json',
    'RUN-FIX-000-ASSISTED-INSTALL.cmd',
    'RUN-FIX-000-PACKAGED-SMOKE.cmd',
    'RUN-FIX-000-PREFLIGHT.cmd',
    'START-HERE.md',
    'runtime/LICENSE.node.txt',
    'runtime/node.exe'
  ]
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.evidenceClass !== 'fix_000_owner_portable_kit' ||
    manifest?.artifact?.size !== documentedD0.size ||
    manifest?.artifact?.sha256 !== documentedD0.sha256 ||
    manifest?.artifact?.artifactSetSha256 !== documentedD0.artifactSetSha256 ||
    !Array.isArray(manifest?.files) ||
    manifest.files.length !== expectedPayload.length ||
    expectedPayload.some((item) => !manifest.files.some((entry) => entry?.path === item))
  ) return false
  for (const entry of manifest.files) {
    if (!expectedPayload.includes(entry.path) || !Number.isInteger(entry.size) || entry.size <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) return false
    const payloadPath = path.join(kitDir, entry.path)
    const payloadRelative = path.relative(kitDir, payloadPath)
    if (payloadRelative.startsWith('..') || path.isAbsolute(payloadRelative) || !existsSync(payloadPath) || statSync(payloadPath).size !== entry.size) return false
    if (createHash('sha256').update(readFileSync(payloadPath)).digest('hex') !== entry.sha256) return false
  }
  if (createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== ownerKitBuild.manifest.contentSetSha256) return false
  const runner = readFileSync(path.join(kitDir, 'RUN-FIX-000-PACKAGED-SMOKE.cmd'), 'utf8')
  if (!runner.includes('set "CAOGEN_FIX000_CONFIRM="') || !runner.includes('if not "%CAOGEN_FIX000_CONFIRM%"=="RUN-FIX-000"')) return false
  const assistedRunner = readFileSync(path.join(kitDir, 'RUN-FIX-000-ASSISTED-INSTALL.cmd'), 'utf8')
  if (!assistedRunner.includes('--assisted-install-only') ||
      !assistedRunner.includes('--owner-authorized') ||
      !assistedRunner.includes('--planned-install-dir')) return false
  return createHash('sha256').update(readFileSync(zipPath)).digest('hex') === ownerKitBuild.zip.sha256
}, ownerKitBuild
  ? {
      status: ownerKitBuild.status,
      artifact: ownerKitBuild.artifact,
      artifactSetSha256: ownerKitBuild.artifactSetSha256,
      manifest: ownerKitBuild.manifest,
      zip: ownerKitBuild.zip
    }
  : { status: 'missing_or_invalid' })

const smokePath = path.join(repoRoot, 'test-results', 'packaged-app-smoke', 'latest-windows-x64-preview.json')
let smokeReport
if (existsSync(smokePath)) {
  try { smokeReport = JSON.parse(readFileSync(smokePath, 'utf8')) } catch { smokeReport = undefined }
}
const portableSmokeAuditPath = path.join(repoRoot, 'test-results', 'fix-000-portable-smoke-audit', 'latest.json')
let portableSmokeAudit
if (existsSync(portableSmokeAuditPath)) {
  try { portableSmokeAudit = JSON.parse(readFileSync(portableSmokeAuditPath, 'utf8')) } catch { portableSmokeAudit = undefined }
}
const repositorySmokePassed = documentedD0 !== undefined &&
  smokeReport?.status === 'passed' &&
  smokeReport?.mode === 'unsigned-preview' &&
  smokeReport?.distributionChannel === 'unsigned_preview' &&
  smokeReport?.allowDirtyPreview === true &&
  smokeReport?.artifactSetSha256 === documentedD0.artifactSetSha256 &&
  smokeReport?.releaseAudit?.status === 'passed' &&
  smokeReport?.installation?.status === 'passed' &&
  smokeReport?.installation?.sourceArtifact?.replaceAll('\\', '/') === documentedD0.path &&
  smokeReport?.installation?.uninstall?.status === 'passed' &&
  smokeReport?.installation?.uninstall?.installRootRemoved === true &&
  Array.isArray(smokeReport?.installation?.uninstall?.residualInstallations) &&
  smokeReport.installation.uninstall.residualInstallations.length === 0 &&
  smokeReport?.target?.type === 'page' &&
  smokeReport?.target?.title === 'CaoGen' &&
  smokeReport?.target?.rootChildCount > 0 &&
  smokeReport?.target?.bodyTextLength > 0 &&
  smokeReport?.target?.preloadReady === true &&
  smokeReport?.cleanup?.status === 'passed'
const portableSmokePassed = documentedD0 !== undefined &&
  portableSmokeAudit?.status === 'passed' &&
  portableSmokeAudit?.evidenceClass === 'fix_000_portable_installed_smoke_audit' &&
  portableSmokeAudit?.required === true &&
  /^[a-f0-9]{64}$/.test(portableSmokeAudit?.recordSha256 || '') &&
  portableSmokeAudit?.artifactBinding?.size === documentedD0.size &&
  portableSmokeAudit?.artifactBinding?.sha256 === documentedD0.sha256 &&
  portableSmokeAudit?.artifactBinding?.artifactSetSha256 === documentedD0.artifactSetSha256 &&
  portableSmokeAudit?.summary?.sourceStatus === 'passed' &&
  portableSmokeAudit?.summary?.preflightCheckCount === 13 &&
  portableSmokeAudit?.summary?.installationStatus === 'passed' &&
  portableSmokeAudit?.summary?.rendererStatus === 'passed' &&
  portableSmokeAudit?.summary?.timeToInteractiveMs > 0 &&
  portableSmokeAudit?.summary?.uninstallStatus === 'passed' &&
  portableSmokeAudit?.summary?.cleanupStatus === 'passed' &&
  portableSmokeAudit?.summary?.screenshot?.size > 0 &&
  /^[a-f0-9]{64}$/.test(portableSmokeAudit?.summary?.screenshot?.sha256 || '') &&
  Array.isArray(portableSmokeAudit?.failures) &&
  portableSmokeAudit.failures.length === 0
check(
  'D0 isolated installed smoke passed through a SHA-bound repository or portable audit',
  () => repositorySmokePassed || portableSmokePassed,
  {
    repository: smokeReport
      ? {
          status: smokeReport.status,
          installationStatus: smokeReport.installation?.status || 'unknown',
          blocker: smokeReport.installation?.failure || smokeReport.failure || null
        }
      : { status: 'missing_or_invalid' },
    portable: portableSmokeAudit
      ? {
          status: portableSmokeAudit.status,
          required: portableSmokeAudit.required,
          sourceStatus: portableSmokeAudit.summary?.sourceStatus || null,
          failureCount: Array.isArray(portableSmokeAudit.failures) ? portableSmokeAudit.failures.length : null
        }
      : { status: 'missing_or_invalid' }
  }
)

const ownerAuditPath = path.join(repoRoot, 'test-results', 'fix-000-owner-retest-audit', 'latest.json')
let ownerAuditReport
if (existsSync(ownerAuditPath)) {
  try { ownerAuditReport = JSON.parse(readFileSync(ownerAuditPath, 'utf8')) } catch { ownerAuditReport = undefined }
}
const expectedOwnerSteps = [
  'artifact_preflight',
  'install',
  'first_launch',
  'provider',
  'project',
  'read_only_task',
  'studio_recruitment',
  'task_status',
  'office_artifact',
  'restart',
  'uninstall_cancel',
  'uninstall_confirm'
]
const ownerAuditSummary = ownerAuditReport
  ? {
      status: ownerAuditReport.status,
      evidenceClass: ownerAuditReport.evidenceClass,
      required: ownerAuditReport.required,
      observation: ownerAuditReport.observation,
      recordSha256: ownerAuditReport.recordSha256,
      artifactBinding: ownerAuditReport.artifactBinding,
      result: ownerAuditReport.summary?.result || null,
      durationMinutes: ownerAuditReport.summary?.durationMinutes ?? null,
      portableSmokeRecordSha256: ownerAuditReport.summary?.portableSmokeRecordSha256 || null,
      stepCounts: ownerAuditReport.summary?.stepCounts || null,
      evidenceCount: Array.isArray(ownerAuditReport.summary?.evidence) ? ownerAuditReport.summary.evidence.length : 0,
      failureCount: Array.isArray(ownerAuditReport.failures) ? ownerAuditReport.failures.length : null
    }
  : { status: 'missing_or_invalid' }
check(
  'FIX-000 installed Owner retest passed against the exact D0',
  () => documentedD0 !== undefined &&
    ownerAuditReport?.status === 'passed' &&
    ownerAuditReport?.evidenceClass === 'installed_owner_retest' &&
    ownerAuditReport?.required === true &&
    ownerAuditReport?.observation === false &&
    /^[a-f0-9]{64}$/.test(ownerAuditReport?.recordSha256 || '') &&
    ownerAuditReport?.artifactBinding?.size === documentedD0.size &&
    ownerAuditReport?.artifactBinding?.sha256 === documentedD0.sha256 &&
    ownerAuditReport?.artifactBinding?.artifactSetSha256 === documentedD0.artifactSetSha256 &&
    ownerAuditReport?.summary?.result === 'passed' &&
    portableSmokePassed &&
    ownerAuditReport?.summary?.portableSmokeRecordSha256 === portableSmokeAudit?.recordSha256 &&
    Number.isFinite(ownerAuditReport?.summary?.durationMinutes) &&
    ownerAuditReport.summary.durationMinutes > 0 &&
    ownerAuditReport.summary.durationMinutes <= 60 &&
    ownerAuditReport?.summary?.stepCounts?.passed === expectedOwnerSteps.length &&
    ownerAuditReport?.summary?.stepCounts?.failed === 0 &&
    ownerAuditReport?.summary?.stepCounts?.not_run === 0 &&
    Array.isArray(ownerAuditReport?.summary?.evidence) &&
    ownerAuditReport.summary.evidence.length === expectedOwnerSteps.length &&
    ownerAuditReport.summary.evidence.every((item, index) =>
      item?.role === expectedOwnerSteps[index] &&
      Number.isInteger(item?.size) &&
      item.size > 0 &&
      /^[a-f0-9]{64}$/.test(item?.sha256 || '')
    ) &&
    Array.isArray(ownerAuditReport?.schemaFailures) &&
    ownerAuditReport.schemaFailures.length === 0 &&
    Array.isArray(ownerAuditReport?.gateFailures) &&
    ownerAuditReport.gateFailures.length === 0,
  ownerAuditSummary
)

const unpackedDiagnosticPath = path.join(repoRoot, 'test-results', 'windows-unpacked-renderer-smoke', 'latest.json')
let unpackedDiagnostic
if (existsSync(unpackedDiagnosticPath)) {
  try { unpackedDiagnostic = JSON.parse(readFileSync(unpackedDiagnosticPath, 'utf8')) } catch { unpackedDiagnostic = undefined }
}
const unpackedDiagnosticSummary = unpackedDiagnostic
  ? {
      status: unpackedDiagnostic.status,
      evidenceClass: unpackedDiagnostic.evidenceClass || 'unknown',
      closesInstalledPackageFindings: unpackedDiagnostic.closesInstalledPackageFindings === true,
      launches: Array.isArray(unpackedDiagnostic.launches)
        ? unpackedDiagnostic.launches.map((launch) => ({
            label: launch.label,
            status: launch.status,
            timeToInteractiveMs: launch.timeToInteractiveMs
          }))
        : []
    }
  : { status: 'missing_or_invalid' }

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const reportRoot = path.join(repoRoot, 'test-results', 'sprint-01-gate-audit')
const reportDir = path.join(reportRoot, runId)
const failed = checks.filter((item) => item.status === 'failed')
const report = {
  status: failed.length === 0 ? 'passed' : 'failed',
  runId,
  reportDir: path.relative(repoRoot, reportDir),
  checks,
  failureCount: failed.length,
  developmentDiagnostics: {
    unpackedRenderer: unpackedDiagnosticSummary,
    policy: 'Diagnostic only. This field never satisfies or replaces the installed-package smoke check.'
  },
  redactionPolicy: 'Only repository paths and gate status are emitted; credentials and private test values are not read.'
}
mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'passed') process.exitCode = 1

function check(name, predicate, detail) {
  let passed = false
  try { passed = Boolean(predicate()) } catch (error) { detail = error instanceof Error ? error.message : String(error) }
  checks.push({ name, status: passed ? 'passed' : 'failed', ...(detail ? { detail } : {}) })
}

function parseDocumentedD0(markdown) {
  const match = markdown.match(/The current FIX-000 D0 artifact is `([^`]+)`, size ([\d,]+) bytes, SHA-256 `([a-f0-9]{64})`, and artifact-set SHA-256 `([a-f0-9]{64})`\./)
  if (!match) return undefined
  return {
    path: match[1],
    size: Number(match[2].replaceAll(',', '')),
    sha256: match[3],
    artifactSetSha256: match[4]
  }
}
