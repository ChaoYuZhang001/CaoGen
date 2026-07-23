import { createHash } from 'node:crypto'

const SENSITIVE_KEY = /(?:apikey|accesskey|accesstoken|authtoken|authorization|clientsecret|credential|cookie|password|privatekey|refreshtoken|secretaccesskey|securitytoken|sessioncookie|signature|webhooksecret)|(?:token|secret|password|credential|cookie)$/i

export function projectAggregateDigest(value: unknown): string {
  return createHash('sha256').update(projectAggregateCanonicalJson(value)).digest('hex')
}

export function projectAggregateCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sanitizeProjectAggregateValue(value: unknown): unknown {
  return sanitize(value, undefined, new WeakSet<object>())
}

export function assertNoCredentialMaterial(value: unknown): void {
  inspectForCredentials(value, undefined, new WeakSet<object>())
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Project aggregate cannot contain a non-finite number')
    }
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) output[key] = canonicalize(child)
  }
  return output
}

function sanitize(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (isSensitiveKey(key)) return '[REDACTED]'
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[REDACTED_CYCLIC_VALUE]'
  seen.add(value)
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitize(item, undefined, seen))
    seen.delete(value)
    return output
  }
  const output: Record<string, unknown> = {}
  for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
    const childValue = (value as Record<string, unknown>)[childKey]
    if (childValue !== undefined) output[childKey] = sanitize(childValue, childKey, seen)
  }
  seen.delete(value)
  return output
}

function sanitizeString(value: string): string {
  return value
    .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
}

function isSensitiveKey(key: string | undefined): boolean {
  if (!key) return false
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (normalized === 'fencingtoken') return false
  return SENSITIVE_KEY.test(normalized)
}

function inspectForCredentials(value: unknown, key: string | undefined, seen: WeakSet<object>): void {
  if (isSensitiveKey(key) && value !== '[REDACTED]') {
    throw new Error(`Project aggregate contains unredacted credential field ${key}`)
  }
  if (typeof value === 'string') {
    if (sanitizeString(value) !== value) {
      throw new Error('Project aggregate contains unredacted credential material')
    }
    return
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) inspectForCredentials(item, undefined, seen)
    seen.delete(value)
    return
  }
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    inspectForCredentials(childValue, childKey, seen)
  }
  seen.delete(value)
}
