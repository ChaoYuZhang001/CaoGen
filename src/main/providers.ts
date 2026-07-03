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
