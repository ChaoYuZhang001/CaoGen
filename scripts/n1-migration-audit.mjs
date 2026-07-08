#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required') || process.env.CAOGEN_N1_MIGRATION_AUDIT_REQUIRED === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'n1-migration-audit')
const reportDir = path.join(reportRoot, runId)
const recordPath = resolveRecordPath()
const record = recordPath ? readJsonFile(recordPath) : undefined
const failures = []

if (!recordPath) {
  failures.push('missing N1 migration record; set CAOGEN_N1_MIGRATION_RECORD or pass --record <path>')
} else if (record?.error) {
  failures.push(`N1 migration record is not valid JSON: ${record.error}`)
} else {
  validateRecord(record.data)
}

const report = {
  status: failures.length === 0 ? 'passed' : required ? 'failed' : recordPath ? 'failed' : 'skipped',
  required,
  runId,
  reportDir,
  recordPath: recordPath ? path.relative(repoRoot, recordPath) : undefined,
  schemaTemplate: 'docs/N1-MIGRATION-RESULT.template.json',
  drillGuide: 'docs/N1-MIGRATION-DRILL.md',
  redactionPolicy: 'The audit reads a local structured record and reports only fields needed for release gating; do not commit recordings, secrets, private repo names, or private URLs.',
  summary: summarizeRecord(record?.data),
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1
if (!required && recordPath && report.status === 'failed') process.exitCode = 1

function validateRecord(value) {
  if (!isRecord(value)) {
    failures.push('record must be a JSON object')
    return
  }
  requireString(value, 'date')
  requireString(value, 'tester')
  requireString(value, 'testerProfile')
  requireString(value, 'engineProvider')
  requireString(value, 'fixturePath')
  requireString(value, 'screenRecordingPath')
  requireString(value, 'gitCommit')

  const totalMinutes = numberField(value, 'totalMinutes')
  if (!Number.isFinite(totalMinutes)) failures.push('totalMinutes must be a number')
  else if (totalMinutes <= 0) failures.push('totalMinutes must be greater than 0')
  else if (totalMinutes > 30) failures.push(`totalMinutes must be <= 30, got ${totalMinutes}`)

  if (!passLike(value.result)) failures.push('result must be pass/passed/达标')
  if (value.noDocsOrHelp !== true) failures.push('noDocsOrHelp must be true')
  if (value.assetZeroLoss !== true) failures.push('assetZeroLoss must be true')
  if (value.sourceAssetsUnchanged !== true) failures.push('sourceAssetsUnchanged must be true')

  const steps = Array.isArray(value.steps) ? value.steps : []
  if (steps.length !== 7) failures.push(`steps must contain 7 items, got ${steps.length}`)
  const ids = new Set()
  for (const step of steps) {
    if (!isRecord(step)) {
      failures.push('each step must be an object')
      continue
    }
    const id = numberField(step, 'id')
    if (!Number.isInteger(id) || id < 1 || id > 7) failures.push(`step id must be integer 1..7, got ${step.id}`)
    else ids.add(id)
    if (step.completed !== true) failures.push(`step ${id || '?'} completed must be true`)
    const minutes = numberField(step, 'minutes')
    if (!Number.isFinite(minutes) || minutes < 0) failures.push(`step ${id || '?'} minutes must be a non-negative number`)
  }
  for (let id = 1; id <= 7; id += 1) {
    if (!ids.has(id)) failures.push(`steps missing id ${id}`)
  }

  if (Array.isArray(value.blockers) && value.blockers.length > 0) failures.push('blockers must be empty for a passed N1 record')
}

function resolveRecordPath() {
  const explicit = argValue('--record') || process.env.CAOGEN_N1_MIGRATION_RECORD
  const candidates = [
    explicit,
    'test-results/n1-migration/latest.json',
    'docs/N1-MIGRATION-RESULT.json',
    'docs/N1-MIGRATION-DRILL-RESULT.json'
  ].filter(Boolean)
  for (const candidate of candidates) {
    const absolutePath = path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate)
    if (existsSync(absolutePath)) return absolutePath
  }
  return explicit ? (path.isAbsolute(explicit) ? explicit : path.join(repoRoot, explicit)) : undefined
}

function summarizeRecord(value) {
  if (!isRecord(value)) return undefined
  return {
    date: stringField(value, 'date'),
    tester: stringField(value, 'tester'),
    testerProfile: stringField(value, 'testerProfile'),
    engineProvider: stringField(value, 'engineProvider'),
    totalMinutes: numberField(value, 'totalMinutes'),
    result: stringField(value, 'result'),
    noDocsOrHelp: value.noDocsOrHelp === true,
    assetZeroLoss: value.assetZeroLoss === true,
    sourceAssetsUnchanged: value.sourceAssetsUnchanged === true,
    stepCount: Array.isArray(value.steps) ? value.steps.length : 0,
    completedStepCount: Array.isArray(value.steps) ? value.steps.filter((step) => step?.completed === true).length : 0,
    hasScreenRecordingPath: typeof value.screenRecordingPath === 'string' && value.screenRecordingPath.trim().length > 0,
    hasGitCommit: typeof value.gitCommit === 'string' && value.gitCommit.trim().length > 0
  }
}

function readJsonFile(filePath) {
  try {
    return { data: JSON.parse(readFileSync(filePath, 'utf8')), error: undefined }
  } catch (error) {
    return { data: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

function requireString(value, key) {
  if (!stringField(value, key)) failures.push(`${key} must be a non-empty string`)
}

function passLike(value) {
  if (value === true) return true
  if (typeof value !== 'string') return false
  return ['pass', 'passed', '达标'].includes(value.trim().toLowerCase())
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value, key) {
  return typeof value?.[key] === 'string' && value[key].trim() ? value[key].trim() : undefined
}

function numberField(value, key) {
  return typeof value?.[key] === 'number' ? value[key] : Number(value?.[key])
}
