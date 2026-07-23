import {
  isSensitiveProviderHeaderName,
  looksLikeProviderCredentialValue
} from '../providerCredentialBroker'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

/**
 * Artifact metadata is user supplied but is persisted into the immutable
 * Workflow Ledger event payload.  Keep the policy in one small, main-process
 * helper so every artifact/graph write applies the same fail-closed checks.
 *
 * This is intentionally a rejection policy, not a redactor: once a secret is
 * presented to a write boundary we do not persist a partially sanitised value
 * whose safety would be difficult to reason about later.
 */

export type WorkflowArtifactSecuritySurface =
  | 'artifact metadata'
  | 'artifact URI'
  | 'graph edge metadata'
  | 'graph location metadata'
  | 'graph location URI'
  | 'graph location path'
  | 'workflow evidence title'
  | 'workflow evidence summary'
  | 'workflow evidence media type'

export interface WorkflowArtifactSecurityIssue {
  code:
  | 'credential-key'
  | 'credential-value'
  | 'url-userinfo'
  | 'url-query'
  | 'url-credential'
  | 'metadata-depth'
  | 'metadata-shape'
  location: WorkflowArtifactSecuritySurface
}

const MAX_METADATA_DEPTH = 32
const MAX_METADATA_NODES = 4096

// ProviderCredentialBroker owns the provider-specific marker list.  These
// additional forms cover deterministic test canaries and common secret labels
// that do not carry a provider prefix (for example REDACTED_TOKEN_PLACEHOLDER).
const SECRET_CANARY = /(?:redacted[_ -]?(?:token|secret|credential)[_ -]?placeholder|(?:secret|credential|password|token|api[_-]?key)[_ -]?(?:canary|fixture|probe|placeholder)|(?:diagnostic|security)[_-]?canary)/i
const CREDENTIAL_NAME = /(?:^|[-_.\s])(?:api[_ -]?key|apikey|access[_ -]?key|auth(?:orization)?|bearer|client[_ -]?(?:secret|key)|cookie|credential|hmac|password|passwd|private[_ -]?key|refresh[_ -]?token|secret|signature|subscription|token|webhook)(?:$|[-_.\s])/i
const CREDENTIAL_NAME_EXACT = new Set([
  'apikey', 'auth', 'authorization', 'bearer', 'cookie', 'credential', 'hmac',
  'password', 'passwd', 'privatekey', 'secret', 'signature', 'token', 'webhook',
  'accesskey', 'clientkey', 'clientsecret', 'refreshtoken', 'subscriptionkey'
])
const CREDENTIAL_COMPACT_PART = /apikey|accesskey|authtoken|client(?:key|secret)|credential|hmac|password|passwd|privatekey|refreshtoken|secret|signature|subscriptionkey|webhook/i
const CREDENTIAL_ASSIGNMENT = /(?:api[_-]?key|access[_-]?key|auth(?:orization)?|bearer|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|signature|subscription|token|webhook)\s*[:=]/i
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

/**
 * Validate an optional metadata object.  The returned value is the same
 * object; callers can persist it after this function returns.
 */
export function assertWorkflowArtifactMetadataSafe(
  metadata: Record<string, unknown> | undefined,
  surface: Extract<WorkflowArtifactSecuritySurface, 'artifact metadata' | 'graph edge metadata' | 'graph location metadata'>
): void {
  if (metadata === undefined) return
  if (!isPlainRecord(metadata)) {
    throw securityError(surface, 'metadata-shape')
  }

  const seen = new Set<object>()
  let nodes = 0
  inspectValue(metadata, surface, 'metadata', 0, seen, () => {
    nodes += 1
    if (nodes > MAX_METADATA_NODES) throw securityError(surface, 'metadata-depth')
  })
}

/** Validate an artifact URI without normalising or persisting a redacted copy. */
export function assertWorkflowArtifactUriSafe(uri: string | undefined): void {
  if (uri === undefined) return
  inspectLocator(uri, 'artifact URI')
}

/** Validate a graph location URI without normalising or persisting a redacted copy. */
export function assertWorkflowArtifactLocationUriSafe(uri: string | undefined): void {
  if (uri === undefined) return
  inspectLocator(uri, 'graph location URI')
}

/** Validate a graph location path for embedded credentials/canaries. */
export function assertWorkflowArtifactLocationPathSafe(path: string | undefined): void {
  if (path === undefined) return
  inspectString(path, 'graph location path', false)
  try {
    const decoded = decodeURIComponent(path)
    if (decoded !== path) inspectString(decoded, 'graph location path', false)
  } catch {
    throw securityError('graph location path', 'url-credential')
  }
}

/** Validate immutable Workflow Evidence text without echoing rejected values. */
export function assertWorkflowEvidenceTextSafe(
  value: string | undefined,
  surface: Extract<
    WorkflowArtifactSecuritySurface,
    'workflow evidence title' | 'workflow evidence summary' | 'workflow evidence media type'
  >
): void {
  if (value === undefined) return
  inspectString(value, surface, true)
}

/**
 * Shared inspection entry point for focused tests and future write callers.
 * It returns only category labels and never echoes the inspected value.
 */
export function inspectWorkflowArtifactSecurity(
  input: {
    artifactMetadata?: Record<string, unknown>
    artifactUri?: string
    edgeMetadata?: Record<string, unknown>
    locationMetadata?: Record<string, unknown>
    locationUri?: string
    locationPath?: string
  }
): WorkflowArtifactSecurityIssue[] {
  const issues: WorkflowArtifactSecurityIssue[] = []
  const check = (run: () => void, location: WorkflowArtifactSecuritySurface): void => {
    try {
      run()
    } catch (error) {
      if (error instanceof WorkflowLedgerCorruptionError) {
        const code = extractSecurityCode(error.message)
        issues.push({ code, location })
        return
      }
      throw error
    }
  }
  check(() => assertWorkflowArtifactMetadataSafe(input.artifactMetadata, 'artifact metadata'), 'artifact metadata')
  check(() => assertWorkflowArtifactUriSafe(input.artifactUri), 'artifact URI')
  check(() => assertWorkflowArtifactMetadataSafe(input.edgeMetadata, 'graph edge metadata'), 'graph edge metadata')
  check(() => assertWorkflowArtifactMetadataSafe(input.locationMetadata, 'graph location metadata'), 'graph location metadata')
  check(() => assertWorkflowArtifactLocationUriSafe(input.locationUri), 'graph location URI')
  check(() => assertWorkflowArtifactLocationPathSafe(input.locationPath), 'graph location path')
  return issues
}

function inspectValue(
  value: unknown,
  surface: Extract<WorkflowArtifactSecuritySurface, 'artifact metadata' | 'graph edge metadata' | 'graph location metadata'>,
  path: string,
  depth: number,
  seen: Set<object>,
  count: () => void
): void {
  count()
  if (depth > MAX_METADATA_DEPTH) throw securityError(surface, 'metadata-depth')
  if (typeof value === 'string') {
    inspectString(value, surface, true)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) throw securityError(surface, 'metadata-shape')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspectValue(item, surface, `${path}[${index}]`, depth + 1, seen, count))
      return
    }
    if (!isPlainRecord(value)) throw securityError(surface, 'metadata-shape')
    for (const [key, child] of Object.entries(value)) {
      if (isCredentialName(key)) throw securityError(surface, 'credential-key')
      inspectValue(child, surface, `${path}.value`, depth + 1, seen, count)
    }
  } finally {
    seen.delete(value)
  }
}

function inspectLocator(value: string, surface: 'artifact URI' | 'graph location URI'): void {
  if (!URL_SCHEME.test(value)) {
    inspectString(value, surface, false)
    // Opaque locators are allowed, but query-like fragments still need the
    // same credential-key/value check (for example `artifact?id=...`).
    inspectQueryText(value, surface)
    return
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw securityError(surface, 'url-credential')
  }
  if (url.username || url.password) throw securityError(surface, 'url-userinfo')
  let decodedPath = url.pathname
  let decodedHash = url.hash
  try {
    decodedPath = decodeURIComponent(url.pathname)
    decodedHash = decodeURIComponent(url.hash)
  } catch {
    throw securityError(surface, 'url-credential')
  }
  if (
    looksLikeCredentialText(url.hostname) ||
    looksLikeCredentialText(decodedPath) ||
    CREDENTIAL_ASSIGNMENT.test(decodedPath) ||
    looksLikeCredentialText(decodedHash)
  ) {
    throw securityError(surface, 'url-credential')
  }
  if (url.search) {
    // Artifact locators may legitimately carry non-sensitive selectors such
    // as `view=1`; unlike a Provider Base URL, the locator is not later joined
    // with an adapter endpoint. Only credential-like query names/values are
    // rejected here.
    for (const [name, queryValue] of url.searchParams.entries()) {
      if (isCredentialName(name) || looksLikeCredentialText(name) || looksLikeCredentialText(queryValue)) {
        throw securityError(surface, 'url-query')
      }
    }
  }
}

function inspectString(
  value: string,
  surface: WorkflowArtifactSecuritySurface,
  inspectEmbeddedUrls: boolean
): void {
  if (looksLikeCredentialText(value) || CREDENTIAL_ASSIGNMENT.test(value)) {
    throw securityError(surface, 'credential-value')
  }
  if (inspectEmbeddedUrls && URL_SCHEME.test(value)) inspectLocator(value, surface === 'artifact metadata' ? 'artifact URI' : 'graph location URI')
  if (inspectEmbeddedUrls) inspectQueryText(value, surface)
}

function inspectQueryText(value: string, surface: WorkflowArtifactSecuritySurface): void {
  const queryIndex = value.indexOf('?')
  if (queryIndex < 0) return
  const query = value.slice(queryIndex + 1).split('#', 1)[0]
  if (!query) return
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    const rawName = separator < 0 ? pair : pair.slice(0, separator)
    const rawValue = separator < 0 ? '' : pair.slice(separator + 1)
    let name = rawName
    let queryValue = rawValue
    try { name = decodeURIComponent(rawName.replace(/\+/g, ' ')) } catch { /* URL parser will reject malformed URLs where applicable. */ }
    try { queryValue = decodeURIComponent(rawValue.replace(/\+/g, ' ')) } catch { /* Keep the opaque value for marker checks. */ }
    if (isCredentialName(name) || looksLikeCredentialText(name) || looksLikeCredentialText(queryValue)) {
      throw securityError(surface, 'url-query')
    }
  }
}

function isCredentialName(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  const compact = normalized.replace(/[-_\s]/g, '')
  return isSensitiveProviderHeaderName(value)
    || CREDENTIAL_NAME_EXACT.has(compact)
    || CREDENTIAL_COMPACT_PART.test(compact)
    || CREDENTIAL_NAME.test(normalized)
}

function looksLikeCredentialText(value: string): boolean {
  return looksLikeProviderCredentialValue(value) || SECRET_CANARY.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function securityError(
  surface: WorkflowArtifactSecuritySurface,
  code: WorkflowArtifactSecurityIssue['code']
): WorkflowLedgerCorruptionError {
  // Do not include keys, URLs, paths, or values: diagnostics must not become
  // a second exfiltration channel for the rejected secret.
  return new WorkflowLedgerCorruptionError(`${surface} rejected by secret-free write policy (${code})`)
}

function extractSecurityCode(message: string): WorkflowArtifactSecurityIssue['code'] {
  const match = message.match(/\(([^)]+)\)$/)?.[1]
  if (
    match === 'credential-key' || match === 'credential-value' || match === 'url-userinfo' ||
    match === 'url-query' || match === 'url-credential' || match === 'metadata-depth' || match === 'metadata-shape'
  ) return match
  return 'credential-value'
}
