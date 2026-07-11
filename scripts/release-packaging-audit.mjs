#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

validatePackage()
validateDist()

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
  git,
  signing: packageJson.build?.mac?.identity === null ? 'unsigned' : 'configured-or-auto',
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
  if (packageJson.build?.mac?.identity === null) {
    warnings.push('macOS package is unsigned; release notes must include first-open Gatekeeper instructions')
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
