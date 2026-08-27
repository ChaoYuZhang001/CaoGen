import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export function readSourceEvidenceState(repoRoot) {
  const commit = gitText(repoRoot, ['rev-parse', 'HEAD'])
  const status = gitText(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  const trackedDiff = execFileSync('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], { cwd: repoRoot })
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).length : 0,
    checkoutDigest: createHash('sha256').update(status).update('\0').update(trackedDiff).digest('hex')
  }
}

export function sourceEvidenceDrift(start, end) {
  const drift = []
  if (end.commit !== start.commit) drift.push(`commit changed from ${start.commit} to ${end.commit}`)
  if (end.checkoutDigest !== start.checkoutDigest) drift.push('worktree contents changed during the run')
  return drift
}

export function bindSourceEvidence(report, start, end, label) {
  const drift = sourceEvidenceDrift(start, end)
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
    report.error = report.error ? `${report.error}; ${message}` : message
    report.warnings.push(message)
  }
  return report.provenance
}

function gitText(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}
