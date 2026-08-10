import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { ProviderGatewayUsageRecord } from '../../shared/provider-gateway-types'

const MAX_USAGE_SCAN_BYTES = 1024 * 1024

export async function discardGatewayUpstreamResponse(
  upstream: Response,
  signal: AbortSignal
): Promise<ProviderGatewayUsageRecord['usage']> {
  if (!upstream.body) return undefined
  const scan = new ProviderGatewayUsageScanner(upstream.headers.get('content-type') ?? '')
  const reader = upstream.body.getReader()
  let bytes = 0
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_USAGE_SCAN_BYTES) {
        await reader.cancel('gateway_error_response_limit').catch(() => undefined)
        return undefined
      }
      scan.push(value)
    }
    return scan.usage()
  } catch {
    await reader.cancel('gateway_error_response_discarded').catch(() => undefined)
    return undefined
  }
}

export async function primeGatewayStreamingResponse(
  upstream: Response,
  signal: AbortSignal
): Promise<Response> {
  if (!upstream.body) return upstream
  const reader = upstream.body.getReader()
  let first: Uint8Array | undefined
  while (!first) {
    if (signal.aborted) throw signal.reason
    const result = await reader.read()
    if (result.done) return cloneResponseWithoutBody(upstream)
    if (result.value.byteLength > 0) first = result.value
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(first as Uint8Array) },
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) controller.close()
        else controller.enqueue(result.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) { await reader.cancel(reason) }
  })
  return new Response(body, responseInit(upstream))
}

export async function streamGatewayResponse(
  upstream: Response,
  response: ServerResponse,
  scan: ProviderGatewayUsageScanner,
  signal: AbortSignal
): Promise<void> {
  if (!upstream.body) {
    response.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      scan.push(value)
      if (!response.write(value)) await once(response, 'drain')
    }
    response.end()
  } finally {
    if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined)
  }
}

export class ProviderGatewayUsageScanner {
  private readonly chunks: Uint8Array[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly contentType: string) {}

  push(chunk: Uint8Array): void {
    if (this.truncated) return
    if (this.bytes + chunk.byteLength > MAX_USAGE_SCAN_BYTES) {
      this.truncated = true
      this.chunks.length = 0
      return
    }
    this.bytes += chunk.byteLength
    this.chunks.push(chunk)
  }

  usage(): ProviderGatewayUsageRecord['usage'] {
    if (this.truncated || this.chunks.length === 0) return undefined
    const text = Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
    if (!this.contentType.toLowerCase().includes('text/event-stream')) return jsonUsage(text)
    let usage: ProviderGatewayUsageRecord['usage']
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      try { usage = normalizeGatewayUsage(JSON.parse(raw) as unknown) ?? usage } catch { /* ignore non-JSON SSE data */ }
    }
    return usage
  }
}

function normalizeGatewayUsage(value: unknown): ProviderGatewayUsageRecord['usage'] {
  if (!isRecord(value)) return undefined
  const response = isRecord(value.response) ? value.response : value
  const usage = isRecord(response.usage) ? response.usage
    : isRecord(response.usageMetadata) ? response.usageMetadata : undefined
  if (!usage) return undefined
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const inputTokens = tokenCount(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount)
  const outputTokens = tokenCount(usage.output_tokens ?? usage.completion_tokens)
    + tokenCount(usage.candidatesTokenCount) + tokenCount(usage.thoughtsTokenCount)
  const cacheReadTokens = tokenCount(
    inputDetails?.cached_tokens ?? promptDetails?.cached_tokens ?? usage.cachedContentTokenCount
  )
  if (inputTokens + outputTokens + cacheReadTokens === 0) return undefined
  return { inputTokens, outputTokens, ...(cacheReadTokens ? { cacheReadTokens } : {}) }
}

function cloneResponseWithoutBody(response: Response): Response {
  return new Response(null, responseInit(response))
}

function responseInit(response: Response): ResponseInit {
  return { status: response.status, statusText: response.statusText, headers: response.headers }
}

function jsonUsage(text: string): ProviderGatewayUsageRecord['usage'] {
  try { return normalizeGatewayUsage(JSON.parse(text) as unknown) } catch { return undefined }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
