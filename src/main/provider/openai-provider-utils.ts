export function openAiEndpoint(
  baseUrl: string,
  endpoint: 'chat/completions' | 'responses'
): string {
  const clean = baseUrl.replace(/\/+$/, '')
  if (clean.toLowerCase().endsWith(`/${endpoint}`)) return clean
  if (/\/(?:v\d+|api\/v\d+|compatible-mode\/v\d+)$/i.test(clean)) return `${clean}/${endpoint}`
  return `${clean}/v1/${endpoint}`
}

export function parseProviderHeaders(raw: string | undefined): Record<string, string> {
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

export function redactProviderBaseUrl(value: string): string {
  const clean = (value || '').trim()
  try {
    const url = new URL(clean)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return clean.replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&]+/gi, '$1[redacted]')
  }
}
