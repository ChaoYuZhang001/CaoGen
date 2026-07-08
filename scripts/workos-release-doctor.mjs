#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const refresh = process.argv.includes('--refresh') || process.env.CAOGEN_WORKOS_RELEASE_DOCTOR_REFRESH === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'workos-release-doctor')
const reportDir = path.join(reportRoot, runId)
const refreshResults = refresh ? refreshLocalEvidence() : []

const reports = {
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
  releasePackagingAudit: readJson('test-results/release-packaging-audit/latest.json'),
  githubReleaseAudit: readJson('test-results/github-release-audit/latest.json')
}

const packageJson = readJson('package.json').data ?? {}
const p2Requirements = Array.isArray(reports.p2Audit.data?.requirements) ? reports.p2Audit.data.requirements : []
const p2ById = Object.fromEntries(p2Requirements.filter(isRecord).map((item) => [item.id, item]))

const domains = [
  p2Domain(),
  n1Domain(),
  packagingDomain(packageJson),
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
  currentPackageVersion: stringField(packageJson, 'version') || 'unknown',
  releaseCandidate: 'v0.2.0',
  redactionPolicy: 'No secret values are read or written; only report paths, status fields, env names, and commands are emitted.',
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
  parallelAgents: buildParallelAgents(),
  releaseStopConditions: [
    'Do not publish v0.2.0 while workos-release-doctor status is not ready.',
    'Do not publish while npm run test:p2-required or npm run test:p2-audit -- --required fails.',
    'Do not publish if real secrets, webhooks, certs, signing material, .env files, test-results, out, dist, node_modules, or local evidence packs are staged.',
    'Do not leave forbidden GitHub Release assets public; delete the asset and rotate/revoke the credential if any real secret was exposed.',
    'Do not claim public latest*.yml or other small text release metadata was content-scanned unless npm run test:github-release-audit:read-text:required -- --tag v0.2.0 passes.',
    'Do not claim Genesis can execute, merge, push, or publish through external child Agents until that is implemented and proved.'
  ]
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportDir, 'report.md'), renderMarkdown(report), 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.md'), renderMarkdown(report), 'utf8')

console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'ready') process.exitCode = 1

function p2Domain() {
  const proved = ['P2-001', 'P2-002', 'P2-003', 'P2-004', 'P2-005']
    .filter((id) => p2ById[id]?.status === 'proved')
  const open = ['P2-001', 'P2-002', 'P2-003', 'P2-004', 'P2-005']
    .filter((id) => p2ById[id]?.status !== 'proved')
    .map((id) => ({
      id,
      status: stringField(p2ById[id], 'status') || 'missing',
      title: stringField(p2ById[id], 'title') || id
    }))
  return {
    id: 'p2_required',
    title: 'P2 required evidence',
    status: reports.p2Audit.data?.status === 'passed' && open.length === 0 ? 'ready' : 'open',
    proved,
    open,
    commands: [
      'npm run test:p2-required',
      'npm run test:p2-audit -- --required'
    ],
    nextActions: open.length === 0
      ? ['Keep P2 required and strict audit green on the release commit.']
      : open.flatMap((item) => nextActionsForP2(item.id))
  }
}

function refreshLocalEvidence() {
  const commands = [
    {
      id: 'n1_migration_audit',
      command: 'node scripts/n1-migration-audit.mjs',
      args: ['scripts/n1-migration-audit.mjs']
    },
    {
      id: 'release_packaging_audit',
      command: 'node scripts/release-packaging-audit.mjs',
      args: ['scripts/release-packaging-audit.mjs']
    },
    {
      id: 'github_release_audit',
      command: 'node scripts/github-release-audit.mjs',
      args: ['scripts/github-release-audit.mjs']
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
    status: audit.data?.status === 'passed' ? 'ready' : 'open',
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
      'npm run test:n1-migration-audit:required'
    ],
    nextActions: audit.data?.status === 'passed'
      ? ['Keep the passed N1 audit report with the release evidence pack and rerun it on the release commit.']
      : [
          'Run docs/N1-MIGRATION-DRILL.md with a human tester and stopwatch.',
          'Record total time, per-step times, no-doc-help status, asset-zero-loss check, and screen recording path.',
          'Write a private JSON record using docs/N1-MIGRATION-RESULT.template.json and run npm run test:n1-migration-audit:required.',
          'Do not replace this with automation; N1 is explicitly human UX evidence.'
        ]
  }
}

function packagingDomain(packageJson) {
  const audit = reports.releasePackagingAudit
  const version = stringField(packageJson, 'version') || 'unknown'
  const distPath = path.join(repoRoot, 'dist')
  const hasDist = existsSync(distPath)
  return {
    id: 'packaging_release',
    title: 'Packaging and GitHub Release readiness',
    status: audit.data?.status === 'passed' ? 'ready' : 'open',
    currentPackageVersion: version,
    distPresent: hasDist,
    audit: {
      path: audit.relativePath,
      exists: audit.exists,
      status: evidenceStatus(audit),
      expectedVersion: audit.data?.expectedVersion,
      failures: Array.isArray(audit.data?.failures) ? audit.data.failures : undefined,
      warnings: Array.isArray(audit.data?.warnings) ? audit.data.warnings : undefined
    },
    commands: [
      'npm run typecheck',
      'npm run build',
      'npm run test:deep',
      'npm run secret:scan:history',
      'npm run dist:mac',
      'npm run test:release-packaging-audit:required'
    ],
    nextActions: [
      'Bump package.json and package-lock.json only when all required evidence gates are proved.',
      'Run macOS packaging and inspect dist assets before uploading.',
      'Run the packaging audit against the intended release version before creating GitHub Release assets.',
      'Publish only the intended installer/update assets; never upload test-results, out, node_modules, .env files, certs, private keys, or local evidence packs.'
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
      'npm run test:github-release-audit:required -- --tag v0.2.0',
      'npm run test:github-release-audit:read-text:required -- --tag v0.2.0'
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
      acceptance: 'P2 audit no longer reports P2-001 missing_evidence.'
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
      acceptance: 'P2 audit marks P2-004 proved without committing secrets or evidence packs.'
    },
    {
      id: 'B5',
      branch: 'codex/workos-b5-n1-drill',
      objective: 'Produce the human N1 30-minute migration drill record.',
      commands: [
        'node scripts/n1-fixture.mjs',
        'npm run dev',
        'npm run test:n1-migration-audit:required'
      ],
      acceptance: 'N1 audit passes for a dated human drill record showing <=30 minutes, all 7 steps complete, no docs/help, evidence path, commit, and source assets unchanged.'
    },
    {
      id: 'B0',
      branch: 'codex/workos-b0-release-gate',
      objective: 'Keep docs, release gate, packaging, and public claims aligned with proved evidence.',
      commands: [
        'npm run workos:release-doctor -- --refresh',
        'npm run test:p2-required',
        'npm run test:p2-audit -- --required',
        'npm run test:release-packaging-audit:required',
        'npm run test:github-release-audit:required',
        'npm run test:github-release-audit:read-text',
        'npm run secret:scan:history'
      ],
      acceptance: 'Release notes and README match current evidence; v0.2.0 is not published until every gate is ready.'
    }
  ]
}

function renderMarkdown(value) {
  const lines = [
    '# CaoGen Work OS Release Doctor',
    '',
    `Status: ${value.status}`,
    `Run ID: ${value.runId}`,
    `Release candidate: ${value.releaseCandidate}`,
    `Package version: ${value.currentPackageVersion}`,
    '',
    '## Refresh',
    '',
    `- Enabled: ${value.refresh.enabled ? 'yes' : 'no'}`,
    ...value.refresh.commands.map((item) => `- ${item.id}: ${item.status} (${item.durationMs}ms)`),
    '',
    '## Domains',
    ''
  ]
  for (const domain of value.domains) {
    lines.push(`### ${domain.title}`)
    lines.push('')
    lines.push(`- Status: ${domain.status}`)
    if (domain.proved?.length) lines.push(`- Proved: ${domain.proved.map((item) => `\`${item}\``).join(', ')}`)
    if (domain.open?.length) lines.push(`- Open: ${domain.open.map((item) => `\`${item.id}:${item.status}\``).join(', ')}`)
    if (domain.commands?.length) {
      lines.push('- Commands:')
      for (const command of domain.commands) lines.push(`  - \`${command}\``)
    }
    if (domain.nextActions?.length) {
      lines.push('- Next actions:')
      for (const action of domain.nextActions) lines.push(`  - ${action}`)
    }
    lines.push('')
  }
  lines.push('## Parallel Agents')
  lines.push('')
  lines.push('| Agent | Branch | Objective | Acceptance |')
  lines.push('|---|---|---|---|')
  for (const agent of value.parallelAgents) {
    lines.push(`| ${agent.id} | \`${agent.branch}\` | ${agent.objective} | ${agent.acceptance} |`)
  }
  lines.push('')
  lines.push('## Stop Conditions')
  lines.push('')
  for (const item of value.releaseStopConditions) lines.push(`- ${item}`)
  lines.push('')
  return `${lines.join('\n')}\n`
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

function evidenceStatus(readResult) {
  if (!readResult.exists) return 'missing'
  if (readResult.error) return 'invalid_json'
  return readResult.data?.status ?? 'unknown'
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value, key) {
  return typeof value?.[key] === 'string' ? value[key] : undefined
}
