import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const BUILD_EVIDENCE_FILE = '.caogen-build-evidence.json'
export const REQUIRED_BUILD_ENTRIES = [
  'main/index.js',
  'preload/index.js',
  'renderer/index.html'
]

export function readBuildEvidence(repoRoot) {
  const evidencePath = path.join(repoRoot, 'out', BUILD_EVIDENCE_FILE)
  if (!existsSync(evidencePath)) {
    throw new Error('Built app evidence is missing. Run npm run build first.')
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  if (evidence?.schemaVersion !== 1 || evidence?.kind !== 'caogen-build-evidence') {
    throw new Error('Built app evidence has an unsupported schema')
  }
  return evidence
}

export function snapshotBuildOutput(repoRoot) {
  const outRoot = path.join(repoRoot, 'out')
  const files = existsSync(outRoot) ? listFiles(outRoot) : []
  const hash = createHash('sha256')
  let totalBytes = 0
  let fileCount = 0
  for (const filePath of files) {
    const relativePath = path.relative(outRoot, filePath).split(path.sep).join('/')
    if (relativePath === BUILD_EVIDENCE_FILE) continue
    const bytes = readFileSync(filePath)
    hash.update(relativePath)
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
    totalBytes += bytes.length
    fileCount += 1
  }
  return { digest: hash.digest('hex'), fileCount, totalBytes }
}

export function verifyBuildEvidence(repoRoot, sourceState) {
  const evidence = readBuildEvidence(repoRoot)
  const output = snapshotBuildOutput(repoRoot)
  const errors = [
    ...validateBuildRecord(evidence),
    ...validateBuildSource(evidence, sourceState),
    ...validateBuildOutput(repoRoot),
    ...validateRecordedOutput(evidence, output)
  ]
  return { status: errors.length === 0 ? 'pass' : 'fail', errors, evidence, output }
}

function validateBuildRecord(evidence) {
  const errors = []
  if (evidence.status !== 'passed') errors.push(`build evidence status is ${evidence.status}`)
  if (evidence.outputValidation?.status !== 'pass') errors.push('recorded build output validation did not pass')
  return errors
}

function validateBuildSource(evidence, sourceState) {
  const errors = []
  const source = evidence.source
  if (source?.status !== 'pass' || !Array.isArray(source?.drift) || source.drift.length > 0) {
    errors.push('recorded build source provenance did not pass without drift')
  }
  for (const boundary of ['start', 'end']) errors.push(...validateBuildBoundary(source?.[boundary], boundary, sourceState))
  return errors
}

function validateBuildBoundary(boundary, name, sourceState) {
  const errors = []
  if (boundary?.commit !== sourceState.commit) {
    errors.push(`build ${name} commit ${boundary?.commit ?? 'missing'} does not match ${sourceState.commit}`)
  }
  if (boundary?.checkoutDigest !== sourceState.checkoutDigest) {
    errors.push(`build ${name} checkout digest does not match the current source`)
  }
  if (boundary?.worktreeClean !== sourceState.worktreeClean ||
      boundary?.statusEntryCount !== sourceState.statusEntryCount) {
    errors.push(`build ${name} worktree state does not match the current source`)
  }
  return errors
}

function validateRecordedOutput(evidence, output) {
  const recorded = evidence.output
  return recorded?.digest === output.digest && recorded?.fileCount === output.fileCount &&
    recorded?.totalBytes === output.totalBytes
    ? []
    : ['built output digest does not match the recorded output']
}

export function validateBuildOutput(repoRoot) {
  const errors = []
  const outRoot = path.join(repoRoot, 'out')
  for (const relativePath of REQUIRED_BUILD_ENTRIES) {
    const filePath = path.join(outRoot, relativePath)
    if (!existsSync(filePath)) {
      errors.push(`required build entry is missing: out/${relativePath}`)
      continue
    }
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
      errors.push(`required build entry is empty or not a file: out/${relativePath}`)
    }
  }
  if (existsSync(outRoot)) {
    for (const entry of unsafeOutputEntries(outRoot)) {
      errors.push(`unsafe build output ${entry.type}: out/${entry.path}`)
    }
  }
  return errors
}

function listFiles(root) {
  const result = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...listFiles(filePath))
    else if (entry.isFile()) result.push(filePath)
  }
  return result.sort()
}

function unsafeOutputEntries(root, relativeRoot = '') {
  const result = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = path.join(relativeRoot, entry.name)
    const absolutePath = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...unsafeOutputEntries(absolutePath, relativePath))
    else if (!entry.isFile()) {
      result.push({
        path: relativePath.split(path.sep).join('/'),
        type: entry.isSymbolicLink() ? 'symbolic link' : 'special entry'
      })
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path))
}
