#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runAudit = process.argv.includes('--audit')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'release-sbom')
const reportDir = path.join(reportRoot, runId)
const packageJson = readJson('package.json')
const lockfile = readJson('package-lock.json')
const packages = lockfile.packages || {}
const components = Object.entries(packages)
  .filter(([relativePath]) => relativePath !== '')
  .map(([relativePath, entry]) => componentFor(relativePath, entry))
  .filter(Boolean)
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
const missingIntegrity = Object.entries(packages)
  .filter(([relativePath, entry]) => relativePath !== '' && isRegistryPackage(entry) && !entry.integrity)
  .map(([relativePath]) => relativePath)
const vulnerabilities = runAudit ? npmAudit() : { executed: false, status: 'not_run', high: null, critical: null }
const failures = []
if (lockfile.lockfileVersion !== 3) failures.push(`package-lock lockfileVersion must be 3, got ${lockfile.lockfileVersion}`)
if (packageJson.version !== lockfile.version || packageJson.version !== lockfile.packages?.['']?.version) {
  failures.push('package.json and package-lock versions do not match')
}
if (components.length === 0) failures.push('CycloneDX component inventory is empty')
if (missingIntegrity.length > 0) failures.push(`${missingIntegrity.length} registry packages lack integrity metadata`)
if (required && !runAudit) failures.push('required SBOM audit must run with --audit')
if (required && vulnerabilities.status !== 'passed') failures.push(`npm audit status is ${vulnerabilities.status}`)
if (vulnerabilities.critical > 0) failures.push(`npm audit reports ${vulnerabilities.critical} critical vulnerabilities`)
if (vulnerabilities.high > 0) failures.push(`npm audit reports ${vulnerabilities.high} high vulnerabilities without a recorded disposition`)

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(0, 8)}-${createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(8, 12)}-5${createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(13, 16)}-8${createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(17, 20)}-${createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(20, 32)}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: packageJson.productName || packageJson.name, version: packageJson.version }
  },
  components
}
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  required,
  runId,
  reportDir,
  packageVersion: packageJson.version,
  commit: gitOutput(['rev-parse', 'HEAD']),
  worktreeClean: gitOutput(['status', '--porcelain=v1', '--untracked-files=all']) === '',
  bomFormat: 'CycloneDX 1.5',
  componentCount: components.length,
  missingIntegrity,
  vulnerabilityAudit: vulnerabilities,
  failures,
  bomDigest: stableBomDigest(bom)
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'bom.json'), `${JSON.stringify(bom, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.bom.json'), `${JSON.stringify(bom, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1

function componentFor(relativePath, entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.version !== 'string') return null
  const name = packageName(relativePath)
  if (!name) return null
  const integrityHash = parseIntegrity(entry.integrity)
  return {
    type: 'library',
    name,
    version: entry.version,
    scope: relativePath.includes('node_modules/') ? 'required' : 'optional',
    purl: `pkg:npm/${encodeURIComponent(name).replace(/%2F/g, '/')}@${entry.version}`,
    ...(integrityHash ? { hashes: [integrityHash] } : {})
  }
}

function parseIntegrity(value) {
  if (typeof value !== 'string') return null
  const separator = value.indexOf('-')
  if (separator <= 0) return null
  const algorithm = value.slice(0, separator).toLowerCase()
  const content = value.slice(separator + 1)
  const labels = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }
  if (!labels[algorithm] || !content) return null
  try {
    return { alg: labels[algorithm], content: Buffer.from(content, 'base64').toString('hex') }
  } catch {
    return null
  }
}

function packageName(relativePath) {
  const marker = 'node_modules/'
  const index = relativePath.lastIndexOf(marker)
  if (index < 0) return null
  const rest = relativePath.slice(index + marker.length)
  if (rest.startsWith('@')) {
    const parts = rest.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return rest.split('/')[0] || null
}

function isRegistryPackage(entry) {
  return typeof entry?.resolved === 'string' && /^https?:\/\//.test(entry.resolved)
}

function npmAudit() {
  try {
    const output = execFileSync('npm', ['audit', '--json', '--ignore-scripts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024
    })
    return summarizeAudit(JSON.parse(output))
  } catch (error) {
    const raw = `${error?.stdout || ''}`
    try {
      return summarizeAudit(JSON.parse(raw))
    } catch {
      return { executed: true, status: 'unavailable', high: null, critical: null, error: 'npm audit did not return JSON' }
    }
  }
}

function summarizeAudit(value) {
  const counts = value?.metadata?.vulnerabilities || {}
  const high = Number(counts.high || 0)
  const critical = Number(counts.critical || 0)
  return { executed: true, status: high === 0 && critical === 0 ? 'passed' : 'findings', high, critical }
}

function stableBomDigest(bom) {
  const digestInput = {
    ...bom,
    metadata: { component: bom.metadata.component }
  }
  return createHash('sha256').update(JSON.stringify(digestInput)).digest('hex')
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}
