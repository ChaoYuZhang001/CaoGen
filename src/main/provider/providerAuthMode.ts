import type { EngineKind, ProviderAuthMode } from '../../shared/types'

export function normalizeProviderAuthMode(
  value: ProviderAuthMode | undefined,
  baseUrl: string,
  engine: EngineKind
): ProviderAuthMode {
  const mode = value === 'none' ? 'none' : 'api-key'
  if (mode === 'api-key') return mode
  if (engine !== 'openai' || !isLoopbackHttpUrl(baseUrl)) {
    throw new Error('无需密钥的 Provider 只允许使用本机回环地址和 OpenAI 兼容引擎')
  }
  return mode
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'http:' && (
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '[::1]'
    )
  } catch {
    return false
  }
}
