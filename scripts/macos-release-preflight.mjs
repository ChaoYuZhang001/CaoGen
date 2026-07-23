#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const configOnly = process.argv.includes('--config-only')
const targetArch = argValue('--arch') || process.arch
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'macos-release-preflight')
const reportDir = path.join(reportRoot, runId)
const checks = []

const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const releaseConfig = require(path.join(repoRoot, 'electron-builder.release.cjs'))
const mac = releaseConfig.mac || {}

check('package version is stable semver', /^\d+\.\d+\.\d+$/.test(packageJson.version || ''))
check('package and lock versions match', packageLock.version === packageJson.version && packageLock.packages?.['']?.version === packageJson.version)
check('release signing cannot be disabled', mac.identity !== null)
check('release requires code signing', mac.forceCodeSigning === true)
check('release enables hardened runtime', mac.hardenedRuntime === true)
check('release enables notarization', mac.notarize === true)
check('release minimum macOS is 14.0 or newer', compareVersions(mac.minimumSystemVersion, '14.0') >= 0)
check('release includes DMG and ZIP targets', hasTarget(mac.target, 'dmg') && hasTarget(mac.target, 'zip'))
check(
  'release preserves the upstream Anthropic CLI signature',
  asArray(mac.signIgnore).some((pattern) => pattern.includes('claude-agent-sdk-darwin-(x64|arm64)/claude$'))
)
check(
  'release declares Apple Events usage',
  typeof mac.extendInfo?.NSAppleEventsUsageDescription === 'string' && mac.extendInfo.NSAppleEventsUsageDescription.trim().length > 0
)

validateEntitlements(mac.entitlements, [
  'com.apple.security.automation.apple-events',
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
])
validateEntitlements(mac.entitlementsInherit, [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
])

let signingIdentityCount = 0
let notarizationMethod = 'not_checked'
if (!configOnly) {
  check('release preflight runs on macOS', process.platform === 'darwin')
  check('target architecture is supported', targetArch === 'x64' || targetArch === 'arm64')
  if (targetArch === 'arm64') {
    check('arm64 release runs on Apple Silicon', process.arch === 'arm64')
  }
  check('release worktree is clean', gitOutput(['status', '--porcelain=v1', '--untracked-files=all']) === '')

  const identities = commandOutput('security', ['find-identity', '-v', '-p', 'codesigning'])
    .split(/\r?\n/)
    .filter((line) => /"Developer ID Application:/.test(line))
  signingIdentityCount = identities.length
  check('Developer ID Application identity is available', signingIdentityCount > 0)

  const cscLinkSet = envSet('CSC_LINK')
  const cscPasswordSet = envSet('CSC_KEY_PASSWORD')
  check('CSC_LINK credentials are complete when used', cscLinkSet === cscPasswordSet)
  if (envSet('CSC_NAME')) check('CSC_NAME selects Developer ID Application', /Developer ID Application/.test(process.env.CSC_NAME || ''))

  const credentialSets = [
    { name: 'api_key', variables: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] },
    { name: 'apple_id', variables: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] },
    { name: 'keychain_profile', variables: ['APPLE_KEYCHAIN_PROFILE'] }
  ]
  const complete = []
  for (const set of credentialSets) {
    const present = set.variables.filter(envSet)
    check(`${set.name} notarization credentials are complete when used`, present.length === 0 || present.length === set.variables.length)
    if (present.length === set.variables.length) complete.push(set.name)
  }
  notarizationMethod = complete.join('+') || 'missing'
  check('notarization credentials are configured', complete.length > 0)
  if (complete.includes('api_key')) {
    check('APPLE_API_KEY points to an existing file', existsSync(process.env.APPLE_API_KEY || ''))
  }
  if (complete.length > 0) {
    check('notarization credentials authenticate with Apple', authenticateNotarizationCredentials(complete))
  }
}

const failures = checks.filter((item) => item.status === 'failed')
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  mode: configOnly ? 'config_only' : 'release',
  runId,
  reportDir,
  packageVersion: packageJson.version,
  targetArch,
  signingIdentityCount,
  notarizationMethod,
  redactionPolicy: 'Environment variable values and credential contents are never emitted.',
  checks,
  failures: failures.map((item) => item.name)
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1

function validateEntitlements(relativePath, expectedKeys) {
  const label = relativePath || 'missing entitlements path'
  check(`${label} exists`, typeof relativePath === 'string' && existsSync(path.join(repoRoot, relativePath)))
  if (typeof relativePath !== 'string' || !existsSync(path.join(repoRoot, relativePath))) return
  try {
    const plist = JSON.parse(commandOutput('plutil', ['-convert', 'json', '-o', '-', path.join(repoRoot, relativePath)]))
    const actualKeys = Object.keys(plist).sort()
    check(`${label} contains only the approved keys`, JSON.stringify(actualKeys) === JSON.stringify([...expectedKeys].sort()))
    for (const key of expectedKeys) check(`${label} enables ${key}`, plist[key] === true)
  } catch (error) {
    check(`${label} is a valid plist`, false, error instanceof Error ? error.message : String(error))
  }
}

function check(name, passed, detail) {
  checks.push({ name, status: passed ? 'passed' : 'failed', ...(detail ? { detail } : {}) })
}

function hasTarget(targets, name) {
  return asArray(targets).some((target) => target === name || target?.target === name)
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

function envSet(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim().length > 0
}

function authenticateNotarizationCredentials(availableMethods) {
  const methods = [
    {
      name: 'api_key',
      args: ['--key', process.env.APPLE_API_KEY, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER]
    },
    {
      name: 'keychain_profile',
      args: ['--keychain-profile', process.env.APPLE_KEYCHAIN_PROFILE]
    },
    {
      name: 'apple_id',
      args: [
        '--apple-id', process.env.APPLE_ID,
        '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id', process.env.APPLE_TEAM_ID
      ]
    }
  ]
  for (const method of methods) {
    if (!availableMethods.includes(method.name)) continue
    try {
      const output = commandOutput('xcrun', ['notarytool', 'history', ...method.args, '--output-format', 'json'])
      const parsed = JSON.parse(output)
      if (Array.isArray(parsed.history)) return true
    } catch {
      // Try another complete credential set without persisting tool output or credential-bearing arguments.
    }
  }
  return false
}

function compareVersions(left, right) {
  const a = String(left || '').split('.').map(Number)
  const b = String(right || '').split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

function commandOutput(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024
  }).trim()
}

function gitOutput(args) {
  try {
    return commandOutput('git', args)
  } catch {
    return null
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}
