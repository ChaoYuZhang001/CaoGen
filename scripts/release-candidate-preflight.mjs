#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { candidateIdentityChecks } from './lib/release-matrix-evidence.mjs'

const repoRoot = process.cwd()
const requestedCommit = (argValue('--commit') || process.env.CAOGEN_RELEASE_COMMIT || '').trim().toLowerCase()
const requestedVersion = (argValue('--version') || process.env.CAOGEN_RELEASE_VERSION || '').trim()
const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const gitStatus = git(['status', '--porcelain=v1', '--untracked-files=all'])
const checks = candidateIdentityChecks({
  requestedCommit,
  actualCommit: git(['rev-parse', 'HEAD']).toLowerCase(),
  requestedVersion,
  packageVersion: packageJson.version,
  lockVersion: packageLock.version,
  rootLockVersion: packageLock.packages?.['']?.version,
  worktreeClean: gitStatus === '',
  commitOnMain: isAncestorOfOriginMain(requestedCommit)
})
const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'release-candidate-preflight')
const reportDir = path.join(reportRoot, runId)
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  runId,
  requestedCommit,
  requestedVersion,
  checks,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1

function isAncestorOfOriginMain(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) return false
  return spawnSync('git', ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'], {
    cwd: repoRoot,
    stdio: 'ignore'
  }).status === 0
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}
