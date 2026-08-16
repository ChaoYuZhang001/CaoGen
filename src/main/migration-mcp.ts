import { containsSensitiveText } from './migration-safety'
import type { JsonObject } from './migration-scan-store'

const BLOCKED_KEYS = new Set(['env', 'headers', 'authorization', 'token', 'apikey', 'password', 'secret'])
const CREDENTIAL_ARG = /^--?(?:api-?key|access-?token|auth-?token|token|key|password|secret|client-?secret|credential|credentials|header|headers|authorization|auth|env)$/i
const CREDENTIAL_ARG_WITH_VALUE = /^--?(?:api-?key|access-?token|auth-?token|token|key|password|secret|client-?secret|credential|credentials|header|headers|authorization|auth|env)=/i
const SHORT_CREDENTIAL_ARG = /^-(?:H|e)$/
type FieldWriter = (config: JsonObject, ignored: string[], value: unknown) => boolean

const FIELD_WRITERS: Record<string, FieldWriter> = {
  command: (config, _ignored, value) => assignSafeString(config, 'command', value),
  cwd: (config, _ignored, value) => assignSafeString(config, 'cwd', value),
  type: writeTransport,
  transport: writeTransport,
  disabled: (config, _ignored, value) => assignTyped(config, 'disabled', value, 'boolean'),
  enabled: (config, _ignored, value) => assignInverseBoolean(config, 'disabled', value),
  timeout: (config, _ignored, value) => assignFiniteNumber(config, 'timeout', value),
  args: writeArgs,
  url: writeUrl,
  httpUrl: writeHttpUrl
}

export function sanitizeMcpConfig(value: unknown): { config: JsonObject; ignoredFields: string[] } {
  if (!isObject(value)) return { config: {}, ignoredFields: ['server_config'] }
  const config: JsonObject = {}
  const ignoredFields: string[] = []
  for (const [key, entry] of Object.entries(value).filter(([key]) => key !== 'httpUrl')) {
    mapMcpField(config, ignoredFields, key, entry)
  }
  if (Object.hasOwn(value, 'httpUrl')) mapMcpField(config, ignoredFields, 'httpUrl', value.httpUrl)
  return { config, ignoredFields: [...new Set(ignoredFields)] }
}

function mapMcpField(config: JsonObject, ignored: string[], key: string, value: unknown): void {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (BLOCKED_KEYS.has(normalized)) return void ignored.push(key)
  if (!FIELD_WRITERS[key]?.(config, ignored, value)) ignored.push(key)
}

function writeArgs(config: JsonObject, ignored: string[], value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const sanitized = sanitizeMcpArgs(value)
  config.args = sanitized.args
  ignored.push(...sanitized.ignoredFields.map((field) => `args.${field}`))
  return true
}

function writeUrl(config: JsonObject, ignored: string[], value: unknown): boolean {
  if (typeof value !== 'string') return false
  const sanitized = sanitizeUrl(value)
  if (sanitized.value) config.url = sanitized.value
  if (sanitized.changed) ignored.push('url.query_or_fragment')
  return true
}

function writeHttpUrl(config: JsonObject, ignored: string[], value: unknown): boolean {
  if (!writeUrl(config, ignored, value)) return false
  config.transport = 'http'
  return true
}

function writeTransport(config: JsonObject, _ignored: string[], value: unknown): boolean {
  if (value !== 'stdio' && value !== 'sse' && value !== 'http') return false
  config.transport = value
  return true
}

function assignSafeString(config: JsonObject, key: string, value: unknown): boolean {
  if (!safeString(value)) return false
  config[key] = value
  return true
}

function assignTyped(config: JsonObject, key: string, value: unknown, expected: 'string' | 'boolean'): boolean {
  if (typeof value !== expected) return false
  config[key] = value
  return true
}

function assignFiniteNumber(config: JsonObject, key: string, value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  config[key] = value
  return true
}

function assignInverseBoolean(config: JsonObject, key: string, value: unknown): boolean {
  if (typeof value !== 'boolean') return false
  config[key] = !value
  return true
}

function sanitizeMcpArgs(value: unknown[]): { args: string[]; ignoredFields: string[] } {
  const args: string[] = []
  const ignoredFields: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (typeof entry !== 'string') {
      ignoredFields.push(String(index))
      continue
    }
    if (CREDENTIAL_ARG.test(entry) || SHORT_CREDENTIAL_ARG.test(entry)) {
      ignoredFields.push(String(index), String(index + 1))
      index += 1
      continue
    }
    if (CREDENTIAL_ARG_WITH_VALUE.test(entry)) {
      ignoredFields.push(String(index))
      continue
    }
    if (containsSensitiveText(entry)) {
      ignoredFields.push(String(index))
      continue
    }
    const sanitizedUrl = sanitizeUrl(entry)
    args.push(sanitizedUrl.value || entry)
    if (sanitizedUrl.changed) ignoredFields.push(String(index))
  }
  return { args, ignoredFields }
}

function sanitizeUrl(value: string): { value: string; changed: boolean } {
  try {
    const url = new URL(value)
    const changed = Boolean(url.username || url.password || url.search || url.hash)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return { value: url.toString(), changed }
  } catch {
    return containsSensitiveText(value) ? { value: '', changed: true } : { value, changed: false }
  }
}

function safeString(value: unknown): value is string {
  return typeof value === 'string' && !containsSensitiveText(value)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
