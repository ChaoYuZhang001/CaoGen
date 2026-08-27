import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'

export function readSourceEvidenceState(repoRoot) {
  const commit = gitText(repoRoot, ['rev-parse', 'HEAD'])
  const status = execFileSync(
    'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoRoot }
  )
  const statusEntryCount = countPorcelainEntries(status)
  const trackedDiff = execFileSync('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], { cwd: repoRoot })
  const untrackedPaths = nullSeparatedEntries(execFileSync(
    'git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot }
  )).sort(Buffer.compare)
  const hash = createHash('sha256').update(status).update('\0').update(trackedDiff)
  for (const relativePath of untrackedPaths) {
    const relativePathText = relativePath.toString('utf8')
    const absolutePath = path.join(repoRoot, relativePathText)
    const stat = lstatSync(absolutePath)
    hash.update('\0untracked\0').update(relativePath).update('\0')
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0').update(readlinkSync(absolutePath, 'buffer'))
    } else if (stat.isFile()) {
      hash.update('file\0').update(String(stat.mode & 0o777)).update('\0').update(readFileSync(absolutePath))
    } else {
      hash.update(`other:${stat.mode & 0o170000}`)
    }
  }
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount,
    checkoutDigest: hash.digest('hex')
  }
}

function countPorcelainEntries(buffer) {
  const records = nullSeparatedEntries(buffer)
  let count = 0
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index].subarray(0, 2).toString('ascii')
    count += 1
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return count
}

function nullSeparatedEntries(buffer) {
  const entries = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    if (index > start) entries.push(buffer.subarray(start, index))
    start = index + 1
  }
  if (start < buffer.length) entries.push(buffer.subarray(start))
  return entries
}

export function sourceEvidenceDrift(start, end) {
  const drift = []
  if (end.commit !== start.commit) drift.push(`commit changed from ${start.commit} to ${end.commit}`)
  if (end.checkoutDigest !== start.checkoutDigest) drift.push('worktree contents changed during the run')
  return drift
}

export function bindSourceEvidence(report, start, end, label) {
  const drift = sourceEvidenceDrift(start, end)
  if (!Array.isArray(report.warnings)) report.warnings = []
  report.sourceRevision = start.commit
  report.sourceRevisionAtEnd = end.commit
  report.sourceWorktreeClean = start.worktreeClean
  report.sourceWorktreeCleanAtEnd = end.worktreeClean
  report.sourceStatusEntryCount = start.statusEntryCount
  report.sourceStatusEntryCountAtEnd = end.statusEntryCount
  report.sourceCheckoutDigest = start.checkoutDigest
  report.sourceCheckoutDigestAtEnd = end.checkoutDigest
  report.provenance = {
    status: drift.length === 0 ? 'pass' : 'fail',
    start,
    end,
    drift
  }
  if (drift.length > 0) {
    const message = `${label} evidence invalidated: ${drift.join('; ')}`
    const existingError = typeof report.error === 'string'
      ? report.error
      : report.error ? JSON.stringify(report.error) : ''
    report.error = existingError ? `${existingError}; ${message}` : message
    report.warnings.push(message)
  }
  return report.provenance
}

function gitText(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}
