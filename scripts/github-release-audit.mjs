#!/usr/bin/env node
import https from 'node:https'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'github-release-audit')
const reportDir = path.join(reportRoot, runId)
const repo = argValue('--repo') || process.env.CAOGEN_GITHUB_REPO || 'ChaoYuZhang001/CaoGen'
const tagFilter = argValue('--tag') || process.env.CAOGEN_GITHUB_RELEASE_TAG
const fixturePath = argValue('--json') || process.env.CAOGEN_GITHUB_RELEASES_JSON
const readTextAssets = process.argv.includes('--read-text-assets') || process.env.CAOGEN_GITHUB_RELEASE_AUDIT_READ_TEXT === '1'
const failures = []
const warnings = []

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
  const releaseSummary = {
    tagName,
    name: stringField(release, 'name') || '',
    url: stringField(release, 'html_url') || '',
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    publishedAt: stringField(release, 'published_at') || null,
    assets: []
  }

  scanText(String(release.body || ''), `${tagName} release notes`)

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
    const text = asset.textContent ?? (browserDownloadUrl ? await readTextAsset(tagName, name, browserDownloadUrl) : undefined)
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
    new RegExp(String.raw`^CaoGen-${version}\.AppImage(?:\.blockmap)?$`),
    /^latest(?:-mac|-linux)?\.ya?ml$/i
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

function shouldReadSmallTextAsset(name, size) {
  return size > 0 && size <= 1024 * 1024 && /\.(ya?ml|json|txt|md)$/i.test(name)
}

async function readTextAsset(tagName, assetName, url) {
  try {
    return await httpGetText(url, { Accept: 'application/octet-stream' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (required) failures.push(`${tagName}/${assetName}: unable to read text release asset: ${message}`)
    else warnings.push(`${tagName}/${assetName}: unable to read text release asset: ${message}`)
    return undefined
  }
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
