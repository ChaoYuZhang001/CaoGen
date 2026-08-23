#!/usr/bin/env node
import { createHash } from 'node:crypto'
import https from 'node:https'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { platformScopedReleaseArtifactNames } from './lib/release-platform-matrix.mjs'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'github-release-audit')
const reportDir = path.join(reportRoot, runId)
const repo = argValue('--repo') || process.env.CAOGEN_GITHUB_REPO || 'ChaoYuZhang001/CaoGen'
const explicitTagFilter = argValue('--tag') || process.env.CAOGEN_GITHUB_RELEASE_TAG
const fixturePath = argValue('--json') || process.env.CAOGEN_GITHUB_RELEASES_JSON
const readTextAssets = process.argv.includes('--read-text-assets') || process.env.CAOGEN_GITHUB_RELEASE_AUDIT_READ_TEXT === '1'
const expectedAssetsFromDist = process.argv.includes('--expected-assets-from-dist') || process.env.CAOGEN_GITHUB_RELEASE_EXPECT_DIST === '1'
const expectedAssetsDirArg = argValue('--expected-assets-dir') || process.env.CAOGEN_GITHUB_RELEASE_EXPECTED_ASSETS_DIR
const expectedAssetsFromNotesArg = optionalArgValue('--expected-assets-from-notes', 'docs/RELEASE-NOTES-FINAL.md')
  || process.env.CAOGEN_GITHUB_RELEASE_EXPECTED_ASSETS_NOTES
const platformScoped = process.argv.includes('--platform-scoped') || process.env.CAOGEN_GITHUB_RELEASE_PLATFORM_SCOPED === '1'
const failures = []
const warnings = []
const expectedAssetsDir = expectedAssetsDirArg
  ? path.resolve(expectedAssetsDirArg)
  : expectedAssetsFromDist
    ? path.join(repoRoot, 'dist')
    : undefined
const releaseNotesPath = expectedAssetsFromNotesArg ? path.resolve(expectedAssetsFromNotesArg) : undefined
const releaseNotesContract = releaseNotesPath ? readReleaseNotesContract(releaseNotesPath) : null
const tagFilter = explicitTagFilter || releaseNotesContract?.tagName
const platformScopedEvidence = platformScoped ? await readPlatformScopedDistEvidence() : { assets: [], digests: {} }
const expectedAssetEvidence = expectedAssetsDir
  ? readExpectedAssetEvidence(expectedAssetsDir)
  : releaseNotesContract?.assetEvidence || {}
const expectedAssets = platformScoped ? platformScopedEvidence.assets : Object.keys(expectedAssetEvidence).sort()

if (expectedAssetsFromDist && expectedAssetsDirArg) {
  failures.push('use either --expected-assets-from-dist or --expected-assets-dir, not both')
}
if (expectedAssetsDir && releaseNotesPath) {
  failures.push('use either local expected assets or --expected-assets-from-notes, not both')
}
if (expectedAssetsDir && !tagFilter) failures.push('local expected assets require an explicit --tag')
if (releaseNotesContract?.tagName && explicitTagFilter && releaseNotesContract.tagName !== explicitTagFilter) {
  failures.push(`release notes tag ${releaseNotesContract.tagName} does not match requested tag ${explicitTagFilter}`)
}
if (platformScoped && (expectedAssetsDir || releaseNotesPath)) {
  failures.push('use --platform-scoped without another expected-assets source')
}
if (platformScoped && !tagFilter) failures.push('--platform-scoped requires an explicit --tag')

let releases = []
let source = fixturePath ? `json:${path.relative(repoRoot, path.resolve(fixturePath))}` : `github:${repo}`
let fetchError = null

try {
  releases = fixturePath ? readFixture(fixturePath) : await fetchReleases(repo)
} catch (error) {
  fetchError = error instanceof Error ? error.message : String(error)
  failures.push(`unable to read GitHub Releases: ${fetchError}`)
}

if (!fetchError && tagFilter) {
  releases = releases.filter((release) => release.tag_name === tagFilter)
  if (releases.length === 0) failures.push(`release tag not found: ${tagFilter}`)
}

const checkedReleases = []
if (!fetchError) {
  for (const release of releases) checkedReleases.push(await inspectRelease(release))
  if (checkedReleases.length === 0) {
    if (required) failures.push('no GitHub Releases were found to audit')
    else warnings.push('no GitHub Releases were found to audit')
  }
  if ((expectedAssetsDir || releaseNotesContract || platformScoped) && tagFilter && checkedReleases.length === 1) {
    const actualAssets = checkedReleases[0].assets.map((asset) => asset.name).sort()
    if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
      const evidenceLabel = platformScoped
        ? 'platform-scoped local dist evidence'
        : releaseNotesContract
          ? `release notes contract ${releaseNotesContract.relativePath}`
          : 'local dist evidence'
      failures.push(`${tagFilter}: release assets must exactly match ${evidenceLabel}; expected ${expectedAssets.join(', ')}`)
    }
    if (!platformScoped) validateExpectedAssetEvidence(checkedReleases[0])
    if (platformScoped) validatePlatformScopedDigests(checkedReleases[0].assets)
  }
}

const status = fetchError && !required ? 'skipped' : failures.length === 0 ? 'passed' : 'failed'
const report = {
  status,
  required,
  runId,
  reportDir,
  repo,
  tagFilter: tagFilter || null,
  source,
  readTextAssets,
  expectedAssetsFromDist,
  expectedAssetsDir: expectedAssetsDir || null,
  expectedAssetsFromNotes: releaseNotesContract?.relativePath || null,
  releaseNotesContract: releaseNotesContract
    ? {
        tagName: releaseNotesContract.tagName,
        assetCount: releaseNotesContract.assets.length,
        bodySha256: releaseNotesContract.bodySha256
      }
    : null,
  expectedAssets,
  expectedAssetEvidence,
  platformScoped,
  expectedAssetDigests: platformScoped ? platformScopedEvidence.digests : undefined,
  releaseCount: checkedReleases.length,
  assetCount: checkedReleases.reduce((total, release) => total + release.assets.length, 0),
  redactionPolicy: 'No secret values are emitted. The audit reports release tags, asset names, sizes, states, and failure categories only.',
  checkedReleases,
  warnings,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (status === 'failed') process.exitCode = 1

async function inspectRelease(release) {
  const tagName = stringField(release, 'tag_name') || 'unknown'
  const tagVersion = versionFromTag(tagName)
  const releaseBody = String(release.body || '')
  let releaseNotesBodyMatches = null
  const releaseSummary = {
    tagName,
    name: stringField(release, 'name') || '',
    url: stringField(release, 'html_url') || '',
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    publishedAt: stringField(release, 'published_at') || null,
    releaseNotesBodyMatches,
    assets: []
  }

  scanText(releaseBody, `${tagName} release notes`)
  if (releaseNotesContract && tagName === releaseNotesContract.tagName) {
    releaseNotesBodyMatches = normalizeMarkdown(releaseBody) === normalizeMarkdown(releaseNotesContract.body)
    releaseSummary.releaseNotesBodyMatches = releaseNotesBodyMatches
    if (!releaseNotesBodyMatches) {
      failures.push(`${tagName}: release notes body does not match ${releaseNotesContract.relativePath}`)
    }
  }

  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const assetSummary = await inspectAsset(tagName, tagVersion, asset)
    releaseSummary.assets.push(assetSummary)
  }

  return releaseSummary
}

async function inspectAsset(tagName, tagVersion, asset) {
  const name = stringField(asset, 'name') || 'unnamed'
  const size = numberField(asset, 'size') || 0
  const state = stringField(asset, 'state') || 'unknown'
  const contentType = stringField(asset, 'content_type') || ''
  const apiDownloadUrl = stringField(asset, 'url') || ''
  const browserDownloadUrl = stringField(asset, 'browser_download_url') || ''
  const categories = {
    allowedName: allowedReleaseAssetName(name),
    forbiddenName: forbiddenReleaseAssetName(name),
    suspiciousName: suspiciousReleaseAssetName(name)
  }
  const versions = versionsInAssetName(name)

  if (state !== 'uploaded') failures.push(`${tagName}/${name}: asset state is ${state}`)
  if (size <= 0) failures.push(`${tagName}/${name}: release asset is empty`)
  if (categories.forbiddenName) failures.push(`${tagName}/${name}: forbidden public release asset name`)
  if (categories.suspiciousName) failures.push(`${tagName}/${name}: suspicious secret/evidence-like release asset name`)
  if (!categories.allowedName) failures.push(`${tagName}/${name}: unexpected release asset name`)
  if (tagVersion) {
    for (const version of versions) {
      if (version !== tagVersion) failures.push(`${tagName}/${name}: asset version ${version} does not match release tag ${tagVersion}`)
    }
  }

  if (readTextAssets && shouldReadSmallTextAsset(name, size)) {
    const downloadUrls = [apiDownloadUrl, browserDownloadUrl].filter(Boolean)
    const text = asset.textContent ?? (downloadUrls.length > 0 ? await readTextAsset(tagName, name, downloadUrls) : undefined)
    if (typeof text === 'string') {
      scanText(text, `${tagName}/${name}`)
      if (/^latest.*\.ya?ml$/i.test(name) && tagVersion && !text.includes(`version: ${tagVersion}`)) {
        failures.push(`${tagName}/${name}: update metadata does not reference version ${tagVersion}`)
      }
    }
  }

  return {
    name,
    size,
    state,
    contentType,
    digest: stringField(asset, 'digest') || null,
    allowedName: categories.allowedName,
    forbiddenName: categories.forbiddenName,
    suspiciousName: categories.suspiciousName,
    versions
  }
}

function allowedReleaseAssetName(name) {
  const version = String.raw`\d+\.\d+\.\d+`
  const rules = [
    new RegExp(String.raw`^CaoGen-${version}(?:-arm64)?\.dmg(?:\.blockmap)?$`),
    new RegExp(String.raw`^CaoGen-${version}(?:-arm64)?-mac\.zip(?:\.blockmap)?$`),
    new RegExp(String.raw`^CaoGen\.Setup\.${version}\.exe(?:\.blockmap)?$`),
    new RegExp(String.raw`^CaoGen-Setup-${version}\.exe(?:\.blockmap)?$`),
    new RegExp(String.raw`^CaoGen-${version}-windows-x64-unsigned-preview\.exe(?:\.blockmap)?$`),
    new RegExp(String.raw`^CaoGen-${version}\.AppImage(?:\.blockmap)?$`),
    /^latest(?:-mac|-linux)?\.ya?ml$/i,
    /^SHA256SUMS\.txt$/
  ]
  return rules.some((rule) => rule.test(name))
}

function forbiddenReleaseAssetName(name) {
  const normalized = name.split('\\').join('/')
  const base = path.basename(normalized)
  return (
    /^\.env(?:\..+)?$/i.test(base) ||
    /\.(pem|p12|pfx|key|mobileprovision|provisionprofile|keystore|jks|crt|cer|p8)(?:$|\.)/i.test(base) ||
    /^(node_modules|test-results|out|dist|\.vscode-test)(?:$|[/. _-])/i.test(normalized) ||
    /(^|\/)(id_rsa|id_ed25519)(?:$|[. _-])/i.test(normalized) ||
    /(^|\/)(GoogleService-Info\.plist|firebase-service-account.*\.json)$/i.test(normalized) ||
    /\.(log|sqlite|db)(?:$|\.)/i.test(base)
  )
}

function suspiciousReleaseAssetName(name) {
  return (
    /\b(api[-_ ]?key|token|secret|password|passwd|credential|webhook|signing|notary|notarization)\b/i.test(name) ||
    /\b(evidence|test[-_ ]?results|n1[-_ ]?migration|audit[-_ ]?pack|local[-_ ]?record)\b/i.test(name)
  )
}

function versionsInAssetName(name) {
  return [...new Set(name.match(/\d+\.\d+\.\d+/g) || [])]
}

function versionFromTag(tagName) {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(tagName)
  if (!match) warnings.push(`${tagName}: release tag is not a plain semantic version tag`)
  return match?.[1]
}

function versionFromTagWithoutWarning(tagName) {
  return /^v?(\d+\.\d+\.\d+)$/.exec(tagName || '')?.[1]
}

function shouldReadSmallTextAsset(name, size) {
  return size > 0 && size <= 1024 * 1024 && /\.(ya?ml|json|txt|md)$/i.test(name)
}

function readExpectedAssetEvidence(directory) {
  if (!existsSync(directory)) {
    failures.push(`local expected assets directory is missing: ${directory}`)
    return {}
  }
  const evidence = {}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      failures.push(`local expected assets directory contains a non-file entry: ${entry.name}`)
      continue
    }
    if (!allowedReleaseAssetName(entry.name) || forbiddenReleaseAssetName(entry.name) || suspiciousReleaseAssetName(entry.name)) {
      failures.push(`local expected assets directory contains an unapproved file: ${entry.name}`)
      continue
    }
    const filePath = path.join(directory, entry.name)
    evidence[entry.name] = {
      size: statSync(filePath).size,
      sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex')
    }
  }
  return evidence
}

function readReleaseNotesContract(filePath) {
  const relativePath = path.relative(repoRoot, filePath)
  if (!existsSync(filePath)) {
    failures.push(`release notes contract is missing: ${filePath}`)
    return emptyReleaseNotesContract(relativePath)
  }

  const body = readFileSync(filePath, 'utf8')
  const lines = body.split(/\r?\n/)
  const tagName = releaseTagFromNotes(lines, relativePath)
  const parsedAssets = parseReleaseAssetsSection(lines)
  const listedAssets = validateReleaseNotesAssets(parsedAssets, tagName, relativePath)
  const assetEvidence = Object.fromEntries(parsedAssets.digestRows.map(({ name, sha256 }) => [name, { sha256 }]))
  return {
    tagName,
    relativePath,
    body,
    bodySha256: createHash('sha256').update(normalizeMarkdown(body)).digest('hex'),
    assets: listedAssets,
    assetEvidence
  }
}

function emptyReleaseNotesContract(relativePath) {
  return {
    tagName: null,
    relativePath,
    body: '',
    bodySha256: null,
    assets: [],
    assetEvidence: {}
  }
}

function releaseTagFromNotes(lines, relativePath) {
  const titleTags = lines
    .map((line) => /^#\s+.+?\b(v\d+\.\d+\.\d+)\b.*$/i.exec(line)?.[1])
    .filter(Boolean)
  const tagNames = [...new Set(titleTags)]
  const tagName = tagNames.length === 1 ? tagNames[0] : null
  if (!tagName) failures.push(`${relativePath}: expected one release version in the H1 title`)
  return tagName
}

function parseReleaseAssetsSection(lines) {
  let inUploadedAssets = false
  let uploadedAssetsHeadingCount = 0
  let sha256HeadingCount = 0
  const assets = []
  const digestRows = []
  for (const line of lines) {
    if (/^##\s+Uploaded Assets\s*$/i.test(line)) {
      inUploadedAssets = true
      uploadedAssetsHeadingCount += 1
      continue
    }
    if (inUploadedAssets && /^##\s+/.test(line)) {
      inUploadedAssets = false
      continue
    }
    if (!inUploadedAssets) continue
    if (/^###\s+SHA256\s*$/i.test(line)) {
      sha256HeadingCount += 1
      continue
    }
    const assetMatch = /^\s*-\s+`([^`]+)`\s*$/.exec(line)
    if (assetMatch) assets.push(assetMatch[1])
    const digestMatch = /^\s*\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$/i.exec(line)
    if (digestMatch) digestRows.push({ name: digestMatch[1], sha256: digestMatch[2].toLowerCase() })
  }
  return { assets, digestRows, uploadedAssetsHeadingCount, sha256HeadingCount }
}

function validateReleaseNotesAssets(parsed, tagName, relativePath) {
  const { assets, digestRows, uploadedAssetsHeadingCount, sha256HeadingCount } = parsed
  if (uploadedAssetsHeadingCount !== 1) {
    failures.push(`${relativePath}: expected exactly one Uploaded Assets section`)
  }
  if (sha256HeadingCount !== 1) failures.push(`${relativePath}: expected exactly one SHA256 table`)
  if (assets.length === 0) failures.push(`${relativePath}: Uploaded Assets list is empty`)

  const duplicateAssets = duplicateValues(assets)
  if (duplicateAssets.length > 0) failures.push(`${relativePath}: duplicate Uploaded Assets entries: ${duplicateAssets.join(', ')}`)
  const duplicateDigests = duplicateValues(digestRows.map((row) => row.name))
  if (duplicateDigests.length > 0) failures.push(`${relativePath}: duplicate SHA256 entries: ${duplicateDigests.join(', ')}`)

  const listedAssets = [...new Set(assets)].sort()
  const digestAssets = [...new Set(digestRows.map((row) => row.name))].sort()
  if (JSON.stringify(listedAssets) !== JSON.stringify(digestAssets)) {
    failures.push(`${relativePath}: Uploaded Assets and SHA256 rows must contain the same names`)
  }

  const expectedVersion = versionFromTagWithoutWarning(tagName)
  for (const name of listedAssets) {
    if (!allowedReleaseAssetName(name) || forbiddenReleaseAssetName(name) || suspiciousReleaseAssetName(name)) {
      failures.push(`${relativePath}: unapproved release asset in contract: ${name}`)
    }
    for (const version of versionsInAssetName(name)) {
      if (expectedVersion && version !== expectedVersion) {
        failures.push(`${relativePath}: asset ${name} does not match release tag ${tagName}`)
      }
    }
  }
  return listedAssets
}

function validateExpectedAssetEvidence(release) {
  const actualByName = Object.fromEntries(release.assets.map((asset) => [asset.name, asset]))
  for (const [name, expected] of Object.entries(expectedAssetEvidence)) {
    const actual = actualByName[name]
    if (!actual) continue
    if (typeof expected.size === 'number' && actual.size !== expected.size) {
      failures.push(`${tagFilter}/${name}: public size ${actual.size} does not match local ${expected.size}`)
    }
    const expectedDigest = `sha256:${expected.sha256}`
    if (actual.digest !== expectedDigest) {
      failures.push(`${tagFilter}/${name}: public digest ${actual.digest || 'missing'} does not match local ${expectedDigest}`)
    }
  }
}

async function readPlatformScopedDistEvidence() {
  const version = versionFromTag(tagFilter || '')
  if (!version) return { assets: [], digests: {} }
  const expected = platformScopedReleaseArtifactNames(version).sort()
  const missing = expected.filter((name) => !existsSync(path.join(repoRoot, 'dist', name)))
  if (missing.length > 0) {
    failures.push(`platform-scoped local dist assets are missing: ${missing.join(', ')}`)
  }
  const present = expected.filter((name) => !missing.includes(name))
  const digests = Object.fromEntries(await Promise.all(present.map(async (name) => [
    name,
    await sha256File(path.join(repoRoot, 'dist', name))
  ])))
  return { assets: expected, digests }
}

function validatePlatformScopedDigests(assets) {
  for (const asset of assets) {
    const expected = platformScopedEvidence.digests[asset.name]
    if (!expected) continue
    if (asset.digest !== `sha256:${expected}`) {
      failures.push(`${tagFilter}/${asset.name}: GitHub asset digest does not match local dist evidence`)
    }
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function readTextAsset(tagName, assetName, urls) {
  let lastError
  for (const url of urls) {
    try {
      return await httpGetText(url, { Accept: 'application/octet-stream' })
    } catch (error) {
      lastError = error
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  if (required) failures.push(`${tagName}/${assetName}: unable to read text release asset: ${message}`)
  else warnings.push(`${tagName}/${assetName}: unable to read text release asset: ${message}`)
  return undefined
}

function scanText(text, label) {
  const patterns = [
    { name: 'openai-or-anthropic-key', regex: /(?<![A-Za-z0-9_])sk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{20,}/g },
    { name: 'github-token', regex: /(?<![A-Za-z0-9_])(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
    { name: 'aws-access-key', regex: /(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}/g },
    { name: 'google-api-key', regex: /(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{20,}/g },
    { name: 'slack-token', regex: /(?<![A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{20,}/g },
    { name: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
  ]
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0
      if (pattern.regex.test(line)) failures.push(`${label}:${index + 1}: ${pattern.name}`)
    }
  }
}

function readFixture(filePath) {
  if (!existsSync(filePath)) throw new Error(`fixture does not exist: ${filePath}`)
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed.releases) ? parsed.releases : []
}

async function fetchReleases(ownerRepo) {
  const url = `https://api.github.com/repos/${ownerRepo}/releases?per_page=100`
  const text = await httpGetText(url, { Accept: 'application/vnd.github+json' })
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('GitHub API response was not a release list')
  return parsed
}

function httpGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    const request = https.get(url, {
      headers: {
        'User-Agent': 'caogen-release-audit',
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        httpGetText(response.headers.location, headers).then(resolve, reject)
        return
      }
      let data = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { data += chunk })
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode || 'unknown'}`))
          return
        }
        resolve(data)
      })
    })
    request.on('error', reject)
    request.setTimeout(30000, () => {
      request.destroy(new Error('request timed out'))
    })
  })
}

function stringField(value, key) {
  return typeof value?.[key] === 'string' ? value[key] : undefined
}

function numberField(value, key) {
  return typeof value?.[key] === 'number' ? value[key] : undefined
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function optionalArgValue(name, defaultValue) {
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const next = process.argv[index + 1]
  return next && !next.startsWith('--') ? next : defaultValue
}

function duplicateValues(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort()
}

function normalizeMarkdown(value) {
  return String(value).replace(/\r\n/g, '\n').trim()
}
