#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required') || process.env.CAOGEN_RELEASE_PACKAGING_AUDIT_REQUIRED === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'release-packaging-audit')
const reportDir = path.join(reportRoot, runId)
const expectedVersion = argValue('--version') || process.env.CAOGEN_RELEASE_VERSION || '0.2.0'
const distDir = normalizePath(argValue('--dist') || process.env.CAOGEN_RELEASE_DIST_DIR || 'dist')
const packageJson = readPackageJson()
const failures = []
const warnings = []
const distFiles = existsSync(distDir) ? listFiles(distDir) : []
const rootFiles = distFiles
  .filter((file) => !file.relativePath.includes(path.sep))
  .map((file) => file.relativePath)
  .sort()

validatePackage()
validateDist()

const report = {
  status: failures.length === 0 ? 'passed' : required ? 'failed' : existsSync(distDir) ? 'failed' : 'skipped',
  required,
  runId,
  reportDir,
  expectedVersion,
  packageVersion: packageJson.version,
  distDir: path.relative(repoRoot, distDir),
  distPresent: existsSync(distDir),
  rootFiles,
  uploadableAssets: rootFiles.filter(isUploadableReleaseAsset),
  expectedMacAssets: expectedMacAssets(expectedVersion),
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
  if (packageJson.version !== expectedVersion) {
    failures.push(`package.json version must be ${expectedVersion}, got ${packageJson.version || 'missing'}`)
  }
  if (packageJson.version === '0.1.2') {
    failures.push('package.json is still at latest public stable version 0.1.2; bump only after required evidence gates pass')
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
  for (const asset of expectedMacAssets(expectedVersion)) {
    const file = distFiles.find((item) => item.relativePath === asset)
    if (!file) failures.push(`missing expected macOS release asset: ${asset}`)
    else if (file.size <= 0) failures.push(`release asset is empty: ${asset}`)
  }
  const latestMac = readDistText('latest-mac.yml')
  if (latestMac !== undefined && !latestMac.includes(`version: ${expectedVersion}`)) {
    failures.push(`latest-mac.yml does not reference version ${expectedVersion}`)
  }
}

function expectedMacAssets(version) {
  return [
    `CaoGen-${version}.dmg`,
    `CaoGen-${version}.dmg.blockmap`,
    `CaoGen-${version}-mac.zip`,
    `CaoGen-${version}-mac.zip.blockmap`,
    `CaoGen-${version}-arm64.dmg`,
    `CaoGen-${version}-arm64.dmg.blockmap`,
    `CaoGen-${version}-arm64-mac.zip`,
    `CaoGen-${version}-arm64-mac.zip.blockmap`,
    'latest-mac.yml'
  ]
}

function forbiddenReleasePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/')
  const base = path.basename(normalized)
  return (
    /^\.env(\..+)?$/.test(base) ||
    /\.(pem|p12|pfx|key|mobileprovision)$/i.test(base) ||
    /^(node_modules|test-results|\.vscode-test)(\/|$)/.test(normalized) ||
    /(^|\/)(id_rsa|id_ed25519)(\.|$)/.test(normalized)
  )
}

function isUploadableReleaseAsset(file) {
  return /\.(dmg|zip|exe|AppImage|blockmap|ya?ml)$/i.test(file)
}

function summarizePublish(value) {
  return Array.isArray(value)
    ? value.map((item) => ({ provider: item?.provider, url: item?.url }))
    : []
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
