import { decryptProviderToken, getProvider } from '../providers'
import { getSettings } from '../settings'
import type { OpenAIProtocol, TaskDagRole, TaskDecomposeInput } from '../../shared/types'
import type { ModelDagDecomposer, ModelDagPayload, ModelDagTaskPayload } from './task-decomposer'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'
const DEFAULT_REASONING_MODEL = 'gpt-4.1'
const MODEL_TIMEOUT_MS = 45_000

interface ProviderModelConfig {
  baseUrl: string
  token: string
  headers: Record<string, string>
  model: string
  protocol: OpenAIProtocol
}

const TASK_ROLES: readonly TaskDagRole[] = [
  'frontend',
  'backend',
  'qa',
  'docs',
  'devops',
  'review',
  'general'
]

function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const name = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (name && value) headers[name] = value
  }
  return headers
}

function protocolFor(baseUrl: string, protocol: OpenAIProtocol | undefined): OpenAIProtocol {
  if (protocol === 'chat' || protocol === 'responses') return protocol
  try {
    return new URL(baseUrl).host === 'api.openai.com' ? 'responses' : 'chat'
  } catch {
    return 'chat'
  }
}

function selectReasoningModel(models: string[], override: string | undefined): string {
  const requested = override?.trim()
  if (requested) return requested
  const reasoner = models.find((model) => /reason|thinking|o3|o4|gpt-5/i.test(model))
  return reasoner ?? models[0] ?? process.env.OPENAI_MODEL ?? DEFAULT_REASONING_MODEL
}

function configFromInput(input: TaskDecomposeInput): ProviderModelConfig {
  const settings = getSettings()
  const providerId = input.providerId?.trim() || settings.defaultProviderId
  const provider = providerId ? getProvider(providerId) : undefined
  const protocol = protocolFor(provider?.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL, provider?.openaiProtocol)
  const rawBaseUrl = (provider?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
  const baseUrl = protocol === 'chat' ? rawBaseUrl.replace(/\/anthropic$/, '') : rawBaseUrl
  const token = provider ? decryptProviderToken(provider) : process.env.OPENAI_API_KEY || ''
  if (!token) {
    throw new Error(`${provider?.name ?? 'OpenAI'} 缺少 API Key,已回退本地 DAG 拆解`)
  }
  return {
    baseUrl,
    token,
    headers: parseHeaders(provider?.customHeaders),
    model: selectReasoningModel(provider?.models ?? [], input.model || settings.defaultModel),
    protocol
  }
}

function systemPrompt(): string {
  return [
    '你是 CaoGen 的任务拆解器,只输出 JSON,不要输出 Markdown。',
    '请把复杂软件开发需求拆成 DAG 子任务。',
    '输出格式:{"title":"...","tasks":[{"id":"kebab-id","title":"...","description":"...","dependencies":["id"],"role":"frontend|backend|qa|docs|devops|review|general"}]}。',
    '约束:任务数 1-33;id 必须唯一;dependencies 只能引用已存在任务 id;避免循环依赖;QA/验证任务通常依赖实现任务。'
  ].join('\n')
}

function userPrompt(input: TaskDecomposeInput): string {
  return [
    `需求: ${input.request}`,
    input.cwd ? `项目目录: ${input.cwd}` : '',
    '',
    '请按现有项目边界拆解,每个任务要能交给独立子 Agent 和 Git worktree 执行。'
  ]
    .filter(Boolean)
    .join('\n')
}

function isRole(value: string): value is TaskDagRole {
  return TASK_ROLES.includes(value as TaskDagRole)
}

function sanitizeTask(value: unknown): ModelDagTaskPayload | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const rawRole = typeof record.role === 'string' ? record.role.trim() : 'general'
  const role = isRole(rawRole) ? rawRole : 'general'
  const dependencies = Array.isArray(record.dependencies)
    ? record.dependencies
        .filter((dep): dep is string => typeof dep === 'string')
        .map((dep) => dep.trim())
        .filter(Boolean)
    : []
  if (!id || !title || !description) return null
  return { id, title, description, dependencies, role }
}

function parseDagPayload(text: string): ModelDagPayload {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const jsonText = fenced ? fenced[1] : trimmed
  const parsed = JSON.parse(jsonText) as unknown
  if (!parsed || typeof parsed !== 'object') throw new Error('模型未返回 JSON 对象')
  const record = parsed as Record<string, unknown>
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.map(sanitizeTask).filter((task): task is ModelDagTaskPayload => Boolean(task))
    : []
  if (tasks.length === 0) throw new Error('模型未返回有效 tasks')
  return {
    title: typeof record.title === 'string' ? record.title.trim() : undefined,
    tasks
  }
}

function extractChatText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const choices = (json as Record<string, unknown>).choices
  if (!Array.isArray(choices)) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object') return ''
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object') return ''
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
}

function extractResponseText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const direct = (json as Record<string, unknown>).output_text
  if (typeof direct === 'string') return direct
  const output = (json as Record<string, unknown>).output
  if (!Array.isArray(output)) return ''
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string') chunks.push(text)
    }
  }
  return chunks.join('').trim()
}

async function fetchJson(url: string, config: ProviderModelConfig, body: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        ...config.headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`模型拆解请求失败:${res.status} ${await res.text()}`)
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function callChat(input: TaskDecomposeInput, config: ProviderModelConfig): Promise<ModelDagPayload> {
  const json = await fetchJson(`${config.baseUrl}/v1/chat/completions`, config, {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(input) }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1
  })
  const text = extractChatText(json)
  if (!text) throw new Error('模型响应缺少 content')
  return parseDagPayload(text)
}

async function callResponses(input: TaskDecomposeInput, config: ProviderModelConfig): Promise<ModelDagPayload> {
  const json = await fetchJson(`${config.baseUrl}/v1/responses`, config, {
    model: config.model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt() }] },
      { role: 'user', content: [{ type: 'input_text', text: userPrompt(input) }] }
    ],
    text: { format: { type: 'json_object' } },
    temperature: 0.1
  })
  const text = extractResponseText(json)
  if (!text) throw new Error('模型响应缺少 output_text')
  return parseDagPayload(text)
}

export function createModelDagDecomposer(input: TaskDecomposeInput): ModelDagDecomposer {
  return {
    async decompose() {
      const config = configFromInput(input)
      return config.protocol === 'chat' ? callChat(input, config) : callResponses(input, config)
    }
  }
}
