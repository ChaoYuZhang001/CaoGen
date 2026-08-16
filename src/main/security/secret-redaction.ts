import { createHash } from 'node:crypto'

const REDACTED = '[REDACTED]'
const MAX_DEPTH = 32
const MAX_NODES = 20_000

const SENSITIVE_KEY = /(?:apikey|accesskey|accesstoken|authtoken|authorization|bearer|clientsecret|credential|cookie|password|passwd|privatekey|refreshtoken|secretaccesskey|securitytoken|sessioncookie|signature|subscriptionkey|webhooksecret)|(?:token|secret|password|credential|cookie)$/i
const NON_SECRET_TOKEN_KEY = /^(?:cached|cachecreation|context|estimated|input|max|output|reasoning|used|total|budget)tokens?$|^(?:token|tokens)count$/i

type KnownCredentialRedactor = (value: string) => string

let redactKnownCredential: KnownCredentialRedactor = (value) => value

/** ProviderCredentialRuntime installs the process-owned Broker redactor here. */
export function configureKnownCredentialRedactor(redactor: KnownCredentialRedactor): void {
  redactKnownCredential = redactor
}

export function containsKnownCredential(value: string): boolean {
  return redactKnownCredential(value) !== value
}

export function redactSensitiveText(value: string): string {
  return redactKnownCredential(value)
    .replace(/-----BEGIN [^-\r\n]+PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-(?:ant-|proj-)?|github_pat_|gh[pousr]_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]')
    .replace(/(\b(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|private[_-]?key|client[_-]?secret|cookie|session)\b\s*[:=]\s*["']?)[^\s,"';]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)=)[^&#\s]+/gi, '$1[REDACTED]')
}

export function containsSensitiveText(value: string): boolean {
  return redactSensitiveText(value) !== value
}

/** Clone JSON-like main-process output while redacting credential keys and values. */
export function redactSensitiveValue<T>(value: T): T {
  let nodes = 0
  return redactValue(value, undefined, 0, new WeakSet<object>(), () => {
    nodes += 1
    if (nodes > MAX_NODES) throw new Error('secret redaction input exceeds the node limit')
  }) as T
}

export function redactLogArguments(values: readonly unknown[]): unknown[] {
  return values.map((value) => redactSensitiveValue(value))
}

function redactValue(
  value: unknown,
  key: string | undefined,
  depth: number,
  seen: WeakSet<object>,
  count: () => void
): unknown {
  count()
  if (isSensitiveKey(key)) return REDACTED
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[REDACTED_NESTED_VALUE]'
  if (value instanceof Uint8Array) return binaryLogMarker(value)
  if (value instanceof ArrayBuffer) return binaryLogMarker(new Uint8Array(value))
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[REDACTED_CYCLIC_VALUE]'
  seen.add(value)
  try {
    if (value instanceof Error) {
      return {
        name: redactSensitiveText(value.name),
        message: redactSensitiveText(value.message),
        ...(value.stack ? { stack: redactSensitiveText(value.stack) } : {}),
        ...('cause' in value && value.cause !== undefined
          ? { cause: redactValue(value.cause, 'cause', depth + 1, seen, count) }
          : {})
      }
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, undefined, depth + 1, seen, count))
    }
    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (childValue === undefined) continue
      output[childKey] = redactValue(childValue, childKey, depth + 1, seen, count)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function isSensitiveKey(key: string | undefined): boolean {
  if (!key) return false
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (normalized === 'fencingtoken' || NON_SECRET_TOKEN_KEY.test(normalized)) return false
  return SENSITIVE_KEY.test(normalized)
}

function binaryLogMarker(value: Uint8Array): string {
  const digest = createHash('sha256').update(value).digest('hex')
  return `[REDACTED_BINARY bytes=${value.byteLength} sha256=${digest}]`
}
