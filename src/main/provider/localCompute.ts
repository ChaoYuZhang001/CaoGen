import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import type {
  LocalComputeActivationOptions,
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
const STARTUP_TIMEOUT_MS = 8_000
const STARTUP_POLL_MS = 200
let activation: Promise<LocalComputeActivationResult> | null = null
let activationCanStart = false

export function activateLocalCompute(
  options: LocalComputeActivationOptions | null = {}
): Promise<LocalComputeActivationResult> {
  const startInstalled = options?.startInstalled === true
  if (activation) {
    if (!startInstalled || activationCanStart) return activation
    return activation.then((result) => result.status === 'activated'
      ? result
      : beginActivation(true))
  }
  return beginActivation(startInstalled)
}

function beginActivation(startInstalled: boolean): Promise<LocalComputeActivationResult> {
  const pending = activate(startInstalled)
  activation = pending
  activationCanStart = startInstalled
  const clear = (): void => {
    if (activation !== pending) return
    activation = null
    activationCanStart = false
  }
  void pending.then(clear, clear)
  return pending
}

async function activate(startInstalled: boolean): Promise<LocalComputeActivationResult> {
  const checkedAt = Date.now()
  const candidates = localComputeCandidates()
  const results = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    probe: await probeModels(candidate)
  })))
  const match = results.find((result) => result.probe.models.length > 0)
  if (match) return activatedResult(checkedAt, match.candidate, match.probe.models)

  const reachable = results.find((result) => result.probe.reachable)
  if (reachable) {
    return {
      status: 'unavailable',
      checkedAt,
      service: reachable.candidate.service,
      reason: 'model-missing'
    }
  }

  const command = ollamaStartCommand()
  if (!command) return { status: 'unavailable', checkedAt, reason: 'runtime-missing' }
  if (!startInstalled) {
    return { status: 'unavailable', checkedAt, service: 'ollama', reason: 'runtime-stopped' }
  }

  const ollama = candidates.find((candidate) => candidate.service === 'ollama')
  if (!ollama || !(await startRuntime(command))) {
    return { status: 'unavailable', checkedAt, service: 'ollama', reason: 'runtime-stopped' }
  }
  const probe = await waitForModels(ollama)
  if (probe.models.length > 0) {
    return {
      ...activatedResult(checkedAt, ollama, probe.models),
      startedService: true
    }
  }
  return {
    status: 'unavailable',
    checkedAt,
    service: 'ollama',
    reason: probe.reachable ? 'model-missing' : 'runtime-stopped',
    startedService: true
  }
}

function activatedResult(
  checkedAt: number,
  candidate: LocalComputeCandidate,
  models: string[]
): LocalComputeActivationResult {
  const provider = ensureProvider(candidate, models)
  return {
    status: 'activated',
    checkedAt,
    service: candidate.service,
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

interface LocalComputeProbe {
  reachable: boolean
  models: string[]
}

async function probeModels(candidate: LocalComputeCandidate): Promise<LocalComputeProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${candidate.baseUrl}${candidate.modelsPath}`, {
      method: 'GET',
      signal: controller.signal
    })
    if (!response.ok) return { reachable: false, models: [] }
    const length = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return { reachable: true, models: [] }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return { reachable: true, models: [] }
    return { reachable: true, models: modelNames(JSON.parse(text), candidate.service) }
  } catch {
    return { reachable: false, models: [] }
  } finally {
    clearTimeout(timer)
  }
}

async function waitForModels(candidate: LocalComputeCandidate): Promise<LocalComputeProbe> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let last: LocalComputeProbe = { reachable: false, models: [] }
  while (Date.now() < deadline) {
    last = await probeModels(candidate)
    if (last.reachable) return last
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS))
  }
  return last
}

interface LocalRuntimeCommand {
  executable: string
  args: string[]
}

function ollamaStartCommand(): LocalRuntimeCommand | null {
  const testMode = !app.isPackaged && process.env.CAOGEN_LOCAL_COMPUTE_TEST_MODE === '1'
  if (testMode) {
    const executable = existingFile(process.env.CAOGEN_LOCAL_COMPUTE_TEST_RUNTIME_EXECUTABLE)
    const script = existingFile(process.env.CAOGEN_LOCAL_COMPUTE_TEST_RUNTIME_SCRIPT)
    return executable && script ? { executable, args: [script, 'serve'] } : null
  }
  const executable = findOllamaExecutable()
  return executable ? { executable, args: ['serve'] } : null
}

function findOllamaExecutable(): string | null {
  const names = process.platform === 'win32' ? ['ollama.exe'] : ['ollama']
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const candidates = pathEntries.flatMap((entry) => names.map((name) => join(entry, name)))
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Ollama.app/Contents/Resources/ollama')
    candidates.push(join(homedir(), '.ollama', 'bin', 'ollama'))
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama', join(homedir(), '.local', 'bin', 'ollama'))
  }
  for (const candidate of candidates) {
    const file = existingFile(candidate)
    if (file) return file
  }
  return null
}

function existingFile(value: string | undefined): string | null {
  if (!value || !isAbsolute(value) || !existsSync(value)) return null
  try {
    return statSync(value).isFile() ? value : null
  } catch {
    return null
  }
}

function startRuntime(command: LocalRuntimeCommand): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (started: boolean): void => {
      if (settled) return
      settled = true
      resolve(started)
    }
    try {
      const child = spawn(command.executable, command.args, {
        detached: true,
        env: { ...process.env },
        stdio: 'ignore',
        windowsHide: true
      })
      child.once('spawn', () => {
        child.unref()
        finish(true)
      })
      child.once('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
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
