import type { EngineKind, OpenAIProtocol } from '../../shared/types'
import { inspectProviderBaseUrl } from '../providerCredentialBroker'

const ANTHROPIC_SUBPATH_HOSTS = [
  'api.deepseek.com',
  'api.moonshot.cn',
  'api.moonshot.ai',
  'open.bigmodel.cn'
]

export function normalizeBaseUrl(baseUrl: string, engine: EngineKind, _protocol?: OpenAIProtocol): string {
  const rawUrl = (baseUrl || '').trim().replace(/\/+$/, '')
  const inspected = inspectProviderBaseUrl(rawUrl)
  if (inspected.rejectedNames.length > 0) {
    throw new Error(`Base URL 不允许包含用户名、密码或非路由查询参数: ${inspected.rejectedNames.join(', ')}。凭据请使用 API 密钥字段。`)
  }
  const url = inspected.safeValue
  if (!url || engine === 'openai') return url
  try {
    const parsed = new URL(url)
    const needsSubpath = ANTHROPIC_SUBPATH_HOSTS.some((host) => parsed.host === host)
    return needsSubpath && !/\/anthropic($|\/)/.test(parsed.pathname) ? `${url}/anthropic` : url
  } catch {
    return url
  }
}
