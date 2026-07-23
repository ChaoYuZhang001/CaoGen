#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildAcceptanceMap } from './lib/product-acceptance-map.mjs'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'product-1.0-acceptance-audit')
const reportDir = path.join(reportRoot, runId)
const prdPath = path.join(repoRoot, 'docs', 'PRODUCT-REQUIREMENTS.md')
const matrixPath = path.join(repoRoot, 'docs', '1.0-ACCEPTANCE-MATRIX.md')
const prdMarkdown = readFileSync(prdPath, 'utf8')
const matrixMarkdown = existsSync(matrixPath) ? readFileSync(matrixPath, 'utf8') : ''
const packageJson = readJson(path.join(repoRoot, 'package.json'))
const requirements = parseRequirements(prdMarkdown)
const p0 = requirements.filter((item) => item.priority === 'P0')
const p1 = requirements.filter((item) => item.priority === 'P1')
const verifiedP0 = p0.filter((item) => item.status === '当前已验证')
const openP0 = p0.filter((item) => item.status !== '当前已验证')
const openP1 = p1.filter((item) => item.status === '立项目标')
const failures = []

if (p0.length !== 64) failures.push(`PRD P0 inventory changed: expected 64, got ${p0.length}`)
if (p1.length !== 38) failures.push(`PRD P1 inventory changed: expected 38, got ${p1.length}`)
if (!existsSync(matrixPath)) failures.push('docs/1.0-ACCEPTANCE-MATRIX.md is missing')
if (openP0.length > 0) failures.push(`${openP0.length} P0 requirements are not fully verified`)
const acceptanceMap = buildAcceptanceMap({
  prdMarkdown,
  matrixMarkdown,
  packageScripts: packageJson.scripts ?? {},
  expectedCounts: { P0: 64, P1: 38 }
})
if (acceptanceMap.structuralFailures.length > 0) {
  failures.push(`${acceptanceMap.structuralFailures.length} acceptance-map structural failures`)
}
if (acceptanceMap.closureFailures.length > 0) {
  failures.push(`${acceptanceMap.closureFailures.length} acceptance-map closure failures`)
}

const report = {
  schemaVersion: 1,
  status: failures.length === 0 ? 'passed' : 'failed',
  required,
  requirement: required ? 'required' : 'informational',
  runId,
  reportDir,
  packageVersion: packageJson.version,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version
  },
  source: 'docs/PRODUCT-REQUIREMENTS.md',
  matrix: 'docs/1.0-ACCEPTANCE-MATRIX.md',
  summary: {
    p0: { total: p0.length, verified: verifiedP0.length, open: openP0.length, statuses: countStatuses(p0) },
    p1: { total: p1.length, openTargets: openP1.length, statuses: countStatuses(p1) }
  },
  acceptanceMap: {
    structuralStatus: acceptanceMap.structuralFailures.length === 0 ? 'passed' : 'failed',
    closureStatus: acceptanceMap.closureFailures.length === 0 ? 'passed' : 'failed',
    summary: acceptanceMap.summary,
    structuralFailures: acceptanceMap.structuralFailures,
    closureFailureCount: acceptanceMap.closureFailures.length
  },
  openP0,
  openP1,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1

function parseRequirements(markdown) {
  const rows = []
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*([A-Z][A-Z0-9-]+-\d+)\s*\|\s*(P[012])\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/)
    if (!match) continue
    rows.push({
      id: match[1],
      priority: match[2],
      status: normalizeCell(match[3]),
      requirement: normalizeCell(match[4])
    })
  }
  return rows
}

function normalizeCell(value) {
  return value.replace(/\*\*/g, '').replace(/`/g, '').trim()
}

function countStatuses(items) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item.status))]
      .sort()
      .map((status) => [status, items.filter((item) => item.status === status).length])
  )
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}
