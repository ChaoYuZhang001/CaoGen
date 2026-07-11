#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const finalMode = process.argv.includes('--final') || process.env.CAOGEN_RELEASE_NOTES_FINAL === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'release-notes-audit')
const reportDir = path.join(reportRoot, runId)
const packageJson = readOptionalJson(path.join(repoRoot, 'package.json')) ?? {}
const defaultNotesPath = finalMode ? 'docs/RELEASE-NOTES-FINAL.md' : 'docs/RELEASE-NOTES-DRAFT.md'
const notesPath = normalizePath(argValue('--notes') || process.env.CAOGEN_RELEASE_NOTES_PATH || defaultNotesPath)
const doctorPath = normalizePath(argValue('--doctor') || process.env.CAOGEN_RELEASE_DOCTOR_PATH || 'test-results/workos-release-doctor/latest.json')
const explicitExpectedVersion = argValue('--version') || process.env.CAOGEN_RELEASE_VERSION || ''
const expectedVersion = explicitExpectedVersion || packageJson.version || ''
const gitState = readGitState()
const failures = []
const warnings = []

const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : ''
const doctor = readOptionalJson(doctorPath)
const doctorPackaging = Array.isArray(doctor?.domains)
  ? doctor.domains.find((domain) => domain?.id === 'packaging_release')
  : undefined

if (!existsSync(notesPath)) {
  failures.push(`release notes file is missing: ${path.relative(repoRoot, notesPath)}`)
} else {
  validateNotes(notes)
}

const report = {
  status: failures.length === 0 ? 'passed' : required ? 'failed' : existsSync(notesPath) ? 'failed' : 'skipped',
  required,
  mode: finalMode ? 'final' : 'draft',
  runId,
  reportDir,
  notesPath: path.relative(repoRoot, notesPath),
  expectedVersion,
  expectedVersionSource: explicitExpectedVersion ? 'explicit' : 'package.json',
  doctorPath: path.relative(repoRoot, doctorPath),
  doctorStatus: doctor?.status,
  doctorOpenDomains: Array.isArray(doctor?.openDomains) ? doctor.openDomains : [],
  doctorReleaseTarget: doctor?.releaseTarget,
  doctorGit: doctor?.git,
  artifactSetSha256: finalMode ? doctorPackaging?.artifacts?.artifactSetSha256 : undefined,
  git: gitState,
  redactionPolicy: 'No secret values are emitted. The audit reports only release-note structure, required claims, and failure categories.',
  warnings,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1
if (!required && existsSync(notesPath) && report.status === 'failed') process.exitCode = 1

function validateNotes(text) {
  if (!expectedVersion) failures.push('unable to determine expected release version from package.json or explicit version')
  else requireText(text, expectedVersion, `release notes must mention ${expectedVersion}`)
  requireHeading(text, 'Release Decision')
  requireHeading(text, 'Uploaded Assets')
  requireHeading(text, 'Truth Boundary')
  requireHeading(text, 'Known Blockers')
  requireHeading(text, 'Security Statement')
  requireHeading(text, 'macOS First Open')
  requireText(text, 'GitHub Releases', 'release notes must name GitHub Releases as the distribution channel')
  if (!finalMode) {
    requireText(text, 'latest public release', 'draft notes must preserve the latest public release boundary until a new release is published')
    requireAny(text, [/no new release assets uploaded yet/i, /no .*assets uploaded yet/i], 'draft notes must state that no new release assets have been uploaded yet')
  }
  requireText(text, 'real keys', 'release notes must include a credential exclusion statement')
  requireText(text, 'test-results', 'release notes must exclude local evidence/test artifacts')
  requireText(text, 'latest*.yml', 'release notes must mention public update metadata assets')

  scanForbiddenSecrets(text)
  scanForbiddenPublicPositioning(text)
  scanOverclaims(text)
  validateDoctorAlignment(text)
  validateFinalMode(text)
}

function validateDoctorAlignment(text) {
  if (!doctor) {
    warnings.push(`release doctor report not found: ${path.relative(repoRoot, doctorPath)}`)
    return
  }
  if (!finalMode && doctor.status === 'not_ready') {
    requireAny(text, [/Do not publish/i, /not ready/i], 'draft notes must say not to publish while release doctor is not_ready')
  }
  const openDomains = Array.isArray(doctor.openDomains) ? doctor.openDomains : []
  if (!finalMode) {
    for (const domain of openDomains) {
      requireText(text, domain, `release notes must list open release domain: ${domain}`)
    }
  }
  if (finalMode) {
    if (doctor.releaseTarget?.version !== expectedVersion) {
      failures.push(`final release notes require doctor target version ${expectedVersion}, got ${doctor.releaseTarget?.version || 'missing'}`)
    }
    if (doctor.currentPackageVersion !== expectedVersion) {
      failures.push(`final release notes require doctor package version ${expectedVersion}, got ${doctor.currentPackageVersion || 'missing'}`)
    }
    if (doctor.git?.commit !== gitState.commit) {
      failures.push(`final release notes require doctor commit ${gitState.commit || 'unknown'}, got ${doctor.git?.commit || 'missing'}`)
    }
    if (doctor.git?.worktreeClean !== true) {
      failures.push('final release notes require a doctor report generated from a clean worktree')
    }
    if (!gitState.worktreeClean) {
      failures.push('final release notes must be audited from a clean worktree')
    }
    const refreshCommands = Array.isArray(doctor.refresh?.commands) ? doctor.refresh.commands : []
    if (doctor.refresh?.enabled !== true) {
      failures.push('final release notes require a refreshed preflight doctor report')
    }
    const failedRefreshCommands = refreshCommands.filter((item) => item?.status !== 'completed')
    if (refreshCommands.length === 0 || failedRefreshCommands.length > 0) {
      failures.push(`final release notes require every doctor refresh command to complete${failedRefreshCommands.length > 0 ? `: ${failedRefreshCommands.map((item) => item?.id || 'unknown').join(', ')}` : ''}`)
    }
  }
}

function validateFinalMode(text) {
  if (!finalMode) return
  if (!doctor) {
    failures.push('final release notes require a workos-release-doctor report')
  } else {
    const openDomains = Array.isArray(doctor.openDomains) ? doctor.openDomains : []
    const blockingDomains = openDomains.filter((domain) => domain !== 'release_notes')
    if (doctor.status !== 'ready' && (openDomains.length === 0 || blockingDomains.length > 0)) {
      failures.push(`final release notes require every doctor domain except release_notes to be ready${blockingDomains.length > 0 ? `: ${blockingDomains.join(', ')}` : ''}`)
    }
  }
  if (/Do not publish|not ready|No (?:new )?.*assets uploaded yet/i.test(text)) {
    failures.push('final release notes must not contain draft-only blocked-release language')
  }
  validateFinalAssets(text)
}

function validateFinalAssets(text) {
  const expectedFiles = doctorPackaging?.artifacts?.files
  if (!isRecord(expectedFiles) || Object.keys(expectedFiles).length === 0) {
    failures.push('final release notes require packaging artifact evidence from the preflight doctor')
    return
  }
  const section = markdownSection(text, 'Uploaded Assets')
  if (!section) {
    failures.push('final release notes must include an Uploaded Assets section')
    return
  }
  const listedAssets = section
    .split(/\r?\n/)
    .map((line) => /^-\s+`([^`]+)`\s*$/.exec(line.trim())?.[1])
    .filter(Boolean)
  const expectedNames = Object.keys(expectedFiles).sort()
  const listedNames = [...new Set(listedAssets)].sort()
  if (listedAssets.length !== listedNames.length) failures.push('final release notes contain duplicate uploaded asset names')
  if (JSON.stringify(listedNames) !== JSON.stringify(expectedNames)) {
    failures.push(`final release notes uploaded assets must exactly match packaging evidence; expected ${expectedNames.join(', ')}`)
  }

  const shaMatches = section
    .split(/\r?\n/)
    .map((line) => /^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$/i.exec(line.trim()))
    .filter(Boolean)
  const shaRows = Object.fromEntries(shaMatches.map((match) => [match[1], match[2].toLowerCase()]))
  const shaNames = Object.keys(shaRows).sort()
  if (shaMatches.length !== shaNames.length) failures.push('final release notes contain duplicate SHA256 rows')
  if (JSON.stringify(shaNames) !== JSON.stringify(expectedNames)) {
    failures.push('final release notes SHA256 table must contain exactly one row for every uploaded asset')
  }
  for (const name of expectedNames) {
    if (shaRows[name] !== expectedFiles[name]?.sha256) {
      failures.push(`final release notes SHA256 mismatch for ${name}`)
    }
  }
}

function markdownSection(text, heading) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'i').test(line))
  if (start < 0) return ''
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line))
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset
  return lines.slice(start + 1, end).join('\n')
}

function scanOverclaims(text) {
  const forbidden = [
    { name: 'genesis-executes-external-agents', regex: /Genesis\s+(?:can\s+)?(?:execute|run|merge|push|publish)\b/i },
    { name: 'auto-publish-overclaim', regex: /\b(auto[- ]?publish|automatic publish|自动发布)\b/i },
    { name: 'auto-merge-overclaim', regex: /\b(auto[- ]?merge|automatic merge|自动合并)\b/i },
    { name: 'fully-replaces-competitors', regex: /\b(fully replaces|drop-in replacement for|平替所有|完全平替)\b/i },
    { name: 'windows-gui-proved-before-evidence', regex: /\bWindows GUI\b.*\b(proved|ready|supported)\b/i },
    { name: 'china-external-proved-before-evidence', regex: /\bChina\b.*\b(real network|external)\b.*\b(proved|ready|supported)\b/i }
  ]
  for (const item of forbidden) {
    if (item.regex.test(text)) failures.push(`release notes contain forbidden overclaim: ${item.name}`)
  }
}

function scanForbiddenPublicPositioning(text) {
  const previouslyForcedVersion = ['0', '2', '0'].join('.')
  const escapedPreviouslyForcedVersion = escapeRegExp(previouslyForcedVersion)
  const forbidden = [
    { name: 'fixed-v-future-target', regex: new RegExp(`\\bv${escapedPreviouslyForcedVersion}\\b`, 'g') },
    { name: 'fixed-future-target', regex: new RegExp(`(?<![0-9.])${escapedPreviouslyForcedVersion}(?![0-9.])`, 'g') },
    { name: 'competitor-Codex', regex: /\bCodex\b/g },
    { name: 'competitor-Claude', regex: /\bClaude(?:\s+Code)?\b/g },
    { name: 'competitor-Hermes', regex: /\bHermes\b/g },
    { name: 'competitor-OpenClaw', regex: /\bOpenClaw\b/g },
    { name: 'competitor-CCswitch', regex: /\bCCswitch\b/g },
    { name: 'competitor-tutti', regex: /\bTutti\b|\btutti\b/g }
  ]
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const item of forbidden) {
      item.regex.lastIndex = 0
      if (item.regex.test(line)) failures.push(`${index + 1}: release notes contain forbidden public positioning term: ${item.name}`)
    }
  }
}

function scanForbiddenSecrets(text) {
  const patterns = [
    { name: 'openai-or-anthropic-key', regex: /(?<![A-Za-z0-9_])sk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{20,}/g },
    { name: 'github-token', regex: /(?<![A-Za-z0-9_])(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
    { name: 'aws-access-key', regex: /(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}/g },
    { name: 'google-api-key', regex: /(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{20,}/g },
    { name: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
  ]
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0
      if (pattern.regex.test(line)) failures.push(`${index + 1}: ${pattern.name}`)
    }
  }
}

function requireHeading(text, heading) {
  const pattern = new RegExp(`^#{2,3}\\s+${escapeRegExp(heading)}\\s*$`, 'im')
  if (!pattern.test(text)) failures.push(`missing release notes section: ${heading}`)
}

function requireText(text, value, message) {
  if (!text.toLowerCase().includes(value.toLowerCase())) failures.push(message)
}

function requireAny(text, patterns, message) {
  if (!patterns.some((pattern) => pattern.test(text))) failures.push(message)
}

function readOptionalJson(filePath) {
  if (!existsSync(filePath)) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    warnings.push(`unable to parse release doctor report: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function readGitState() {
  const commit = gitOutput(['rev-parse', 'HEAD'])
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    commit,
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
