#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const required = process.argv.includes('--required')
const asarPath = path.resolve(repoRoot, argValue('--asar') || 'dist/win-unpacked/resources/app.asar')
const runtimeReportPath = path.resolve(
  repoRoot,
  argValue('--runtime-report') || 'test-results/watercolor-runtime-assets/latest.json'
)
const releaseAuditPath = path.resolve(
  repoRoot,
  argValue('--release-audit') || 'test-results/windows-preview-audit/latest-x64.json'
)
const reportRoot = path.join(repoRoot, 'test-results', 'watercolor-packaged-assets')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(reportRoot, runId)

const failures = []
const runtimeReport = readJson(runtimeReportPath, 'runtime asset report')
const releaseAudit = readJson(releaseAuditPath, 'Windows preview audit')
if (!existsSync(asarPath)) failures.push(`app.asar is missing: ${reportPath(asarPath)}`)

const expectedFiles = Array.isArray(runtimeReport?.files)
  ? runtimeReport.files.filter((item) => item?.ok === true && typeof item.filename === 'string')
  : []
if (runtimeReport?.status !== 'pass' || runtimeReport?.counts?.passed !== 49 || expectedFiles.length !== 49) {
  failures.push('runtime asset report is not a complete 49/49 pass')
}

const archiveEntries = existsSync(asarPath)
  ? asar.listPackage(asarPath).map((entry) => entry.replaceAll('\\', '/').replace(/^\//, ''))
  : []
const packagedAssetPattern = /^out\/renderer\/assets\/(role-(?:researcher|planner|writer|designer|developer|review-test|operations)-state-(?:idle|thinking|tool-running|awaiting-approval|blocked|repairing|delivering)-v01)-[A-Za-z0-9_-]+\.png$/
const packagedEntries = archiveEntries.filter((entry) => packagedAssetPattern.test(entry))
const matchedEntries = new Set()
const files = expectedFiles.map((expected) => {
  const sourceStem = expected.filename.replace(/\.png$/i, '')
  const matches = packagedEntries.filter((entry) => packagedAssetPattern.exec(entry)?.[1] === sourceStem)
  if (matches.length !== 1) {
    failures.push(`${expected.filename}: expected exactly one packaged asset, found ${matches.length}`)
    return {
      filename: expected.filename,
      packagedPath: matches.length === 1 ? matches[0] : null,
      status: 'failed',
      failure: `expected exactly one packaged asset, found ${matches.length}`
    }
  }
  const packagedPath = matches[0]
  matchedEntries.add(packagedPath)
  let bytes
  try {
    bytes = asar.extractFile(asarPath, packagedPath.replaceAll('/', path.sep))
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    failures.push(`${expected.filename}: cannot extract packaged asset: ${failure}`)
    return {
      filename: expected.filename,
      packagedPath,
      status: 'failed',
      failure
    }
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const digestMatches = sha256 === expected.sha256
  const sizeMatches = bytes.length === expected.bytes
  if (!digestMatches || !sizeMatches) failures.push(`${expected.filename}: packaged bytes differ from the verified runtime asset`)
  return {
    filename: expected.filename,
    packagedPath,
    status: digestMatches && sizeMatches ? 'passed' : 'failed',
    sourceBytes: expected.bytes,
    packagedBytes: bytes.length,
    sourceSha256: expected.sha256,
    packagedSha256: sha256
  }
})

const unexpected = packagedEntries.filter((entry) => !matchedEntries.has(entry))
if (unexpected.length > 0) failures.push(`unexpected packaged watercolor assets: ${unexpected.join(', ')}`)
if (packagedEntries.length !== 49) failures.push(`expected 49 packaged watercolor assets, found ${packagedEntries.length}`)

const auditedAsarPath = releaseAudit?.buildProvenance?.app?.asarPath
  ? path.resolve(repoRoot, releaseAudit.buildProvenance.app.asarPath)
  : null
const releaseAuditBound = releaseAudit?.status === 'passed' &&
  releaseAudit?.mode === 'post_build' &&
  auditedAsarPath === asarPath &&
  /^[a-f0-9]{64}$/i.test(releaseAudit?.artifactSetSha256 || '')
if (!releaseAuditBound) failures.push('Windows preview audit is not bound to this app.asar build input')

const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  evidenceClass: 'packaged_build_input',
  closesInstalledPackageVisualAcceptance: false,
  required,
  runId,
  reportDir: reportPath(reportDir),
  asarPath: reportPath(asarPath),
  asarSha256: existsSync(asarPath) ? sha256File(asarPath) : null,
  runtimeReport: reportPath(runtimeReportPath),
  releaseAudit: {
    path: reportPath(releaseAuditPath),
    bound: releaseAuditBound,
    artifactSetSha256: releaseAudit?.artifactSetSha256 || null,
    installer: releaseAudit?.artifacts?.installer || null
  },
  counts: {
    expected: expectedFiles.length,
    packaged: packagedEntries.length,
    matched: files.filter((item) => item.status === 'passed').length,
    unexpected: unexpected.length
  },
  unexpected,
  files,
  failures,
  policy: 'This proves the audited prepackaged app.asar input. Installed-package digest parity and human visual acceptance remain separate gates.'
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  status: report.status,
  evidenceClass: report.evidenceClass,
  asarSha256: report.asarSha256,
  releaseAudit: report.releaseAudit,
  counts: report.counts,
  failures: report.failures
}, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1

function readJson(filePath, label) {
  if (!existsSync(filePath)) {
    failures.push(`${label} is missing: ${reportPath(filePath)}`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    failures.push(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function reportPath(filePath) {
  const relative = path.relative(repoRoot, filePath)
  return relative && !relative.startsWith('..') ? relative : filePath
}
