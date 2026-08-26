#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const scanHistory = process.argv.includes('--history')
const scanWorktree = process.argv.includes('--worktree')
const repoRoot = process.cwd()

const forbiddenPathRules = [
  { name: 'caogen-private-config', test: (file) => /(^|\/)\.caogen-private(\/|$)/.test(file) },
  { name: 'dotenv', test: (file) => /^\.env(\..+)?$/.test(path.basename(file)) && path.basename(file) !== '.env.example' },
  { name: 'private-key-or-cert', test: (file) => /\.(pem|p12|pfx|key|mobileprovision|provisionprofile|keystore|jks|crt|cer|p8)$/i.test(file) },
  { name: 'ssh-private-key', test: (file) => /(^|\/)(id_rsa|id_ed25519)(\.|$)/.test(file) },
  { name: 'google-service-account', test: (file) => /(^|\/)(GoogleService-Info\.plist|firebase-service-account.*\.json)$/i.test(file) },
  { name: 'credential-file', test: (file) => /(^|\/).*credentials.*$/i.test(file) },
  { name: 'generated-artifact', test: (file) => /(^|\/)(node_modules|out|dist|test-results)(\/|$)/.test(file) || file === 'model-stats.json' },
  { name: 'plugin-build-artifact', test: (file) => /^plugins\/(vscode\/out|jetbrains\/build)(\/|$)/.test(file) }
]

const secretPatterns = [
  { name: 'openai-or-anthropic-key', regex: /(?<![A-Za-z0-9_])sk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github-token', regex: /(?<![A-Za-z0-9_])(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'aws-access-key', regex: /(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { name: 'google-api-key', regex: /(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{20,}/g },
  { name: 'slack-token', regex: /(?<![A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{20,}/g },
  { name: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'hardcoded-secret-assignment',
    regex: /(?<![?&])\b(api[_-]?key|token|secret|password|passwd|client_secret|private[_-]?key)\b\s*[:=]\s*['"]([^'"]{12,})['"]/gi
  }
]

const historyGrepPatterns = [
  ['openai-or-anthropic-key', '(^|[^A-Za-z0-9_-])sk-(proj-|ant-api03-)?[A-Za-z0-9_-]{20,}'],
  ['github-token', 'ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}'],
  ['aws-access-key', '(AKIA|ASIA)[0-9A-Z]{16}'],
  ['google-api-key', 'AIza[0-9A-Za-z_-]{20,}'],
  ['slack-token', 'xox[baprs]-[A-Za-z0-9-]{20,}'],
  ['private-key-block', 'BEGIN [A-Z ]*PRIVATE KEY'],
  ['hardcoded-secret-assignment', "(^|[^?&A-Za-z0-9_])(api[_-]?key|token|secret|password|passwd|client_secret|private[_-]?key)[[:space:]]*[:=][[:space:]]*['\"][^'\"]{12,}['\"]"]
]

const allowedSecretLine = new RegExp(
  [
    '<your-api-key>',
    '<secret>',
    'mock-key',
    'test-openai-key',
    'good-key',
    'bad-key',
    'bad-or-limited',
    'fixture-api-key',
    'token-for-smoke',
    'secret-for-smoke',
    'smoke-token',
    'wrong-token',
    'aliyun-token-for-smoke',
    'coding-token-for-smoke',
    'wechat-token-for-smoke',
    'new-secret-value',
    'access-token-value',
    'access-token-rotated',
    'xai-access-token',
    'xai-refresh-token',
    'xai-access-rotated',
    'service-access-token',
    'service-refresh-token',
    'github-provider-token-one',
    'github-provider-token-two',
    'github-long-lived-token',
    'xai-provider-access',
    'xai-provider-refresh',
    'xai-provider-access-rotated',
    'xai-provider-refresh-rotated',
    'quick-access-token',
    'quick-refresh-token',
    'quick-github-token',
    'rollback-access-token',
    'rollback-refresh-token',
    'REDACTED',
    'PLACEHOLDER',
    'dummy',
    'example',
    'sk-live-secret-value-that-must-not-render'
  ].join('|'),
  'i'
)

const findings = []

scanCurrentTrackedFiles()
scanIndexFiles()
if (scanWorktree) scanWorktreeSensitivePaths()
if (scanHistory) await scanGitHistory()

if (findings.length > 0) {
  console.error('Secret scan failed:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exit(1)
}

const scopes = ['tracked file contents', 'staged file contents']
if (scanWorktree) scopes.push('worktree file contents and sensitive filenames')
if (scanHistory) scopes.push('git history')
console.log(`Secret scan clean: ${scopes.join(', ')}`)

function scanCurrentTrackedFiles() {
  const files = gitList(['ls-files', '-z'])
  for (const file of files) {
    checkForbiddenPath(file, 'tracked')
    scanFileContent(file, 'tracked')
  }
}

function scanIndexFiles() {
  const files = gitList(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
  for (const file of files) {
    checkForbiddenPath(file, 'staged')
    const text = readGitBlob(':', file)
    if (text !== undefined) scanText(text, file, 'staged')
  }
}

function scanWorktreeSensitivePaths() {
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  for (const entry of status) {
    const file = normalizeStatusPath(entry)
    if (!file) continue
    for (const rule of forbiddenPathRules) {
      if (rule.test(file)) findings.push(`${file}: ${rule.name} present in worktree`)
    }
    scanFileContent(file, 'worktree')
  }
}

async function scanGitHistory() {
  const historicalFiles = new Set(gitList(['log', '--all', '--name-only', '--pretty=format:', '-z']))
  for (const file of historicalFiles) checkForbiddenPath(file, 'history')
  // Scan each reachable blob once. `git grep <pattern> <all revisions>` walks
  // every historical tree for every pattern and becomes quadratic in a large
  // repository. Blob traversal preserves full-history coverage while making
  // the required gate bounded by the number of unique file contents.
  await readReachableHistoryBlobs()
}

function readReachableHistoryBlobs() {
  const objects = gitList(['rev-list', '--objects', '--all'])
    .map((entry) => {
      const separator = entry.indexOf(' ')
      return separator > 0 ? { oid: entry.slice(0, separator), file: entry.slice(separator + 1) } : undefined
    })
    .filter((entry) => entry?.oid && entry.file)
  if (objects.length === 0) return []

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repoRoot })
    let stderr = ''
    let buffer = Buffer.alloc(0)
    let objectIndex = 0
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.stdout.on('data', (chunk) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
      while (objectIndex < objects.length) {
        const headerEnd = buffer.indexOf(0x0a)
        if (headerEnd < 0) return
        const header = buffer.subarray(0, headerEnd).toString('utf8').split(' ')
        const size = Number(header[2])
        if (!Number.isSafeInteger(size) || size < 0) {
          reject(new Error(`git cat-file returned an invalid header for ${objects[objectIndex].oid}`))
          child.kill()
          return
        }
        const bodyStart = headerEnd + 1
        if (buffer.length < bodyStart + size + 1) return
        if (header[1] === 'blob') {
          scanHistoryBlob({
            oid: objects[objectIndex].oid,
            file: objects[objectIndex].file,
            content: buffer.subarray(bodyStart, bodyStart + size)
          })
        }
        buffer = buffer.subarray(bodyStart + size + 1)
        objectIndex += 1
      }
    })
    child.on('error', reject)
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(`git cat-file --batch failed: ${stderr}`))
      else if (objectIndex !== objects.length) reject(new Error(`git cat-file returned ${objectIndex}/${objects.length} objects`))
      else resolve()
    })
    child.stdin.end(`${objects.map(({ oid }) => oid).join('\n')}\n`)
  })
}

function scanHistoryBlob({ oid, file, content }) {
  if (content.includes(0)) return
  const lines = content.toString('utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (allowedSecretLine.test(line)) continue
    const location = `${oid}:${file}:${index + 1}:${line}`
    for (const name of historyPatternNames(line)) findings.push(`${name} in history: ${safeHistoryLocation(location)}`)
  }
}

function historyPatternNames(line) {
  const matches = []
  if (/(?<![A-Za-z0-9_-])sk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{20,}/i.test(line)) matches.push('openai-or-anthropic-key')
  if (/(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/i.test(line)) matches.push('github-token')
  if (/(?:AKIA|ASIA)[0-9A-Z]{16}/.test(line)) matches.push('aws-access-key')
  if (/AIza[0-9A-Za-z_-]{20,}/.test(line)) matches.push('google-api-key')
  if (/xox[baprs]-[A-Za-z0-9-]{20,}/.test(line)) matches.push('slack-token')
  if (/BEGIN [A-Z ]*PRIVATE KEY/i.test(line)) matches.push('private-key-block')
  if (/(^|[^?&A-Za-z0-9_])(?:api[_-]?key|token|secret|password|passwd|client_secret|private[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i.test(line)) {
    matches.push('hardcoded-secret-assignment')
  }
  return matches
}

function checkForbiddenPath(file, scope) {
  for (const rule of forbiddenPathRules) {
    if (rule.test(file)) findings.push(`${file}: ${rule.name} is forbidden in ${scope}`)
  }
}

function scanFileContent(file, scope) {
  if (file === 'package-lock.json' || file.endsWith('/package-lock.json')) return
  const fullPath = path.join(repoRoot, file)
  if (!existsSync(fullPath)) return
  const text = readTextFile(fullPath)
  if (text === undefined) return
  scanText(text, file, scope)
}

function scanText(text, file, scope) {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (allowedSecretLine.test(line)) continue
    for (const pattern of secretPatterns) {
      pattern.regex.lastIndex = 0
      let match
      while ((match = pattern.regex.exec(line))) {
        findings.push(`${file}:${index + 1}: ${pattern.name} in ${scope}`)
      }
    }
  }
}

function gitList(args) {
  const output = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return output.split(args.includes('-z') ? '\0' : '\n').filter(Boolean)
}

function readGitBlob(revision, file) {
  try {
    const ref = revision === ':' ? `:${file}` : `${revision}:${file}`
    return execFileSync('git', ['show', ref], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return undefined
  }
}

function readTextFile(file) {
  try {
    const buffer = readFileSync(file)
    if (buffer.includes(0)) return undefined
    return buffer.toString('utf8')
  } catch {
    return undefined
  }
}

function normalizeStatusPath(entry) {
  const value = entry.slice(3)
  if (!value) return undefined
  const renamed = value.split(' -> ')
  return renamed[renamed.length - 1]
}

function safeHistoryLocation(line) {
  const match = line.match(/^([0-9a-f]{40}):(.+?):([0-9]+):/i)
  return match ? `${match[1].slice(0, 12)}:${match[2]}:${match[3]}` : 'location unavailable'
}
