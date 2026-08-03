import type {
  LocalComputeActivationResult,
  LocalComputeService,
  ProviderView
} from '../../shared/types'
import { createProvider, listProviders, updateProvider } from '../providers'

interface LocalComputeCandidate {
  service: LocalComputeService
  name: string
  baseUrl: string
  modelsPath: string
}

const MAX_RESPONSE_BYTES = 1024 * 1024
const PROBE_TIMEOUT_MS = 900
let activation: Promise<LocalComputeActivationResult> | null = null

export function activateLocalCompute(): Promise<LocalComputeActivationResult> {
  if (activation) return activation
  activation = activate().finally(() => {
    activation = null
  })
  return activation
}

async function activate(): Promise<LocalComputeActivationResult> {
  const checkedAt = Date.now()
  const candidates = localComputeCandidates()
  const results = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    models: await probeModels(candidate)
  })))
  const match = results.find((result) => result.models.length > 0)
  if (!match) return { status: 'unavailable', checkedAt }

  const provider = ensureProvider(match.candidate, match.models)
  return {
    status: 'activated',
    checkedAt,
    service: match.candidate.service,
    provider
  }
}

function ensureProvider(candidate: LocalComputeCandidate, models: string[]): ProviderView {
  const existing = listProviders().find((provider) =>
    canonicalTarget(provider.baseUrl) === canonicalTarget(candidate.baseUrl)
    && provider.engine === 'openai'
  )
  const input = {
    name: candidate.name,
    baseUrl: candidate.baseUrl,
    models,
    engine: 'openai' as const,
    openaiProtocol: 'chat' as const,
    authMode: 'none' as const,
    note: 'CaoGen 自动发现的本机模型服务'
  }
  return existing ? updateProvider(existing.id, input) : createProvider(input)
}

async function probeModels(candidate: LocalComputeCandidate): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${candidate.baseUrl}${candidate.modelsPath}`, {
      method: 'GET',
      signal: controller.signal
    })
    if (!response.ok) return []
    const length = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return []
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return []
    return modelNames(JSON.parse(text), candidate.service)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

function modelNames(value: unknown, service: LocalComputeService): string[] {
  const root = recordValue(value)
  const rows = service === 'ollama'
    ? root?.models
    : root?.data
  if (!Array.isArray(rows)) return []
  const output: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const record = recordValue(row)
    const raw = service === 'ollama'
      ? record?.name ?? record?.model
      : record?.id
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (!name || name.length > 240 || seen.has(name)) continue
    seen.add(name)
    output.push(name)
    if (output.length >= 500) break
  }
  return output
}

function localComputeCandidates(): LocalComputeCandidate[] {
  const testUrl = process.env.CAOGEN_LOCAL_COMPUTE_TEST_MODE === '1'
    ? loopbackBaseUrl(process.env.CAOGEN_LOCAL_COMPUTE_TEST_BASE_URL)
    : null
  if (testUrl) {
    return [{
      service: 'ollama',
      name: 'Ollama（本机）',
      baseUrl: testUrl,
      modelsPath: '/api/tags'
    }]
  }
  return [
    {
      service: 'ollama',
      name: 'Ollama（本机）',
      baseUrl: 'http://127.0.0.1:11434',
      modelsPath: '/api/tags'
    },
    {
      service: 'lm-studio',
      name: 'LM Studio（本机）',
      baseUrl: 'http://127.0.0.1:1234',
      modelsPath: '/v1/models'
    },
    {
      service: 'vllm',
      name: 'vLLM（本机）',
      baseUrl: 'http://127.0.0.1:8000',
      modelsPath: '/v1/models'
    }
  ]
}

function loopbackBaseUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) return null
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function canonicalTarget(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
