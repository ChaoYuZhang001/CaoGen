#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const required = process.argv.includes('--required')
const configOnly = process.argv.includes('--config-only')
const targetArch = argValue('--arch') || 'x64'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'macos-release-audit')
const reportDir = path.join(reportRoot, runId)
const checks = []
const warnings = []

let packageJson = {}
try {
  packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  check('config', 'package.json is readable', true)
} catch (error) {
  check('config', 'package.json is readable', false, errorMessage(error))
}

const version = typeof packageJson.version === 'string' && packageJson.version ? packageJson.version : 'unknown'
const archDefaults = targetArch === 'arm64'
  ? {
      app: 'dist/mac-arm64/CaoGen.app',
      dmg: `dist/CaoGen-${version}-arm64.dmg`,
      zip: `dist/CaoGen-${version}-arm64-mac.zip`
    }
  : {
      app: 'dist/mac/CaoGen.app',
      dmg: `dist/CaoGen-${version}.dmg`,
      zip: `dist/CaoGen-${version}-mac.zip`
    }
const appPath = resolvePath(argValue('--app') || archDefaults.app)
const dmgPath = resolvePath(argValue('--dmg') || archDefaults.dmg)
const zipPath = resolvePath(argValue('--zip') || archDefaults.zip)
const configPath = path.join(repoRoot, 'electron-builder.release.cjs')
const mainEntitlementKeys = [
  'com.apple.security.automation.apple-events',
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
]
const inheritEntitlementKeys = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
]
const claudeEntitlementKeys = [
  'com.apple.security.automation.apple-events',
  ...inheritEntitlementKeys
]
const expectedClaudeSignIgnore = 'app\\.asar\\.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-(x64|arm64)/claude$'

const configSummary = inspectReleaseConfig()
const artifactPresence = {
  app: isDirectory(appPath),
  dmg: isFile(dmgPath),
  zip: isFile(zipPath)
}
const artifacts = {
  app: { path: reportPath(appPath), present: artifactPresence.app },
  dmg: { path: reportPath(dmgPath), present: artifactPresence.dmg },
  zip: { path: reportPath(zipPath), present: artifactPresence.zip }
}
let appSigning = null
let appEntitlements = null
let machOAudit = null
let claudeAudit = null
const archiveAudits = {}

if (!configOnly) inspectArtifacts()

const failures = checks.filter((item) => item.status === 'failed')
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  mode: configOnly ? 'config_only' : 'post_build',
  required,
  runId,
  reportDir,
  packageVersion: version,
  targetArch,
  platform: process.platform,
  config: configSummary,
  artifacts,
  appSigning,
  appEntitlements,
  machOAudit,
  claudeAudit,
  archiveAudits,
  summary: summarizeChecks(checks),
  redactionPolicy: 'Credential values and signing material are never read into the report. Command output is redacted before storage.',
  checks,
  warnings,
  failures: failures.map((item) => `${item.scope}: ${item.name}`)
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))

const anyArtifactPresent = Object.values(artifactPresence).some(Boolean)
if (required && report.status !== 'passed') process.exitCode = 1
if (!required && !configOnly && anyArtifactPresent && report.status === 'failed') process.exitCode = 1

function inspectReleaseConfig() {
  const summary = {
    path: reportPath(configPath),
    present: isFile(configPath),
    loaded: false,
    forceCodeSigning: false,
    hardenedRuntime: false,
    notarize: false,
    identityDisabled: null,
    minimumSystemVersion: null,
    entitlements: null,
    entitlementsInherit: null,
    preservesAnthropicSignature: false,
    declaresAppleEventsUsage: false
  }

  check('config', 'electron-builder.release.cjs exists', summary.present)
  if (!summary.present) return summary

  let releaseConfig
  try {
    releaseConfig = require(configPath)
    summary.loaded = isRecord(releaseConfig)
    check('config', 'electron-builder.release.cjs exports an object', summary.loaded)
  } catch (error) {
    check('config', 'electron-builder.release.cjs loads', false, errorMessage(error))
    return summary
  }
  if (!summary.loaded) return summary

  const mac = isRecord(releaseConfig.mac) ? releaseConfig.mac : {}
  summary.forceCodeSigning = mac.forceCodeSigning === true
  summary.hardenedRuntime = mac.hardenedRuntime === true
  summary.notarize = mac.notarize === true
  summary.identityDisabled = mac.identity === null
  summary.minimumSystemVersion = typeof mac.minimumSystemVersion === 'string' ? mac.minimumSystemVersion : null
  summary.preservesAnthropicSignature = asArray(mac.signIgnore).some((pattern) => pattern === expectedClaudeSignIgnore)
  summary.declaresAppleEventsUsage =
    typeof mac.extendInfo?.NSAppleEventsUsageDescription === 'string' &&
    mac.extendInfo.NSAppleEventsUsageDescription.trim().length > 0

  check('config', 'forceCodeSigning is true', summary.forceCodeSigning)
  check('config', 'hardenedRuntime is true', summary.hardenedRuntime)
  check('config', 'notarize is true', summary.notarize)
  check('config', 'identity is not null', !summary.identityDisabled)
  check('config', 'minimumSystemVersion is 14.0 or newer', versionAtLeast(mac.minimumSystemVersion, '14.0'))
  check('config', 'DMG target is enabled', hasTarget(mac.target, 'dmg'))
  check('config', 'ZIP target is enabled', hasTarget(mac.target, 'zip'))
  check('config', 'Anthropic CLI is the approved signIgnore exception', summary.preservesAnthropicSignature)
  check('config', 'NSAppleEventsUsageDescription is present', summary.declaresAppleEventsUsage)

  summary.entitlements = inspectConfiguredEntitlements(mac.entitlements, mainEntitlementKeys, 'main entitlements')
  summary.entitlementsInherit = inspectConfiguredEntitlements(
    mac.entitlementsInherit,
    inheritEntitlementKeys,
    'inherited entitlements'
  )
  return summary
}

function inspectConfiguredEntitlements(configuredPath, expectedKeys, label) {
  const validPath = typeof configuredPath === 'string' && configuredPath.trim().length > 0
  const absolutePath = validPath ? resolvePath(configuredPath) : null
  const summary = {
    path: absolutePath ? reportPath(absolutePath) : null,
    present: absolutePath ? isFile(absolutePath) : false,
    valid: false,
    keys: []
  }

  check('config', `${label} path is configured`, validPath)
  check('config', `${label} file exists`, summary.present)
  if (!summary.present) return summary

  try {
    const plist = parsePlistFile(absolutePath)
    summary.valid = isRecord(plist)
    summary.keys = summary.valid ? Object.keys(plist).sort() : []
    check('config', `${label} is a valid plist dictionary`, summary.valid)
    if (!summary.valid) return summary
    check(
      'config',
      `${label} contains only the approved keys`,
      sameStrings(summary.keys, [...expectedKeys].sort()),
      summary.keys.join(', ')
    )
    for (const key of expectedKeys) check('config', `${label} enables ${key}`, plist[key] === true)
  } catch (error) {
    check('config', `${label} is parseable`, false, errorMessage(error))
  }
  return summary
}

function inspectArtifacts() {
  check('invocation', 'target architecture is x64 or arm64', targetArch === 'x64' || targetArch === 'arm64')
  check('platform', 'post-build audit runs on macOS', process.platform === 'darwin')
  check('app', 'release app exists', artifactPresence.app, reportPath(appPath))
  check('dmg', 'release DMG exists', artifactPresence.dmg, reportPath(dmgPath))
  check('zip', 'release ZIP exists', artifactPresence.zip, reportPath(zipPath))

  if (process.platform !== 'darwin') {
    warnings.push('Artifact signing, notarization, and archive checks require macOS.')
    return
  }

  if (artifactPresence.app) inspectApp()
  if (artifactPresence.dmg) {
    commandCheck('dmg', 'hdiutil verifies the DMG', 'hdiutil', ['verify', dmgPath])
    archiveAudits.dmg = inspectDmgPayload()
  }
  if (artifactPresence.zip) {
    commandCheck('zip', 'unzip verifies the ZIP', 'unzip', ['-t', zipPath])
    archiveAudits.zip = inspectZipPayload()
  }
}

function inspectApp() {
  commandCheck('app', 'codesign verifies the app deeply and strictly', 'codesign', [
    '--verify',
    '--deep',
    '--strict',
    appPath
  ])

  const details = runCommand('codesign', ['-dvvv', appPath])
  const parsedDetails = parseCodeSignDetails(details.output)
  appSigning = {
    detailCommandPassed: details.ok,
    developerIdApplication: parsedDetails.developerIdApplication,
    authority: parsedDetails.developerAuthority,
    teamIdentifier: parsedDetails.teamIdentifier,
    hardenedRuntime: parsedDetails.hardenedRuntime
  }
  check('app', 'codesign details are readable', details.ok, details.ok ? undefined : commandFailureDetail(details))
  check('app', 'app uses a Developer ID Application identity', parsedDetails.developerIdApplication)
  check('app', 'app has a TeamIdentifier', validTeamIdentifier(parsedDetails.teamIdentifier))
  check('app', 'app signature enables hardened runtime', parsedDetails.hardenedRuntime)

  const authorityTeam = teamFromAuthority(parsedDetails.developerAuthority)
  if (authorityTeam) {
    check('app', 'Developer ID authority and TeamIdentifier agree', authorityTeam === parsedDetails.teamIdentifier)
  }

  inspectMainExecutableArchitecture()
  appEntitlements = inspectSignedEntitlements(appPath, mainEntitlementKeys, 'app')
  commandCheck('app', 'Gatekeeper accepts the app for execution', 'spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=4',
    appPath
  ])
  commandCheck('app', 'the app has a valid stapled notarization ticket', 'xcrun', ['stapler', 'validate', appPath])

  machOAudit = inspectMachOFiles()
  claudeAudit = inspectAnthropicClaude(machOAudit.files)
}

function inspectMainExecutableArchitecture() {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist')
  check('app', 'app Info.plist exists', isFile(infoPlistPath), reportPath(infoPlistPath))
  if (!isFile(infoPlistPath)) return

  let info
  try {
    info = parsePlistFile(infoPlistPath)
  } catch (error) {
    check('app', 'app Info.plist is parseable', false, errorMessage(error))
    return
  }
  const executableName = typeof info?.CFBundleExecutable === 'string' ? info.CFBundleExecutable : ''
  check('app', 'CFBundleExecutable is configured', executableName.length > 0)
  if (!executableName) return

  const executablePath = path.join(appPath, 'Contents', 'MacOS', executableName)
  check('app', 'main executable exists', isFile(executablePath), reportPath(executablePath))
  if (!isFile(executablePath)) return

  const result = runCommand('lipo', ['-archs', executablePath])
  check('app', 'main executable architectures are readable', result.ok, result.ok ? undefined : commandFailureDetail(result))
  if (!result.ok) return
  const architectures = result.stdout.trim().split(/\s+/).filter(Boolean)
  const expected = targetArch === 'x64' ? 'x86_64' : targetArch
  artifacts.app.mainExecutable = reportPath(executablePath)
  artifacts.app.architectures = architectures
  check(
    'app',
    `main executable contains only ${expected}`,
    architectures.length === 1 && architectures[0] === expected,
    architectures.join(', ') || 'none'
  )
}

function inspectSignedEntitlements(targetPath, expectedKeys, scope) {
  const result = runCommand('codesign', ['-d', '--entitlements', '-', targetPath])
  const summary = {
    readable: result.ok,
    keys: [],
    expectedKeys
  }
  check(scope, `${scope} signed entitlements are readable`, result.ok, result.ok ? undefined : commandFailureDetail(result))
  if (!result.ok) return summary

  try {
    const plist = parseEmbeddedPlist(result.output)
    summary.keys = Object.keys(plist).sort()
    for (const key of expectedKeys) check(scope, `${scope} signature enables ${key}`, plist[key] === true)
  } catch (error) {
    check(scope, `${scope} signed entitlements are parseable`, false, errorMessage(error))
  }
  return summary
}

function inspectMachOFiles() {
  let regularFiles
  try {
    regularFiles = listRegularFiles(appPath)
  } catch (error) {
    check('mach_o', 'app files are enumerable', false, errorMessage(error))
    return { total: 0, passed: 0, failed: 0, files: [] }
  }

  let detected
  try {
    detected = detectMachOFiles(regularFiles)
    check('mach_o', 'Mach-O files are discoverable with file', true)
  } catch (error) {
    check('mach_o', 'Mach-O files are discoverable with file', false, errorMessage(error))
    return { total: 0, passed: 0, failed: 0, files: [] }
  }

  check('mach_o', 'at least one Mach-O file is present', detected.length > 0)
  const files = []
  for (const item of detected) {
    const result = runCommand('codesign', ['--verify', '--strict', item.path])
    files.push({
      path: reportPath(item.path),
      fileType: item.fileType,
      status: result.ok ? 'passed' : 'failed',
      ...(result.ok ? {} : { detail: commandFailureDetail(result) })
    })
  }
  const failed = files.filter((item) => item.status === 'failed')
  check(
    'mach_o',
    'every Mach-O file has a valid code signature',
    failed.length === 0,
    failed.length === 0 ? `${files.length} verified` : `${failed.length} of ${files.length} failed`
  )
  return {
    total: files.length,
    passed: files.length - failed.length,
    failed: failed.length,
    files
  }
}

function inspectAnthropicClaude(machOFiles) {
  const expectedSuffix = `/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-${targetArch}/claude`
  const candidates = machOFiles.filter((item) => item.path.split(path.sep).join('/').endsWith(expectedSuffix))
  const summary = {
    expectedSuffix,
    count: candidates.length,
    path: candidates[0]?.path || null,
    authority: null,
    teamIdentifier: null,
    hardenedRuntime: false,
    entitlements: null,
    architectures: []
  }
  check('claude', `exactly one ${targetArch} Anthropic CLI is present`, candidates.length === 1, `${candidates.length} found`)
  if (candidates.length !== 1) return summary

  const claudePath = resolvePath(candidates[0].path)
  commandCheck('claude', 'Anthropic CLI signature verifies strictly', 'codesign', ['--verify', '--strict', claudePath])

  const details = runCommand('codesign', ['-dvvv', claudePath])
  const parsed = parseCodeSignDetails(details.output)
  summary.authority = parsed.developerAuthority
  summary.teamIdentifier = parsed.teamIdentifier
  summary.hardenedRuntime = parsed.hardenedRuntime
  check('claude', 'Anthropic CLI codesign details are readable', details.ok, details.ok ? undefined : commandFailureDetail(details))
  check(
    'claude',
    'Anthropic CLI retains the Anthropic PBC Developer ID signature',
    parsed.developerAuthority === 'Developer ID Application: Anthropic PBC (Q6L2SF6YDW)',
    parsed.developerAuthority || 'missing'
  )
  check('claude', 'Anthropic CLI TeamIdentifier is Q6L2SF6YDW', parsed.teamIdentifier === 'Q6L2SF6YDW')
  check('claude', 'Anthropic CLI enables hardened runtime', parsed.hardenedRuntime)

  const lipo = runCommand('lipo', ['-archs', claudePath])
  if (lipo.ok) summary.architectures = lipo.stdout.trim().split(/\s+/).filter(Boolean)
  const expectedArchitecture = targetArch === 'x64' ? 'x86_64' : targetArch
  check('claude', 'Anthropic CLI architecture is readable', lipo.ok, lipo.ok ? undefined : commandFailureDetail(lipo))
  check(
    'claude',
    `Anthropic CLI contains only ${expectedArchitecture}`,
    summary.architectures.length === 1 && summary.architectures[0] === expectedArchitecture,
    summary.architectures.join(', ') || 'none'
  )

  summary.entitlements = inspectSignedEntitlements(claudePath, claudeEntitlementKeys, 'claude')
  return summary
}

function inspectDmgPayload() {
  const mountPoint = mkdtempSync(path.join(tmpdir(), 'caogen-release-dmg-'))
  const summary = { mounted: false, appPath: null, checks: null }
  try {
    const attached = runCommand('hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mountPoint,
      dmgPath
    ])
    summary.mounted = attached.ok
    check('dmg_app', 'DMG mounts read-only', attached.ok, attached.ok ? undefined : commandFailureDetail(attached))
    if (!attached.ok) return summary
    const archivedApp = path.join(mountPoint, 'CaoGen.app')
    summary.appPath = reportPath(archivedApp)
    summary.checks = inspectArchivedApp('dmg_app', archivedApp)
    return summary
  } finally {
    if (summary.mounted) {
      const detached = runCommand('hdiutil', ['detach', mountPoint])
      check('dmg_app', 'DMG detaches cleanly', detached.ok, detached.ok ? undefined : commandFailureDetail(detached))
    }
    rmSync(mountPoint, { recursive: true, force: true })
  }
}

function inspectZipPayload() {
  const extractRoot = mkdtempSync(path.join(tmpdir(), 'caogen-release-zip-'))
  const summary = { extracted: false, appPath: null, checks: null }
  try {
    const extracted = runCommand('ditto', ['-x', '-k', zipPath, extractRoot], 64 * 1024 * 1024)
    summary.extracted = extracted.ok
    check('zip_app', 'ZIP extracts successfully', extracted.ok, extracted.ok ? undefined : commandFailureDetail(extracted))
    if (!extracted.ok) return summary
    const archivedApp = findAppBundle(extractRoot)
    summary.appPath = archivedApp ? reportPath(archivedApp) : null
    check('zip_app', 'ZIP contains CaoGen.app', Boolean(archivedApp))
    if (archivedApp) summary.checks = inspectArchivedApp('zip_app', archivedApp)
    return summary
  } finally {
    rmSync(extractRoot, { recursive: true, force: true })
  }
}

function inspectArchivedApp(scope, archivedApp) {
  const startIndex = checks.length
  check(scope, 'archived app bundle exists', isDirectory(archivedApp))
  if (!isDirectory(archivedApp)) return summarizeChecks(checks.slice(startIndex))
  commandCheck(scope, 'archived app signature verifies deeply and strictly', 'codesign', [
    '--verify',
    '--deep',
    '--strict',
    archivedApp
  ])
  const details = runCommand('codesign', ['-dvvv', archivedApp])
  const parsed = parseCodeSignDetails(details.output)
  check(scope, 'archived app uses Developer ID Application', parsed.developerIdApplication)
  check(scope, 'archived app has a TeamIdentifier', validTeamIdentifier(parsed.teamIdentifier))
  check(scope, 'archived app enables hardened runtime', parsed.hardenedRuntime)
  commandCheck(scope, 'Gatekeeper accepts the archived app', 'spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=4',
    archivedApp
  ])
  commandCheck(scope, 'archived app has a valid stapled ticket', 'xcrun', ['stapler', 'validate', archivedApp])
  inspectArchivedArchitecture(scope, archivedApp)
  inspectArchivedClaude(scope, archivedApp)
  return summarizeChecks(checks.slice(startIndex))
}

function inspectArchivedArchitecture(scope, archivedApp) {
  const infoPath = path.join(archivedApp, 'Contents', 'Info.plist')
  if (!isFile(infoPath)) {
    check(scope, 'archived app Info.plist exists', false)
    return
  }
  try {
    const info = parsePlistFile(infoPath)
    check(scope, 'archived app version matches package.json', info.CFBundleShortVersionString === version)
    check(scope, 'archived app minimum macOS is 14.0 or newer', versionAtLeast(info.LSMinimumSystemVersion, '14.0'))
    const executable = path.join(archivedApp, 'Contents', 'MacOS', String(info.CFBundleExecutable || ''))
    const lipo = runCommand('lipo', ['-archs', executable])
    const architectures = lipo.ok ? lipo.stdout.trim().split(/\s+/).filter(Boolean) : []
    const expected = targetArch === 'x64' ? 'x86_64' : targetArch
    check(scope, 'archived app architecture is readable', lipo.ok, lipo.ok ? undefined : commandFailureDetail(lipo))
    check(scope, `archived app contains only ${expected}`, architectures.length === 1 && architectures[0] === expected)
  } catch (error) {
    check(scope, 'archived app Info.plist is parseable', false, errorMessage(error))
  }
}

function inspectArchivedClaude(scope, archivedApp) {
  const claudePath = path.join(
    archivedApp,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-darwin-${targetArch}`,
    'claude'
  )
  check(scope, 'archived app contains the target Anthropic CLI', isFile(claudePath))
  if (!isFile(claudePath)) return
  const details = runCommand('codesign', ['-dvvv', claudePath])
  const parsed = parseCodeSignDetails(details.output)
  check(scope, 'archived Anthropic CLI retains its Developer ID', parsed.developerAuthority === 'Developer ID Application: Anthropic PBC (Q6L2SF6YDW)')
  check(scope, 'archived Anthropic CLI retains TeamIdentifier Q6L2SF6YDW', parsed.teamIdentifier === 'Q6L2SF6YDW')
  check(scope, 'archived Anthropic CLI enables hardened runtime', parsed.hardenedRuntime)
}

function findAppBundle(root) {
  const direct = path.join(root, 'CaoGen.app')
  if (isDirectory(direct)) return direct
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name, 'CaoGen.app')
    if (isDirectory(candidate)) return candidate
  }
  return null
}

function detectMachOFiles(files) {
  const result = []
  const batchSize = 100
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = files.slice(offset, offset + batchSize)
    const command = runCommand('file', ['-b', ...batch], 32 * 1024 * 1024)
    if (!command.ok) throw new Error(commandFailureDetail(command))
    const lines = command.stdout.replace(/\r/g, '').replace(/\n$/, '').split('\n')
    if (lines.length !== batch.length) {
      for (const filePath of batch) {
        const single = runCommand('file', ['-b', filePath])
        if (!single.ok) throw new Error(commandFailureDetail(single))
        if (/\bMach-O\b/.test(single.stdout)) result.push({ path: filePath, fileType: single.stdout.trim() })
      }
      continue
    }
    for (let index = 0; index < batch.length; index += 1) {
      if (/\bMach-O\b/.test(lines[index])) result.push({ path: batch[index], fileType: lines[index].trim() })
    }
  }
  return result
}

function listRegularFiles(root) {
  const result = []
  visit(root)
  return result

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolutePath)
      else if (entry.isFile()) result.push(absolutePath)
    }
  }
}

function parseCodeSignDetails(output) {
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim())
  const developerAuthority = authorities.find((authority) => authority.startsWith('Developer ID Application:')) || null
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() || null
  const hardenedRuntime = /flags=.*\(runtime(?:[,)]|\))/.test(output) || /^Runtime Version=/m.test(output)
  return {
    authorities,
    developerAuthority,
    developerIdApplication: Boolean(developerAuthority),
    teamIdentifier,
    hardenedRuntime
  }
}

function parsePlistFile(filePath) {
  const plist = require('plist')
  return plist.parse(readFileSync(filePath, 'utf8'))
}

function parseEmbeddedPlist(output) {
  const start = output.indexOf('<?xml')
  const end = output.lastIndexOf('</plist>')
  if (start >= 0 && end >= start) {
    const plist = require('plist')
    const parsed = plist.parse(output.slice(start, end + '</plist>'.length))
    if (!isRecord(parsed)) throw new Error('signed entitlements are not a plist dictionary')
    return parsed
  }
  const parsed = {}
  for (const match of output.matchAll(/\[Key\]\s+([^\r\n]+)[\s\S]*?\[Bool\]\s+(true|false)/g)) {
    parsed[match[1].trim()] = match[2] === 'true'
  }
  if (Object.keys(parsed).length === 0) throw new Error('codesign output did not contain readable entitlements')
  return parsed
}

function commandCheck(scope, name, command, args) {
  const result = runCommand(command, args)
  check(scope, name, result.ok, result.ok ? undefined : commandFailureDetail(result))
  return result
}

function runCommand(command, args, maxBuffer = 16 * 1024 * 1024) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  return {
    ok: result.status === 0 && !result.error,
    exitCode: typeof result.status === 'number' ? result.status : null,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`.trim(),
    error: result.error ? errorMessage(result.error) : null
  }
}

function commandFailureDetail(result) {
  return tail(redact(`${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`)) || `exit ${result.exitCode ?? 'unknown'}`
}

function check(scope, name, passed, detail) {
  checks.push({
    scope,
    name,
    status: passed ? 'passed' : 'failed',
    ...(detail ? { detail: redact(String(detail)) } : {})
  })
}

function summarizeChecks(items) {
  const counts = { passed: 0, failed: 0 }
  for (const item of items) counts[item.status] += 1
  return { total: items.length, counts }
}

function versionAtLeast(value, minimum) {
  const left = parseVersion(value)
  const right = parseVersion(minimum)
  if (!left || !right) return false
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(value)) return null
  return value.split('.').map(Number)
}

function hasTarget(targets, name) {
  return asArray(targets).some((target) => target === name || (isRecord(target) && target.target === name))
}

function validTeamIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'not set'
}

function teamFromAuthority(authority) {
  return typeof authority === 'string' ? /\(([A-Z0-9]{10})\)$/.exec(authority)?.[1] || null : null
}

function sameStrings(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile()
  } catch {
    return false
  }
}

function isDirectory(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function resolvePath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.join(repoRoot, value)
}

function reportPath(filePath) {
  const relative = path.relative(repoRoot, filePath)
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' ? relative : filePath
}

function redact(value) {
  let result = value
  const secretNames = [
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_KEYCHAIN',
    'APPLE_KEYCHAIN_PROFILE',
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME'
  ]
  for (const name of secretNames) {
    const secret = process.env[name]
    if (typeof secret === 'string' && secret.length >= 8) result = result.split(secret).join('[REDACTED]')
  }
  return result
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]')
}

function tail(value) {
  const trimmed = value.trim()
  return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0) {
    const next = process.argv[index + 1]
    if (next && !next.startsWith('--')) return next
  }
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}
