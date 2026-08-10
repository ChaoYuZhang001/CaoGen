import type { ProviderAdvancedConfig } from '../../shared/types'

export interface ProviderRequestTimeouts {
  streamingFirstByteTimeoutSeconds?: number
  streamingIdleTimeoutSeconds?: number
  requestTimeoutSeconds?: number
}

export type ProviderRequestTimeoutCode =
  | 'PROVIDER_FIRST_BYTE_TIMEOUT'
  | 'PROVIDER_STREAM_IDLE_TIMEOUT'
  | 'PROVIDER_REQUEST_TIMEOUT'

type ProviderStreamReadResult =
  | { done: true; value?: undefined }
  | { done: false; value: Uint8Array }

export class ProviderRequestTimeoutError extends Error {
  constructor(readonly code: ProviderRequestTimeoutCode, seconds: number) {
    const phase = code === 'PROVIDER_FIRST_BYTE_TIMEOUT'
      ? 'first byte'
      : code === 'PROVIDER_STREAM_IDLE_TIMEOUT' ? 'stream idle' : 'request'
    super(`Provider ${phase} timeout after ${seconds} seconds`)
    this.name = 'ProviderRequestTimeoutError'
  }
}

export function providerRequestTimeouts(
  provider: { advancedConfig?: ProviderAdvancedConfig } | undefined
): ProviderRequestTimeouts {
  const reliability = provider?.advancedConfig?.reliability
  return {
    streamingFirstByteTimeoutSeconds: reliability?.streamingFirstByteTimeoutSeconds,
    streamingIdleTimeoutSeconds: reliability?.streamingIdleTimeoutSeconds,
    requestTimeoutSeconds: reliability?.requestTimeoutSeconds
  }
}

export function providerRequestIsStreaming(body: unknown): boolean {
  if (typeof body !== 'string') return false
  try {
    const parsed = JSON.parse(body) as unknown
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).stream === true)
  } catch {
    return false
  }
}

export class ProviderRequestDeadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly parentSignal: AbortSignal
  private readonly timeouts: ProviderRequestTimeouts
  private readonly streaming: boolean
  private timer?: ReturnType<typeof setTimeout>
  private timeoutError?: ProviderRequestTimeoutError
  private finished = false

  constructor(parentSignal: AbortSignal, timeouts: ProviderRequestTimeouts, streaming: boolean) {
    this.parentSignal = parentSignal
    this.timeouts = timeouts
    this.streaming = streaming
    this.signal = this.controller.signal
    if (parentSignal.aborted) this.abortFromParent()
    else parentSignal.addEventListener('abort', this.abortFromParent, { once: true })
    this.arm(
      streaming ? 'PROVIDER_FIRST_BYTE_TIMEOUT' : 'PROVIDER_REQUEST_TIMEOUT',
      streaming ? timeouts.streamingFirstByteTimeoutSeconds : timeouts.requestTimeoutSeconds
    )
  }

  wrapResponse(response: Response): Response {
    if (!this.streaming || !response.body) return response
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const result = await this.read(reader)
          if (result.done) {
            this.finish()
            controller.close()
            return
          }
          if (result.value.byteLength > 0) this.markStreamActivity()
          controller.enqueue(result.value)
        } catch (error) {
          controller.error(this.errorOr(error))
        }
      },
      cancel: async (reason) => {
        this.finish()
        await reader.cancel(reason)
      }
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }

  errorOr(error: unknown): unknown {
    return this.timeoutError ?? error
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    this.clearTimer()
    this.parentSignal.removeEventListener('abort', this.abortFromParent)
  }

  private readonly abortFromParent = (): void => {
    this.clearTimer()
    if (!this.controller.signal.aborted) this.controller.abort(this.parentSignal.reason)
  }

  private markStreamActivity(): void {
    this.arm('PROVIDER_STREAM_IDLE_TIMEOUT', this.timeouts.streamingIdleTimeoutSeconds)
  }

  private read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ProviderStreamReadResult> {
    if (this.signal.aborted) return Promise.reject(this.errorOr(this.signal.reason))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        void reader.cancel(this.errorOr(this.signal.reason)).catch(() => undefined)
        reject(this.errorOr(this.signal.reason))
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
      void (reader.read() as Promise<ProviderStreamReadResult>).then(
        (result) => {
          this.signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
        (error) => {
          this.signal.removeEventListener('abort', onAbort)
          reject(this.errorOr(error))
        }
      )
    })
  }

  private arm(code: ProviderRequestTimeoutCode, seconds: number | undefined): void {
    this.clearTimer()
    if (this.finished || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return
    this.timer = setTimeout(() => {
      this.timeoutError = new ProviderRequestTimeoutError(code, seconds)
      this.controller.abort(this.timeoutError)
    }, seconds * 1_000)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
