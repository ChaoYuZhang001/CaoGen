#!/usr/bin/env node
import { listPackage } from '@electron/asar'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import releaseProvenance from './lib/release-provenance.cjs'
import { requiresTrustedMacDistribution } from './lib/release-packaging-policy.mjs'

const { readPackagedReleaseProvenance, releaseProvenanceChecks } = releaseProvenance

const repoRoot = process.cwd()
const required = process.argv.includes('--required') || process.env.CAOGEN_RELEASE_PACKAGING_AUDIT_REQUIRED === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'release-packaging-audit')
const reportDir = path.join(reportRoot, runId)
const distDir = normalizePath(argValue('--dist') || process.env.CAOGEN_RELEASE_DIST_DIR || 'dist')
const packageJson = readPackageJson()
const packageLock = readOptionalJson('package-lock.json')
const explicitExpectedVersion = argValue('--version') || process.env.CAOGEN_RELEASE_VERSION || ''
const expectedVersion = explicitExpectedVersion || packageJson.version
const failures = []
const warnings = []
const distFiles = existsSync(distDir) ? listFiles(distDir) : []
const rootFiles = distFiles
  .filter((file) => !file.relativePath.includes(path.sep))
  .map((file) => file.relativePath)
  .sort()
const uploadableAssets = rootFiles.filter(isUploadableReleaseAsset)
const uploadableAssetDigests = digestAssets(uploadableAssets)
const artifactSetSha256 = digestJson(uploadableAssetDigests)
const git = readGitState()
const packagedRuntime = inspectPackagedRuntime()
const macSigning = inspectMacSigning()
const releaseProvenanceRequired = requiresTrustedMacDistribution(expectedVersion)

validatePackage()
validateMacSigning()
validateDist()
validateReleaseBuildProvenance()

const report = {
  status: failures.length === 0 ? 'passed' : required ? 'failed' : existsSync(distDir) ? 'failed' : 'skipped',
  required,
  runId,
  reportDir,
  expectedVersion,
  expectedVersionSource: explicitExpectedVersion ? 'explicit' : 'package.json',
  packageVersion: packageJson.version,
  packageLockVersion: packageLock?.version ?? packageLock?.packages?.['']?.version,
  distDir: path.relative(repoRoot, distDir),
  distPresent: existsSync(distDir),
  rootFiles,
  uploadableAssets,
  uploadableAssetDigests,
  artifactSetSha256,
  unexpectedUploadableAssets: uploadableAssets.filter((file) => !isExpectedUploadableReleaseAsset(file, expectedVersion)),
  expectedMacAssets: expectedMacAssets(expectedVersion),
  packagedRuntime,
  releaseProvenanceRequired,
  git,
  signing: macSigning.status,
  signingEvidence: macSigning,
  publish: summarizePublish(packageJson.build?.publish),
  warnings,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1
if (!required && existsSync(distDir) && report.status === 'failed') process.exitCode = 1

function validatePackage() {
  if (!packageJson.version) {
    failures.push('package.json version is missing')
    return
  }
  if (packageJson.version !== expectedVersion) {
    failures.push(`package.json version must be ${expectedVersion}, got ${packageJson.version || 'missing'}`)
  }
  const lockVersion = packageLock?.version ?? packageLock?.packages?.['']?.version
  if (lockVersion !== expectedVersion) {
    failures.push(`package-lock.json version must be ${expectedVersion}, got ${lockVersion || 'missing'}`)
  }
  const rootLockVersion = packageLock?.packages?.['']?.version
  if (rootLockVersion !== expectedVersion) {
    failures.push(`package-lock root package version must be ${expectedVersion}, got ${rootLockVersion || 'missing'}`)
  }
  const publishEntries = Array.isArray(packageJson.build?.publish) ? packageJson.build.publish : []
  for (const entry of publishEntries) {
    const url = typeof entry?.url === 'string' ? entry.url : ''
    if (/example\.com/i.test(url) && process.env.CAOGEN_RELEASE_ALLOW_PLACEHOLDER_PUBLISH !== '1') {
      failures.push('build.publish still points at example.com; set a real update source or explicitly allow placeholder publish metadata')
    }
  }
}

function validateMacSigning() {
  if (macSigning.status === 'invalid') failures.push('packaged macOS app has an invalid code signature')
  if (macSigning.status === 'unsigned') {
    warnings.push('macOS package is unsigned; release notes must include first-open Gatekeeper instructions')
  }
  if (macSigning.status === 'signed' && !macSigning.developerIdApplication) {
    warnings.push('macOS package is signed, but not with a Developer ID Application identity')
  }
  if (macSigning.status === 'not_inspected' && packageJson.build?.mac?.identity === null) {
    warnings.push('macOS signing could not be inspected on this platform; package.json configures the default macOS build as unsigned')
  }
}

function validateDist() {
  if (!existsSync(distDir)) {
    failures.push(`dist directory is missing: ${path.relative(repoRoot, distDir)}`)
    return
  }
  for (const file of distFiles) {
    if (forbiddenReleasePath(file.relativePath)) failures.push(`forbidden release artifact path: ${file.relativePath}`)
  }
  for (const asset of expectedReleaseAssets(expectedVersion)) {
    const file = distFiles.find((item) => item.relativePath === asset)
    if (!file) failures.push(`missing expected macOS release asset: ${asset}`)
    else if (file.size <= 0) failures.push(`release asset is empty: ${asset}`)
  }
  const expected = new Set(expectedReleaseAssets(expectedVersion))
  for (const asset of rootFiles.filter((file) => /^CaoGen-\d+\.\d+\.\d+/.test(file))) {
    if (!expected.has(asset)) failures.push(`stale or unexpected CaoGen release asset in dist root: ${asset}`)
  }
  for (const asset of rootFiles.filter(isUploadableReleaseAsset).filter((file) => !isExpectedUploadableReleaseAsset(file, expectedVersion))) {
    failures.push(`unexpected uploadable release asset in dist root: ${asset}`)
  }
  const latestMac = readDistText('latest-mac.yml')
  if (latestMac !== undefined && !latestMac.includes(`version: ${expectedVersion}`)) {
    failures.push(`latest-mac.yml does not reference version ${expectedVersion}`)
  }
  if (!packagedRuntime.asarPresent) {
    failures.push(`packaged app archive is missing: ${packagedRuntime.asarPath}`)
  } else if (packagedRuntime.error) {
    failures.push(`unable to inspect packaged app archive: ${packagedRuntime.error}`)
  } else {
    for (const missing of packagedRuntime.missingRuntimeFiles) {
      failures.push(`packaged app is missing required runtime file: ${missing}`)
    }
  }
}

function validateReleaseBuildProvenance() {
  if (!releaseProvenanceRequired) return
  if (!packagedRuntime.releaseProvenance) {
    failures.push('release build provenance is unavailable')
    return
  }
  for (const [name, passed] of Object.entries(packagedRuntime.releaseProvenance.checks)) {
    if (!passed) failures.push(`release build provenance check failed: ${name}`)
  }
}

function inspectPackagedRuntime() {
  const appPath = path.join(distDir, 'mac', 'CaoGen.app')
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
  const requiredRuntimeFiles = [
    '/node_modules/tree-sitter/index.js',
    '/node_modules/node-gyp-build/index.js',
    '/node_modules/node-gyp-build/package.json'
  ]
  if (!existsSync(asarPath)) {
    return {
      asarPath: path.relative(repoRoot, asarPath),
      asarPresent: false,
      requiredRuntimeFiles,
      missingRuntimeFiles: requiredRuntimeFiles,
      releaseProvenance: null
    }
  }
  try {
    const entries = new Set(listPackage(asarPath))
    const inspectedProvenance = readPackagedReleaseProvenance(appPath)
    return {
      asarPath: path.relative(repoRoot, asarPath),
      asarPresent: true,
      requiredRuntimeFiles,
      missingRuntimeFiles: requiredRuntimeFiles.filter((file) => !entries.has(file)),
      releaseProvenance: {
        present: inspectedProvenance.present,
        value: inspectedProvenance.value,
        error: inspectedProvenance.error,
        checks: releaseProvenanceChecks(inspectedProvenance.value, {
          gitCommit: git.commit,
          packageVersion: expectedVersion
        })
      }
    }
  } catch (error) {
    return {
      asarPath: path.relative(repoRoot, asarPath),
      asarPresent: true,
      requiredRuntimeFiles,
      missingRuntimeFiles: requiredRuntimeFiles,
      releaseProvenance: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function inspectMacSigning() {
  const appPath = path.join(distDir, 'mac', 'CaoGen.app')
  const relativeAppPath = path.relative(repoRoot, appPath)
  if (!existsSync(appPath)) return emptySigningEvidence('missing', relativeAppPath)
  if (process.platform !== 'darwin') {
    return {
      ...emptySigningEvidence('not_inspected', relativeAppPath),
      reason: 'codesign inspection requires macOS'
    }
  }

  const detail = runCodesign(['-d', '--verbose=4', appPath])
  const verification = runCodesign(['--verify', '--deep', '--strict', appPath])
  const detailOutput = `${detail.stdout || ''}\n${detail.stderr || ''}`.trim()
  const verificationOutput = `${verification.stdout || ''}\n${verification.stderr || ''}`.trim()
  const authority = detailOutput.match(/^Authority=(.+)$/m)?.[1]?.trim() || null
  const teamIdentifier = detailOutput.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null
  const developerIdApplication = Boolean(authority?.startsWith('Developer ID Application:'))
  const hardenedRuntime = /flags=.*\bruntime\b/i.test(detailOutput) || /^Runtime Version=/m.test(detailOutput)
  const unsigned = /code object is not signed at all/i.test(`${detailOutput}\n${verificationOutput}`)
  const verified = verification.status === 0
  const status = resolveSigningStatus({ unsigned, verified, developerIdApplication })
  const evidence = {
    status,
    appPath: relativeAppPath,
    inspected: true,
    verified,
    developerIdApplication,
    authority,
    teamIdentifier,
    hardenedRuntime
  }
  if (status === 'invalid') evidence.failure = summarizeCodesignFailure(verificationOutput)
  return evidence
}

function emptySigningEvidence(status, appPath) {
  return {
    status,
    appPath,
    inspected: false,
    verified: false,
    developerIdApplication: false,
    authority: null,
    teamIdentifier: null,
    hardenedRuntime: false
  }
}

function runCodesign(args) {
  return spawnSync('codesign', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function resolveSigningStatus({ unsigned, verified, developerIdApplication }) {
  if (unsigned) return 'unsigned'
  if (!verified) return 'invalid'
  return developerIdApplication ? 'developer-id-signed' : 'signed'
}

function summarizeCodesignFailure(output) {
  return output.split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ') || 'codesign verification failed'
}

function expectedReleaseAssets(version) {
  return expectedMacAssets(version)
}

function expectedMacAssets(version) {
  return [
    `CaoGen-${version}.dmg`,
    `CaoGen-${version}.dmg.blockmap`,
    `CaoGen-${version}-mac.zip`,
    `CaoGen-${version}-mac.zip.blockmap`,
    'latest-mac.yml'
  ]
}

function forbiddenReleasePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/')
  const base = path.basename(normalized)
  return (
    /^\.env(\..+)?$/.test(base) ||
    /\.(pem|p12|pfx|key|mobileprovision|provisionprofile|keystore|jks|crt|cer|p8)$/i.test(base) ||
    /^(node_modules|test-results|\.vscode-test)(\/|$)/.test(normalized) ||
    /(^|\/)(id_rsa|id_ed25519)(\.|$)/.test(normalized)
  )
}

function isUploadableReleaseAsset(file) {
  return /\.(dmg|zip|exe|AppImage|blockmap)$/i.test(file) || /^latest.*\.ya?ml$/i.test(file)
}

function isExpectedUploadableReleaseAsset(file, version) {
  const expected = new Set(expectedReleaseAssets(version))
  return expected.has(file)
}

function summarizePublish(value) {
  return Array.isArray(value)
    ? value.map((item) => ({ provider: item?.provider, url: item?.url }))
    : []
}

function digestAssets(files) {
  return Object.fromEntries(files.map((file) => {
    const absolutePath = path.join(distDir, file)
    return [file, {
      size: statSync(absolutePath).size,
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
    }]
  }))
}

function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function readGitState() {
  const commit = gitOutput(['rev-parse', 'HEAD'])
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return ''
  }
}

function readDistText(relativePath) {
  const filePath = path.join(distDir, relativePath)
  if (!existsSync(filePath)) return undefined
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

function listFiles(root) {
  const result = []
  visit(root)
  return result

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = path.relative(root, absolutePath)
      result.push({ relativePath, size: statSync(absolutePath).size })
    }
  }
}

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
}

function readOptionalJson(relativePath) {
  const filePath = path.join(repoRoot, relativePath)
  if (!existsSync(filePath)) return undefined
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function normalizePath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}
