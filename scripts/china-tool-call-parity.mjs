#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import deepTestStatus from './deep-test-status.cjs'

const { reportDeepTestStatus } = deepTestStatus

const enabled = process.env.CAOGEN_CHINA_TOOL_CALL_PARITY === '1'
const required = process.env.CAOGEN_CHINA_TOOL_CALL_PARITY_REQUIRED === '1' || process.argv.includes('--required')
const repoRoot = process.cwd()
const rawProviders = resolveProvidersInput(process.env.CAOGEN_CHINA_PARITY_PROVIDERS)
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'china-tool-call-parity', runId)
const configurationGuide = 'docs/P2-EXTERNAL-REQUIRED.md'
const providerTemplate = [
  {
    id: 'openai-baseline',
    name: 'OpenAI baseline',
    group: 'baseline',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    apiKey: '<secret>'
  },
  {
    id: 'deepseek-china',
    name: 'DeepSeek China',
    group: 'china',
    apiFormat: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '<secret>'
  }
]
mkdirSync(reportDir, { recursive: true })

if (!enabled || !rawProviders?.trim()) {
  const report = {
    status: required ? 'failed' : 'skipped',
    required,
    reportDir,
    reason: 'set CAOGEN_CHINA_TOOL_CALL_PARITY=1 and CAOGEN_CHINA_PARITY_PROVIDERS JSON',
    requiredEnvironment: ['CAOGEN_CHINA_TOOL_CALL_PARITY=1', 'CAOGEN_CHINA_PARITY_PROVIDERS'],
    configurationGuide,
    providerTemplate,
    goldenCases: 0,
    results: [],
    parityFailures: required ? ['required parity mode needs explicit baseline and China provider configuration'] : []
  }
  writeReport(report)
  reportDeepTestStatus('skip', { reason: report.reason, details: { reportDir } })
  console.log('SKIP china tool-call parity: set CAOGEN_CHINA_TOOL_CALL_PARITY=1 and CAOGEN_CHINA_PARITY_PROVIDERS JSON')
  if (required) process.exit(1)
  process.exit(0)
}

const providers = parseProviders(rawProviders)
const requireBaseline = process.env.CAOGEN_CHINA_PARITY_REQUIRE_BASELINE !== '0'
const maxGap = Number.parseFloat(process.env.CAOGEN_CHINA_PARITY_MAX_GAP ?? '0')
const productTools = await loadProductToolMap()
const goldenCases = expandToolChoiceModes([
  goldenCase(productTools, {
    id: 'read-package',
    prompt: 'Read package.json and summarize the scripts field. Use read_file.',
    expectedName: 'read_file',
    requiredArguments: ['path']
  }),
  goldenCase(productTools, {
    id: 'run-typecheck',
    prompt: 'Run the TypeScript type check command for this project. Use bash.',
    expectedName: 'bash',
    requiredArguments: ['command']
  }),
  goldenCase(productTools, {
    id: 'search-model-router',
    prompt: 'Search this repository for model-router references. Use search_code.',
    expectedName: 'search_code',
    requiredArguments: ['query']
  }),
  goldenCase(productTools, {
    id: 'find-openai-tools',
    prompt: 'Find the file named openaiTools.ts. Use find_file.',
    expectedName: 'find_file',
    requiredArguments: ['pattern']
  }),
  goldenCase(productTools, {
    id: 'dry-run-search-replace',
    prompt: 'Preview replacing draft with stable in docs/README.md without writing. Use search_replace with dry_run.',
    expectedName: 'search_replace',
    requiredArguments: ['file_path', 'replacements']
  }),
  goldenCase(productTools, {
    id: 'browser-status',
    prompt: 'Report whether browser automation is available. Use browser_automation_status.',
    expectedName: 'browser_automation_status',
    requiredArguments: []
  })
])

const results = []
for (const provider of providers) {
  const cases = []
  for (const item of goldenCases) cases.push(await runGoldenCase(provider, item))
  const passed = cases.filter((item) => item.ok).length
  results.push({
    id: provider.id,
    name: provider.name,
    group: provider.group,
    apiFormat: provider.apiFormat,
    model: provider.model,
    endpoint: maskUrl(provider.baseUrl),
    passRate: passed / cases.length,
    cases
  })
}

const baselines = results.filter((item) => item.group === 'baseline')
const chinaProviders = results.filter((item) => item.group === 'china')
const bestBaseline = baselines.reduce((best, item) => Math.max(best, item.passRate), 0)
const parityFailures = []
if (requireBaseline && baselines.length === 0) {
  parityFailures.push('missing baseline provider; add group=baseline or set CAOGEN_CHINA_PARITY_REQUIRE_BASELINE=0')
}
if (chinaProviders.length === 0) parityFailures.push('missing China provider; add at least one provider with group=china')
if (baselines.length > 0) {
  for (const provider of chinaProviders) {
    if (provider.passRate + maxGap < bestBaseline) {
      parityFailures.push(`${provider.id} passRate ${provider.passRate.toFixed(3)} is below baseline ${bestBaseline.toFixed(3)}`)
    }
  }
}
for (const provider of results) {
  if (provider.passRate < 1 && (!baselines.length || provider.group === 'baseline')) {
    parityFailures.push(`${provider.id} did not pass all golden tool-call cases`)
  }
}

const report = {
  status: parityFailures.length === 0 ? 'passed' : 'failed',
  required,
  goldenCases: goldenCases.length,
  providerTemplate,
  configurationGuide,
  requireBaseline,
  maxGap,
  bestBaseline,
  results,
  reportDir,
  parityFailures
}
writeReport(report)
reportDeepTestStatus(report.status === 'passed' ? 'pass' : 'fail', {
  ...(report.status === 'passed' ? {} : { reason: report.parityFailures.join('; ') || 'tool-call parity failed' }),
  details: { reportDir, providers: report.results.length, goldenCases: report.goldenCases }
})
console.log(JSON.stringify(report, null, 2))
if (parityFailures.length > 0) process.exitCode = 1

async function runGoldenCase(provider, item) {
  if (provider.apiFormat === 'anthropic') return runAnthropicGoldenCase(provider, item)
  return runOpenAiCompatibleGoldenCase(provider, item)
}

async function runOpenAiCompatibleGoldenCase(provider, item) {
  const started = Date.now()
  try {
    const response = await fetch(chatCompletionsEndpoint(provider.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: item.prompt }],
        tools: [item.tool],
        tool_choice: openAiToolChoice(item),
        stream: false
      })
    })
    const text = await response.text()
    const parsed = parseJson(text)
    const toolCall = parsed?.choices?.[0]?.message?.tool_calls?.[0]
    const name = toolCall?.function?.name
    const argsText = toolCall?.function?.arguments
    const args = typeof argsText === 'string' ? parseJson(argsText) : argsText
    return validateToolCall(item, response.status, response.ok, name, args, Date.now() - started, text)
  } catch (error) {
    return { id: item.id, ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
}

async function runAnthropicGoldenCase(provider, item) {
  const started = Date.now()
  try {
    const response = await fetch(anthropicMessagesEndpoint(provider.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': provider.anthropicVersion
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 512,
        messages: [{ role: 'user', content: item.prompt }],
        tools: [toAnthropicTool(item.tool)],
        tool_choice: anthropicToolChoice(item)
      })
    })
    const text = await response.text()
    const parsed = parseJson(text)
    const toolUse = Array.isArray(parsed?.content) ? parsed.content.find((part) => part?.type === 'tool_use') : undefined
    return validateToolCall(item, response.status, response.ok, toolUse?.name, toolUse?.input, Date.now() - started, text)
  } catch (error) {
    return { id: item.id, ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
}

function validateToolCall(item, statusCode, responseOk, name, args, latencyMs, rawText) {
  const ok =
    responseOk &&
    name === item.expectedName &&
    isRecord(args) &&
    item.requiredArguments.every((key) => Object.prototype.hasOwnProperty.call(args, key))
  return {
    id: item.id,
    mode: item.toolChoiceMode,
    ok,
    statusCode,
    latencyMs,
    toolName: name,
    argumentKeys: isRecord(args) ? Object.keys(args).sort() : [],
    error: ok ? undefined : preview(rawText)
  }
}

function toAnthropicTool(openAiTool) {
  return {
    name: openAiTool.function.name,
    description: openAiTool.function.description,
    input_schema: openAiTool.function.parameters
  }
}

function openAiToolChoice(item) {
  return item.toolChoiceMode === 'forced'
    ? { type: 'function', function: { name: item.expectedName } }
    : 'auto'
}

function anthropicToolChoice(item) {
  return item.toolChoiceMode === 'forced'
    ? { type: 'tool', name: item.expectedName }
    : { type: 'auto' }
}

function goldenCase(productTools, item) {
  const tool = productTools.get(item.expectedName)
  if (!tool) throw new Error(`product tool schema missing ${item.expectedName}`)
  return { ...item, tool }
}

function expandToolChoiceModes(cases) {
  return cases.flatMap((item) => [
    { ...item, id: `${item.id}-auto`, toolChoiceMode: 'auto' },
    { ...item, id: `${item.id}-forced`, toolChoiceMode: 'forced' }
  ])
}

async function loadProductToolMap() {
  mkdirSync(path.join(repoRoot, 'test-results'), { recursive: true })
  const tempRoot = mkdtempSync(path.join(repoRoot, 'test-results', 'caogen-china-tool-schema-'))
  const outDir = path.join(tempRoot, 'compiled')
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        'src/main/openaiTools.ts',
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
        '--esModuleInterop'
      ],
      { cwd: repoRoot, stdio: 'inherit' }
    )
    const module = await import(pathToFileURL(findCompiled(outDir, 'openaiTools.js')).href)
    return new Map(module.OPENAI_CODING_TOOLS.map((tool) => [tool.function.name, tool]))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
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

function parseProviders(text) {
  const parsed = JSON.parse(stripJsonBom(text))
  if (!Array.isArray(parsed)) throw new Error('CAOGEN_CHINA_PARITY_PROVIDERS must be a JSON array')
  return parsed.map((item, index) => {
    if (!isRecord(item)) throw new Error(`provider[${index}] must be an object`)
    const id = stringField(item, 'id')
    const name = stringField(item, 'name') || id
    const group = stringField(item, 'group') === 'baseline' ? 'baseline' : 'china'
    const apiFormat = stringField(item, 'apiFormat') === 'anthropic' ? 'anthropic' : 'openai-compatible'
    const baseUrl = normalizeBaseUrl(stringField(item, 'baseUrl'), apiFormat)
    const model = stringField(item, 'model')
    const apiKey = stringField(item, 'apiKey')
    const anthropicVersion = stringField(item, 'anthropicVersion') || '2023-06-01'
    if (!id || !baseUrl || !model || !apiKey) throw new Error(`provider[${index}] missing id/baseUrl/model/apiKey`)
    const endpointFailure = publicEndpointFailure(baseUrl, `provider[${index}]`)
    if (endpointFailure) throw new Error(endpointFailure)
    return { id, name, group, apiFormat, baseUrl, model, apiKey, anthropicVersion }
  })
}

function resolveProvidersInput(value) {
  const text = value?.trim()
  if (!text) return undefined
  const candidate = path.isAbsolute(text) ? text : path.join(repoRoot, text)
  if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
  return text
}

function stripJsonBom(text) {
  return text.replace(/^\uFEFF/, '')
}

function normalizeBaseUrl(value, apiFormat) {
  const clean = value.replace(/\/+$/, '')
  return clean
}

function chatCompletionsEndpoint(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(clean)) return clean
  if (/\/(?:v\d+|api\/v\d+|compatible-mode\/v\d+)$/i.test(clean)) return `${clean}/chat/completions`
  return `${clean}/v1/chat/completions`
}

function anthropicMessagesEndpoint(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, '')
  if (/\/messages$/i.test(clean)) return clean
  if (/\/v\d+$/i.test(clean)) return `${clean}/messages`
  return `${clean}/v1/messages`
}

function stringField(record, key) {
  return typeof record[key] === 'string' ? record[key].trim() : ''
}

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

function maskUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    for (const key of [...url.searchParams.keys()]) if (/token|key|secret|sign|access/i.test(key)) url.searchParams.set(key, '***')
    return url.toString()
  } catch {
    return String(rawUrl)
  }
}

function publicEndpointFailure(rawUrl, target) {
  if (!required) return undefined
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return `${target} endpoint must be a valid URL`
  }
  if (url.protocol !== 'https:') return `${target} endpoint must use https in required mode`
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
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
    return `${target} endpoint must be a public real-network host, got ${host}`
  }
  return undefined
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
    a === 0
  )
}

function preview(text) {
  if (!text) return undefined
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const json = JSON.stringify(report, null, 2)
  writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8')
  writeFileSync(path.join(repoRoot, 'test-results', 'china-tool-call-parity', 'latest.json'), json, 'utf8')
}
