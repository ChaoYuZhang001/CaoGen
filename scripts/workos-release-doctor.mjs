#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { renderReleaseDoctorMarkdown } from './lib/release-doctor-render.mjs'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const refresh = process.argv.includes('--refresh') || process.env.CAOGEN_WORKOS_RELEASE_DOCTOR_REFRESH === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'workos-release-doctor')
const reportDir = path.join(reportRoot, runId)
const refreshResults = refresh ? refreshLocalEvidence() : []
const gitState = readGitState()

const reports = {
  deepTest: readJson('test-results/caogen-deep/latest.json'),
  p2Required: readJson('test-results/p2-required/latest.json'),
  p2Audit: readJson('test-results/p2-completion-audit/latest.json'),
  idePlugins: readJson('test-results/ide-plugins/latest.json'),
  vscodeExtensionHost: readJson('test-results/vscode-extension-host/latest.json'),
  jetbrainsInteraction: readJson('test-results/jetbrains-ide-interaction/latest.json'),
  guiPermission: readJson('test-results/gui-permission/latest.json'),
  guiInputPreflight: readJson('test-results/gui-input-preflight/latest.json'),
  guiVscode: readJson('test-results/gui-vscode-e2e/latest.json'),
  guiCrossApp: readJson('test-results/gui-cross-app-e2e/latest.json'),
  chinaRealNetwork: readJson('test-results/china-real-network/latest.json'),
  chinaToolCallParity: readJson('test-results/china-tool-call-parity/latest.json'),
  n1MigrationAudit: readJson('test-results/n1-migration-audit/latest.json'),
  product1SoakAudit: readJson('test-results/product-1.0-soak-audit/latest.json'),
  product1AcceptanceAudit: readJson('test-results/product-1.0-acceptance-audit/latest.json'),
  product1AcceptanceMap: readJson('test-results/product-1.0-acceptance-map/latest.json'),
  realProviderRelease: readJson('test-results/real-provider-release/latest.json'),
  releaseSbomAudit: readJson('test-results/release-sbom/latest.json'),
  releasePackagingAudit: readJson('test-results/release-packaging-audit/latest.json'),
  macosReleaseAudit: readJson('test-results/macos-release-audit/latest.json'),
  packagedAppSmoke: readJson('test-results/packaged-app-smoke/latest.json'),
  releaseNotesAudit: readJson('test-results/release-notes-audit/latest.json'),
  productPositioningAudit: readJson('test-results/product-positioning-audit/latest.json'),
  githubReleaseAudit: readJson('test-results/github-release-audit/latest.json')
}

const packageJson = readJson('package.json').data ?? {}
const currentPackageVersion = stringField(packageJson, 'version') || 'unknown'
const explicitReleaseVersion = argValue('--version') || process.env.CAOGEN_RELEASE_VERSION || ''
const releaseTargetVersion = explicitReleaseVersion || currentPackageVersion
const releaseTargetLabel = explicitReleaseVersion ? `v${releaseTargetVersion}` : 'not selected; rolling from current package version'
const p2Requirements = Array.isArray(reports.p2Audit.data?.requirements) ? reports.p2Audit.data.requirements : []
const p2ById = Object.fromEntries(p2Requirements.filter(isRecord).map((item) => [item.id, item]))
const p2RequiredResults = Array.isArray(reports.p2Required.data?.results) ? reports.p2Required.data.results : []
const p2RequiredByName = Object.fromEntries(p2RequiredResults.filter(isRecord).map((item) => [item.name, item]))
const releaseRequiredP2Ids = ['P2-002', 'P2-003', 'P2-005']
const nonBlockingP2Ids = {
  'P2-001': 'delegated_windows_agent',
  'P2-004': 'user_configured_external'
}

const domains = [
  ...(refresh ? [refreshDomain()] : []),
  stableProductAcceptanceDomain(),
  realDefaultProviderDomain(),
  sbomDomain(),
  releaseIdentityDomain(),
  deepTestDomain(),
  dagFinalizationDomain(),
  p2Domain(),
  n1Domain(),
  product1SoakDomain(),
  packagingDomain(packageJson),
  productPositioningDomain(),
  releaseNotesDomain(),
  githubReleaseDomain(),
  secretDomain()
]
const openDomains = domains.filter((domain) => domain.status !== 'ready' && domain.blocking !== false)
const manualDomains = domains.filter((domain) => domain.blocking === false)
const report = {
  status: openDomains.length === 0 ? 'ready' : 'not_ready',
  required,
  runId,
  reportDir,
  currentPackageVersion,
  releaseCandidate: releaseTargetLabel,
  releaseTarget: {
    version: releaseTargetVersion,
    source: explicitReleaseVersion ? 'explicit' : 'package.json',
    label: releaseTargetLabel
  },
  git: gitState,
  redactionPolicy: 'No secret values are read or written; only report paths, status fields, env names, and commands are emitted.',
  optionalEngines: [
    {
      id: 'claude',
      releaseRequired: false,
      defaultSelected: false,
      policy: 'Authentication is required only when the user explicitly selects the optional Claude engine.'
    }
  ],
  refresh: {
    enabled: refresh,
    commands: refreshResults
  },
  sourceReports: Object.fromEntries(Object.entries(reports).map(([name, value]) => [
    name,
    {
      path: value.relativePath,
      exists: value.exists,
      status: evidenceStatus(value),
      error: value.error
    }
  ])),
  domains,
  openDomains: openDomains.map((domain) => domain.id),
  manualDomains: manualDomains.map((domain) => domain.id),
  waivedDomains: domains.filter((domain) => domain.status === 'waived').map((domain) => domain.id),
  parallelAgents: buildParallelAgents(),
  releaseStopConditions: [
    'Do not publish a new release while workos-release-doctor status is not ready.',
    'Do not label a 1.x build stable while any PRD P0 remains short of the exact current-verified state.',
    'Do not publish a 1.x stable release without release-bound real default OpenAI-compatible provider evidence.',
    'Do not label a 1.x build stable without a release-bound CycloneDX/SPDX inventory and vulnerability disposition.',
    'Do not publish a 1.x macOS stable build without Developer ID signing, Hardened Runtime, notarization, stapling, and the required macOS release audit.',
    'Do not publish until the required taskDag durable finalization crash e2e is present and passing in the release-bound Deep report.',
    'Do not publish while release-scope P2 evidence is missing: P2-002, P2-003, and P2-005 must be proved.',
    'Do not claim P2-001 Windows GUI evidence or P2-004 China external evidence as release-proved until their separate required gates pass.',
    'Do not make N1 30-minute human migration claims in release notes without a passed private N1 audit record.',
    'Do not publish a 1.x stable release without a passed private seven-day soak record bound to the exact frozen version, commit, and artifact set, except 1.0.0 when its explicit version-scoped owner waiver validates; that waiver never applies to another release.',
    'Do not publish if real secrets, webhooks, certs, signing material, .env files, test-results, out, dist, node_modules, or local evidence packs are staged.',
    'Do not publish public product or release copy that mentions external product names, uses comparison framing, or forces a fixed future version target.',
    'Do not publish until npm run test:release-notes-audit:final passes for the exact GitHub Release body.',
    'Do not leave forbidden GitHub Release assets public; delete the asset and rotate/revoke the credential if any real secret was exposed.',
    'Do not claim a published release passed until npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z --expected-assets-from-dist proves the exact local dist asset set and public text metadata.',
    'Do not claim Genesis can execute, merge, push, or publish through external child Agents until that is implemented and proved.'
  ]
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportDir, 'report.md'), renderReleaseDoctorMarkdown(report), 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.md'), renderReleaseDoctorMarkdown(report), 'utf8')

console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'ready') process.exitCode = 1

function p2Domain() {
  const releaseChecks = {
    'P2-002': p2ById['P2-002']?.status === 'proved' || p2RequiredByName.p2_default_smoke?.status === 'pass',
    'P2-003': p2ById['P2-003']?.status === 'proved' || p2RequiredByName.p2_default_smoke?.status === 'pass',
    'P2-005':
      p2ById['P2-005']?.status === 'proved' ||
      (
        p2RequiredByName.ide_build_and_vscode_required?.status === 'pass' &&
        p2RequiredByName.jetbrains_ide_interaction_required?.status === 'pass'
      )
  }
  const proved = [
    ...releaseRequiredP2Ids.filter((id) => releaseChecks[id]),
    ...Object.keys(nonBlockingP2Ids).filter((id) => p2ById[id]?.status === 'proved')
  ]
  const blockingOpen = releaseRequiredP2Ids
    .filter((id) => !releaseChecks[id])
    .map((id) => ({
      id,
      status: stringField(p2ById[id], 'status') || 'missing',
      title: stringField(p2ById[id], 'title') || id
    }))
  const nonBlockingOpen = Object.entries(nonBlockingP2Ids)
    .filter(([id]) => p2ById[id]?.status !== 'proved')
    .map(([id, releasePolicy]) => ({
      id,
      status: stringField(p2ById[id], 'status') || 'missing',
      title: stringField(p2ById[id], 'title') || id,
      releasePolicy
    }))
  return {
    id: 'p2_required',
    title: 'P2 release-scope evidence',
    status: blockingOpen.length === 0 ? 'ready' : 'open',
    releaseRequired: releaseRequiredP2Ids,
    proved,
    open: blockingOpen,
    nonBlockingOpen,
    commands: [
      'npm run test:p2',
      'npm run test:p2-ide-build-and-vscode:required',
      'npm run test:jetbrains-ide-interaction:required',
      'npm run test:p2-audit -- --required # optional full external audit; P2-001/P2-004 are non-blocking unless release notes claim them'
    ],
    nextActions: [
      ...(blockingOpen.length === 0
        ? ['Keep P2-002/P2-003/P2-005 proved on the release commit.']
        : blockingOpen.flatMap((item) => nextActionsForP2(item.id))),
      ...nonBlockingOpen.flatMap((item) => nextActionsForP2(item.id))
    ]
  }
}

function releaseIdentityDomain() {
  const checks = {
    packageVersionMatchesTarget: currentPackageVersion === releaseTargetVersion,
    commitResolved: /^[0-9a-f]{40}$/.test(gitState.commit),
    worktreeClean: gitState.worktreeClean
  }
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  return {
    id: 'release_identity',
    title: 'Release version and Git identity',
    status: failures.length === 0 ? 'ready' : 'open',
    targetVersion: releaseTargetVersion,
    packageVersion: currentPackageVersion,
    git: gitState,
    checks,
    failures,
    commands: [
      `git rev-parse HEAD`,
      `git status --porcelain=v1 --untracked-files=all`,
      `npm run workos:release-doctor -- --refresh --version ${releaseTargetVersion}`
    ],
    nextActions: failures.length === 0
      ? ['Keep the release target, commit, and clean worktree unchanged through the final release-notes audit.']
      : [
          'Commit the exact release candidate and rerun the doctor from a clean worktree.',
          'Do not reuse a doctor or final release-notes report from another version or commit.'
        ]
  }
}

function stableProductAcceptanceDomain() {
  const audit = reports.product1AcceptanceAudit
  const acceptanceMap = reports.product1AcceptanceMap
  if (!requiresStableProductAcceptance()) {
    return {
      id: 'product_1_0_acceptance',
      title: 'Formal 1.0 product acceptance',
      status: 'not_required_before_1_0',
      blocking: false,
      commands: ['npm run test:product-1.0-acceptance'],
      nextActions: ['Use the formal PRD gate for every 1.x stable candidate.']
    }
  }
  const checks = {
    auditPassed: audit.data?.status === 'passed',
    acceptanceMapStructured: acceptanceMap.data?.structuralStatus === 'passed',
    acceptanceMapClosed: acceptanceMap.data?.closureStatus === 'passed',
    packageVersionMatches: audit.data?.packageVersion === releaseTargetVersion,
    acceptanceMapVersionMatches: acceptanceMap.data?.packageVersion === releaseTargetVersion,
    acceptanceMapCommitMatches: acceptanceMap.data?.git?.commit === gitState.commit,
    acceptanceMapClean: acceptanceMap.data?.git?.worktreeClean === true && gitState.worktreeClean,
    p0InventoryComplete: audit.data?.summary?.p0?.total === 64,
    p0MapComplete:
      acceptanceMap.data?.summary?.p0?.total === 64 &&
      acceptanceMap.data?.summary?.p0?.mapped === 64,
    p1MapComplete:
      acceptanceMap.data?.summary?.p1?.total === 38 &&
      acceptanceMap.data?.summary?.p1?.mapped === 38,
    everyP0Verified:
      audit.data?.summary?.p0?.verified === audit.data?.summary?.p0?.total &&
      audit.data?.summary?.p0?.open === 0,
    acceptanceMatrixPresent: existsSync(path.join(repoRoot, 'docs', '1.0-ACCEPTANCE-MATRIX.md'))
  }
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  return {
    id: 'product_1_0_acceptance',
    title: 'Formal 1.0 product acceptance',
    status: failures.length === 0 ? 'ready' : 'open',
    checks,
    failures,
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      summary: audit.data?.summary,
      openP0: Array.isArray(audit.data?.openP0) ? audit.data.openP0.map((item) => item.id) : []
    },
    acceptanceMap: {
      path: acceptanceMap.relativePath,
      exists: acceptanceMap.exists,
      status: evidenceStatus(acceptanceMap),
      structuralStatus: acceptanceMap.data?.structuralStatus,
      closureStatus: acceptanceMap.data?.closureStatus,
      summary: acceptanceMap.data?.summary,
      structuralFailures: acceptanceMap.data?.structuralFailures,
      closureFailureCount: Array.isArray(acceptanceMap.data?.closureFailures)
        ? acceptanceMap.data.closureFailures.length
        : undefined,
      releaseBindingFailures: acceptanceMap.data?.releaseBindingFailures
    },
    commands: [
      'npm run test:product-1.0-acceptance',
      'npm run test:product-1.0-acceptance:required',
      'npm run test:1.0-acceptance-map',
      'npm run test:1.0-acceptance-map:required'
    ],
    nextActions: failures.length === 0
      ? ['Keep all 64 PRD P0 requirements verified and bound to their acceptance evidence.']
      : [
          'Use docs/1.0-ACCEPTANCE-MATRIX.md as the owner and evidence ledger for the remaining PRD P0/P1 work.',
          'Keep the machine-readable acceptance map complete and bind the required result to the clean release commit.',
          'Do not use a green engineering Deep report as a substitute for the formal 1.0 product acceptance gate.'
        ]
  }
}

function sbomDomain() {
  const audit = reports.releaseSbomAudit
  if (!requiresStableProductAcceptance()) {
    return {
      id: 'release_sbom',
      title: 'Release SBOM and dependency decision',
      status: 'not_required_before_1_0',
      blocking: false,
      commands: ['npm run test:release-sbom'],
      nextActions: ['Generate a release-bound SBOM before any 1.x stable publication.']
    }
  }
  const checks = {
    auditPassed: audit.data?.status === 'passed',
    packageVersionMatches: audit.data?.packageVersion === releaseTargetVersion,
    commitMatches: audit.data?.commit === gitState.commit,
    cleanCommitEvidence: audit.data?.worktreeClean === true && gitState.worktreeClean,
    cyclonedxInventoryPresent: audit.data?.bomFormat === 'CycloneDX 1.5' && audit.data?.componentCount > 0,
    vulnerabilityAuditPassed: audit.data?.vulnerabilityAudit?.status === 'passed'
  }
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  return {
    id: 'release_sbom',
    title: 'Release SBOM and dependency decision',
    status: failures.length === 0 ? 'ready' : 'open',
    checks,
    failures,
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      packageVersion: audit.data?.packageVersion,
      commit: audit.data?.commit,
      worktreeClean: audit.data?.worktreeClean,
      bomFormat: audit.data?.bomFormat,
      componentCount: audit.data?.componentCount,
      vulnerabilityAudit: audit.data?.vulnerabilityAudit,
      bomDigest: audit.data?.bomDigest
    },
    commands: [
      'npm run test:release-sbom:required'
    ],
    nextActions: failures.length === 0
      ? ['Keep the SBOM, digest, and vulnerability disposition bound to the exact release commit and artifact set.']
      : ['Run the required SBOM audit with --audit on the clean release commit and record every High/Critical disposition.']
  }
}

function realDefaultProviderDomain() {
  const audit = reports.realProviderRelease
  if (!requiresStableProductAcceptance()) {
    return {
      id: 'real_default_provider',
      title: 'Real default OpenAI-compatible provider evidence',
      status: 'not_required_before_1_0',
      blocking: false,
      commands: ['npm run test:real-provider-release:required -- --record /private/path/result.json'],
      nextActions: ['Record release-bound real default provider evidence before any 1.x stable publication.']
    }
  }
  const checks = {
    auditPassed: audit.data?.status === 'passed',
    candidateVersionMatches: audit.data?.candidateVersion === releaseTargetVersion,
    gitCommitMatches: audit.data?.gitCommit === gitState.commit,
    worktreeClean: audit.data?.worktreeClean === true,
    protocolOpenAiCompatible: audit.data?.protocol === 'openai-compatible',
    redacted: audit.data?.redacted === true
  }
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  return {
    id: 'real_default_provider',
    title: 'Real default OpenAI-compatible provider evidence',
    status: failures.length === 0 ? 'ready' : 'open',
    checks,
    failures,
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      candidateVersion: audit.data?.candidateVersion,
      gitCommit: audit.data?.gitCommit,
      worktreeClean: audit.data?.worktreeClean,
      protocol: audit.data?.protocol,
      redacted: audit.data?.redacted
    },
    commands: ['npm run test:real-provider-release:required -- --record /private/path/result.json'],
    nextActions: failures.length === 0
      ? ['Keep the redacted real-provider record bound to the exact clean release commit and version.']
      : ['Run the real default OpenAI-compatible provider release gate with a private record, then rerun Release Doctor on the same candidate.']
  }
}

function refreshDomain() {
  const failed = refreshResults.filter((item) => item.status !== 'completed')
  return {
    id: 'evidence_refresh',
    title: 'Current release evidence refresh',
    status: failed.length === 0 ? 'ready' : 'open',
    commands: refreshResults,
    failures: failed.map((item) => ({ id: item.id, exitCode: item.exitCode, error: item.error })),
    nextActions: failed.length === 0
      ? ['Keep every refreshed audit green on the release commit.']
      : ['Fix every failed refresh command; stale latest.json reports cannot satisfy the release gate.']
  }
}

function deepTestDomain() {
  const audit = reports.deepTest
  const required = audit.data?.summary?.required
  const checks = {
    passed: audit.data?.status === 'pass',
    everyRequiredPassed:
      typeof required?.total === 'number' &&
      required.total > 0 &&
      required.counts?.pass === required.total &&
      required.blocking === 0,
    commitMatches: audit.data?.git?.commit === gitState.commit,
    cleanCommitEvidence: audit.data?.git?.worktreeClean === true && gitState.worktreeClean,
    gitStateUnchanged: audit.data?.git?.unchanged === true
  }
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  return {
    id: 'deep_test',
    title: 'Full required deep-test gate',
    status: failures.length === 0 ? 'ready' : 'open',
    checks,
    failures,
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      runId: audit.data?.runId,
      git: audit.data?.git,
      summary: audit.data?.summary
    },
    commands: ['npm run test:deep'],
    nextActions: failures.length === 0
      ? ['Keep the full required deep-test report bound to the release commit.']
      : ['Run npm run test:deep from the clean release commit; every required check must pass.']
  }
}

function dagFinalizationDomain() {
  const audit = reports.deepTest
  const result = Array.isArray(audit.data?.results)
    ? audit.data.results.find((item) => item?.name === 'taskDag durable finalization crash e2e')
    : undefined
  const checks = {
    present: Boolean(result),
    executed: result?.executed === true,
    required: result?.requirement === 'required',
    passed: result?.status === 'pass'
  }
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  return {
    id: 'dag_finalization',
    title: 'Durable DAG finalization crash gate',
    status: failures.length === 0 ? 'ready' : 'open',
    checks,
    failures,
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      result
    },
    commands: ['npm run test:dag-finalization', 'npm run test:deep'],
    nextActions: failures.length === 0
      ? ['Keep the durable finalization crash result bound to the exact release commit.']
      : ['Run the required durable finalization crash E2E through the full Deep gate on the release commit.']
  }
}

function refreshLocalEvidence() {
  const refreshReleaseVersion = argValue('--version') || process.env.CAOGEN_RELEASE_VERSION || stringField(readJson('package.json').data, 'version') || 'unknown'
  const refreshReleaseMajor = Number(refreshReleaseVersion.split('.')[0])
  const commands = [
    ...(Number.isFinite(refreshReleaseMajor) && refreshReleaseMajor >= 1
      ? [{
          id: 'product_1_0_soak_audit',
          command: `node scripts/product-1.0-soak-audit.mjs --required --version ${refreshReleaseVersion}`,
          args: ['scripts/product-1.0-soak-audit.mjs', '--required', '--version', refreshReleaseVersion]
        }]
      : []),
    {
      id: 'product_1_0_acceptance_audit',
      command: 'node scripts/product-1.0-acceptance-audit.mjs',
      args: ['scripts/product-1.0-acceptance-audit.mjs']
    },
    {
      id: 'product_1_0_acceptance_map',
      command: 'node scripts/product-1.0-acceptance-map.mjs',
      args: ['scripts/product-1.0-acceptance-map.mjs']
    },
    {
      id: 'release_sbom_audit',
      command: 'node scripts/release-sbom-audit.mjs --audit',
      args: ['scripts/release-sbom-audit.mjs', '--audit']
    },
    {
      id: 'release_packaging_audit',
      command: 'node scripts/release-packaging-audit.mjs',
      args: ['scripts/release-packaging-audit.mjs']
    },
    {
      id: 'product_positioning_audit',
      command: 'node scripts/product-positioning-audit.mjs',
      args: ['scripts/product-positioning-audit.mjs']
    },
    {
      id: 'macos_release_audit',
      command: 'node scripts/macos-release-audit.mjs',
      args: ['scripts/macos-release-audit.mjs']
    },
    {
      id: 'github_release_audit',
      command: 'node scripts/github-release-audit.mjs',
      args: ['scripts/github-release-audit.mjs']
    },
    {
      id: 'secret_history_scan',
      command: 'node scripts/secret-scan.mjs --worktree --history',
      args: ['scripts/secret-scan.mjs', '--worktree', '--history']
    }
  ]
  return commands.map((item) => runRefreshCommand(item))
}

function runRefreshCommand(item) {
  const startedAt = Date.now()
  try {
    execFileSync(process.execPath, item.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return {
      id: item.id,
      command: item.command,
      status: 'completed',
      exitCode: 0,
      durationMs: Date.now() - startedAt
    }
  } catch (error) {
    return {
      id: item.id,
      command: item.command,
      status: 'failed',
      exitCode: typeof error?.status === 'number' ? error.status : 1,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function nextActionsForP2(id) {
  if (id === 'P2-001') {
    return [
      'Run the Windows GUI evidence branch on a Windows desktop with VS Code installed.',
      'Commands: npm run test:gui-input-preflight:required, npm run test:gui-vscode-e2e:required, npm run test:gui-cross-app-e2e:required, npm run test:gui-desktop-e2e:required.',
      'Acceptance: gui-vscode-e2e and gui-cross-app-e2e latest reports pass with strict editor input, terminal marker, and no prototype-only fallback.'
    ]
  }
  if (id === 'P2-004') {
    return [
      'Run China external evidence with real public HTTPS targets and real provider config.',
      'Commands: npm run test:p2-external:doctor -- --refresh, npm run test:china-real-network:required, npm run test:china-tool-call-parity:required.',
      'Acceptance: China real-network and tool-call parity reports pass, then strict P2 audit marks P2-004 proved.'
    ]
  }
  return [`Close ${id} according to docs/WORKOS-PHASE2-PARALLEL-PLAN.md and rerun strict audit.`]
}

function n1Domain() {
  const audit = reports.n1MigrationAudit
  const stableRequired = requiresStableProductAcceptance()
  const candidates = [
    'docs/N1-MIGRATION-RESULTS.md',
    'docs/N1-MIGRATION-DRILL-RESULT.md',
    'docs/N1-MIGRATION-RESULT.json',
    'docs/N1-MIGRATION-DRILL-RESULT.json',
    'test-results/n1-migration/latest.json'
  ]
  const evidence = candidates.map((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath)
    return {
      path: relativePath,
      exists: existsSync(absolutePath),
      size: existsSync(absolutePath) ? statSync(absolutePath).size : 0
    }
  })
  return {
    id: 'n1_migration',
    title: 'N1 human 30-minute migration drill',
    status: audit.data?.status === 'passed' ? 'ready' : stableRequired ? 'open' : 'not_required_without_n1_claims',
    ...(stableRequired ? {} : { blocking: false }),
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      failures: Array.isArray(audit.data?.failures) ? audit.data.failures : undefined
    },
    evidence,
    commands: [
      'node scripts/n1-fixture.mjs',
      'npm run dev',
      stableRequired
        ? 'npm run test:n1-migration-audit:required'
        : 'npm run test:n1-migration-audit:required # optional before making N1 claims'
    ],
    nextActions: audit.data?.status === 'passed'
      ? ['Keep the passed N1 audit report private and bind it to the exact stable candidate.']
      : stableRequired
        ? ['Run the required private 30-minute human migration drill and bind its timestamped result to the stable candidate.']
        : [
            'N1 human drill is not a release blocker unless the release notes make N1 claims.',
            'Do not claim 30-minute human migration in release notes until a private N1 audit record passes.'
          ]
  }
}

function product1SoakDomain() {
  const audit = reports.product1SoakAudit
  const summary = isRecord(audit.data?.summary) ? audit.data.summary : {}
  const waiver = isRecord(audit.data?.waiver) ? audit.data.waiver : {}
  const stableRequired = requiresStableProductAcceptance()
  const soakArtifactDigest = stringField(summary, 'artifactSetDigest') || ''
  const packagingArtifactDigest = stringField(reports.releasePackagingAudit.data, 'artifactSetSha256') || ''
  const soakChecks = buildProduct1SoakChecks(audit, summary, soakArtifactDigest, packagingArtifactDigest)
  const waiverChecks = buildProduct1SoakWaiverChecks(audit, waiver)
  const soakPassed = Object.values(soakChecks).every(Boolean)
  const waiverAccepted = stableRequired && Object.values(waiverChecks).every(Boolean)
  return {
    id: 'product_1_0_soak',
    title: 'Feature-frozen seven-day daily-use soak',
    status: product1SoakStatus(soakPassed, waiverAccepted, stableRequired),
    ...(stableRequired && !waiverAccepted ? {} : { blocking: false }),
    acceptedBy: soakPassed ? 'seven_day_soak' : waiverAccepted ? 'version_scoped_owner_waiver' : undefined,
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      decision: audit.data?.decision,
      releaseVersion: audit.data?.releaseVersion,
      summary,
      waiver
    },
    waiver: waiverAccepted ? waiver : undefined,
    packagingArtifactDigest: packagingArtifactDigest ? `sha256:${packagingArtifactDigest}` : undefined,
    checks: soakChecks,
    waiverChecks,
    failures: product1SoakFailures(soakChecks, waiverChecks, soakPassed, waiverAccepted),
    commands: [
      'npm run test:1.0-soak-audit:smoke',
      'npm run test:1.0-soak-audit:required -- --record /private/path/to/soak.json',
      'npm run test:1.0-soak-audit:required -- --version 1.0.0 --waiver docs/1.0-SOAK-WAIVER.json',
      `npm run workos:release-doctor -- --required --version ${releaseTargetVersion}`
    ],
    nextActions: product1SoakNextActions(soakPassed, waiverAccepted)
  }
}

function buildProduct1SoakChecks(audit, summary, soakArtifactDigest, packagingArtifactDigest) {
  return {
    auditPassed: audit.data?.status === 'passed',
    auditDecisionIsSoak: audit.data?.decision === 'seven_day_soak',
    auditReleaseVersionMatches: audit.data?.releaseVersion === releaseTargetVersion,
    candidateVersionMatches: stringField(summary, 'candidateVersion') === releaseTargetVersion,
    gitCommitMatches: stringField(summary, 'gitCommit') === gitState.commit,
    artifactSetBound: /^sha256:[0-9a-f]{64}$/i.test(soakArtifactDigest),
    artifactSetMatchesPackaging: Boolean(packagingArtifactDigest) && soakArtifactDigest === `sha256:${packagingArtifactDigest}`,
    featureFrozen: summary.featureFrozen === true,
    sevenConsecutiveDays: summary.dayCount === 7,
    zeroDataLoss: summary.zeroDataLoss === true,
    zeroDuplicateHighRiskEffects: summary.zeroDuplicateHighRiskEffects === true,
    noReset: summary.resetCount === 0
  }
}

function buildProduct1SoakWaiverChecks(audit, waiver) {
  return {
    auditWaived: audit.data?.status === 'waived',
    auditHasNoFailures: Array.isArray(audit.data?.failures) && audit.data.failures.length === 0,
    auditDecisionIsOwnerWaiver: audit.data?.decision === 'owner_waiver',
    auditReleaseVersionMatches: audit.data?.releaseVersion === releaseTargetVersion,
    waiverPathRecorded: Boolean(stringField(audit.data, 'waiverPath')?.trim()),
    releaseVersionIsExactly1_0_0: releaseTargetVersion === '1.0.0',
    schemaVersionMatches: waiver.schemaVersion === 1,
    gateMatches: stringField(waiver, 'gateId') === 'product_1_0_soak',
    decisionRecorded: stringField(waiver, 'decision') === 'waive',
    waiverVersionMatches: stringField(waiver, 'releaseVersion') === releaseTargetVersion,
    exactVersionScope: stringField(waiver, 'scope') === 'exact_release_version_only',
    ownerRecorded: Boolean(stringField(waiver, 'owner')?.trim()),
    decisionTimeRecorded: Number.isFinite(Date.parse(stringField(waiver, 'decidedAt') || '')),
    decisionSourceRecorded: Boolean(stringField(waiver, 'decisionSource')?.trim()),
    reasonRecorded: Boolean(stringField(waiver, 'reason')?.trim()),
    acceptedRiskRecorded: Boolean(stringField(waiver, 'acceptedRisk')?.trim()),
    ownerApproved: waiver.approvedByOwner === true,
    riskAccepted: waiver.riskAccepted === true,
    futureVersionsExcluded: waiver.appliesToFutureVersions === false,
    expiresAfter1_0_0: stringField(waiver, 'expiresAfterReleaseVersion') === '1.0.0',
    substituteEvidenceRecorded:
      Array.isArray(waiver.substituteEvidence) &&
      waiver.substituteEvidence.some((item) => typeof item === 'string' && item.trim())
  }
}

function product1SoakStatus(soakPassed, waiverAccepted, stableRequired) {
  if (soakPassed) return 'ready'
  if (waiverAccepted) return 'waived'
  return stableRequired ? 'open' : 'not_required_before_1_x'
}

function product1SoakFailures(soakChecks, waiverChecks, soakPassed, waiverAccepted) {
  if (soakPassed || waiverAccepted) return []
  return [
    ...failedCheckNames('soak', soakChecks),
    ...failedCheckNames('waiver', waiverChecks)
  ]
}

function failedCheckNames(prefix, checks) {
  return Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => `${prefix}.${name}`)
}

function product1SoakNextActions(soakPassed, waiverAccepted) {
  if (soakPassed) {
    return ['Keep the private soak record and raw evidence bound to the exact release candidate; any candidate change restarts the clock.']
  }
  if (waiverAccepted) {
    return [
      'Keep the explicit owner, reason, accepted risk, and compensating gates visible in the 1.0.0 release decision.',
      'This waiver expires with 1.0.0; a later release requires its own policy decision and cannot inherit this waiver.'
    ]
  }
  return ['Run seven consecutive real daily-use days on one feature-frozen candidate, or for exactly 1.0.0 validate the explicit owner waiver; then rerun Release Doctor.']
}

function packagingDomain(packageJson) {
  const audit = reports.releasePackagingAudit
  const macosAudit = reports.macosReleaseAudit
  const launchAudit = reports.packagedAppSmoke
  const version = stringField(packageJson, 'version') || 'unknown'
  const distPath = path.join(repoRoot, 'dist')
  const hasDist = existsSync(distPath)
  const artifacts = releaseArtifactEvidence(version)
  const checks = {
    auditPassed: audit.data?.status === 'passed',
    expectedVersionMatches: audit.data?.expectedVersion === releaseTargetVersion,
    packageVersionMatches: audit.data?.packageVersion === releaseTargetVersion,
    packageLockVersionMatches: audit.data?.packageLockVersion === releaseTargetVersion,
    commitMatches: audit.data?.git?.commit === gitState.commit,
    cleanCommitEvidence: audit.data?.git?.worktreeClean === true && gitState.worktreeClean,
    packagedLaunchPassed: launchAudit.data?.status === 'passed',
    packagedLaunchVersionMatches: launchAudit.data?.packageVersion === releaseTargetVersion,
    packagedLaunchCommitMatches: launchAudit.data?.git?.commit === gitState.commit,
    packagedLaunchCleanEvidence: launchAudit.data?.git?.worktreeClean === true && gitState.worktreeClean,
    artifactsComplete: artifacts.complete,
    artifactSetMatches: Boolean(artifacts.artifactSetSha256) && audit.data?.artifactSetSha256 === artifacts.artifactSetSha256,
    ...(requiresTrustedMacDistribution()
      ? {
          macosDistributionAuditPassed: macosAudit.data?.status === 'passed',
          macosDistributionVersionMatches: macosAudit.data?.packageVersion === releaseTargetVersion
        }
      : {})
  }
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  return {
    id: 'packaging_release',
    title: 'Packaging and GitHub Release readiness',
    status: failures.length === 0 ? 'ready' : 'open',
    currentPackageVersion: version,
    distPresent: hasDist,
    checks,
    failures,
    artifacts,
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      expectedVersion: audit.data?.expectedVersion,
      packageVersion: audit.data?.packageVersion,
      packageLockVersion: audit.data?.packageLockVersion,
      git: audit.data?.git,
      artifactSetSha256: audit.data?.artifactSetSha256,
      failures: Array.isArray(audit.data?.failures) ? audit.data.failures : undefined,
      warnings: Array.isArray(audit.data?.warnings) ? audit.data.warnings : undefined
    },
    packagedAppSmoke: {
      path: launchAudit.relativePath,
      exists: launchAudit.exists,
      status: evidenceStatus(launchAudit),
      packageVersion: launchAudit.data?.packageVersion,
      git: launchAudit.data?.git,
      target: launchAudit.data?.target,
      failure: launchAudit.data?.failure
    },
    macosReleaseAudit: {
      required: requiresTrustedMacDistribution(),
      path: macosAudit.relativePath,
      exists: macosAudit.exists,
      status: evidenceStatus(macosAudit),
      packageVersion: macosAudit.data?.packageVersion,
      targetArch: macosAudit.data?.targetArch,
      failures: Array.isArray(macosAudit.data?.failures) ? macosAudit.data.failures : undefined
    },
    commands: [
      'npm run typecheck',
      'npm run build',
      'npm run test:deep',
      'npm run secret:scan:history',
      ...(requiresTrustedMacDistribution()
        ? [
            'npm run release:mac:preflight:x64',
            'npm run dist:mac:release:x64',
            'npm run test:macos-release-audit:required -- --arch x64'
          ]
        : ['npm run dist:mac:x64']),
      'npm run test:release-packaging-audit:required',
      'npm run test:packaged-app:mac'
    ],
    nextActions: [
      'Bump package.json and package-lock.json only when all required evidence gates are proved.',
      'Run macOS packaging and inspect dist assets before uploading.',
      ...(requiresTrustedMacDistribution()
        ? ['For a 1.x stable release, unsigned preview assets never satisfy the distribution gate.']
        : []),
      'Run the packaging audit against the intended release version before creating GitHub Release assets.',
      'Launch the packaged macOS app from a fresh user-data directory and require a real renderer target.',
      'Publish only the intended installer/update assets; never upload test-results, out, node_modules, .env files, certs, private keys, or local evidence packs.'
    ]
  }
}

function releaseArtifactEvidence(version) {
  const files = [
    `CaoGen-${version}.dmg`,
    `CaoGen-${version}.dmg.blockmap`,
    `CaoGen-${version}-mac.zip`,
    `CaoGen-${version}-mac.zip.blockmap`,
    'latest-mac.yml'
  ].sort()
  const missing = files.filter((file) => !existsSync(path.join(repoRoot, 'dist', file)))
  if (missing.length > 0) return { complete: false, missing, files: {}, artifactSetSha256: null }
  const digests = Object.fromEntries(files.map((file) => {
    const absolutePath = path.join(repoRoot, 'dist', file)
    return [file, {
      size: statSync(absolutePath).size,
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
    }]
  }))
  return {
    complete: true,
    missing: [],
    files: digests,
    artifactSetSha256: createHash('sha256').update(JSON.stringify(digests)).digest('hex')
  }
}

function releaseNotesDomain() {
  const audit = reports.releaseNotesAudit
  const currentArtifactSetSha256 = releaseArtifactEvidence(releaseTargetVersion).artifactSetSha256
  const expectedVersionMatches = audit.data?.expectedVersion === releaseTargetVersion
  const commitMatches = audit.data?.git?.commit === gitState.commit
  const cleanCommitEvidence = audit.data?.git?.worktreeClean === true && gitState.worktreeClean
  const artifactSetMatches =
    Boolean(currentArtifactSetSha256) && audit.data?.artifactSetSha256 === currentArtifactSetSha256
  const finalPassed =
    audit.data?.status === 'passed' &&
    audit.data?.mode === 'final' &&
    expectedVersionMatches &&
    commitMatches &&
    cleanCommitEvidence &&
    artifactSetMatches
  const draftPassed = audit.data?.status === 'passed' && audit.data?.mode === 'draft'
  return {
    id: 'release_notes',
    title: 'GitHub Release notes truthfulness',
    status: finalPassed ? 'ready' : draftPassed ? 'draft_ready' : 'open',
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      mode: audit.data?.mode,
      notesPath: audit.data?.notesPath,
      expectedVersion: audit.data?.expectedVersion,
      git: audit.data?.git,
      binding: {
        expectedVersionMatches,
        commitMatches,
        cleanCommitEvidence,
        artifactSetMatches
      },
      failures: Array.isArray(audit.data?.failures) ? audit.data.failures : undefined,
      warnings: Array.isArray(audit.data?.warnings) ? audit.data.warnings : undefined
    },
    commands: [
      'npm run test:release-notes-audit',
      'npm run test:release-notes-audit:required',
      'npm run test:release-notes-audit:final'
    ],
    nextActions: finalPassed
      ? ['Keep the final release notes audit green on the exact GitHub Release body and release commit.']
      : draftPassed
        ? [
            'Keep docs/RELEASE-NOTES-DRAFT.md aligned with current open gates.',
            'After P2, N1, packaging, and public assets are ready, replace draft-only blocked-release language with exact uploaded assets and run npm run test:release-notes-audit:final.'
          ]
        : [
            'Create or update docs/RELEASE-NOTES-DRAFT.md with exact supported claims, blockers, asset policy, macOS first-open guidance, and security statement.',
            'Run npm run test:release-notes-audit:required before merging release docs.'
          ]
  }
}

function productPositioningDomain() {
  const audit = reports.productPositioningAudit
  return {
    id: 'product_positioning',
    title: 'Public product positioning',
    status: audit.data?.status === 'passed' ? 'ready' : 'open',
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      scannedFiles: Array.isArray(audit.data?.scannedFiles) ? audit.data.scannedFiles : undefined,
      failures: Array.isArray(audit.data?.failures) ? audit.data.failures : undefined,
      warnings: Array.isArray(audit.data?.warnings) ? audit.data.warnings : undefined
    },
    commands: [
      'npm run test:product-positioning',
      'npm run test:product-positioning:required'
    ],
    nextActions: audit.data?.status === 'passed'
      ? ['Keep README, welcome copy, release notes, and release gate free of external product names/comparison framing and version-neutral.']
      : [
          'Run npm run test:product-positioning:required and remove fixed future-version language, external product names/comparison framing, or overclaims from public product copy.',
          'Keep technical engine/provider labels in settings separate from public positioning copy.'
        ]
  }
}

function githubReleaseDomain() {
  const audit = reports.githubReleaseAudit
  return {
    id: 'github_release_assets',
    title: 'Public GitHub Release asset hygiene',
    status: audit.data?.status === 'passed' ? 'ready' : 'open',
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      repo: audit.data?.repo,
      releaseCount: audit.data?.releaseCount,
      assetCount: audit.data?.assetCount,
      failures: Array.isArray(audit.data?.failures) ? audit.data.failures : undefined,
      warnings: Array.isArray(audit.data?.warnings) ? audit.data.warnings : undefined
    },
    commands: [
      'npm run test:github-release-audit',
      'npm run test:github-release-audit:required',
      'npm run test:github-release-audit:read-text',
      'npm run test:github-release-audit:required -- --tag vX.Y.Z',
      'npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z',
      'npm run test:github-release-audit:read-text:required -- --tag vX.Y.Z --expected-assets-from-dist'
    ],
    nextActions: audit.data?.status === 'passed'
      ? ['Keep the public release asset audit green after creating or editing any GitHub Release.']
      : [
          'Audit current public GitHub Release assets before publishing or editing release notes.',
          'Only installer/update metadata assets are allowed: DMG, mac zip, Windows installer, AppImage, blockmap, and latest*.yml.',
          'If a forbidden asset is already public, delete it from GitHub Releases and rotate/revoke the credential if it contained a real secret.'
        ]
  }
}

function secretDomain() {
  if (requiresStableProductAcceptance()) {
    const refreshResult = refreshResults.find((item) => item.id === 'secret_history_scan')
    const passed = refresh && refreshResult?.status === 'completed'
    return {
      id: 'secret_hygiene',
      title: 'Secret and public repository hygiene',
      status: passed ? 'ready' : 'open',
      commands: [
        'npm run secret:scan',
        'npm run secret:scan:history',
        `npm run workos:release-doctor -- --refresh --version ${releaseTargetVersion}`,
        'git status --short --ignored',
        'git diff --cached --name-only'
      ],
      nextActions: passed
        ? ['Keep the successful history scan bound to this refreshed release-doctor run.']
        : ['Run the release doctor with --refresh so the secret-history scan is executed in the same required decision.']
    }
  }
  return {
    id: 'secret_hygiene',
    title: 'Secret and public repository hygiene',
    status: 'manual_gate',
    blocking: false,
    commands: [
      'npm run secret:scan',
      'npm run secret:scan:history',
      'git status --short --ignored',
      'git diff --cached --name-only'
    ],
    nextActions: [
      'Run secret scans immediately before every commit and release.',
      'If a real token was ever pushed or shared outside the repo, rotate or revoke it on the provider platform; Git deletion alone is not enough.'
    ]
  }
}

function requiresStableProductAcceptance() {
  const major = Number(String(releaseTargetVersion).split('.')[0])
  return Number.isFinite(major) && major >= 1
}

function requiresTrustedMacDistribution() {
  return process.platform === 'darwin' && requiresStableProductAcceptance()
}

function buildParallelAgents() {
  return [
    {
      id: 'B1',
      branch: 'codex/workos-b1-gui-required',
      objective: 'Close P2-001 with strict Windows VS Code GUI and cross-app evidence.',
      commands: [
        'npm run test:gui-input-preflight:required',
        'npm run test:gui-vscode-e2e:required',
        'npm run test:gui-cross-app-e2e:required',
        'npm run test:gui-desktop-e2e:required'
      ],
      acceptance: 'Non-blocking unless release notes claim Windows GUI proof; after this separate agent passes, release notes may upgrade the claim.'
    },
    {
      id: 'B4',
      branch: 'codex/workos-b4-china-external',
      objective: 'Close P2-004 using real China network targets and real provider tool-call parity.',
      commands: [
        'npm run test:p2-external:pack',
        'npm run test:p2-external:doctor -- --refresh',
        'npm run test:china-real-network:required',
        'npm run test:china-tool-call-parity:required'
      ],
      acceptance: 'User-configured; a release may ship without this evidence if release notes do not claim China external proof.'
    },
    {
      id: 'B0',
      branch: 'codex/workos-b0-release-gate',
      objective: 'Keep docs, release gate, packaging, and public claims aligned with proved evidence.',
      commands: [
        'npm run workos:release-doctor -- --refresh',
        'npm run test:p2',
        'npm run test:p2-ide-build-and-vscode:required',
        'npm run test:jetbrains-ide-interaction:required',
        'npm run test:release-packaging-audit:required',
        'npm run test:product-positioning:required',
        'npm run test:release-notes-audit:required',
        'npm run test:github-release-audit:required',
        'npm run test:github-release-audit:read-text',
        'npm run secret:scan:history'
      ],
      acceptance: 'Release notes and README match current evidence; no new release is published until every required gate is ready.'
    }
  ]
}

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) return { relativePath, exists: false, data: null, error: 'missing file' }
  try {
    return {
      relativePath,
      exists: true,
      data: JSON.parse(readFileSync(absolutePath, 'utf8')),
      error: null
    }
  } catch (error) {
    return {
      relativePath,
      exists: true,
      data: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function readGitState() {
  const commit = gitOutput(['rev-parse', 'HEAD'])
  const branch = gitOutput(['branch', '--show-current'])
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    commit,
    branch: branch || 'detached',
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return ''
  }
}

function evidenceStatus(readResult) {
  if (!readResult.exists) return 'missing'
  if (readResult.error) return 'invalid_json'
  return readResult.data?.status ?? 'unknown'
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function stringField(value, key) {
  return typeof value?.[key] === 'string' ? value[key] : undefined
}
