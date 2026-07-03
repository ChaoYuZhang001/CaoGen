import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Provider, ProviderInput, ProviderView } from '../shared/types'

let cache: Provider[] | null = null

function providersFile(): string {
  return join(app.getPath('userData'), 'providers.json')
}

function load(): Provider[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(providersFile(), 'utf8'))
    cache = Array.isArray(raw) ? (raw as Provider[]) : []
  } catch {
    cache = []
  }
  return cache
}

function persist(): void {
  try {
    mkdirSync(dirname(providersFile()), { recursive: true })
    writeFileSync(providersFile(), JSON.stringify(cache ?? [], null, 2))
  } catch (err) {
    console.error('[agent-desk] 保存 Provider 失败:', err)
  }
}

/** 明文 token → 加密串(safeStorage 不可用时退回 base64,并标记前缀) */
function encryptToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(token).toString('base64')}`
  }
  // 退化路径:仅 base64(明确标记,便于排查),不至于明文落盘
  return `b64:${Buffer.from(token, 'utf8').toString('base64')}`
}

/** 加密串 → 明文 token,仅在主进程注入 SDK env 时使用,不回传渲染进程 */
export function decryptToken(encrypted: string): string {
  if (!encrypted) return ''
  try {
    if (encrypted.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(encrypted.slice(4), 'base64'))
    }
    if (encrypted.startsWith('b64:')) {
      return Buffer.from(encrypted.slice(4), 'base64').toString('utf8')
    }
  } catch (err) {
    console.error('[agent-desk] 解密 Provider token 失败:', err)
  }
  return ''
}

function toView(p: Provider): ProviderView {
  const { encryptedToken, ...rest } = p
  return { ...rest, hasToken: encryptedToken.length > 0 }
}

export function listProviders(): ProviderView[] {
  return load().map(toView)
}

/** 主进程内部用:取完整 Provider(含加密 token) */
export function getProvider(id: string): Provider | undefined {
  return load().find((p) => p.id === id)
}

export function createProvider(input: ProviderInput): ProviderView {
  const provider: Provider = {
    id: randomUUID(),
    name: input.name,
    baseUrl: input.baseUrl,
    encryptedToken: encryptToken(input.token),
    models: input.models,
    customHeaders: input.customHeaders,
    note: input.note,
    createdAt: Date.now()
  }
  cache = [...load(), provider]
  persist()
  return toView(provider)
}

export function updateProvider(id: string, patch: Partial<ProviderInput>): ProviderView {
  const list = load()
  const idx = list.findIndex((p) => p.id === id)
  if (idx === -1) throw new Error('Provider 不存在')
  const prev = list[idx]
  const next: Provider = {
    ...prev,
    name: patch.name ?? prev.name,
    baseUrl: patch.baseUrl ?? prev.baseUrl,
    models: patch.models ?? prev.models,
    customHeaders: patch.customHeaders ?? prev.customHeaders,
    note: patch.note ?? prev.note,
    encryptedToken: patch.token === undefined ? prev.encryptedToken : encryptToken(patch.token)
  }
  cache = [...list.slice(0, idx), next, ...list.slice(idx + 1)]
  persist()
  return toView(next)
}

export function deleteProvider(id: string): void {
  cache = load().filter((p) => p.id !== id)
  persist()
}

/**
 * 用 API key 从端点拉取模型列表(GET {baseUrl}/v1/models)。
 * 同时带 x-api-key 与 Authorization: Bearer,兼容 Anthropic / OpenAI 两种鉴权。
 * token 显式传入(新建时),或经 providerId 取已存密钥(编辑时)。
 */
export async function fetchModels(opts: {
  baseUrl: string
  token?: string
  providerId?: string
}): Promise<string[]> {
  const base = (opts.baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('请先填写 Base URL')
  let token = opts.token?.trim() || ''
  if (!token && opts.providerId) {
    const p = getProvider(opts.providerId)
    if (p) token = decryptToken(p.encryptedToken)
  }
  if (!token) throw new Error('请先填写 API 密钥')

  const url = `${base}/v1/models`
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'x-api-key': token,
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01'
      }
    })
  } catch (err) {
    throw new Error(`请求失败:${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`端点返回 ${res.status}${res.status === 401 ? '(密钥无效?)' : ''}`)
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error('响应不是合法 JSON,可能端点不支持 /v1/models')
  }
  // 兼容 {data:[{id}]}(Anthropic/OpenAI)与直接数组
  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as Record<string, unknown>)?.data)
      ? ((json as Record<string, unknown>).data as unknown[])
      : []
  const ids = arr
    .map((m) => {
      const o = m as Record<string, unknown> | string
      if (typeof o === 'string') return o
      return typeof o?.id === 'string' ? o.id : ''
    })
    .filter(Boolean)
  if (ids.length === 0) throw new Error('端点未返回任何模型')
  // 去重保序
  return [...new Set(ids)]
}
