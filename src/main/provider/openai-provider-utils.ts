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
  return clean ? '[provider-url-redacted]' : '[not-configured]'
}

export function redactProviderErrorText(value: string): string {
  return value
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[provider-url-redacted]')
    .replace(/((?:base\s*url|baseurl|endpoint)\s*[:=]\s*)[^\s,;]+/gi, '$1[provider-url-redacted]')
}
