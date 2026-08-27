import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bindSourceEvidence, readSourceEvidenceState } from './source-evidence-binding.mjs'

export function createProviderEvidenceReport(runId, gate, checks) {
  return {
    schemaVersion: 1,
    runId,
    gate,
    status: 'failed',
    ok: false,
    pass: 0,
    total: 0,
    checks,
    failures: [],
    warnings: []
  }
}

export function markProviderEvidencePassed(report) {
  report.status = 'passed'
  report.ok = true
  report.generatedAt = new Date().toISOString()
  report.pass = report.checks.length
  report.total = report.checks.length
}

export function markProviderEvidenceFailed(report, error, message) {
  report.status = 'failed'
  report.ok = false
  report.pass = report.checks.filter((check) => check.status === 'pass').length
  report.total = report.checks.length
  report.failures.push({ message, errorDigest: digestError(error) })
}

export function writeProviderEvidenceReport(input) {
  const provenance = bindSourceEvidence(
    input.report,
    input.sourceAtStart,
    readSourceEvidenceState(input.repoRoot),
    input.label
  )
  if (provenance.status !== 'pass') markReportFailed(input.report, input.report.error)
  mkdirSync(input.reportDir, { recursive: true })
  let body = serialize(input.report)
  if (input.redaction?.contains(body, input.redaction.markers)) {
    markReportFailed(input.report, input.redaction.failureMessage, true)
    body = serialize(input.report)
  }
  writeFileSync(path.join(input.reportDir, 'report.json'), body, 'utf8')
  writeFileSync(path.join(input.reportRoot, 'latest.json'), body, 'utf8')
  return input.report.status === 'passed'
}

function markReportFailed(report, message, replaceFailures = false) {
  report.status = 'failed'
  report.ok = false
  const failure = { message }
  if (replaceFailures) report.failures = [failure]
  else report.failures.push(failure)
}

function digestError(error) {
  const value = error instanceof Error ? error.stack || error.message : String(error)
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function serialize(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}
