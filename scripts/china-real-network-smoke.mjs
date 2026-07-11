#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import deepTestStatus from './deep-test-status.cjs'

const { reportDeepTestStatus } = deepTestStatus

const repoRoot = process.cwd()
const enabled = process.env.CAOGEN_CHINA_REAL_NETWORK === '1'
const required = process.env.CAOGEN_CHINA_REAL_NETWORK_REQUIRED === '1' || process.argv.includes('--required')
const requiredTargets = parseRequiredTargets(process.env.CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS)
const results = []
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'china-real-network', runId)
const configurationGuide = 'docs/P2-EXTERNAL-REQUIRED.md'
const supportedTargets = [
  'feishu',
  'dingtalk',
  'wecom',
  'gitee_issue',
  'gitee_pull_request',
  'aliyun_yunxiao_api',
  'tencent_coding_api',
  'wechat_miniprogram_api'
]
const unsupportedRequiredTargets = requiredTargets.filter((target) => !supportedTargets.includes(target))
mkdirSync(reportDir, { recursive: true })

if (!enabled) {
  const report = {
    status: required ? 'failed' : 'skipped',
    required,
    reportDir,
    supportedTargets,
    requiredTargets,
    configurationGuide,
    missingConfiguration: missingRealNetworkConfiguration(),
    reason: 'set CAOGEN_CHINA_REAL_NETWORK=1 and provide target credentials',
    results
  }
  writeReport(report)
  const deepStatusReported = reportDeepTestStatus(required ? 'blocked' : 'skip', {
    reason: report.reason,
    details: { reportDir }
  })
  console.log('SKIP china real network smoke: set CAOGEN_CHINA_REAL_NETWORK=1 and provide target credentials')
  if (required && !deepStatusReported) process.exit(1)
  process.exit(0)
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-china-real-network-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  compile(
    [
      'src/main/notification/feishu.ts',
      'src/main/notification/dingtalk.ts',
      'src/main/notification/wecom.ts',
      'src/main/agent/tools/gitee-tools.ts'
    ],
    outDir
  )

  const feishu = await import(pathToFileURL(findCompiled(outDir, 'feishu.js')).href)
  const dingtalk = await import(pathToFileURL(findCompiled(outDir, 'dingtalk.js')).href)
  const wecom = await import(pathToFileURL(findCompiled(outDir, 'wecom.js')).href)
  const gitee = await import(pathToFileURL(findCompiled(outDir, 'gitee-tools.js')).href)

  await runOptional('feishu', Boolean(process.env.FEISHU_WEBHOOK_URL), async () => {
    assertRequiredPublicEndpoint(process.env.FEISHU_WEBHOOK_URL, 'feishu')
    const result = await feishu.sendFeishuNotification(
      { title: 'CaoGen P2-004 real network smoke', text: `timestamp=${new Date().toISOString()}` },
      { webhookUrl: process.env.FEISHU_WEBHOOK_URL, secret: process.env.FEISHU_WEBHOOK_SECRET, dryRun: false }
    )
    return normalizeSendResult(result, process.env.FEISHU_WEBHOOK_URL)
  })

  await runOptional('dingtalk', Boolean(process.env.DINGTALK_WEBHOOK_URL), async () => {
    assertRequiredPublicEndpoint(process.env.DINGTALK_WEBHOOK_URL, 'dingtalk')
    const result = await dingtalk.sendDingTalkNotification(
      { title: 'CaoGen P2-004 real network smoke', text: `timestamp=${new Date().toISOString()}` },
      { webhookUrl: process.env.DINGTALK_WEBHOOK_URL, secret: process.env.DINGTALK_WEBHOOK_SECRET, dryRun: false }
    )
    return normalizeSendResult(result, process.env.DINGTALK_WEBHOOK_URL)
  })

  await runOptional('wecom', Boolean(process.env.WECOM_WEBHOOK_URL), async () => {
    assertRequiredPublicEndpoint(process.env.WECOM_WEBHOOK_URL, 'wecom')
    const result = await wecom.sendWeComNotification(
      { title: 'CaoGen P2-004 real network smoke', text: `timestamp=${new Date().toISOString()}` },
      { webhookUrl: process.env.WECOM_WEBHOOK_URL, dryRun: false }
    )
    return normalizeSendResult(result, process.env.WECOM_WEBHOOK_URL)
  })

  await runOptional(
    'gitee_issue',
    Boolean(process.env.GITEE_ACCESS_TOKEN && process.env.GITEE_OWNER && process.env.GITEE_REPO),
    async () => {
      if (process.env.GITEE_API_URL) assertRequiredPublicEndpoint(process.env.GITEE_API_URL, 'gitee_issue')
      const result = await gitee.sendGiteeIssue(
        {
          owner: process.env.GITEE_OWNER,
          repo: process.env.GITEE_REPO,
          title: `CaoGen P2-004 real network smoke ${new Date().toISOString()}`,
          body: 'Evidence issue created by an explicitly enabled CaoGen real-network smoke.',
          labels: ['caogen-smoke']
        },
        { accessToken: process.env.GITEE_ACCESS_TOKEN, baseApiUrl: process.env.GITEE_API_URL, dryRun: false }
      )
      return normalizeSendResult(result, result.request?.url)
    }
  )

  await runOptional(
    'gitee_pull_request',
    Boolean(
      process.env.GITEE_ACCESS_TOKEN &&
      process.env.GITEE_OWNER &&
      process.env.GITEE_REPO &&
      process.env.GITEE_PR_HEAD &&
      process.env.GITEE_PR_BASE
    ),
    async () => {
      if (process.env.GITEE_API_URL) assertRequiredPublicEndpoint(process.env.GITEE_API_URL, 'gitee_pull_request')
      const result = await gitee.sendGiteePullRequest(
        {
          owner: process.env.GITEE_OWNER,
          repo: process.env.GITEE_REPO,
          title: `CaoGen P2-004 real PR smoke ${new Date().toISOString()}`,
          head: process.env.GITEE_PR_HEAD,
          base: process.env.GITEE_PR_BASE,
          body: 'Evidence pull request created by an explicitly enabled CaoGen real-network smoke.',
          draft: process.env.GITEE_PR_DRAFT === '1'
        },
        { accessToken: process.env.GITEE_ACCESS_TOKEN, baseApiUrl: process.env.GITEE_API_URL, dryRun: false }
      )
      return normalizeSendResult(result, result.request?.url)
    }
  )

  await runOptional('aliyun_yunxiao_api', Boolean(process.env.ALIYUN_YUNXIAO_API_URL || process.env.ALIYUN_DEVOPS_CHECK_URL), async () =>
    requestConfiguredApi({
      url: process.env.ALIYUN_YUNXIAO_API_URL || process.env.ALIYUN_DEVOPS_CHECK_URL,
      token: process.env.ALIYUN_YUNXIAO_TOKEN || process.env.ALIYUN_DEVOPS_TOKEN,
      method: process.env.ALIYUN_YUNXIAO_METHOD,
      bodyText: process.env.ALIYUN_YUNXIAO_BODY,
      authPrefix: process.env.ALIYUN_YUNXIAO_AUTH_PREFIX
    })
  )
  await runOptional('tencent_coding_api', Boolean(process.env.TENCENT_CODING_API_URL || process.env.TENCENT_CODING_CHECK_URL), async () =>
    requestConfiguredApi({
      url: process.env.TENCENT_CODING_API_URL || process.env.TENCENT_CODING_CHECK_URL,
      token: process.env.TENCENT_CODING_TOKEN,
      method: process.env.TENCENT_CODING_METHOD,
      bodyText: process.env.TENCENT_CODING_BODY,
      authPrefix: process.env.TENCENT_CODING_AUTH_PREFIX
    })
  )
  await runOptional('wechat_miniprogram_api', Boolean(process.env.WECHAT_MINIPROGRAM_API_URL || process.env.WECHAT_MINIPROGRAM_CHECK_URL), async () =>
    requestConfiguredApi({
      url: process.env.WECHAT_MINIPROGRAM_API_URL || process.env.WECHAT_MINIPROGRAM_CHECK_URL,
      token: process.env.WECHAT_MINIPROGRAM_TOKEN,
      method: process.env.WECHAT_MINIPROGRAM_METHOD,
      bodyText: process.env.WECHAT_MINIPROGRAM_BODY,
      authPrefix: process.env.WECHAT_MINIPROGRAM_AUTH_PREFIX
    })
  )

  const active = results.filter((item) => item.status !== 'skipped')
  const missingRequiredTargets = requiredTargets
    .filter((target) => supportedTargets.includes(target))
    .filter((target) => results.find((item) => item.name === target)?.status !== 'pass')
  const failures = []
  for (const target of unsupportedRequiredTargets) failures.push(`unsupported required target ${target}`)
  if (required && requiredTargets.length === 0) failures.push('required mode needs CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS to declare real targets')
  if (required && active.length === 0) failures.push('required mode needs at least one active real-network check')
  for (const target of missingRequiredTargets) failures.push(`required target ${target} did not pass`)
  if (results.some((item) => item.status === 'fail')) failures.push('one or more active real-network checks failed')
  const report = {
    status: failures.length > 0 ? 'failed' : active.length === 0 ? 'skipped' : 'passed',
    required,
    supportedTargets,
    requiredTargets,
    missingConfiguration: missingRealNetworkConfiguration(),
    configurationGuide,
    activeChecks: active.length,
    reportDir,
    results,
    failures
  }
  writeReport(report)
  reportDeepTestStatus(deepStatus(report.status), {
    ...(report.status === 'passed' ? {} : { reason: report.failures.join('; ') || 'no active real-network checks' }),
    details: { reportDir, activeChecks: report.activeChecks }
  })
  console.log(JSON.stringify(report, null, 2))
  if (failures.length > 0) process.exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function deepStatus(status) {
  if (status === 'passed') return 'pass'
  if (status === 'skipped') return 'skip'
  return 'fail'
}

async function runOptional(name, shouldRun, fn) {
  if (!shouldRun) {
    results.push({ name, status: 'skipped', reason: 'missing explicit environment configuration' })
    return
  }
  const started = Date.now()
  try {
    const evidence = await fn()
    results.push({ name, status: evidence.ok === true ? 'pass' : 'fail', durationMs: Date.now() - started, ...evidence })
  } catch (error) {
    results.push({ name, status: 'fail', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
  }
}

function normalizeSendResult(result, url) {
  return {
    ok: result.ok === true && result.sent === true && result.dryRun === false,
    endpoint: maskUrl(url),
    statusCode: result.status,
    sent: result.sent === true,
    dryRun: result.dryRun === true,
    responsePreview: preview(result.responseText),
    error: result.error
  }
}

async function checkUrl(rawUrl, token) {
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const headers = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' }
    if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`
    const response = await fetch(rawUrl, { method: 'GET', headers, signal: controller.signal })
    const responseText = await response.text()
    return {
      ok: response.status >= 200 && response.status < 400,
      endpoint: maskUrl(rawUrl),
      statusCode: response.status,
      latencyMs: Date.now() - started,
      responsePreview: preview(responseText)
    }
  } catch (error) {
    return { ok: false, endpoint: maskUrl(rawUrl), latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function requestConfiguredApi(options) {
  const rawUrl = requiredEnvText(options.url, 'api url')
  assertRequiredPublicEndpoint(rawUrl, 'configured_api')
  const method = normalizeMethod(options.method, options.bodyText)
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const headers = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' }
    const token = options.token?.trim()
    if (token) headers.authorization = `${options.authPrefix?.trim() || 'Bearer'} ${token}`
    const body = normalizeRequestBody(options.bodyText)
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
    const response = await fetch(rawUrl, { method, headers, body, signal: controller.signal })
    const responseText = await response.text()
    return {
      ok: response.status >= 200 && response.status < 400,
      endpoint: maskUrl(rawUrl),
      method,
      statusCode: response.status,
      latencyMs: Date.now() - started,
      responsePreview: preview(responseText)
    }
  } catch (error) {
    return {
      ok: false,
      endpoint: maskUrl(rawUrl),
      method,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

function normalizeMethod(value, bodyText) {
  const method = value?.trim().toUpperCase()
  if (method) return method
  return bodyText?.trim() ? 'POST' : 'GET'
}

function normalizeRequestBody(value) {
  const text = value?.trim()
  if (!text) return undefined
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return JSON.stringify({ text })
  }
}

function requiredEnvText(value, name) {
  const text = value?.trim()
  if (!text) throw new Error(`missing ${name}`)
  return text
}

function compile(files, outDir) {
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  const found = findCompiledOptional(root, fileName)
  if (!found) throw new Error(`compiled ${fileName} not found`)
  return found
}

function findCompiledOptional(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function maskUrl(rawUrl) {
  if (!rawUrl) return undefined
  try {
    const url = new URL(rawUrl)
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|sign|access/i.test(key)) url.searchParams.set(key, '***')
    }
    return url.toString()
  } catch {
    return String(rawUrl).replace(/(token|key|secret|sign)=([^&\s]+)/gi, '$1=***')
  }
}

function preview(text) {
  if (!text) return undefined
  const redacted = redactPreview(text)
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted
}

function parseRequiredTargets(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function missingRealNetworkConfiguration() {
  const missing = []
  if (targetSelected('feishu') && !process.env.FEISHU_WEBHOOK_URL) missing.push({ target: 'feishu', env: ['FEISHU_WEBHOOK_URL'] })
  if (targetSelected('dingtalk') && !process.env.DINGTALK_WEBHOOK_URL) missing.push({ target: 'dingtalk', env: ['DINGTALK_WEBHOOK_URL'] })
  if (targetSelected('wecom') && !process.env.WECOM_WEBHOOK_URL) missing.push({ target: 'wecom', env: ['WECOM_WEBHOOK_URL'] })
  if (targetSelected('gitee_issue') && !(process.env.GITEE_ACCESS_TOKEN && process.env.GITEE_OWNER && process.env.GITEE_REPO)) {
    missing.push({ target: 'gitee_issue', env: ['GITEE_ACCESS_TOKEN', 'GITEE_OWNER', 'GITEE_REPO'] })
  }
  if (targetSelected('gitee_pull_request') && !(process.env.GITEE_ACCESS_TOKEN && process.env.GITEE_OWNER && process.env.GITEE_REPO && process.env.GITEE_PR_HEAD && process.env.GITEE_PR_BASE)) {
    missing.push({
      target: 'gitee_pull_request',
      env: ['GITEE_ACCESS_TOKEN', 'GITEE_OWNER', 'GITEE_REPO', 'GITEE_PR_HEAD', 'GITEE_PR_BASE']
    })
  }
  if (targetSelected('aliyun_yunxiao_api') && !(process.env.ALIYUN_YUNXIAO_API_URL || process.env.ALIYUN_DEVOPS_CHECK_URL)) {
    missing.push({ target: 'aliyun_yunxiao_api', env: ['ALIYUN_YUNXIAO_API_URL'] })
  }
  if (targetSelected('tencent_coding_api') && !(process.env.TENCENT_CODING_API_URL || process.env.TENCENT_CODING_CHECK_URL)) {
    missing.push({ target: 'tencent_coding_api', env: ['TENCENT_CODING_API_URL'] })
  }
  if (targetSelected('wechat_miniprogram_api') && !(process.env.WECHAT_MINIPROGRAM_API_URL || process.env.WECHAT_MINIPROGRAM_CHECK_URL)) {
    missing.push({ target: 'wechat_miniprogram_api', env: ['WECHAT_MINIPROGRAM_API_URL'] })
  }
  for (const target of unsupportedRequiredTargets) missing.push({ target, error: 'unsupported target' })
  return missing
}

function targetSelected(name) {
  return requiredTargets.length === 0 || requiredTargets.includes(name)
}

function assertRequiredPublicEndpoint(rawUrl, target) {
  if (!required) return
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`${target} endpoint must be a valid URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${target} endpoint must use https in required mode`)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw new Error(`${target} endpoint host is empty`)
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'example.com' ||
    host.endsWith('.example.com') ||
    host === 'invalid' ||
    host.endsWith('.invalid') ||
    /(^|[-.])mock([-.]|$)/i.test(host) ||
    isPrivateHost(host)
  ) {
    throw new Error(`${target} endpoint must be a public real-network host, got ${host}`)
  }
}

function isPrivateHost(host) {
  if (host === '::1') return true
  if (/^(fc|fd|fe80):/i.test(host)) return true
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 0)
  )
}

function redactPreview(text) {
  return text
    .replace(/(authorization|access_token|refresh_token|token|secret|api[_-]?key|sign|password)["'=:\s]+([^"',\s&]+)/gi, '$1=***')
    .replace(/(https?:\/\/[^?\s]+)\?([^\s]+)/gi, (_match, baseUrl, query) => {
      const redacted = String(query).replace(/([^=&\s]*(?:token|secret|key|sign|access)[^=&\s]*)=([^&\s]+)/gi, '$1=***')
      return `${baseUrl}?${redacted}`
    })
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const json = JSON.stringify(report, null, 2)
  writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8')
  writeFileSync(path.join(repoRoot, 'test-results', 'china-real-network', 'latest.json'), json, 'utf8')
}
